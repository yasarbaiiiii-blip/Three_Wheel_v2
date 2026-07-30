import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, Text, TouchableOpacity, View } from "react-native";

import type * as pathApi from "../../../api/pathApi";
import { CSV_PLANNER } from "../../../config/featureFlags";
import type { StagedPlanResultState, StagedWorkflowStatus, StagedWorkflowStep } from "../../../types/fieldsWorkflow";
import type { PlanLine } from "../../../types/plan";
import {
  CSV_STAGE_STEP_LABELS,
  planAndStageAppTrajectory,
  uploadAndStageCsvMission,
  type CsvStageStep,
} from "../../../utils/csvMissionStaging";
import { evaluateCsvSendReadiness } from "../../../utils/csvGeometryReadiness";
import {
  buildOrderedTrajectory,
  defaultPathOrder,
  selectMarkPlanLines,
  type CsvPathOrderEntry,
} from "../../../utils/csvPathOrder";
import {
  buildCsvExtensionLines,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "../../../utils/csvExtensions";
import { buildTrajectory } from "../../../utils/csvTrajectory";
import type { LocalPointCsvResult } from "../../../utils/localPointCsv";
import { sanitizePlanLines } from "../../../utils/pathWorkflow";
import {
  hydrateStagedMissionForMap,
  isStagedHydrationLineId,
} from "../../../utils/stagedMissionHydration";
import { buildSurveyCsvExport, type SurveyCsvExport } from "../../../utils/surveyCsvExport";
import { FIELDS_COLORS } from "../fieldsTheme";

type CsvStageAndLoadPanelProps = {
  apiBaseUrl: string;
  /**
   * Which import owns this panel:
   * - `"csv"`: survey points → frontend fits lines → plan-trajectory (or rover upload)
   * - `"dxf"`: real DXF path geometry already in `lines` → plan-trajectory only
   */
  sourceKind?: "csv" | "dxf";
  /**
   * CSV local preview (required for CSV / rover-CSV path).
   * Not used when `sourceKind === "dxf"` (geometry lives in `lines`).
   */
  localCsvPreview?: LocalPointCsvResult | null;
  /** Sampled map pins, purely to explain "map shows N of M pins" to the operator. */
  mapPinCount?: number | null;
  /** Current map plan lines (CSV fitted marks / DXF entity paths + transit). */
  lines?: PlanLine[];
  /** Operator order/paint from CsvPathOrderStep; defaults to all marks painted in list order. */
  pathOrder?: CsvPathOrderEntry[] | null;
  /** Local PRE/AFT config for app-planned trajectory (spray-off travel runs). */
  extensionConfig?: CsvExtensionConfig | null;
  /**
   * Explicit origin for app-planned plan-trajectory (DXF alignment / geoOrigin).
   * When set, overrides CSV anchor.
   */
  originGps?: [number, number] | null;
  /** Mission name stem for plan-trajectory (defaults from CSV/DXF file name). */
  missionName?: string | null;
  /** Parse/import warnings for readiness (DXF local warnings). */
  parseWarnings?: string[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  onSelectLine: (id: string | null) => void;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApi.StagedMissionResponse | null>>;
  /** Map projection origin — must be set with staged geometry (never independently). */
  setAlignedRefPoints?: React.Dispatch<
    React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>
  >;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  /** App's staged-load commit: loads to the controller, verifies, re-hydrates, navigates. */
  onLoadSelectedPath: (missionId?: string) => boolean | Promise<boolean>;
  missionActionBusy: boolean;
};

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metres(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toFixed(1)} m`;
}

async function buildUploadFormData(exported: SurveyCsvExport): Promise<FormData> {
  const formData = new FormData();
  if (Platform.OS === "web") {
    formData.append("file", new Blob([exported.text], { type: "text/csv" }), exported.fileName);
    return formData;
  }
  const FileSystem = require("expo-file-system/legacy");
  const uri = `${FileSystem.cacheDirectory ?? ""}${exported.fileName}`;
  await FileSystem.writeAsStringAsync(uri, exported.text, { encoding: "utf8" });
  formData.append("file", { uri, name: exported.fileName, type: "text/csv" } as any);
  return formData;
}

/**
 * Verify & Load panel (Send to Rover) — status, block reason, Send.
 *
 * - CSV + `CSV_PLANNER === "rover"`: survey CSV upload → plan-and-stage → load.
 * - CSV + `CSV_PLANNER === "app"`: fit points → buildTrajectory → plan-trajectory.
 * - DXF (`sourceKind === "dxf"`): real file path geometry in `lines` → plan-trajectory.
 *   Never re-fits CAD entities; never uploads the DXF file on the app-planned path.
 */
export function CsvStageAndLoadPanel({
  apiBaseUrl,
  sourceKind,
  localCsvPreview = null,
  mapPinCount: _mapPinCount = null,
  lines = [],
  pathOrder = null,
  extensionConfig = null,
  originGps = null,
  missionName = null,
  parseWarnings = [],
  setLines,
  onSelectLine,
  setStagedMissionId,
  setStagedPlanResult,
  setStagedMissionInspection,
  setAlignedRefPoints,
  onWorkflowStep,
  onLoadSelectedPath,
  missionActionBusy,
}: CsvStageAndLoadPanelProps) {
  const extCfg = useMemo(
    () => normalizeCsvExtensionConfig(extensionConfig),
    [extensionConfig]
  );
  void _mapPinCount;
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<CsvStageStep | "loadMission" | null>(null);
  const [staged, setStaged] = useState<{ missionId: string; plan: pathApi.PathPlanResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadBlocked, setLoadBlocked] = useState(false);
  /** Operator accepted remaining non-paintable painted paths (they are still refused in buildTrajectory). */
  const [geometryAcknowledged, setGeometryAcknowledged] = useState(false);
  /** Operator confirmed critical parse-frame warnings. */
  const [parseAcknowledged, setParseAcknowledged] = useState(false);

  // Prefer explicit sourceKind; fall back to legacy heuristic for callers that omit it.
  const isDxfLocal =
    sourceKind === "dxf" ||
    (sourceKind == null && localCsvPreview == null && originGps != null);
  const exported = useMemo(
    () => (!isDxfLocal && localCsvPreview ? buildSurveyCsvExport(localCsvPreview) : null),
    [isDxfLocal, localCsvPreview]
  );
  // Local DXF always uses app planner (real path vertices); CSV follows CSV_PLANNER.
  const useAppPlanner = isDxfLocal || CSV_PLANNER === "app";

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

  const groundTruthSource = useMemo(
    () =>
      (localCsvPreview?.points ?? [])
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => ({
          north: p.north_m,
          east: p.east_m,
          lat: p.lat as number,
          lon: p.lon as number,
        })),
    [localCsvPreview?.points]
  );

  const readiness = useMemo(
    () =>
      evaluateCsvSendReadiness({
        lines,
        pathOrder: order,
        parseWarnings: combinedWarnings,
        geometryAcknowledged,
        parseAcknowledged,
        requireGpsAnchor: useAppPlanner,
        hasGpsAnchor: resolvedOriginGps != null,
        dxfOperatorOrderAuthoritative: isDxfLocal,
      }),
    [
      lines,
      order,
      combinedWarnings,
      geometryAcknowledged,
      parseAcknowledged,
      useAppPlanner,
      resolvedOriginGps,
      isDxfLocal,
    ]
  );

  const appTrajectory = useMemo(() => {
    if (!useAppPlanner) return null;
    return buildOrderedTrajectory(markLines, order, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      groundTruthSource,
      extensions: extCfg,
    });
  }, [useAppPlanner, markLines, order, groundTruthSource, extCfg]);

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
    (useAppPlanner
      ? (appTrajectory?.runs.length ?? 0) < 1 || resolvedOriginGps == null
      : !exported || exported.numPoints < 2 || paintedCount < 1);

  const stepLabel =
    step === "loadMission"
      ? "Loading to controller…"
      : step
        ? CSV_STAGE_STEP_LABELS[step]
        : null;

  const applyStagedSuccess = async (
    result: {
      missionId: string;
      plan: pathApi.PathPlanResponse;
      stagedInspection?: pathApi.StagedMissionResponse;
    },
    allowLoad: boolean,
    preSendExtensionLines: PlanLine[] = []
  ) => {
    const plan = result.plan;
    setStaged({ missionId: result.missionId, plan });
    setStagedMissionId(result.missionId);
    setStagedMissionInspection(result.stagedInspection ?? null);
    setStagedPlanResult({
      missionId: result.missionId,
      numWaypoints: nullableNumber(plan.num_waypoints),
      numSegments: nullableNumber(plan.num_segments),
      totalLengthM: nullableNumber(plan.total_length_m),
      markLengthM: nullableNumber(plan.mark_length_m),
      transitLengthM: nullableNumber(plan.transit_length_m),
      estimatedPaintL: nullableNumber(plan.mission_summary?.estimated_paint_l),
      estimatedRuntimeS: nullableNumber(plan.mission_summary?.estimated_runtime_s),
      rmseM: nullableNumber(plan.mission_summary?.rmse_m),
      warnings: Array.isArray(plan.warnings)
        ? plan.warnings.filter((w): w is string => typeof w === "string")
        : [],
    });
    onWorkflowStep?.("staged", "verified");
    onWorkflowStep?.("loaded", "pending");

    // Prefer stagedInspection (has anchor + waypoints). PathPlanResponse has no anchor —
    // hydrating lines from plan alone caused frame desync under numbered pins.
    // Extension catalog recovers pre/aft labels (artifact only has spray booleans).
    const hydrated = hydrateStagedMissionForMap(result.stagedInspection ?? null, {
      extensionLines: preSendExtensionLines,
    });
    if (hydrated) {
      setAlignedRefPoints?.(hydrated.alignedRefPoints);
      setLines(sanitizePlanLines(hydrated.lines));
      onSelectLine(hydrated.selectedLineId);
    }

    if (allowLoad) {
      setLoadBlocked(false);
      setStep("loadMission");
      await onLoadSelectedPath(result.missionId);
    }
  };

  const handleSendAppPlanned = async () => {
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
        ? "DXF trajectory requires a confirmed GPS origin (georeferenced file, or complete Align first)."
        : "App-planned trajectory requires GPS survey points with a lat/lon anchor (origin_gps).";
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
    // Re-send guard: after a successful send, applyStagedSuccess replaces the
    // map lines with the rover's densified staged waypoints. Sending THOSE
    // would re-plan rover output as survey geometry (every 5 cm waypoint
    // becomes a source vertex — field 2026-07-29 staged must_hit=122/123 and
    // scored the day's worst curve RMS). Require a fresh import instead.
    if (appTrajectory.paintedLines.some((l) => isStagedHydrationLineId(l.id))) {
      Alert.alert(
        "Already staged — re-import to send again",
        isDxfLocal
          ? "The map is showing the rover's staged mission (already densified), not the original DXF path. Re-import the DXF file, then send."
          : "The map is showing the rover's staged mission (already densified), not the original survey geometry. Re-import the CSV file, then send."
      );
      return;
    }

    setBusy(true);
    setError(null);
    setStep(null);
    setLoadBlocked(false);
    try {
      // CSV: paintedLines are frontend-fitted from survey points.
      // DXF: paintedLines are the real entity paths from parseLocalDxf (already baked
      // through Align when metric). buildTrajectory only packs vertices into mark/travel runs.
      const built = buildTrajectory(appTrajectory.paintedLines, {
        markSpeedMs: 0.35,
        travelSpeedMs: 0.5,
        groundTruthSource: isDxfLocal ? undefined : groundTruthSource,
        extensions: extCfg,
      });
      if (built.runs.length === 0) {
        const detail = built.warnings.slice(0, 3).join("\n") || "No mark runs produced.";
        setError(detail);
        Alert.alert("Empty trajectory", detail);
        return;
      }
      const preSendExtensions = buildCsvExtensionLines(appTrajectory.paintedLines, extCfg);

      const result = await planAndStageAppTrajectory(apiBaseUrl, {
        missionName: resolvedMissionName,
        originGps: resolvedOriginGps,
        runs: built.runs,
        groundTruth: built.groundTruth,
        onStep: setStep,
      });

      if (!result.success || !result.missionId || !result.plan) {
        const message = result.error || "Could not stage the trajectory.";
        setError(message);
        setLoadBlocked(result.failedStep === "verifyEcho");
        onWorkflowStep?.("staged", "failed");
        Alert.alert(
          result.failedStep === "verifyEcho" ? "Verification Failed — Load Blocked" : "Send Failed",
          `Failed at step "${CSV_STAGE_STEP_LABELS[result.failedStep ?? "planTrajectory"]}"\n\n${message}`
        );
        return;
      }

      await applyStagedSuccess(
        {
          missionId: result.missionId,
          plan: result.plan,
          stagedInspection: result.stagedInspection,
        },
        result.echoVerification == null || result.echoVerification.ok,
        preSendExtensions
      );
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Could not send the path.";
      setError(message);
      Alert.alert("Error", message);
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const handleSendRoverPlanned = async () => {
    if (!apiBaseUrl) {
      Alert.alert("Not connected", "Connect to the rover before sending the path.");
      return;
    }
    if (!exported) {
      Alert.alert("Error", "No survey CSV to upload.");
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
    setBusy(true);
    setError(null);
    setStep(null);
    setLoadBlocked(false);
    try {
      const formData = await buildUploadFormData(exported);
      const result = await uploadAndStageCsvMission(apiBaseUrl, exported, formData, {
        onStep: setStep,
      });

      if (!result.success || !result.missionId || !result.plan) {
        const message = result.error || "Could not stage the mission.";
        setError(message);
        onWorkflowStep?.("staged", "failed");
        Alert.alert(
          "Send Failed",
          `Failed at step "${CSV_STAGE_STEP_LABELS[result.failedStep ?? "upload"]}"\n\n${message}`
        );
        return;
      }

      await applyStagedSuccess(
        {
          missionId: result.missionId,
          plan: result.plan,
          stagedInspection: result.stagedInspection,
        },
        true
      );
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Could not send the path.";
      setError(message);
      Alert.alert("Error", message);
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const blockSummary = [
    ...readiness.hardBlocks,
    ...readiness.needsAck,
  ].slice(0, 2);

  return (
    <View style={{ gap: 10 }}>
      {/* Compact status — only when something needs attention or send is running */}
      {(busy || readinessBlocksSend || error || loadBlocked || staged) && (
        <Text
          style={{
            color: error || loadBlocked || readiness.hardBlocks.length > 0
              ? FIELDS_COLORS.danger
              : readinessBlocksSend
                ? FIELDS_COLORS.warning
                : staged
                  ? FIELDS_COLORS.success
                  : FIELDS_COLORS.textMuted,
            fontSize: 11,
            lineHeight: 15,
          }}
          numberOfLines={3}
        >
          {busy
            ? stepLabel ?? "Working…"
            : error
              ? error
              : loadBlocked
                ? "Load blocked — verify failed. Fix and re-send."
                : staged
                  ? `Loaded · mark ${metres(nullableNumber(staged.plan.mark_length_m))}`
                  : blockSummary[0] ?? "Resolve warnings to send"}
          {!busy && !error && !loadBlocked && !staged && blockSummary[1]
            ? `\n${blockSummary[1]}`
            : ""}
        </Text>
      )}

      {/* Single ack when needed */}
      {readiness.needsAck.length > 0 && !busy ? (
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
          <Text style={{ color: FIELDS_COLORS.warning, fontSize: 12, fontWeight: "700" }}>
            Acknowledge warnings to enable Send
          </Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity
        onPress={useAppPlanner ? handleSendAppPlanned : handleSendRoverPlanned}
        disabled={disabled}
        activeOpacity={0.8}
        style={{
          height: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          backgroundColor: disabled ? FIELDS_COLORS.textDim : "#7c3aed",
        }}
      >
        {busy ? <ActivityIndicator size="small" color="#fff" /> : null}
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
          {busy
            ? (stepLabel ?? "Working…")
            : !apiBaseUrl
              ? "Connect rover to send"
              : paintedCount < 1
                ? "Paint a path first"
                : readinessBlocksSend
                  ? "Send blocked"
                  : "Send to Rover"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
