import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Text, TouchableOpacity, View } from "react-native";

import type { StagedPlanResultState, StagedWorkflowStatus, StagedWorkflowStep } from "../../../types/fieldsWorkflow";
import type { PlanLine } from "../../../types/plan";
import type { MissionLayer } from "../../../types/missionLayers";
import type { UploadedFileEntry } from "../../../types/uploadedFiles";
import {
  MISSION_STAGE_STEP_LABELS,
  stageAppPlannedMission,
  stagedPlanResultFromAdmitted,
  type AdmittedMission,
  type MissionStageStep,
} from "../../../utils/missionStaging";
import type { DashPattern } from "../../../utils/appPlannedMissionBuilder";
import { evaluateCsvSendReadiness } from "../../../utils/csvGeometryReadiness";
import {
  buildOrderedTrajectory,
  defaultPathOrder,
  selectMarkPlanLines,
  type CsvPathOrderEntry,
} from "../../../utils/missionPathOrder";
import {
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "../../../utils/missionExtensions";
import {
  buildAppPlannedStartSnapshot,
  type AppPlannedStartSnapshot,
} from "../../../utils/appPlannedStartSnapshot";
import {
  buildTrajectory,
  type RoverPoseForEntry,
} from "../../../utils/missionTrajectory";
import type { LocalPointCsvResult } from "../../../utils/localPointCsv";
import { yieldToUi } from "../../../utils/runtimeGuards";
import { isStagedHydrationLineId } from "../../../utils/stagedMissionHydration";
import { FIELDS_COLORS } from "../fieldsTheme";

type CsvStageAndLoadPanelProps = {
  apiBaseUrl: string;
  /**
   * Which import owns this panel:
   * - `"csv"`: survey points → frontend fits lines → app-planned mission
   * - `"dxf"`: real DXF path geometry already in `lines` → app-planned mission
   */
  sourceKind?: "csv" | "dxf";
  /**
   * CSV local preview (required for CSV).
   * Not used when `sourceKind === "dxf"` (geometry lives in `lines`).
   */
  localCsvPreview?: LocalPointCsvResult | null;
  /** Sampled map pins, purely to explain "map shows N of M pins" to the operator. */
  mapPinCount?: number | null;
  /** Current map plan lines (CSV fitted marks / DXF entity paths + transit). */
  lines?: PlanLine[];
  /** Mission layers + file assignments (kept for caller compatibility). */
  missionLayers?: MissionLayer[];
  uploadedFiles?: UploadedFileEntry[];
  /** Operator order/paint from CsvPathOrderStep; defaults to all marks painted in list order. */
  pathOrder?: CsvPathOrderEntry[] | null;
  /** Local PRE/AFT config for app-planned trajectory (spray-off travel runs). */
  extensionConfig?: CsvExtensionConfig | null;
  /** Dashed spray pattern (alternating mark/travel runs); null = continuous. */
  dashPattern?: DashPattern | null;
  /**
   * GPS anchor of the mission (DXF alignment / geoOrigin). When set, overrides
   * the CSV anchor. Without one the mission is refused: points are metres from
   * this origin and the rover cannot place them otherwise.
   */
  originGps?: [number, number] | null;
  /**
   * Live rover pose (unused for entry on Send — entry is rebuilt at Start).
   * Kept optional for future preview; Start reads App telemetry.
   */
  roverPose?: RoverPoseForEntry | null;
  /**
   * Called after a successful app-planned Send so Start can restage with a
   * fresh runtime entry from the live rover pose (original geometry, not densified).
   */
  onAppPlannedStartSnapshot?: (snapshot: AppPlannedStartSnapshot) => void;
  /** Mission name stem (defaults from CSV/DXF file name). */
  missionName?: string | null;
  /** Parse/import warnings for readiness (DXF local warnings). */
  parseWarnings?: string[];
  /** Kept so callers can still pass map setters; Send no longer overwrites operator geometry. */
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  onSelectLine: (id: string | null) => void;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  /** Map projection origin — must be set with staged geometry (never independently). */
  setAlignedRefPoints?: React.Dispatch<
    React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>
  >;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  /**
   * The mission is stored on the rover and verified. There is no load step: Start (on Home) does
   * everything. The app uses this to open the mission screen.
   */
  onMissionStored: (missionId: string) => void;
  missionActionBusy: boolean;
  onBeginPathExclusive?: (kind: "send") => boolean;
  onEndPathExclusive?: (kind: "send") => void;
};

function metres(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toFixed(1)} m`;
}

/**
 * Send panel (Send to Rover) — status, block reason, Send.
 *
 * - CSV: fit points → buildTrajectory → app-planned mission (`POST /api/missions/plan`).
 * - DXF (`sourceKind === "dxf"`): real file path geometry in `lines` → the same path.
 *   Never re-fits CAD entities; never uploads the DXF file.
 *
 * Send stores the mission on the rover and verifies what was stored. Nothing else is staged:
 * there is no load step, Start does everything.
 */
export function CsvStageAndLoadPanel({
  apiBaseUrl,
  sourceKind,
  localCsvPreview = null,
  mapPinCount: _mapPinCount = null,
  lines = [],
  missionLayers: _missionLayers = [],
  uploadedFiles: _uploadedFiles = [],
  pathOrder = null,
  extensionConfig = null,
  dashPattern = null,
  originGps = null,
  roverPose: _roverPose = null,
  onAppPlannedStartSnapshot,
  missionName = null,
  parseWarnings = [],
  setLines: _setLines,
  onSelectLine: _onSelectLine,
  setStagedMissionId,
  setStagedPlanResult,
  setAlignedRefPoints: _setAlignedRefPoints,
  onWorkflowStep,
  onMissionStored,
  missionActionBusy,
  onBeginPathExclusive,
  onEndPathExclusive,
}: CsvStageAndLoadPanelProps) {
  void _roverPose;
  void _setLines;
  void _onSelectLine;
  void _setAlignedRefPoints;
  void _missionLayers;
  void _uploadedFiles;
  const extCfg = useMemo(
    () => normalizeCsvExtensionConfig(extensionConfig),
    [extensionConfig]
  );
  void _mapPinCount;
  const [busy, setBusy] = useState(false);
  const sendInFlightRef = useRef(false);
  const [step, setStep] = useState<MissionStageStep | null>(null);
  const [staged, setStaged] = useState<AdmittedMission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startBlocked, setStartBlocked] = useState(false);
  /** Operator accepted remaining non-paintable painted paths (they are still refused in buildTrajectory). */
  const [geometryAcknowledged, setGeometryAcknowledged] = useState(false);
  /** Operator confirmed critical parse-frame warnings. */
  const [parseAcknowledged, setParseAcknowledged] = useState(false);

  // Prefer explicit sourceKind; fall back to legacy heuristic for callers that omit it.
  const isDxfLocal =
    sourceKind === "dxf" ||
    (sourceKind == null && localCsvPreview == null && originGps != null);

  const markLines = useMemo(() => selectMarkPlanLines(lines), [lines]);
  const order = useMemo(
    () => pathOrder ?? defaultPathOrder(markLines),
    [pathOrder, markLines]
  );

  const resolvedOriginGps: [number, number] | null = useMemo(() => {
    if (originGps != null && Number.isFinite(originGps[0]) && Number.isFinite(originGps[1])) {
      return originGps;
    }
    if (localCsvPreview?.kind === "gps" && localCsvPreview.anchor) {
      return [localCsvPreview.anchor.lat, localCsvPreview.anchor.lon];
    }
    return null;
  }, [originGps, localCsvPreview]);

  const resolvedMissionName =
    missionName?.replace(/\.[^.]+$/, "") ||
    localCsvPreview?.fileName?.replace(/\.[^.]+$/, "") ||
    (isDxfLocal ? "dxf_mission" : "csv_mission");

  const combinedWarnings = useMemo(() => {
    const fromCsv = localCsvPreview?.warnings ?? [];
    return [...fromCsv, ...parseWarnings];
  }, [localCsvPreview?.warnings, parseWarnings]);

  // New file / geometry → re-require acknowledgement.
  useEffect(() => {
    setGeometryAcknowledged(false);
    setParseAcknowledged(false);
  }, [
    localCsvPreview?.fileName,
    localCsvPreview?.num_points,
    missionName,
    markLines.length,
    isDxfLocal,
  ]);

  const readiness = useMemo(
    () =>
      evaluateCsvSendReadiness({
        lines,
        pathOrder: order,
        parseWarnings: combinedWarnings,
        geometryAcknowledged,
        parseAcknowledged,
        requireGpsAnchor: true,
        hasGpsAnchor: resolvedOriginGps != null,
        dxfOperatorOrderAuthoritative: isDxfLocal,
      }),
    [
      lines,
      order,
      combinedWarnings,
      geometryAcknowledged,
      parseAcknowledged,
      resolvedOriginGps,
      isDxfLocal,
    ]
  );

  const appTrajectory = useMemo(
    () =>
      buildOrderedTrajectory(markLines, order, {
        markSpeedMs: 0.35,
        travelSpeedMs: 0.5,
        extensions: extCfg,
      }),
    [markLines, order, extCfg]
  );

  const paintedCount = useMemo(
    () => order.filter((e) => e.paint !== false && markLines.some((m) => m.id === e.lineId)).length,
    [order, markLines]
  );

  const readinessBlocksSend = !readiness.canSend;
  const disabled =
    busy ||
    missionActionBusy ||
    !apiBaseUrl ||
    readinessBlocksSend ||
    (appTrajectory?.runs.length ?? 0) < 1 ||
    resolvedOriginGps == null;

  const stepLabel = step ? MISSION_STAGE_STEP_LABELS[step] : null;

  const applyStagedSuccess = (admitted: AdmittedMission) => {
    setStaged(admitted);
    setStagedMissionId(admitted.missionId);
    setStagedPlanResult(stagedPlanResultFromAdmitted(admitted));
    onWorkflowStep?.("staged", "verified");
    setStartBlocked(false);
    // Keep operator DXF/CSV segments on the map: the rover's densified waypoints are never
    // hydrated back, so Path Order keeps one row per original segment.
    onMissionStored(admitted.missionId);
  };

  const handleSendAppPlanned = async () => {
    if (sendInFlightRef.current || busy || missionActionBusy) return;
    if (!apiBaseUrl) {
      Alert.alert("Not connected", "Connect to the rover before sending the path.");
      return;
    }
    if (!readiness.canSend) {
      Alert.alert(
        "Send blocked",
        [...readiness.hardBlocks, ...readiness.needsAck].slice(0, 6).join("\n\n") ||
          "Resolve geometry or parse warnings before sending."
      );
      return;
    }
    if (!resolvedOriginGps) {
      const message = isDxfLocal
        ? "No GPS origin. A DXF mission needs a georeferenced file, or complete Align first: the rover cannot place the plan without it."
        : "No GPS origin. A CSV mission needs GPS survey points (lat/lon): the rover cannot place the plan without it.";
      setError(message);
      Alert.alert("Missing origin", message);
      return;
    }
    if (!appTrajectory || appTrajectory.paintedLines.length === 0) {
      Alert.alert(
        "Empty trajectory",
        isDxfLocal
          ? "No painted DXF mark paths to send. Check the file has LINE/POLYLINE geometry (or enough points)."
          : "No painted mark paths to send."
      );
      return;
    }
    // Re-send guard: if the map is already rover densified (recovery / an older
    // Send that hydrated waypoints), refuse — re-planning those 5 cm points as
    // survey vertices staged must_hit=122/123 (2026-07-29). Fresh Send leaves
    // original DXF/CSV segments in `lines`, so this only trips on stale geometry.
    if (appTrajectory.paintedLines.some((l) => isStagedHydrationLineId(l.id))) {
      Alert.alert(
        "Already staged — re-import to send again",
        isDxfLocal
          ? "The map is showing the rover's staged mission (already densified), not the original DXF path. Re-import the DXF file, then send."
          : "The map is showing the rover's staged mission (already densified), not the original survey geometry. Re-import the CSV file, then send."
      );
      return;
    }

    sendInFlightRef.current = true;
    if (onBeginPathExclusive && !onBeginPathExclusive("send")) {
      sendInFlightRef.current = false;
      return;
    }
    setBusy(true);
    setError(null);
    setStep(null);
    setStartBlocked(false);
    await yieldToUi();
    try {
      // CSV: paintedLines are frontend-fitted from survey points.
      // DXF: paintedLines are the real entity paths from parseLocalDxf (already baked
      // through Align when metric). buildTrajectory packs vertices into mark/travel runs.
      // Runtime entry is NOT built here — Start Mission restages with live pose every time.
      const built = buildTrajectory(appTrajectory.paintedLines, {
        markSpeedMs: 0.35,
        travelSpeedMs: 0.5,
        extensions: extCfg,
        includeEntryTransit: false,
      });
      if (built.runs.length === 0) {
        const detail = built.warnings.slice(0, 3).join("\n") || "No mark runs produced.";
        setError(detail);
        Alert.alert("Empty trajectory", detail);
        return;
      }
      const sourcePainted = appTrajectory.paintedLines;

      const result = await stageAppPlannedMission({
        missionName: resolvedMissionName,
        anchor: resolvedOriginGps,
        runs: built.runs,
        dash: dashPattern,
        onStep: setStep,
      });

      if (!result.success || !result.admitted) {
        const message = result.error || "Could not stage the trajectory.";
        setError(message);
        setStartBlocked(result.startBlocked === true);
        onWorkflowStep?.("staged", "failed");
        Alert.alert(
          result.startBlocked ? "Verification Failed — Start Blocked" : "Send Failed",
          `Failed at step "${MISSION_STAGE_STEP_LABELS[result.failedStep ?? "build"]}"\n\n${message}`
        );
        return;
      }

      // Freeze source geometry after success — Start restages from this snapshot.
      onAppPlannedStartSnapshot?.(
        buildAppPlannedStartSnapshot({
          paintedLines: sourcePainted,
          extensionConfig: extCfg,
          originGps: resolvedOriginGps,
          missionName: resolvedMissionName,
          dash: dashPattern,
        })
      );

      applyStagedSuccess(result.admitted);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Could not send the path.";
      setError(message);
      Alert.alert("Error", message);
    } finally {
      setBusy(false);
      setStep(null);
      sendInFlightRef.current = false;
      onEndPathExclusive?.("send");
    }
  };

  return (
    <View style={{ gap: 10 }}>
      {/* Compact status — only when something needs attention or send is running */}
      {(busy || error || startBlocked || staged) && (
        <Text
          style={{
            color: error || startBlocked
              ? FIELDS_COLORS.danger
              : staged
                ? FIELDS_COLORS.success
                : FIELDS_COLORS.textMuted,
            fontSize: 11,
            lineHeight: 15,
          }}
          numberOfLines={2}
        >
          {busy
            ? stepLabel ?? "Working…"
            : error
              ? error
              : startBlocked
                ? "Start blocked"
                : staged
                  ? `Sent · ${metres(staged.markLengthM)}`
                  : ""}
        </Text>
      )}

      {/* Single ack when needed - show what is being acknowledged (e.g. the assumed DXF unit scale). */}
      {readiness.needsAck.length > 0 && !busy ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
            {readiness.needsAck.slice(0, 3).join("\n")}
          </Text>
          <TouchableOpacity
            onPress={() => {
              if (readiness.needsGeometryAck) setGeometryAcknowledged(true);
              if (readiness.needsParseAck) setParseAcknowledged(true);
            }}
            style={{
              height: 40,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: FIELDS_COLORS.warningMuted,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.warningBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.warning, fontSize: 12, fontWeight: "800" }}>
              Acknowledge
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <TouchableOpacity
        onPress={handleSendAppPlanned}
        disabled={disabled}
        activeOpacity={0.8}
        style={{
          height: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          backgroundColor: disabled ? FIELDS_COLORS.surfaceSolid : FIELDS_COLORS.accentBrand,
          borderWidth: 1,
          borderColor: disabled ? FIELDS_COLORS.panelBorder : FIELDS_COLORS.accentBorder,
        }}
      >
        {busy ? <ActivityIndicator size="small" color={FIELDS_COLORS.accentText} /> : null}
        <Text
          style={{
            color: disabled ? FIELDS_COLORS.textDim : FIELDS_COLORS.accentText,
            fontSize: 14,
            fontWeight: "800",
          }}
        >
          {busy
            ? (stepLabel ?? "Working…")
            : !apiBaseUrl
              ? "Connect rover"
              : paintedCount < 1
                ? "Paint a path"
                : readinessBlocksSend
                  ? "Send blocked"
                  : "Send"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
