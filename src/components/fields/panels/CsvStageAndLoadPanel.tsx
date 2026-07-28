import React, { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, Text, TouchableOpacity, View } from "react-native";
import { Check, Circle } from "lucide-react-native";

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

type VerifyPhase = "idle" | "plan" | "verify" | "load" | "done" | "failed";

function phaseFromStep(step: CsvStageStep | "loadMission" | null, busy: boolean, done: boolean): VerifyPhase {
  if (done) return "done";
  if (!busy || step == null) return "idle";
  if (step === "loadMission") return "load";
  if (step === "verifyEcho" || step === "inspect") return "verify";
  return "plan";
}

/**
 * CSV Verify & Load panel (Send to Rover).
 *
 * - `CSV_PLANNER === "rover"` (default): survey CSV upload → plan-and-stage → load.
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

  const paintedCount = useMemo(
    () => order.filter((e) => e.paint !== false && markLines.some((m) => m.id === e.lineId)).length,
    [order, markLines]
  );

  const disabled =
    busy ||
    missionActionBusy ||
    !apiBaseUrl ||
    (useAppPlanner
      ? (appTrajectory?.runs.length ?? 0) < 1 ||
        (localCsvPreview.kind === "gps" && !localCsvPreview.anchor)
      : exported.numPoints < 2 || paintedCount < 1);

  const stepLabel =
    step === "loadMission"
      ? "Loading to controller…"
      : step
        ? CSV_STAGE_STEP_LABELS[step]
        : null;

  const phase = phaseFromStep(step, busy, staged != null && !loadBlocked && !error);

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

  const verifySteps = useAppPlanner
    ? [
        { key: "plan", label: "Plan trajectory" },
        { key: "verify", label: "Verify run echo" },
        { key: "load", label: "Load to controller" },
      ]
    : [
        { key: "plan", label: "Upload & plan" },
        { key: "verify", label: "Stage mission" },
        { key: "load", label: "Load to controller" },
      ];

  const phaseRank: Record<VerifyPhase, number> = {
    idle: 0,
    plan: 1,
    verify: 2,
    load: 3,
    done: 4,
    failed: 0,
  };

  return (
    <View style={{ gap: 12 }}>
      <View
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          backgroundColor: FIELDS_COLORS.surfaceSolid,
          padding: 12,
          gap: 8,
        }}
      >
        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>
          Verify & Load
        </Text>
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, lineHeight: 16 }}>
          {localCsvPreview.num_points} pts · {exported.numPaths} path
          {exported.numPaths === 1 ? "" : "s"} · {paintedCount} painted ·{" "}
          {localCsvPreview.kind === "gps" ? "GPS survey" : "local NED"}
          {useAppPlanner && appTrajectory
            ? ` · paint ${appTrajectory.totals.markLengthM.toFixed(1)} m · transit ${appTrajectory.totals.travelLengthM.toFixed(1)} m`
            : ""}
        </Text>
        {mapPinCount != null && mapPinCount < localCsvPreview.num_points ? (
          <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10 }}>
            Map shows {mapPinCount} pins (sampled) + full path line.
          </Text>
        ) : null}

        {/* Verification checklist */}
        <View style={{ gap: 6, marginTop: 4 }}>
          {verifySteps.map((s, i) => {
            const rank = phaseRank[phase];
            const stepRank = i + 1;
            const done = rank > stepRank || phase === "done";
            const active = busy && rank === stepRank;
            return (
              <View
                key={s.key}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {done ? (
                  <Check size={14} color={FIELDS_COLORS.success} strokeWidth={3} />
                ) : active ? (
                  <ActivityIndicator size="small" color={FIELDS_COLORS.accentBrand} />
                ) : (
                  <Circle size={12} color={FIELDS_COLORS.textDim} strokeWidth={2} />
                )}
                <Text
                  style={{
                    color: done
                      ? FIELDS_COLORS.success
                      : active
                        ? FIELDS_COLORS.accentBrand
                        : FIELDS_COLORS.textDim,
                    fontSize: 12,
                    fontWeight: active || done ? "700" : "500",
                  }}
                >
                  {s.label}
                  {active && stepLabel ? ` — ${stepLabel}` : ""}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {localCsvPreview.warnings.length > 0 ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
          {localCsvPreview.warnings.slice(0, 4).join("\n")}
          {localCsvPreview.warnings.length > 4
            ? `\n…+${localCsvPreview.warnings.length - 4} more`
            : ""}
        </Text>
      ) : null}

      {localCsvPreview.kind === "ned" ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
          {useAppPlanner
            ? 'No latitude/longitude — app planner needs origin_gps. Use a GPS survey CSV or set CSV_PLANNER to "rover".'
            : "No latitude/longitude — mission stages in the rover's local frame (LOCAL_NED)."}
        </Text>
      ) : null}

      <TouchableOpacity
        onPress={useAppPlanner ? handleSendAppPlanned : handleSendRoverPlanned}
        disabled={disabled}
        activeOpacity={0.8}
        style={{
          height: 50,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          backgroundColor: disabled ? FIELDS_COLORS.textDim : "#7c3aed",
          elevation: 3,
          shadowColor: "#7c3aed",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.28,
          shadowRadius: 4,
        }}
      >
        {busy ? <ActivityIndicator size="small" color="#fff" /> : null}
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.2 }}>
          {busy
            ? (stepLabel ?? "Working…")
            : useAppPlanner
              ? "Verify Trajectory & Load"
              : "Verify & Load to Rover"}
        </Text>
      </TouchableOpacity>

      {!apiBaseUrl ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11 }}>
          Connect to the rover to enable verification and load.
        </Text>
      ) : paintedCount < 1 ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11 }}>
          Paint at least one path above before loading.
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
            borderColor: FIELDS_COLORS.successBorder,
            backgroundColor: FIELDS_COLORS.successMuted,
            padding: 10,
            gap: 4,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.success, fontSize: 12, fontWeight: "700" }}>
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
