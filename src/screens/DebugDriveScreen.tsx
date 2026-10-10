/**
 * Phase 2 DEBUG-Grade Engineering Screen
 *
 * Dedicated engineering view for rover driving tests (Saturday test: driving only, no paint).
 *
 * Requirements:
 * - Connection panel: host, token (stored securely), connect/disconnect.
 * - Live NED position, heading (degrees), speed (m/s) with staleness greyout.
 * - Link health: gateway connected, PX4 link session, timesync, resets.
 * - RTK panel from GET /api/rtk/status: source, transport, worker_state, ages, counters, receiver fix.
 * - Telemetry age (STALE after 1.0s, DISCONNECTED after 2.5s).
 * - Heartbeat interval measurement (500 ms target, actual measured interval & jitter).
 * - Last command result verbatim (ok, code, reason, delivered, data).
 * - Controls: Arm/Disarm, Offboard On/Off, Mission Start/Pause/Resume/Abort/SkipPoint.
 *   This is a SEPARATE engineering tool (own connection panel, reached from the connection screen).
 *   The arm and OFFBOARD buttons live only here: the operator mission flow never arms and never
 *   changes mode, the rover does both (mission contract v2).
 * - Mission state is read from `mission_state` rover events, like the operator screen.
 * - E-stop: 1-tap assert; clearing protected by confirmation modal.
 * - Mission upload (client half of GAP-04): POST /api/missions/plan. Clearly indicates 404 if unimplemented.
 * - Spray controls: HIDDEN / DISABLED for Saturday.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Satellite,
  ShieldAlert,
  SkipForward,
  Square,
  XCircle,
} from "lucide-react-native";

import {
  getProdApiClient,
  initProdApiClient,
  ProdApiClient,
  ProdApiError,
} from "../api/prodClient";
import {
  getProdSocketManager,
  type ProdSocketStatus,
} from "../api/prodSocket";
import {
  loadProdHost,
  loadProdToken,
  saveProdHost,
  saveProdToken,
} from "../api/prodStorage";
import {
  HeartbeatScheduler,
  type HeartbeatMetrics,
} from "../utils/heartbeatScheduler";
import { getAppTransport } from "../services/appTransport";
import {
  useProdTelemetry,
  getDerivedVehiclePose,
  getOverallStaleness,
} from "../features/telemetry/prodTelemetryStore";
import { useRoverEvents } from "../features/telemetry/roverEventStore";
import { selectMission } from "../features/mission/missionLifecycle";
import { beginStartTap } from "../features/mission/startTap";
import {
  MissionStateEnum,
  MISSION_STATE_NAMES,
  RppStateEnum,
  RPP_STATE_NAMES,
  FixTypeEnum,
  FIX_TYPE_NAMES,
  ArmingStateEnum,
  NavStateEnum,
} from "../contract/prod/realtime";
import type {
  MissionSummary,
  RtkStatusReport,
  GatewayVerdictResponse,
} from "../contract/prod/rest";
import type { PlanLine } from "../types/plan";
import { buildAppPlannedMissionFromLines } from "../utils/appPlannedMissionBuilder";
import { describeMissionPlanFailure } from "../utils/appPlannedMissionErrors";
import {
  discoverRovers,
  type DiscoveredRoverTarget,
} from "../utils/roverDiscovery";

interface DebugDriveScreenProps {
  onBack?: () => void;
  currentPlanLines?: PlanLine[];
  /** GPS anchor of the loaded plan (its local origin). Without it upload is refused. */
  originGps?: [number, number] | null;
}

