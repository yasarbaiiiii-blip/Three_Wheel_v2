import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, TouchableOpacity, Text, View } from "react-native";
import { Check as CheckIcon, Loader } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import type {
  StagedPlanResultState,
  StagedWorkflowStatus,
  StagedWorkflowStep,
} from "../../../types/fieldsWorkflow";
import type { ImportedPlan, PlanLine } from "../../../types/plan";
import {
  formatFinite,
  getLineLengthM,
  groupExtensionLinesForList,
  isExtensionGroupSelected,
  isPrimaryEditableLine,
  normalizeEntityType,
  type SelectLineFn,
} from "../../../utils/pathWorkflow";
import { DraggableReorderList } from "../DraggableReorderList";
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
  onRefreshPaths,
  onSelectPath,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  protectedResident,
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

  // Filter to primary editable lines for reorder + spray
  const primaryLines = useMemo(() => lines.filter(isPrimaryEditableLine), [lines]);

  // Keep reordered list in sync
  useEffect(() => {
    setReorderedLines(primaryLines);
  }, [primaryLines]);

  // One row per unique (pre, aft) extension distance group. Multiple configs/plans
  // with different lengths (0.5 m vs 0.8 m) yield multiple Extension rows.
  const extensionGroups = useMemo(
    () => groupExtensionLinesForList(lines, extPre, extAft),
    [lines, extPre, extAft]
  );

  // One row per transit leg — individual entity like line/arc/circle (not grouped).
  // Geometry only regenerates on a full path refetch (Save/reload), not live while
  // dragging (ambient transit is force-hidden during this step in useFieldsWorkflow).
  const transitLines = useMemo(() => lines.filter((l) => l.layer === "transit"), [lines]);

  // Primary + transit: single-line select (clears any multi-highlight via atomic API).
  // Extension groups: multi-highlight every segment in that Pre/Aft group.
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
    // Also update parent lines
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
      // Build entity order from reordered lines
      const entityOrder = reorderedLines
        .filter((line) => line.entity?.entity_id)
        .map((line) => line.entity!.entity_id);

      // Build spray overrides
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
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Drag to reorder path segments. Check/uncheck to toggle spray. Tap a row to highlight it
        on the preview (Extension highlights the whole distance group).
      </Text>

      {/* Reorderable list with spray checkboxes */}
      <View
        style={{
          height: 320,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          overflow: "hidden",
        }}
      >
        <DraggableReorderList
          data={reorderedLines}
          onDragEnd={(next) => {
            onInvalidateWorkflow("spray");
            setReorderedLines(next);
          }}
          onPressItem={handleSelectPrimaryOrTransit}
          selectedRowId={selectedLineId}
          footer={
            (transitLines.length > 0 || extensionGroups.length > 0) && (
              <View style={{ gap: 8, padding: 10 }}>
                {transitLines.length > 0 && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10 }}>
                      Transit (reflects last-saved order)
                    </Text>
                    {transitLines.map((line, idx) => {
                      const lengthM = getLineLengthM(line);
                      const selected = line.id === selectedLineId && !(highlightLineIds && highlightLineIds.length > 0);
                      return (
                        <Pressable
                          key={line.id}
                          onPress={() => handleSelectPrimaryOrTransit(line)}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingHorizontal: 10,
                            paddingVertical: 10,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: selected ? FIELDS_COLORS.teal : FIELDS_COLORS.panelBorder,
                            backgroundColor: selected ? FIELDS_COLORS.accentMuted : "transparent",
                          }}
                        >
                          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "600" }}>
                            Transit {idx + 1}
                          </Text>
                          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
                            {lengthM != null ? `${formatFinite(lengthM, 2)} m` : "n/a"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                {extensionGroups.map((group, groupIndex) => {
                  const selected = isExtensionGroupSelected(group, selectedLineId, highlightLineIds);
                  const title =
                    extensionGroups.length > 1 ? `Extension ${groupIndex + 1}` : "Extension";
                  return (
                    <View
                      key={group.key}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        paddingHorizontal: 10,
                        paddingVertical: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: selected ? FIELDS_COLORS.teal : FIELDS_COLORS.panelBorder,
                        backgroundColor: selected ? FIELDS_COLORS.accentMuted : "transparent",
                      }}
                    >
                      <Pressable
                        onPress={() => handleSelectExtensionGroup(group.lineIds)}
                        style={{ flex: 1 }}
                      >
                        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "600" }}>
                          {title}
                        </Text>
                        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                          Pre {formatFinite(group.preM, 2)} m · Aft {formatFinite(group.aftM, 2)} m
                        </Text>
                      </Pressable>
                      <TouchableOpacity
                        onPress={onToggleExtensionVisible}
                        activeOpacity={0.7}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          borderWidth: 1.5,
                          borderColor: extensionVisible ? FIELDS_COLORS.teal : FIELDS_COLORS.textDim,
                          backgroundColor: extensionVisible ? FIELDS_COLORS.teal : "transparent",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {extensionVisible ? <CheckIcon size={14} color="#fff" /> : null}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )
          }
          renderExtraRight={(item) => {
            const entityType = normalizeEntityType(item.entity?.entity_type);
            const isSprayable =
              entityType === "line" || entityType === "arc" || entityType === "circle";

            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {/* Type badge */}
                <View
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: FIELDS_COLORS.surfaceSolid,
                    borderWidth: 1,
                    borderColor: FIELDS_COLORS.panelBorder,
                  }}
                >
                  <Text
                    style={{
                      color: FIELDS_COLORS.textDim,
                      fontSize: 9,
                      fontWeight: "700",
                      textTransform: "uppercase",
                    }}
                  >
                    {entityType || item.layer}
                  </Text>
                </View>

                {/* Spray checkbox */}
                {item.entity && isSprayable ? (
                  <TouchableOpacity
                    onPress={() => handleToggleSpray(item.id)}
                    activeOpacity={0.7}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      borderWidth: 1.5,
                      borderColor: item.entity.is_mark ? FIELDS_COLORS.teal : FIELDS_COLORS.textDim,
                      backgroundColor: item.entity.is_mark ? FIELDS_COLORS.teal : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {item.entity.is_mark ? <CheckIcon size={14} color="#fff" /> : null}
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          }}
        />
      </View>

      {/* Load to Controller */}
      <TouchableOpacity
        onPress={handleLoadToController}
        disabled={isLoading || missionActionBusy || !verifiedAlignmentRequest}
        activeOpacity={0.8}
        style={{
          height: 52,
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
