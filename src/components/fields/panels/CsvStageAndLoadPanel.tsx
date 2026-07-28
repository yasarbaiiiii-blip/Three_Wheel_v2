import React, { useMemo, useState } from "react";
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
import {
  buildOrderedTrajectory,
  defaultPathOrder,
  selectMarkPlanLines,
  type CsvPathOrderEntry,
} from "../../../utils/csvPathOrder";
import { buildTrajectory } from "../../../utils/csvTrajectory";
import type { LocalPointCsvResult } from "../../../utils/localPointCsv";
import { sanitizePlanLines } from "../../../utils/pathWorkflow";
import { hydrateStagedMissionForMap } from "../../../utils/stagedMissionHydration";
import { buildSurveyCsvExport, type SurveyCsvExport } from "../../../utils/surveyCsvExport";
import { FIELDS_COLORS } from "../fieldsTheme";

type CsvStageAndLoadPanelProps = {
  apiBaseUrl: string;
  localCsvPreview: LocalPointCsvResult;
  /** Sampled map pins, purely to explain "map shows N of M pins" to the operator. */
  mapPinCount?: number | null;
  /** Current map plan lines (CSV marks + templates + preview transit). */
  lines?: PlanLine[];
  /** Operator order/paint from CsvPathOrderStep; defaults to all marks painted in list order. */
  pathOrder?: CsvPathOrderEntry[] | null;
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
 * CSV Send/Load panel.
 *
 * - `CSV_PLANNER === "rover"` (default): survey CSV upload → plan-and-stage (today).
 * - `CSV_PLANNER === "app"`: buildTrajectory → plan-trajectory → verify run_echo → load.
 */
export function CsvStageAndLoadPanel({
  apiBaseUrl,
  localCsvPreview,
  mapPinCount = null,
  lines = [],
  pathOrder = null,
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
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<CsvStageStep | "loadMission" | null>(null);
  const [staged, setStaged] = useState<{ missionId: string; plan: pathApi.PathPlanResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadBlocked, setLoadBlocked] = useState(false);

  const exported = useMemo(() => buildSurveyCsvExport(localCsvPreview), [localCsvPreview]);
  const useAppPlanner = CSV_PLANNER === "app";

  const markLines = useMemo(() => selectMarkPlanLines(lines), [lines]);
  const order = useMemo(
    () => pathOrder ?? defaultPathOrder(markLines),
    [pathOrder, markLines]
  );

  const groundTruthSource = useMemo(
    () =>
      localCsvPreview.points
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => ({
          north: p.north_m,
          east: p.east_m,
          lat: p.lat as number,
          lon: p.lon as number,
        })),
    [localCsvPreview.points]
  );

  const appTrajectory = useMemo(() => {
    if (!useAppPlanner) return null;
    return buildOrderedTrajectory(markLines, order, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      groundTruthSource,
    });
  }, [useAppPlanner, markLines, order, groundTruthSource]);

  const disabled =
    busy ||
    missionActionBusy ||
    !apiBaseUrl ||
    (useAppPlanner
      ? (appTrajectory?.runs.length ?? 0) < 1 ||
        (localCsvPreview.kind === "gps" && !localCsvPreview.anchor)
      : exported.numPoints < 2);

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
    allowLoad: boolean
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
    const hydrated = hydrateStagedMissionForMap(result.stagedInspection ?? null);
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
    if (!localCsvPreview.anchor) {
      const message =
        "App-planned trajectory requires GPS survey points with a lat/lon anchor (origin_gps).";
      setError(message);
      Alert.alert("Missing origin", message);
      return;
    }
    if (!appTrajectory || appTrajectory.paintedLines.length === 0) {
      Alert.alert("Empty trajectory", "No painted mark paths to send.");
      return;
    }

    setBusy(true);
    setError(null);
    setStep(null);
    setLoadBlocked(false);
    try {
      const built = buildTrajectory(appTrajectory.paintedLines, {
        markSpeedMs: 0.35,
        travelSpeedMs: 0.5,
        groundTruthSource,
      });

      const result = await planAndStageAppTrajectory(apiBaseUrl, {
        missionName: localCsvPreview.fileName.replace(/\.[^.]+$/, "") || "csv_mission",
        originGps: [localCsvPreview.anchor.lat, localCsvPreview.anchor.lon],
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
        result.echoVerification == null || result.echoVerification.ok
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

  const warnings = staged?.plan.warnings?.filter((w): w is string => typeof w === "string") ?? [];

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        {localCsvPreview.num_points} point{localCsvPreview.num_points === 1 ? "" : "s"} ·{" "}
        {exported.numPaths} path{exported.numPaths === 1 ? "" : "s"} ·{" "}
        {localCsvPreview.kind === "gps" ? "GPS survey" : "local NED metres"}
        {"\n"}
        Frame: {localCsvPreview.point_source_frame}
        {localCsvPreview.kind === "gps" && localCsvPreview.anchor
          ? `\nPreview anchor: ${localCsvPreview.anchor.lat.toFixed(6)}, ${localCsvPreview.anchor.lon.toFixed(6)}`
          : ""}
        {mapPinCount != null && mapPinCount < localCsvPreview.num_points
          ? `\nMap shows ${mapPinCount} pins (sampled) + full path line.`
          : ""}
        {useAppPlanner && appTrajectory
          ? `\nApp planner: ${appTrajectory.totals.markRunCount} mark / ${appTrajectory.totals.travelRunCount} travel · paint ${appTrajectory.totals.markLengthM.toFixed(1)} m · travel ${appTrajectory.totals.travelLengthM.toFixed(1)} m`
          : ""}
      </Text>

      <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 16 }}>
        {useAppPlanner
          ? "Sends the app-built trajectory (order, paint, travel legs) to the rover for densify & stage. Load is blocked if run_echo does not match."
          : `Sends as ${exported.fileName}. The rover plans the route — it may reorder or reverse paths and adds the transit legs between them — and the map is redrawn from that planned geometry before anything is loaded.`}
      </Text>

      {localCsvPreview.warnings.length > 0 ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
          {localCsvPreview.warnings.slice(0, 6).join("\n")}
          {localCsvPreview.warnings.length > 6
            ? `\n…+${localCsvPreview.warnings.length - 6} more`
            : ""}
        </Text>
      ) : null}

      {localCsvPreview.kind === "ned" ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
          {useAppPlanner
            ? 'No latitude/longitude in this file — app-planned trajectory needs origin_gps. Use a GPS survey CSV or set CSV_PLANNER to "rover".'
            : "No latitude/longitude in this file — the mission stages in the rover's local frame (LOCAL_NED) and is placed relative to where the rover stands, not at a surveyed ground position."}
        </Text>
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
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
          {busy
            ? (stepLabel ?? "Working…")
            : useAppPlanner
              ? "Plan Trajectory & Load"
              : "Send to Rover & Load"}
        </Text>
      </TouchableOpacity>

      {!apiBaseUrl ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11 }}>
          Connect to the rover to enable sending.
        </Text>
      ) : null}

      {loadBlocked ? (
        <Text style={{ color: FIELDS_COLORS.danger, fontSize: 11, lineHeight: 16 }}>
          Load blocked: densified run_echo did not match the trajectory we sent. Fix order/geometry
          and re-send.
        </Text>
      ) : null}

      {error ? (
        <Text style={{ color: FIELDS_COLORS.danger, fontSize: 11, lineHeight: 16 }}>{error}</Text>
      ) : null}

      {staged ? (
        <View
          style={{
            borderRadius: 10,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            padding: 10,
            gap: 4,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
            Staged {staged.missionId}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, lineHeight: 16 }}>
            {staged.plan.num_waypoints ?? "—"} waypoints · mark{" "}
            {metres(nullableNumber(staged.plan.mark_length_m))} · transit{" "}
            {metres(nullableNumber(staged.plan.transit_length_m))}
          </Text>
          {warnings.map((warning, i) => (
            <Text key={i} style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
              {warning}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
