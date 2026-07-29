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
import type { SelectLineFn } from "../../../utils/pathWorkflow";
import {
  applyCsvOrderToPlanLines,
  defaultPathOrder,
  selectMarkPlanLines,
  type CsvPathOrderEntry,
} from "../../../utils/csvPathOrder";
import {
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "../../../utils/csvExtensions";
import { CsvPathOrderStep } from "./CsvPathOrderStep";
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
  /** Georeferenced DXF: backend auto-places at its own WGS84 origin, so loading is
   * allowed without a manual alignment request. */
  isGeographicDxf?: boolean;
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
  /** Global DXF extension config from Upload / entities. */
  extPre?: string;
  extAft?: string;
  /** When true, client builds purple PRE/AFT geometry into `lines` (CSV parity). */
  extensionsEnabled?: boolean;
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
  onInvalidateWorkflow,
  verifiedAlignmentRequest,
  isGeographicDxf = false,
  onWorkflowStep,
  setSegmentVerification,
  setStagedPlanResult,
  setStagedMissionInspection,
  setStagedMissionId,
  onLoadSelectedPath,
  missionActionBusy,
  onNavigateHome,
  extPre,
  extAft,
  extensionsEnabled = false,
}: PathOrderAndSprayStepProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadStep, setLoadStep] = useState<pathApi.LoadToControllerStep | null>(null);
  /** Operator path order + paint (CSV-parity list). */
  const [pathOrder, setPathOrder] = useState<CsvPathOrderEntry[] | null>(null);

  const extensionConfig: CsvExtensionConfig = useMemo(
    () =>
      normalizeCsvExtensionConfig({
        enabled: extensionsEnabled,
        preM: Number(extPre) || 0.5,
        aftM: Number(extAft) || 0.5,
        // Always chain free-ends (matches rover path_entities with per_line=false).
        perLine: false,
      }),
    [extensionsEnabled, extPre, extAft]
  );

  const markLines = useMemo(() => selectMarkPlanLines(lines), [lines]);

  const markKey = useMemo(
    () =>
      markLines
        .map((l) => l.id)
        .slice()
        .sort()
        .join("|"),
    [markLines]
  );

  // Seed order when mark ids appear / change.
  useEffect(() => {
    setPathOrder((prev) => {
      if (markLines.length === 0) return prev;
      if (!prev || prev.length === 0) return defaultPathOrder(markLines);
      const byId = new Map(prev.map((e) => [e.lineId, e]));
      const markIds = new Set(markLines.map((l) => l.id));
      const next: CsvPathOrderEntry[] = [];
      for (const e of prev) {
        if (!markIds.has(e.lineId)) continue;
        const line = markLines.find((l) => l.id === e.lineId);
        next.push(line ? { ...e, label: line.label } : e);
      }
      for (const line of markLines) {
        if (!byId.has(line.id)) {
          next.push({ lineId: line.id, label: line.label, paint: true });
        }
      }
      if (
        prev &&
        next.length === prev.length &&
        next.every(
          (e, i) =>
            e.lineId === prev[i]?.lineId &&
            e.paint === prev[i]?.paint &&
            e.label === prev[i]?.label
        )
      ) {
        return prev;
      }
      return next;
    });
  }, [markKey, markLines]);

  // When Upload toggles extension config, rebuild purple PRE/AFT + transit.
  // Bail out when topology is unchanged to avoid render loops.
  useEffect(() => {
    if (markLines.length === 0) return;
    const order = pathOrder ?? defaultPathOrder(markLines);
    setLines((prev) => {
      const next = applyCsvOrderToPlanLines(prev, order, extensionConfig);
      const prevSig = prev.map((l) => `${l.id}:${l.layer}`).join("|");
      const nextSig = next.map((l) => `${l.id}:${l.layer}`).join("|");
      return prevSig === nextSig ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionConfig.enabled, extensionConfig.preM, extensionConfig.aftM, extensionConfig.perLine]);

  const handleLoadToController = async () => {
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to load.");
      return;
    }
    const isDxfPath = targetPath?.toLowerCase().endsWith(".dxf");
    if (!verifiedAlignmentRequest && !isGeographicDxf && isDxfPath) {
      Alert.alert("Missing Alignment", "Please complete the alignment step before loading.");
      return;
    }

    setIsLoading(true);
    setLoadStep(null);

    try {
      const order = pathOrder ?? defaultPathOrder(markLines);
      const orderedMarks = order
        .map((e) => markLines.find((l) => l.id === e.lineId))
        .filter((l): l is PlanLine => l != null);

      const entityOrder = orderedMarks
        .filter((line) => line.entity?.entity_id)
        .map((line) => line.entity!.entity_id);

      const sprayOverrides = orderedMarks
        .filter((line) => line.entity?.entity_id)
        .map((line) => {
          const entry = order.find((e) => e.lineId === line.id);
          const paint = entry?.paint !== false;
          return {
            entity_id: line.entity!.entity_id,
            is_mark: paint && line.entity?.is_mark !== false,
          };
        });

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
        Same layout as CSV: drag paths to reorder, Paint/Skip each path. Purple pre-ext / aft-ext
        and transit legs are built on device from path order.
      </Text>

      <CsvPathOrderStep
        lines={lines}
        extensionConfig={extensionConfig}
        onOrderChange={(_painted, fullOrder) => {
          onInvalidateWorkflow("spray");
          setPathOrder(fullOrder);
          setLines((prev) => {
            const next = applyCsvOrderToPlanLines(prev, fullOrder, extensionConfig);
            const prevSig = prev.map((l) => `${l.id}:${l.layer}`).join("|");
            const nextSig = next.map((l) => `${l.id}:${l.layer}`).join("|");
            return prevSig === nextSig ? prev : next;
          });
        }}
      />

      <TouchableOpacity
        onPress={handleLoadToController}
        disabled={isLoading || missionActionBusy || (!verifiedAlignmentRequest && !isGeographicDxf)}
        activeOpacity={0.8}
        style={{
          height: 52,
          flexShrink: 0,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            isLoading || missionActionBusy || (!verifiedAlignmentRequest && !isGeographicDxf)
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

      {!verifiedAlignmentRequest && isGeographicDxf && (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10, textAlign: "center" }}>
          Georeferenced DXF — no alignment needed.
        </Text>
      )}
      {!verifiedAlignmentRequest && !isGeographicDxf && (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10, textAlign: "center" }}>
          Complete alignment before loading to controller.
        </Text>
      )}
    </View>
  );
}
