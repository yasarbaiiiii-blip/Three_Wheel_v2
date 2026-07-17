import React, { useEffect, useMemo, useState } from "react";
import { Alert, TouchableOpacity, Text, View } from "react-native";
import { Loader } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import type {
  StagedPlanResultState,
  StagedWorkflowStatus,
  StagedWorkflowStep,
} from "../../../types/fieldsWorkflow";
import type { ImportedPlan, PlanLine } from "../../../types/plan";
import {
  buildPathOrderRows,
  groupExtensionLinesForList,
  isPrimaryEditableLine,
  type SelectLineFn,
} from "../../../utils/pathWorkflow";
import { PathOrderUnifiedList } from "../PathOrderUnifiedList";
import { FIELDS_COLORS } from "../fieldsTheme";

type PathOrderAndSprayStepProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onSelectLine: SelectLineFn;
  onRefreshPaths: () => void;
  onSelectPath: (name: string) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  protectedResident: boolean;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  setSegmentVerification: React.Dispatch<React.SetStateAction<pathApi.PathSegmentsResponse | null>>;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApi.StagedMissionResponse | null>>;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  onLoadSelectedPath: (missionId?: string) => boolean | Promise<boolean>;
  missionActionBusy: boolean;
  onNavigateHome: () => void;
  extensionVisible: boolean;
  onToggleExtensionVisible: () => void;
  /** Current multi-line highlight set (used to paint Extension group row selection). */
  highlightLineIds?: string[] | null;
  /** Global DXF extension config, reused from Step 1 so Extension rows show the same
   * pre/aft distance without a second fetch when per-entity preview lengths are missing. */
  extPre?: string;
  extAft?: string;
};

const LOAD_STEP_LABELS: Record<pathApi.LoadToControllerStep, string> = {
  saveOrder: "Saving path order...",
  saveSpray: "Saving spray settings...",
  verifySegments: "Verifying segments...",
  planAndStage: "Planning & staging mission...",
  getStagedMission: "Inspecting staged mission...",
  loadMission: "Loading to controller...",
};

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildStagedPlanResult(
  missionId: string,
  stagedPlanResult: any,
  segmentVerification?: pathApi.PathSegmentsResponse
): StagedPlanResultState {
  const summary = stagedPlanResult?.mission_summary ?? {};
  const alignmentMetadata = stagedPlanResult?.alignment_metadata ?? {};
  const warnings = Array.isArray(stagedPlanResult?.warnings)
    ? stagedPlanResult.warnings.filter((warning: unknown): warning is string => typeof warning === "string")
    : [];

  return {
    missionId,
    numWaypoints:
      nullableNumber(stagedPlanResult?.num_waypoints) ??
      nullableNumber(summary?.num_waypoints) ??
      nullableNumber(segmentVerification?.num_waypoints),
    numSegments:
      nullableNumber(stagedPlanResult?.num_segments) ??
      nullableNumber(segmentVerification?.num_segments),
    totalLengthM:
      nullableNumber(summary?.total_length_m) ??
      nullableNumber(segmentVerification?.total_length_m),
    markLengthM: nullableNumber(segmentVerification?.mark_length_m),
    transitLengthM: nullableNumber(segmentVerification?.transit_length_m),
    estimatedPaintL: nullableNumber(summary?.estimated_paint_l),
    estimatedRuntimeS: nullableNumber(summary?.estimated_runtime_s),
    rmseM: nullableNumber(summary?.rmse_m) ?? nullableNumber(alignmentMetadata?.rmse_m),
    warnings,
  };
}

