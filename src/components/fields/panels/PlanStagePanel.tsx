import React, { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import * as pathApi from "../../../api/pathApi";
import * as missionApi from "../../../api/missionApi";
import {
  getLoadedMissionId,
  runningMissionMismatch,
} from "../../../api/missionContract";
import type {
  StagedPlanResultState,
  StagedWorkflowState,
  StagedWorkflowStatus,
} from "../../../types/fieldsWorkflow";
import {
  coerceFiniteNumber,
  formatFinite,
  formatSprayFlagSample,
  formatWaypointPair,
  parsePlanAndStageResponse,
} from "../../../utils/pathWorkflow";
import { FIELDS_COLORS } from "../fieldsTheme";

type PlanStagePanelProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  stagedWorkflow: StagedWorkflowState;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  stagedPlanResult: StagedPlanResultState | null;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  stagedMissionInspection: pathApi.StagedMissionResponse | null;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApi.StagedMissionResponse | null>>;
  stagedMissionId: string | null;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  onLoadSelectedPath: (missionId?: string) => void;
  missionActionBusy: boolean;
  onWorkflowStep?: (step: "staged", status: StagedWorkflowStatus) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
};

export function PlanStagePanel({
  apiBaseUrl,
  selectedPathName,
  stagedWorkflow,
  verifiedAlignmentRequest,
  stagedPlanResult,
  setStagedPlanResult,
  stagedMissionInspection,
  setStagedMissionInspection,
  stagedMissionId,
  setStagedMissionId,
  loadedPathInspection,
  onLoadSelectedPath,
  missionActionBusy,
  onWorkflowStep,
  onInvalidateWorkflow,
}: PlanStagePanelProps) {
  const [isPlanningAndStaging, setIsPlanningAndStaging] = useState(false);

  const canPlanAndStage =
    !!selectedPathName &&
    stagedWorkflow.alignment === "verified" &&
    stagedWorkflow.spray === "verified";
  const canLoadStagedMission = !!stagedMissionId && stagedWorkflow.staged === "verified";

  const handlePlanAndStage = async () => {
    if (!selectedPathName || !apiBaseUrl) {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      Alert.alert("Error", "No path selected to plan and stage.");
      return;
    }
    if (stagedWorkflow.alignment !== "verified" || stagedWorkflow.spray !== "verified") {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      Alert.alert(
        "Prerequisites Required",
        "Complete alignment and spray segment verification before final planning."
      );
      return;
    }
    if (!verifiedAlignmentRequest) {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      Alert.alert("Plan & Stage Failed", "Verified alignment inputs are missing. Re-run alignment before staging.");
      return;
    }

    const body: pathApi.PlanAndStageRequest = {
      source: selectedPathName,
      ...verifiedAlignmentRequest,
    };

    setIsPlanningAndStaging(true);
    onInvalidateWorkflow("staged");
    try {
      const planRes = await pathApi.planAndStage(apiBaseUrl, selectedPathName, body);
      if (!planRes.ok) {
        setStagedPlanResult(null);
        setStagedMissionInspection(null);
        setStagedMissionId(null);
        onWorkflowStep?.("staged", "failed");
        const errText = await planRes.text();
        Alert.alert("Plan & Stage Failed", errText || "Could not plan and stage mission.");
        return;
      }

      const planRaw = await planRes.json();
      const parsed = parsePlanAndStageResponse(planRaw);
      if (!parsed) {
        setStagedPlanResult(null);
        setStagedMissionInspection(null);
        setStagedMissionId(null);
        onWorkflowStep?.("staged", "failed");
        Alert.alert("Plan & Stage Failed", "Response did not include a staged mission_id.");
        return;
      }

      const { plan, missionId } = parsed;
      const summary = plan.mission_summary;
      setStagedMissionId(missionId);
      setStagedPlanResult({
        missionId,
        numWaypoints: coerceFiniteNumber(plan.num_waypoints ?? summary?.num_waypoints),
        numSegments: coerceFiniteNumber(plan.num_segments),
        totalLengthM: coerceFiniteNumber(plan.total_length_m ?? summary?.total_length_m),
        markLengthM: coerceFiniteNumber(plan.mark_length_m),
        transitLengthM: coerceFiniteNumber(plan.transit_length_m),
        estimatedPaintL: coerceFiniteNumber(summary?.estimated_paint_l),
        estimatedRuntimeS: coerceFiniteNumber(summary?.estimated_runtime_s),
        rmseM: coerceFiniteNumber(summary?.rmse_m),
        warnings: Array.isArray(plan.warnings) ? plan.warnings.map(String) : [],
      });

      const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
      if (!stagedRes.ok) {
        setStagedMissionInspection(null);
        setStagedMissionId(null);
        onWorkflowStep?.("staged", "failed");
        const errText = await stagedRes.text();
        Alert.alert("Staged Inspection Failed", errText || "Mission staged but inspection fetch failed.");
        return;
      }

      const stagedData = (await stagedRes.json()) as pathApi.StagedMissionResponse;
      setStagedMissionInspection(stagedData);
      setStagedMissionId(missionId);
      onWorkflowStep?.("staged", "verified");
      Alert.alert("Success", "Mission planned and staged successfully.");
    } catch (err) {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      console.log("Error planning and staging mission:", err);
      Alert.alert("Error", "Could not connect to the rover to plan and stage mission.");
    } finally {
      setIsPlanningAndStaging(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Run final planning after alignment and spray verification are complete.
      </Text>

      {!canPlanAndStage ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10, lineHeight: 15 }}>
          Requires verified alignment and spray segments
          {selectedPathName ? "" : " plus a selected path"}.
        </Text>
      ) : null}

      <Pressable
        onPress={handlePlanAndStage}
        disabled={isPlanningAndStaging || !canPlanAndStage}
        style={{
          height: 44,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isPlanningAndStaging || !canPlanAndStage ? FIELDS_COLORS.textDim : "#2563eb",
        }}
      >
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
          {isPlanningAndStaging ? "Planning..." : "Plan & Stage Mission"}
        </Text>
      </Pressable>

      {stagedPlanResult ? (
        <View
          style={{
            padding: 12,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            gap: 6,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontWeight: "800", fontSize: 13 }}>Staged Mission Summary</Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
            Mission ID: {stagedPlanResult.missionId}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
            Waypoints: {formatFinite(stagedPlanResult.numWaypoints, 0)} | Segments:{" "}
            {formatFinite(stagedPlanResult.numSegments, 0)}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
            Total: {formatFinite(stagedPlanResult.totalLengthM, 1)} m | Mark:{" "}
            {formatFinite(stagedPlanResult.markLengthM, 1)} m | Transit:{" "}
            {formatFinite(stagedPlanResult.transitLengthM, 1)} m
          </Text>
          {stagedMissionInspection ? (
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
              Waypoints sample: {formatWaypointPair(stagedMissionInspection.waypoints)}
            </Text>
          ) : null}
          {stagedPlanResult.warnings.length > 0 ? (
            <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10 }} numberOfLines={4}>
              Warnings: {stagedPlanResult.warnings.join("; ")}
            </Text>
          ) : null}
        </View>
      ) : null}

      {stagedPlanResult ? (
        <>
          {!canLoadStagedMission ? (
            <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10, lineHeight: 15 }}>
              Requires a verified staged mission before controller load.
            </Text>
          ) : null}
          <Pressable
            onPress={() => stagedMissionId && onLoadSelectedPath(stagedMissionId)}
            disabled={missionActionBusy || !canLoadStagedMission}
            style={{
              height: 44,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: missionActionBusy || !canLoadStagedMission ? FIELDS_COLORS.textDim : "#7c3aed",
            }}
          >
            <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
              {missionActionBusy ? "Loading..." : "Load Staged Mission to Controller"}
            </Text>
          </Pressable>
        </>
      ) : null}

      {loadedPathInspection?.loaded && stagedMissionId ? (
        <View
          style={{
            padding: 12,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            gap: 6,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontWeight: "800", fontSize: 13 }}>Controller Load Confirmed</Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
            Staged ID: {stagedMissionId}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
            Loaded ID: {getLoadedMissionId(loadedPathInspection) ?? "n/a"}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
            Running ID: {loadedPathInspection.running_mission_id ?? "n/a"}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
            Placement: {loadedPathInspection.placement_mode ?? "unknown"} |{" "}
            {loadedPathInspection.is_staged ? "staged" : "not staged"} |{" "}
            {loadedPathInspection.protected ? "protected" : "unprotected"}
          </Text>
          {runningMissionMismatch(getLoadedMissionId(loadedPathInspection), loadedPathInspection.running_mission_id) ? (
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 11, fontWeight: "800" }}>
              {runningMissionMismatch(getLoadedMissionId(loadedPathInspection), loadedPathInspection.running_mission_id)}
            </Text>
          ) : null}
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
            Path: {selectedPathName || loadedPathInspection.name || "n/a"}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={3}>
            Anchor: {stagedMissionInspection?.anchor ? JSON.stringify(stagedMissionInspection.anchor) : "n/a"}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
            Waypoints: {formatFinite(loadedPathInspection.num_waypoints, 0)}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }} numberOfLines={2}>
            Loaded sample: {formatWaypointPair(loadedPathInspection.sample_coords)}
            {loadedPathInspection.sample_truncated ? " (truncated)" : ""}
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
            Spray flags: {formatSprayFlagSample(loadedPathInspection)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}