export function DebugDriveScreen({ onBack, currentPlanLines, originGps }: DebugDriveScreenProps) {
  // ---- Connection state ----
  const [hostUrl, setHostUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [socketStatus, setSocketStatus] = useState<ProdSocketStatus>("disconnected");
  const [socketError, setSocketError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // ---- Rover Discovery State ----
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<string | null>(null);
  const [discoveredRoversList, setDiscoveredRoversList] = useState<DiscoveredRoverTarget[]>([]);

  // ---- Heartbeat scheduler state ----
  const [heartbeatMetrics, setHeartbeatMetrics] = useState<HeartbeatMetrics>({
    targetIntervalMs: 500,
    actualIntervalMs: 500,
    jitterMs: 0,
    threadLagMs: 0,
    maxThreadBlockMs: 0,
    lastSentAt: null,
    lastAckAt: null,
    consecutiveErrors: 0,
    totalSent: 0,
    totalAcks: 0,
    isRunning: false,
    transport: "none",
  });

  const heartbeatRef = useRef<HeartbeatScheduler | null>(null);

  // ---- Command & Mission State ----
  const [lastCommandResult, setLastCommandResult] = useState<{
    cmd: string;
    status: number;
    response: GatewayVerdictResponse | Record<string, unknown>;
    timestamp: string;
  } | null>(null);

  const [commandBusy, setCommandBusy] = useState(false);

  // E-Stop Clear Modal
  const [showClearEstopModal, setShowClearEstopModal] = useState(false);

  // RTK status fetched from REST
  const [rtkRestStatus, setRtkRestStatus] = useState<RtkStatusReport | null>(null);
  const [rtkLoading, setRtkLoading] = useState(false);

  // Mission list
  const [missionsList, setMissionsList] = useState<MissionSummary[]>([]);
  const [selectedMissionSha, setSelectedMissionSha] = useState<string>("");
  const [missionsLoading, setMissionsLoading] = useState(false);

  // App-planned mission upload feedback
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // Telemetry store hook
  const telemetry = useProdTelemetry();
  const roverEvents = useRoverEvents();
  const vehiclePose = getDerivedVehiclePose();
  const overallStaleness = getOverallStaleness();

  // Load saved credentials on mount + fast background probe
  useEffect(() => {
    void (async () => {
      const savedHost = await loadProdHost();
      const savedToken = await loadProdToken();
      if (savedHost) {
        setHostUrl(savedHost);
      } else {
        // Fast background probe on AP
        void (async () => {
          try {
            const found = await discoverRovers({
              seedHost: "",
              includePrototype: false,
            });
            if (found.length > 0) {
              setHostUrl(found[0].url);
              setDiscoveredRoversList(found);
            }
          } catch {
            // Ignore
          }
        })();
      }
      if (savedToken) setToken(savedToken);
    })();
  }, []);

  // Auto-discover rovers handler
  const handleAutoDiscover = useCallback(async () => {
    if (discovering) return;
    setDiscovering(true);
    setDiscoveryProgress("Probing AP...");
    try {
      const found = await discoverRovers({
        seedHost: hostUrl,
        preferredPort: 8000,
        includePrototype: true,
        concurrency: 28,
        timeoutMs: 500,
        onProgress: (scanned, total) => {
          setDiscoveryProgress(`${scanned}/${total}`);
        },
      });
      setDiscoveredRoversList(found);
      if (found.length > 0) {
        if (!hostUrl) {
          setHostUrl(found[0].url);
        }
      }
    } catch {
      // Ignore
    } finally {
      setDiscovering(false);
      setDiscoveryProgress(null);
    }
  }, [discovering, hostUrl]);

  // Listen to socket status and heartbeat from unified AppTransportService
  useEffect(() => {
    const transport = getAppTransport();
    const unsubStatus = transport.subscribeStatus((st, err) => {
      setSocketStatus(st);
      if (err) setSocketError(err);
      else if (st === "connected") setSocketError(null);
    });
    const unsubMetrics = transport.subscribeHeartbeat((m) => {
      setHeartbeatMetrics(m);
    });
    return () => {
      unsubStatus();
      unsubMetrics();
    };
  }, []);

  // Handle Connect via unified transport
  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setSocketError(null);
    try {
      const transport = getAppTransport();
      await transport.connect(hostUrl, token);

      // Refresh RTK and missions list
      void refreshRtkStatus();
      void refreshMissionsList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSocketError(`Connect failed: ${msg}`);
    } finally {
      setConnecting(false);
    }
  }, [hostUrl, token]);

  // Handle Disconnect via unified transport
  const handleDisconnect = useCallback(() => {
    getAppTransport().disconnect();
    setSocketStatus("disconnected");
  }, []);

  // Helper to record verbatim command responses
  const recordResult = useCallback(
    (cmd: string, status: number, resp: GatewayVerdictResponse | Record<string, unknown>) => {
      setLastCommandResult({
        cmd,
        status,
        response: resp,
        timestamp: new Date().toLocaleTimeString(),
      });
    },
    []
  );

  // E-STOP: 1-tap assert (never blocked)
  const handleAssertEstop = useCallback(async () => {
    const client = getProdApiClient();
    setCommandBusy(true);
    try {
      const res = await client.estop(true);
      recordResult("POST /api/estop (ASSERT)", 200, res);
    } catch (err) {
      const apiErr = err instanceof ProdApiError ? err : null;
      recordResult(
        "POST /api/estop (ASSERT)",
        apiErr?.status || 500,
        apiErr ? { ok: false, code: apiErr.code, reason: apiErr.reason, delivered: apiErr.delivered } : { ok: false, code: "ERROR", reason: String(err), delivered: false }
      );
    } finally {
      setCommandBusy(false);
    }
  }, [recordResult]);

  // E-STOP: Clear after modal confirmation
  const handleConfirmClearEstop = useCallback(async () => {
    setShowClearEstopModal(false);
    const client = getProdApiClient();
    setCommandBusy(true);
    try {
      const res = await client.estop(false);
      recordResult("POST /api/estop (CLEAR)", 200, res);
    } catch (err) {
      const apiErr = err instanceof ProdApiError ? err : null;
      recordResult(
        "POST /api/estop (CLEAR)",
        apiErr?.status || 500,
        apiErr ? { ok: false, code: apiErr.code, reason: apiErr.reason, delivered: apiErr.delivered } : { ok: false, code: "ERROR", reason: String(err), delivered: false }
      );
    } finally {
      setCommandBusy(false);
    }
  }, [recordResult]);

  // Arm / Disarm
  const handleArmToggle = useCallback(
    async (armTarget: boolean) => {
      const client = getProdApiClient();
      setCommandBusy(true);
      const cmdName = armTarget ? "POST /api/vehicle/arm (TRUE)" : "POST /api/vehicle/arm (FALSE)";
      try {
        const res = await client.arm(armTarget);
        recordResult(cmdName, 200, res);
      } catch (err) {
        const apiErr = err instanceof ProdApiError ? err : null;
        recordResult(
          cmdName,
          apiErr?.status || 500,
          apiErr ? { ok: false, code: apiErr.code, reason: apiErr.reason, delivered: apiErr.delivered } : { ok: false, code: "ERROR", reason: String(err), delivered: false }
        );
      } finally {
        setCommandBusy(false);
      }
    },
    [recordResult]
  );

  // Offboard Enable / Disable
  const handleOffboardToggle = useCallback(
    async (enableTarget: boolean) => {
      const client = getProdApiClient();
      setCommandBusy(true);
      const cmdName = enableTarget ? "POST /api/vehicle/offboard (ENABLE)" : "POST /api/vehicle/offboard (DISABLE)";
      try {
        const res = await client.setOffboard(enableTarget);
        recordResult(cmdName, 200, res);
      } catch (err) {
        const apiErr = err instanceof ProdApiError ? err : null;
        recordResult(
          cmdName,
          apiErr?.status || 500,
          apiErr ? { ok: false, code: apiErr.code, reason: apiErr.reason, delivered: apiErr.delivered } : { ok: false, code: "ERROR", reason: String(err), delivered: false }
        );
      } finally {
        setCommandBusy(false);
      }
    },
    [recordResult]
  );

  // Mission Commands: Pause, Resume, Abort, SkipPoint
  const handleMissionCommand = useCallback(
    async (action: "pause" | "resume" | "abort" | "skip_point") => {
      const client = getProdApiClient();
      setCommandBusy(true);
      const cmdName = `POST /api/mission/${action}`;
      try {
        let res: GatewayVerdictResponse;
        if (action === "pause") res = await client.pauseMission();
        else if (action === "resume") res = await client.resumeMission();
        else if (action === "abort") res = await client.abortMission("operator");
        else res = await client.skipPoint();

        recordResult(cmdName, 200, res);
      } catch (err) {
        const apiErr = err instanceof ProdApiError ? err : null;
        recordResult(
          cmdName,
          apiErr?.status || 500,
          apiErr ? { ok: false, code: apiErr.code, reason: apiErr.reason, delivered: apiErr.delivered } : { ok: false, code: "ERROR", reason: String(err), delivered: false }
        );
      } finally {
        setCommandBusy(false);
      }
    },
    [recordResult]
  );

  // Start Mission
  const handleStartMission = useCallback(async () => {
    if (!selectedMissionSha) return;
    const client = getProdApiClient();
    setCommandBusy(true);
    const cmdName = `POST /api/missions/${selectedMissionSha.slice(0, 8)}.../start`;
    // One tap = one request id; an unknown outcome is retried once with the same id.
    const tap = beginStartTap(selectedMissionSha);
    try {
      const res = await tap.submit(client);
      recordResult(cmdName, 202, res as unknown as Record<string, unknown>);
    } catch (err) {
      const apiErr = err instanceof ProdApiError ? err : null;
      recordResult(
        cmdName,
        apiErr?.status || 500,
        apiErr ? { ok: false, code: apiErr.code, reason: apiErr.reason, delivered: apiErr.delivered } : { ok: false, code: "ERROR", reason: String(err), delivered: false }
      );
    } finally {
      setCommandBusy(false);
    }
  }, [selectedMissionSha, recordResult]);

  // Refresh RTK Status
  const refreshRtkStatus = useCallback(async () => {
    setRtkLoading(true);
    try {
      const status = await getProdApiClient().getRtkStatus();
      setRtkRestStatus(status);
    } catch (e) {
      console.warn("[DebugDrive] getRtkStatus error:", e);
    } finally {
      setRtkLoading(false);
    }
  }, []);

  // Refresh Missions List
  const refreshMissionsList = useCallback(async () => {
    setMissionsLoading(true);
    try {
      const resp = await getProdApiClient().listMissions();
      setMissionsList(resp.missions || []);
      if (resp.missions && resp.missions.length > 0 && !selectedMissionSha) {
        setSelectedMissionSha(resp.missions[0].sha256);
      }
    } catch (e) {
      console.warn("[DebugDrive] listMissions error:", e);
    } finally {
      setMissionsLoading(false);
    }
  }, [selectedMissionSha]);

  // GAP-04: Upload App-Planned Mission
  const handleUploadAppPlannedMission = useCallback(async () => {
    if (!currentPlanLines || currentPlanLines.length === 0) {
      setUploadStatus("No plan geometry currently loaded in app.");
      return;
    }
    setCommandBusy(true);
    setUploadStatus("Building and uploading app-planned mission (POST /api/missions/plan)...");

    try {
      const payload = buildAppPlannedMissionFromLines({
        lines: currentPlanLines,
        anchor: originGps,
        missionName: "operator_debug_plan",
      });

      const res = await getProdApiClient().uploadAppPlannedMission(payload);
      setUploadStatus(`Uploaded successfully! SHA256: ${res.mission.sha256.slice(0, 16)}...`);
      recordResult("POST /api/missions/plan", 201, {
        ok: true,
        code: "CREATED",
        reason: "Mission artifact created",
        delivered: true,
        data: res.mission as unknown as Record<string, unknown>,
      });
      void refreshMissionsList();
    } catch (err: unknown) {
      if (err instanceof ProdApiError) {
        if (err.status === 404) {
          const notFoundMsg = "Backend returned 404: the rover does not serve POST /api/missions/plan (update the rover backend).";
          setUploadStatus(notFoundMsg);
          recordResult("POST /api/missions/plan", 404, {
            ok: false,
            code: "NOT_FOUND",
            reason: notFoundMsg,
            delivered: false,
          });
        } else {
          setUploadStatus(`Upload rejected (${err.status}): ${err.code} - ${err.reason}`);
          recordResult("POST /api/missions/plan", err.status, {
            ok: false,
            code: err.code,
            reason: err.reason,
            delivered: err.delivered,
          });
        }
      } else {
        setUploadStatus(`Upload not sent: ${describeMissionPlanFailure(err)}`);
      }
    } finally {
      setCommandBusy(false);
    }
  }, [currentPlanLines, originGps, recordResult, refreshMissionsList]);

  // ---- Derived State Fields ----
  const snap = telemetry.snapshot;
  // E-stop, gateway link and mission state come from `rover_event`s (unknown reads as unknown, never the last value).
  const isEstopAsserted = telemetry.estopAsserted;
  const estopSource = telemetry.estopSource || "unknown";

  const missionView = selectMission(roverEvents);
  const missionStateNum = missionView.known ? missionView.run.state : null;
  const missionStateName = missionView.known
    ? MISSION_STATE_NAMES[missionView.run.state] ?? `UNKNOWN(${missionView.run.state})`
    : "UNKNOWN";
  const activeMissionSha = missionView.known ? missionView.run.executionSha : "";

  const rppStateNum = snap?.rpp?.data?.state ?? RppStateEnum.IDLE;
  const rppStateName = RPP_STATE_NAMES[rppStateNum] ?? `UNKNOWN(${rppStateNum})`;
  const crossTrackM = snap?.rpp?.data?.cross_track_right_m ?? null;

  const motionGuardData = snap?.motion_guard?.data;
  const motionGuardAccepted = motionGuardData?.accepted;
  const motionGuardReason = motionGuardData?.reason_code;

  const px4LinkData = snap?.px4_link?.data;
  const px4Alive = px4LinkData?.session_alive ?? false;

  const rtkSnap = snap?.rtk_status?.data;
  const fixTypeNum = rtkSnap?.fix_type ?? FixTypeEnum.UNKNOWN;
  const fixTypeName = FIX_TYPE_NAMES[fixTypeNum] ?? `FIX(${fixTypeNum})`;

  // Staleness styling
  const isPoseStale = vehiclePose.staleness.isStale || vehiclePose.staleness.isDisconnected;
  const poseOpacity = isPoseStale ? 0.45 : 1.0;

  return (
    <View style={styles.root}>
      {/* Top Header Bar */}
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.headerTitle}>DYX 3WD · Engineering Debug Client</Text>
          <View style={styles.badgeRow}>
            {/* Staleness Badge */}
            <View
              style={[
                styles.pill,
                overallStaleness.grade === "LIVE"
                  ? styles.pillGreen
                  : overallStaleness.grade === "STALE"
                    ? styles.pillAmber
                    : styles.pillRed,
              ]}
            >
              <Text style={styles.pillText}>
                TELEMETRY: {overallStaleness.formattedAge}
              </Text>
            </View>

            {/* Socket Status Pill */}
            <View
              style={[
                styles.pill,
                socketStatus === "connected"
                  ? styles.pillGreen
                  : socketStatus === "connecting"
                    ? styles.pillAmber
                    : styles.pillRed,
              ]}
            >
              <Text style={styles.pillText}>WS: {socketStatus.toUpperCase()}</Text>
            </View>

            {/* Gateway Link Pill */}
            <View
              style={[
                styles.pill,
                telemetry.gatewayConnected ? styles.pillGreen : styles.pillRed,
              ]}
            >
              <Text style={styles.pillText}>
                GATEWAY: {telemetry.gatewayConnected ? "ONLINE" : "DISCONNECTED"}
              </Text>
            </View>
            <View style={[styles.pill, telemetry.operatorAlive && overallStaleness.isLive && !telemetry.awaitingPacket ? styles.pillGreen : styles.pillRed]}>
              <Text style={styles.pillText}>OPERATOR: {telemetry.operatorAlive && overallStaleness.isLive && !telemetry.awaitingPacket ? "ALIVE" : "UNAVAILABLE"}</Text>
            </View>
            <View style={[styles.pill, vehiclePose.staleness.isLive && vehiclePose.northM !== null ? styles.pillGreen : styles.pillRed]}>
              <Text style={styles.pillText}>VEHICLE: {vehiclePose.northM === null ? "UNAVAILABLE" : vehiclePose.staleness.grade}</Text>
            </View>
          </View>
        </View>

        {onBack && (
          <Pressable style={styles.backButton} onPress={onBack}>
            <Text style={styles.backButtonText}>Close Debug</Text>
          </Pressable>
        )}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.scrollContent}>
        {/* =========================================================================
            E-STOP SECTION (Owner Rule 3: 1-tap assert; confirmation modal to clear)
        ========================================================================= */}
        <View style={styles.estopContainer}>
          {isEstopAsserted ? (
            <View style={styles.estopAlertBanner}>
              <View style={styles.estopAlertHeader}>
                <ShieldAlert size={28} color="#fee2e2" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.estopAlertTitle}>EMERGENCY STOP ASSERTED</Text>
                  <Text style={styles.estopAlertSubtitle}>
                    Rover motion is hardware/firmware inhibited · Source: {estopSource}
                  </Text>
                </View>
              </View>
              <Pressable
                style={styles.estopClearButton}
                onPress={() => setShowClearEstopModal(true)}
                disabled={commandBusy}
              >
                <Text style={styles.estopClearButtonText}>CLEAR EMERGENCY STOP (MODAL CONFIRM)</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.estopAssertButton}
              onPress={handleAssertEstop}
              disabled={commandBusy}
            >
              <ShieldAlert size={32} color="#ffffff" />
              <View style={{ alignItems: "center" }}>
                <Text style={styles.estopAssertButtonText}>EMERGENCY STOP (ASSERT)</Text>
                <Text style={styles.estopAssertSubtext}>ONE-TAP IMMEDIATE HALT · NEVER BLOCKED</Text>
              </View>
            </Pressable>
          )}
        </View>

        {/* =========================================================================
            CONNECTION & HEARTBEAT STRIP
        ========================================================================= */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Rover Connection & Heartbeat Timing</Text>
          <View style={styles.rowWrap}>
            <View style={styles.inputGroup}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.inputLabel}>Rover Backend URL (Port 8000)</Text>
                <Pressable
                  style={styles.scanLinkBtn}
                  onPress={handleAutoDiscover}
                  disabled={discovering || socketStatus === "connected"}
                >
                  {discovering ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      <ActivityIndicator size="small" color="#38bdf8" />
                      <Text style={styles.scanLinkText}>
                        {discoveryProgress || "Scanning..."}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.scanLinkText}>🔍 Scan Rover</Text>
                  )}
                </Pressable>
              </View>
              <TextInput
                style={styles.input}
                value={hostUrl}
                onChangeText={setHostUrl}
                autoCapitalize="none"
                placeholder="Rover address, e.g. http://<rover-ip>:8000"
                placeholderTextColor="#64748b"
              />
              {discoveredRoversList.length > 0 && (
                <View style={styles.discoveredRow}>
                  <Text style={styles.discoveredLabel}>Found:</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                    {discoveredRoversList.map((r) => {
                      const isSelected = hostUrl === r.url;
                      return (
                        <Pressable
                          key={r.id}
                          style={[
                            styles.discoveredPill,
                            isSelected && styles.discoveredPillActive,
                          ]}
                          onPress={() => setHostUrl(r.url)}
                        >
                          <Text
                            style={[
                              styles.discoveredPillText,
                              isSelected && styles.discoveredPillTextActive,
                            ]}
                          >
                            {r.generation === "production" ? "PROD" : "PROTO"} · {r.host}:{r.port} ({r.responseTimeMs}ms)
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
            </View>

            <View style={[styles.inputGroup, { flex: 1.2 }]}>
              <Text style={styles.inputLabel}>Bearer Token (Saved to SecureStore)</Text>
              <View style={styles.tokenInputRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={token}
                  onChangeText={setToken}
                  secureTextEntry={!showToken}
                  placeholder="Paste static token..."
                  placeholderTextColor="#64748b"
                />
                <Pressable
                  style={styles.toggleVisibilityBtn}
                  onPress={() => setShowToken(!showToken)}
                >
                  <Text style={styles.toggleVisibilityText}>{showToken ? "Hide" : "Show"}</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.buttonRowInline}>
              {socketStatus === "connected" ? (
                <Pressable style={styles.btnDanger} onPress={handleDisconnect}>
                  <Text style={styles.btnText}>Disconnect</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={[styles.btnPrimary, connecting && styles.btnDisabled]}
                  onPress={handleConnect}
                  disabled={connecting}
                >
                  {connecting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.btnText}>Connect Rover</Text>
                  )}
                </Pressable>
              )}
            </View>
          </View>

          {socketError && (
            <Text style={styles.errorText}>Connection error: {socketError}</Text>
          )}

          {/* Heartbeat Monitor */}
          <View style={styles.heartbeatRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Heartbeat Target</Text>
              <Text style={styles.metricVal}>500 ms</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Actual Measured Interval</Text>
              <Text
                style={[
                  styles.metricVal,
                  heartbeatMetrics.actualIntervalMs > 750 ? styles.valWarn : styles.valGood,
                ]}
              >
                {heartbeatMetrics.isRunning ? `${heartbeatMetrics.actualIntervalMs} ms` : "--"}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Jitter</Text>
              <Text style={styles.metricVal}>
                {heartbeatMetrics.isRunning ? `±${heartbeatMetrics.jitterMs} ms` : "--"}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Acks / Sent</Text>
              <Text style={styles.metricVal}>
                {heartbeatMetrics.totalAcks} / {heartbeatMetrics.totalSent}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Link Status</Text>
              <Text
                style={[
                  styles.metricVal,
                  heartbeatMetrics.consecutiveErrors > 0 ? styles.valWarn : styles.valGood,
                ]}
              >
                {heartbeatMetrics.consecutiveErrors > 0
                  ? `Dropped (${heartbeatMetrics.consecutiveErrors})`
                  : heartbeatMetrics.isRunning
                    ? "HEALTHY"
                    : "STOPPED"}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Thread Lag / Max</Text>
              <Text style={styles.metricVal}>
                {heartbeatMetrics.isRunning
                  ? `${heartbeatMetrics.threadLagMs} ms (max ${heartbeatMetrics.maxThreadBlockMs} ms)`
                  : "--"}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Transport</Text>
              <Text style={styles.metricVal}>
                {heartbeatMetrics.isRunning ? heartbeatMetrics.transport.toUpperCase() : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* =========================================================================
            LIVE KINEMATICS & POSE (Local NED, Heading in Deg, Staleness Greyout)
        ========================================================================= */}
        <View style={[styles.card, { opacity: poseOpacity }]}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Live Kinematics & Pose (Local NED)</Text>
            {isPoseStale && (
              <View style={styles.badgeWarn}>
                <Text style={styles.badgeWarnText}>
                  {vehiclePose.staleness.grade}: {vehiclePose.staleness.formattedAge}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.metricsGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>North (N)</Text>
              <Text style={styles.metricCardVal}>
                {vehiclePose.northM != null ? `${vehiclePose.northM.toFixed(3)} m` : "--"}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>East (E)</Text>
              <Text style={styles.metricCardVal}>
                {vehiclePose.eastM != null ? `${vehiclePose.eastM.toFixed(3)} m` : "--"}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Down (D)</Text>
              <Text style={styles.metricCardVal}>
                {vehiclePose.downM != null ? `${vehiclePose.downM.toFixed(3)} m` : "--"}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Heading (Deg)</Text>
              <Text style={[styles.metricCardVal, styles.valHighlight]}>
                {vehiclePose.headingDeg != null ? `${vehiclePose.headingDeg.toFixed(1)}°` : "--"}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Yaw Rate</Text>
              <Text style={styles.metricCardVal}>
                {vehiclePose.yawRateDegps != null
                  ? `${vehiclePose.yawRateDegps.toFixed(1)}°/s`
                  : "--"}
              </Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Ground Speed</Text>
              <Text style={styles.metricCardVal}>
                {vehiclePose.speedMps != null ? `${vehiclePose.speedMps.toFixed(2)} m/s` : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* =========================================================================
            FSM & CONTROLLER STATES + VEHICLE ACTUATION
        ========================================================================= */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Vehicle States & Actuation Controls</Text>
          <View style={styles.metricsGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Arming State</Text>
              <Text
                style={[
                  styles.metricCardVal,
                  vehiclePose.armingState === ArmingStateEnum.ARMED
                    ? styles.valGood
                    : styles.valAmber,
                ]}
              >
                {vehiclePose.armingState === ArmingStateEnum.ARMED
                  ? "ARMED"
                  : vehiclePose.armingState === ArmingStateEnum.DISARMED
                    ? "DISARMED"
                    : "UNKNOWN"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>PX4 Nav State</Text>
              <Text
                style={[
                  styles.metricCardVal,
                  vehiclePose.navState === NavStateEnum.OFFBOARD
                    ? styles.valGood
                    : styles.valAmber,
                ]}
              >
                {vehiclePose.navState === NavStateEnum.OFFBOARD
                  ? "OFFBOARD (14)"
                  : vehiclePose.navState != null
                    ? `MODE ${vehiclePose.navState}`
                    : "--"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Mission FSM State</Text>
              <Text style={[styles.metricCardVal, styles.valGood]}>
                {missionStateName}{missionStateNum !== null ? ` (${missionStateNum})` : ""}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>RPP Tracker State</Text>
              <Text style={[styles.metricCardVal, styles.valGood]}>
                {rppStateName} ({rppStateNum})
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Cross-Track Error</Text>
              <Text style={styles.metricCardVal}>
                {crossTrackM != null ? `${crossTrackM.toFixed(3)} m` : "--"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Motion Guard</Text>
              <Text
                style={[
                  styles.metricCardVal,
                  motionGuardAccepted ? styles.valGood : styles.valWarn,
                ]}
              >
                {motionGuardAccepted ? "ACCEPTED" : `BLOCKED (rc: ${motionGuardReason ?? "?"})`}
              </Text>
            </View>
          </View>

          {/* Actuation Controls */}
          <View style={styles.controlsRow}>
            <Pressable
              style={[styles.btnAction, styles.btnSuccess]}
              onPress={() => handleArmToggle(true)}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>ARM ROVER</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnDanger]}
              onPress={() => handleArmToggle(false)}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>DISARM ROVER</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnPrimary]}
              onPress={() => handleOffboardToggle(true)}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>OFFBOARD ON</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnNeutral]}
              onPress={() => handleOffboardToggle(false)}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>OFFBOARD OFF</Text>
            </Pressable>
          </View>
        </View>

        {/* =========================================================================
            READ-ONLY RTK STATUS PANEL (docs/plans/2026-10-08_production_rtk_plan.md)
        ========================================================================= */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Satellite size={20} color="#38bdf8" />
              <Text style={styles.cardTitle}>RTK System Status (Read-Only)</Text>
            </View>
            <Pressable
              style={styles.btnSmall}
              onPress={refreshRtkStatus}
              disabled={rtkLoading}
            >
              {rtkLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.btnSmallText}>Refresh Status</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.metricsGrid}>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Receiver Fix</Text>
              <Text
                style={[
                  styles.metricCardVal,
                  fixTypeNum === FixTypeEnum.RTK_FIXED
                    ? styles.valGood
                    : fixTypeNum === FixTypeEnum.RTK_FLOAT
                      ? styles.valAmber
                      : styles.valWarn,
                ]}
              >
                {fixTypeName}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Selected Source</Text>
              <Text style={styles.metricCardVal}>
                {rtkRestStatus?.source?.selected || "NTRIP (Default)"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Selected Transport</Text>
              <Text style={styles.metricCardVal}>
                {rtkRestStatus?.transport?.selected || "USB_DIRECT"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Horizontal Accuracy</Text>
              <Text style={styles.metricCardVal}>
                {rtkSnap?.horizontal_accuracy_m != null
                  ? `${(rtkSnap.horizontal_accuracy_m * 100).toFixed(1)} cm`
                  : "--"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Satellites Used</Text>
              <Text style={styles.metricCardVal}>
                {rtkSnap?.satellites_used ?? "--"}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>Corrections Age</Text>
              <Text style={styles.metricCardVal}>
                {rtkSnap?.correction_age_s != null
                  ? `${rtkSnap.correction_age_s.toFixed(1)} s`
                  : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* =========================================================================
            MISSION CONTROLS & GAP-04 APP-PLANNED MISSION UPLOAD
        ========================================================================= */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Mission Execution & Staged Artifacts</Text>
            <Pressable
              style={styles.btnSmall}
              onPress={refreshMissionsList}
              disabled={missionsLoading}
            >
              {missionsLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.btnSmallText}>Refresh Missions</Text>
              )}
            </Pressable>
          </View>

          {/* Active Mission Hash */}
          <View style={{ marginBottom: 12 }}>
            <Text style={styles.inputLabel}>Current Loaded Mission Artifact (SHA-256):</Text>
            <Text style={styles.codeText}>
              {activeMissionSha || "No mission currently loaded on rover."}
            </Text>
          </View>

          {/* Stored missions list */}
          {missionsList.length > 0 && (
            <View style={{ marginBottom: 14 }}>
              <Text style={styles.inputLabel}>Select Stored Mission on Rover:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {missionsList.map((m) => {
                    const isSelected = selectedMissionSha === m.sha256;
                    return (
                      <Pressable
                        key={m.sha256}
                        style={[styles.missionPill, isSelected && styles.missionPillActive]}
                        onPress={() => setSelectedMissionSha(m.sha256)}
                      >
                        <Text style={[styles.missionPillText, isSelected && styles.missionPillTextActive]}>
                          {m.sha256.slice(0, 10)}... ({m.num_points} pts)
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            </View>
          )}

          {/* Controls: Start, Pause, Resume, Abort, Skip */}
          <View style={styles.controlsRow}>
            <Pressable
              style={[styles.btnAction, styles.btnSuccess, !selectedMissionSha && styles.btnDisabled]}
              onPress={handleStartMission}
              disabled={!selectedMissionSha || commandBusy}
            >
              <Text style={styles.btnActionText}>START MISSION</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnAmber]}
              onPress={() => handleMissionCommand("pause")}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>PAUSE</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnPrimary]}
              onPress={() => handleMissionCommand("resume")}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>RESUME</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnDanger]}
              onPress={() => handleMissionCommand("abort")}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>ABORT</Text>
            </Pressable>

            <Pressable
              style={[styles.btnAction, styles.btnNeutral]}
              onPress={() => handleMissionCommand("skip_point")}
              disabled={commandBusy}
            >
              <Text style={styles.btnActionText}>SKIP POINT</Text>
            </Pressable>
          </View>

          {/* GAP-04 Upload app-planned mission */}
          <View style={styles.uploadSection}>
            <Text style={styles.sectionHeading}>
              GAP-04: Client-Planned Mission Ingest (POST /api/missions/plan)
            </Text>
            <Text style={styles.sectionDescription}>
              Uploads current lines planned in the app to the production contract without raw DXF/CSV re-planning.
            </Text>

            <Pressable
              style={[styles.btnUpload, commandBusy && styles.btnDisabled]}
              onPress={handleUploadAppPlannedMission}
              disabled={commandBusy}
            >
              <Text style={styles.btnUploadText}>UPLOAD APP-PLANNED MISSION (GAP-04)</Text>
            </Pressable>

            {uploadStatus && (
              <View style={styles.statusBox}>
                <Text style={styles.statusText}>{uploadStatus}</Text>
              </View>
            )}
          </View>
        </View>

        {/* =========================================================================
            LAST COMMAND VERBATIM RESULT (ok, code, reason, delivered, data)
        ========================================================================= */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Last Rover Command Verdict (Verbatim Backend Reply)</Text>
          {lastCommandResult ? (
            <View style={styles.resultBox}>
              <View style={styles.resultHeaderRow}>
                <Text style={styles.resultCmd}>{lastCommandResult.cmd}</Text>
                <Text
                  style={[
                    styles.resultStatus,
                    lastCommandResult.response.ok ? styles.valGood : styles.valWarn,
                  ]}
                >
                  HTTP {lastCommandResult.status} · {lastCommandResult.response.ok ? "OK" : "FAILED"}
                </Text>
                <Text style={styles.resultTime}>{lastCommandResult.timestamp}</Text>
              </View>
              <Text style={styles.codeText}>
                {JSON.stringify(lastCommandResult.response, null, 2)}
              </Text>
            </View>
          ) : (
            <Text style={styles.emptyText}>No command sent in this session.</Text>
          )}
        </View>
      </ScrollView>

      {/* =========================================================================
          CLEAR E-STOP CONFIRMATION MODAL (Owner Answer 3)
      ========================================================================= */}
      <Modal
        visible={showClearEstopModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowClearEstopModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <AlertTriangle size={32} color="#f59e0b" />
              <Text style={styles.modalTitle}>Confirm Clear Emergency Stop</Text>
            </View>

            <Text style={styles.modalMessage}>
              Are you sure you want to clear the rover Emergency Stop?
              {"\n\n"}
              • This permits autonomous and remote actuation.
              {"\n"}
              • Confirm that all personnel are safely clear of the rover.
              {"\n"}
              • Clearing requires OPERATOR authority role.
            </Text>

            <View style={styles.modalButtonRow}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => setShowClearEstopModal(false)}
              >
                <Text style={styles.modalCancelBtnText}>Cancel</Text>
              </Pressable>

              <Pressable
                style={styles.modalConfirmBtn}
                onPress={handleConfirmClearEstop}
              >
                <Text style={styles.modalConfirmBtnText}>Confirm Clear E-Stop</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#090d16",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
    backgroundColor: "#0f172a",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitleRow: {
    flex: 1,
    gap: 8,
  },
  headerTitle: {
    fontSize: 19,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: 0.4,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  pillGreen: {
    backgroundColor: "rgba(16, 185, 129, 0.12)",
    borderColor: "#10b981",
  },
  pillAmber: {
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderColor: "#f59e0b",
  },
  pillRed: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderColor: "#ef4444",
  },
  pillText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#f8fafc",
    letterSpacing: 0.3,
  },
  backButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#334155",
  },
  backButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#f8fafc",
  },
  body: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
  },
  estopContainer: {
    marginBottom: 4,
  },
  estopAssertButton: {
    backgroundColor: "#dc2626",
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    borderWidth: 2,
    borderColor: "#f87171",
    shadowColor: "#dc2626",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 8,
  },
  estopAssertButtonText: {
    fontSize: 20,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: 1.2,
  },
  estopAssertSubtext: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fee2e2",
    marginTop: 2,
    letterSpacing: 0.5,
  },
  estopAlertBanner: {
    backgroundColor: "#7f1d1d",
    borderWidth: 2,
    borderColor: "#ef4444",
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  estopAlertHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  estopAlertTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: 0.8,
  },
  estopAlertSubtitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fecaca",
    marginTop: 2,
  },
  estopClearButton: {
    backgroundColor: "#16a34a",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#4ade80",
  },
  estopClearButtonText: {
    fontSize: 14,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: 0.6,
  },
  card: {
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1f2937",
    borderRadius: 14,
    padding: 16,
    gap: 14,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#f3f4f6",
    letterSpacing: 0.3,
  },
  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "flex-end",
  },
  inputGroup: {
    flex: 1,
    minWidth: 220,
    gap: 6,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94a3b8",
  },
  scanLinkBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.3)",
  },
  scanLinkText: {
    color: "#38bdf8",
    fontSize: 11,
    fontWeight: "700",
  },
  discoveredRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  discoveredLabel: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "700",
  },
  discoveredPill: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  discoveredPillActive: {
    backgroundColor: "rgba(16, 185, 129, 0.2)",
    borderColor: "#10b981",
  },
  discoveredPillText: {
    color: "#cbd5e1",
    fontSize: 11,
    fontWeight: "600",
  },
  discoveredPillTextActive: {
    color: "#34d399",
    fontWeight: "800",
  },
  input: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#ffffff",
    fontSize: 13,
  },
  tokenInputRow: {
    flexDirection: "row",
    gap: 8,
  },
  toggleVisibilityBtn: {
    backgroundColor: "#334155",
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 8,
  },
  toggleVisibilityText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#f8fafc",
  },
  buttonRowInline: {
    paddingBottom: 2,
  },
  btnPrimary: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: "center",
  },
  btnDanger: {
    backgroundColor: "#dc2626",
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: "center",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800",
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
    fontWeight: "700",
  },
  heartbeatRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    backgroundColor: "#0d131f",
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  metricBox: {
    flex: 1,
    minWidth: 100,
    gap: 2,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748b",
    textTransform: "uppercase",
  },
  metricVal: {
    fontSize: 14,
    fontWeight: "800",
    color: "#f8fafc",
  },
  valGood: {
    color: "#10b981",
  },
  valWarn: {
    color: "#ef4444",
  },
  valAmber: {
    color: "#f59e0b",
  },
  valHighlight: {
    color: "#38bdf8",
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  metricCard: {
    flex: 1,
    minWidth: 140,
    backgroundColor: "#1e293b",
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    gap: 4,
  },
  metricCardLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94a3b8",
  },
  metricCardVal: {
    fontSize: 16,
    fontWeight: "900",
    color: "#f8fafc",
  },
  badgeWarn: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderColor: "#f59e0b",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeWarnText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#f59e0b",
  },
  controlsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  btnAction: {
    flex: 1,
    minWidth: 130,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnActionText: {
    fontSize: 13,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: 0.5,
  },
  btnSuccess: {
    backgroundColor: "#16a34a",
  },
  btnAmber: {
    backgroundColor: "#d97706",
  },
  btnNeutral: {
    backgroundColor: "#475569",
  },
  btnSmall: {
    backgroundColor: "#334155",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  btnSmallText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#ffffff",
  },
  missionPill: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  missionPillActive: {
    backgroundColor: "#2563eb",
    borderColor: "#60a5fa",
  },
  missionPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94a3b8",
  },
  missionPillTextActive: {
    color: "#ffffff",
  },
  uploadSection: {
    marginTop: 10,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#1f2937",
    gap: 8,
  },
  sectionHeading: {
    fontSize: 13,
    fontWeight: "800",
    color: "#e2e8f0",
  },
  sectionDescription: {
    fontSize: 12,
    color: "#94a3b8",
    lineHeight: 16,
  },
  btnUpload: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 4,
  },
  btnUploadText: {
    fontSize: 13,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: 0.6,
  },
  statusBox: {
    backgroundColor: "#1e293b",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155",
  },
  statusText: {
    fontSize: 12,
    color: "#f8fafc",
    fontWeight: "600",
  },
  resultBox: {
    backgroundColor: "#0a0f1d",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  resultHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  resultCmd: {
    fontSize: 13,
    fontWeight: "800",
    color: "#38bdf8",
  },
  resultStatus: {
    fontSize: 12,
    fontWeight: "800",
  },
  resultTime: {
    fontSize: 11,
    color: "#64748b",
  },
  codeText: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#cbd5e1",
    lineHeight: 16,
  },
  emptyText: {
    fontSize: 12,
    color: "#64748b",
    fontStyle: "italic",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalSheet: {
    backgroundColor: "#111827",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#374151",
    padding: 24,
    maxWidth: 480,
    width: "100%",
    gap: 16,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "#ffffff",
  },
  modalMessage: {
    fontSize: 14,
    color: "#cbd5e1",
    lineHeight: 20,
  },
  modalButtonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: "#374151",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  modalCancelBtnText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#f8fafc",
  },
  modalConfirmBtn: {
    flex: 1.5,
    backgroundColor: "#16a34a",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  modalConfirmBtnText: {
    fontSize: 14,
    fontWeight: "900",
    color: "#ffffff",
  },
});