export function PathOrderAndSprayStep({
  apiBaseUrl,
  selectedPathName,
  importedPlan,
  lines,
  setLines,
  selectedLineId,
  onSelectLine,
  onInvalidateWorkflow,
  verifiedAlignmentRequest,
  onWorkflowStep,
  setSegmentVerification,
  setStagedPlanResult,
  setStagedMissionInspection,
  setStagedMissionId,
  onLoadSelectedPath,
  missionActionBusy,
  onNavigateHome,
  extensionVisible,
  onToggleExtensionVisible,
  highlightLineIds = null,
  extPre,
  extAft,
}: PathOrderAndSprayStepProps) {
  const [reorderedLines, setReorderedLines] = useState<PlanLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadStep, setLoadStep] = useState<pathApi.LoadToControllerStep | null>(null);

  // Primary paths only — drag/reorder + spray
  const primaryLines = useMemo(() => lines.filter(isPrimaryEditableLine), [lines]);

  useEffect(() => {
    setReorderedLines(primaryLines);
  }, [primaryLines]);

  // One Extension row per unique (pre, aft) distance; 0.5 vs 0.2 → two rows.
  const extensionGroups = useMemo(
    () => groupExtensionLinesForList(lines, extPre, extAft),
    [lines, extPre, extAft]
  );

  // One row per transit leg (same list as paths; not a separate section).
  const transitLines = useMemo(() => lines.filter((l) => l.layer === "transit"), [lines]);

  // Flat list: primaries → all transits → extension group(s). No section headers.
  const pathOrderRows = useMemo(
    () => buildPathOrderRows(reorderedLines, transitLines, extensionGroups),
    [reorderedLines, transitLines, extensionGroups]
  );

  const handleSelectPrimaryOrTransit = (line: PlanLine) => {
    onSelectLine(line.id);
  };

  const handleSelectExtensionGroup = (lineIds: string[]) => {
    if (lineIds.length === 0) return;
    onSelectLine(lineIds[0], { highlightLineIds: lineIds });
  };

  const handleToggleSpray = (lineId: string) => {
    onInvalidateWorkflow("spray");
    const idx = reorderedLines.findIndex((l) => l.id === lineId);
    if (idx === -1) return;
    const next = [...reorderedLines];
    if (next[idx].entity) {
      next[idx] = {
        ...next[idx],
        entity: { ...next[idx].entity!, is_mark: !next[idx].entity!.is_mark },
      };
    }
    setReorderedLines(next);
    setLines((prev) => {
      const updated = [...prev];
      const parentIdx = updated.findIndex((l) => l.id === lineId);
      if (parentIdx !== -1 && updated[parentIdx].entity) {
        updated[parentIdx] = {
          ...updated[parentIdx],
          entity: { ...updated[parentIdx].entity!, is_mark: !updated[parentIdx].entity!.is_mark },
        };
      }
      return updated;
    });
  };

  const handleLoadToController = async () => {
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to load.");
      return;
    }
    const isDxfPath = targetPath?.toLowerCase().endsWith(".dxf");
    if (!verifiedAlignmentRequest && isDxfPath) {
      Alert.alert("Missing Alignment", "Please complete the alignment step before loading.");
      return;
    }

    setIsLoading(true);
    setLoadStep(null);

    try {
      const entityOrder = reorderedLines
        .filter((line) => line.entity?.entity_id)
        .map((line) => line.entity!.entity_id);

      const overridesMap = new Map<string, boolean>();
      reorderedLines
        .filter((line) => line.entity?.entity_id)
        .forEach((line) => {
          overridesMap.set(line.entity!.entity_id, !!line.entity!.is_mark);
        });
      const sprayOverrides = Array.from(overridesMap.entries()).map(([entity_id, is_mark]) => ({
        entity_id,
        is_mark,
      }));

      const result = await pathApi.loadToController(apiBaseUrl, targetPath, {
        entityOrder,
        sprayOverrides,
        alignmentRequest: verifiedAlignmentRequest || {},
        onStep: (step) => setLoadStep(step),
      });

      if (!result.success) {
        Alert.alert(
          "Load Failed",
          `Failed at step "${LOAD_STEP_LABELS[result.failedStep!]}"\n\n${result.error}`
        );
        return;
      }

      const missionId = result.missionId;
      if (!missionId) {
        Alert.alert("Load Failed", "Plan & stage succeeded, but no mission ID was returned.");
        return;
      }

      setSegmentVerification(result.segmentVerification ?? null);
      setStagedPlanResult(
        buildStagedPlanResult(missionId, result.stagedPlanResult, result.segmentVerification)
      );
      setStagedMissionInspection(result.stagedMissionInspection ?? null);
      setStagedMissionId(missionId);
      onWorkflowStep?.("order", "verified");
      onWorkflowStep?.("spray", "verified");
      onWorkflowStep?.("staged", "verified");
      onWorkflowStep?.("loaded", "pending");

      setLoadStep("loadMission");
      const loaded = await onLoadSelectedPath(missionId);
      if (!loaded) {
        return;
      }

      Alert.alert("Success", "Mission loaded to controller successfully.", [
        {
          text: "Go to Home",
          onPress: onNavigateHome,
        },
      ]);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to load to controller");
    } finally {
      setIsLoading(false);
      setLoadStep(null);
    }
  };

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        One list: paths, transit, and extension. Drag paths to reorder. Check paths to toggle spray.
        Tap a row to highlight it on the preview (Extension highlights its whole distance group).
      </Text>

      {/* Bounded flex shell so DraggableFlatList scrolls when rows exceed the viewport. */}
      <View
        style={{
          flex: 1,
          minHeight: 220,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          overflow: "hidden",
          backgroundColor: FIELDS_COLORS.cardSolid,
        }}
      >
        <PathOrderUnifiedList
          rows={pathOrderRows}
          onReorderPrimaries={(next) => {
            onInvalidateWorkflow("spray");
            setReorderedLines(next);
          }}
          onPressPrimary={handleSelectPrimaryOrTransit}
          onPressTransit={handleSelectPrimaryOrTransit}
          onPressExtension={handleSelectExtensionGroup}
          selectedLineId={selectedLineId}
          highlightLineIds={highlightLineIds}
          extensionVisible={extensionVisible}
          onToggleExtensionVisible={onToggleExtensionVisible}
          onToggleSpray={handleToggleSpray}
        />
      </View>

      <TouchableOpacity
        onPress={handleLoadToController}
        disabled={isLoading || missionActionBusy || !verifiedAlignmentRequest}
        activeOpacity={0.8}
        style={{
          height: 52,
          flexShrink: 0,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            isLoading || missionActionBusy || !verifiedAlignmentRequest
              ? FIELDS_COLORS.textDim
              : "#7c3aed",
          elevation: 4,
          shadowColor: "#7c3aed",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
        }}
      >
        {isLoading ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Loader size={16} color="#fff" />
            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>
              {loadStep ? LOAD_STEP_LABELS[loadStep] : "Loading..."}
            </Text>
          </View>
        ) : (
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "900", letterSpacing: 0.5 }}>
            Load to Controller
          </Text>
        )}
      </TouchableOpacity>

      {!verifiedAlignmentRequest && (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10, textAlign: "center" }}>
          Complete alignment before loading to controller.
        </Text>
      )}
    </View>
  );
}
