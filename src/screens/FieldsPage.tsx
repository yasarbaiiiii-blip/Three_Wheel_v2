import React, { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import * as missionApi from "../api/missionApi";
import * as pathApi from "../api/pathApi";
import {
  getLoadedMissionId,
  isProtectedMissionResident,
} from "../api/missionContract";
import { PlacedItem } from "../components/BoundaryEditor";
import { FieldsStepCard } from "../components/fields/FieldsStepCard";
import { FieldsClearBar } from "../components/fields/FieldsClearBar";
import { MapPlanInteractionOverlay } from "../components/fields/MapPlanInteractionOverlay";
import { FIELDS_COLORS } from "../components/fields/fieldsTheme";
import { AlignDxfPanel } from "../components/fields/panels/AlignDxfPanel";
import { BoundingBoxStep } from "../components/fields/panels/BoundingBoxStep";
import { PathOrderAndSprayStep } from "../components/fields/panels/PathOrderAndSprayStep";
import { TemplatePanel } from "../components/fields/panels/TemplatePanel";
import { UploadAndPreviewStep } from "../components/fields/panels/UploadAndPreviewStep";
import { useFieldsWorkflow } from "../hooks/useFieldsWorkflow";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
import type {
  AlignmentResultState,
  FieldsStepId,
  StagedPlanResultState,
  StagedWorkflowState,
  StagedWorkflowStatus,
  StagedWorkflowStep,
} from "../types/fieldsWorkflow";
import type { ImportedPlan, LayerVisibility, PlanLine, TelemetrySnapshot } from "../types/plan";

export type FieldsPageProps = {
  importedPlan: ImportedPlan | null;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  lines: PlanLine[];
  mapSourceLines?: PlanLine[];
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  autoOriginEnabled?: boolean;
  autoOrigin?: boolean;
  onToggleAutoOrigin?: () => void;
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  previewRoverPoint: { north: number; east: number } | null;
  missionRunning: boolean;
  telemetrySnapshot: TelemetrySnapshot | null;
  selectedLineId: string | null;
  layerVisibility: LayerVisibility;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  onLoadSelectedPath: (missionId?: string) => boolean | Promise<boolean>;
  missionActionBusy: boolean;
  onSelectLine: (id: string | null) => void;
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  stagedWorkflow: StagedWorkflowState;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApi.AlignPathRequest | null>>;
  segmentVerification: pathApi.PathSegmentsResponse | null;
  setSegmentVerification: React.Dispatch<React.SetStateAction<pathApi.PathSegmentsResponse | null>>;
  stagedPlanResult: StagedPlanResultState | null;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  stagedMissionInspection: pathApi.StagedMissionResponse | null;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApi.StagedMissionResponse | null>>;
  stagedMissionId: string | null;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  showRefPointLabels?: boolean;
  activeRefPointLabelIndex?: number | null;
  setActiveRefPointLabelIndex?: React.Dispatch<React.SetStateAction<number | null>>;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
  isPlanEditingMode?: boolean;
  onStartPlanEditing?: () => void;
  onStopPlanEditing?: () => void;
  extractedCorners?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[] | null;
  setExtractedCorners?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[] | null>>;
  onClearMission: () => Promise<void>;
  onNavigateHome?: () => void;
  renderPlanPreview: (props: {
    lines: PlanLine[];
    mapSourceLines?: PlanLine[];
    autoOriginReference?: AutoOriginReference | null;
    mapGeometryFrame?: MapGeometryFrame;
    autoOriginEnabled?: boolean;
    visibility: LayerVisibility;
    selectedLineId: string | null;
    onSelectLine?: (id: string | null) => void;
    roverPosN?: number | null;
    roverPosE?: number | null;
    roverHeadingDeg?: number | null;
    selectedPoints?: { x: number; y: number; lat?: number; lon?: number }[];
    onSelectPoint?: (pt: { x: number; y: number }) => void;
    alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
    stagedVerified?: boolean;
    mapViewEnabled?: boolean;
    showRefPointLabels?: boolean;
    activeRefPointLabelIndex?: number | null;
    onToggleRefPointLabel?: React.Dispatch<React.SetStateAction<number | null>>;
    isVisualAlignmentMode?: boolean;
    isPlanEditingMode?: boolean;
    visualAlignmentItem?: PlacedItem | null;
    setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
    boundaryMode?: boolean;
    boundaryWidth?: number;
    boundaryHeight?: number;
    boundaryPosition?: { x: number; y: number };
    onMoveBoundary?: (x: number, y: number) => void;
    boundaryRotation?: number;
    onRotateBoundary?: (rotation: number) => void;
    sketchMode?: boolean;
    showBoundaryPoints?: boolean;
  }) => React.ReactNode;
  gpsPointMission?: pathApi.ParsePointGpsCsvResponse | null;
  onGpsPointMissionParsed?: (data: pathApi.ParsePointGpsCsvResponse) => void;
  onStageAndLoadGpsPointMission?: () => Promise<void>;
};

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

const STEP_DEFS: { id: FieldsStepId; title: string; stepNumber: number }[] = [
  { id: "boundingBox", title: "Bounding Box", stepNumber: 1 },
  { id: "upload", title: "Upload & Parse", stepNumber: 2 },
  { id: "align", title: "Align DXF", stepNumber: 3 },
  { id: "orderAndSpray", title: "Path Order & Load", stepNumber: 4 },
];

export function FieldsPage(props: FieldsPageProps) {
  const {
    importedPlan,
    setImportedPlan,
    lines,
    mapSourceLines,
    autoOriginReference = null,
    mapGeometryFrame = "NONE",
    autoOriginEnabled = false,
    autoOrigin = false,
    onToggleAutoOrigin,
    setLines,
    previewRoverPoint,
    missionRunning,
    telemetrySnapshot,
    selectedLineId,
    layerVisibility,
    backendPaths,
    selectedPathName,
    onSelectPath,
    onLoadSelectedPath,
    missionActionBusy,
    onSelectLine,
    apiBaseUrl,
    onRefreshPaths,
    onWorkflowStep,
    stagedWorkflow,
    alignmentResult,
    setAlignmentResult,
    verifiedAlignmentRequest,
    setVerifiedAlignmentRequest,
    segmentVerification,
    setSegmentVerification,
    stagedPlanResult,
    setStagedPlanResult,
    stagedMissionInspection,
    setStagedMissionInspection,
    stagedMissionId,
    setStagedMissionId,
    loadedPathInspection,
    onInvalidateWorkflow,
    alignedRefPoints = [],
    setAlignedRefPoints,
    mapViewEnabled = false,
    showRefPointLabels = false,
    activeRefPointLabelIndex = null,
    setActiveRefPointLabelIndex,
    isVisualAlignmentMode,
    visualAlignmentItem,
    setVisualAlignmentItem,
    onStartVisualAlignment,
    onConfirmVisualAlignment,
    isPlanEditingMode,
    onStartPlanEditing,
    onStopPlanEditing,
    extractedCorners,
    setExtractedCorners,
    onClearMission,
    onNavigateHome,
    renderPlanPreview,
    gpsPointMission = null,
    onGpsPointMissionParsed,
    onStageAndLoadGpsPointMission,
  } = props;

  const [refPoints, setRefPoints] = useState<RefPoint[]>([]);
  const [missionSummary, setMissionSummary] = useState<any | null>(null);
  const [alignmentMethod, setAlignmentMethod] = useState<"least_squares" | "single_point" | "visual_alignment">("least_squares");

  const [boundaryMode, setBoundaryMode] = useState(false);
  const [boundaryWidthStr, setBoundaryWidthStr] = useState("4.0");
  const [boundaryHeightStr, setBoundaryHeightStr] = useState("3.0");
  const [activeBoundaryWidth, setActiveBoundaryWidth] = useState<number | null>(null);
  const [activeBoundaryHeight, setActiveBoundaryHeight] = useState<number | null>(null);
  const [sketchMode, setSketchMode] = useState(false);
  const [showSnapPoints, setShowSnapPoints] = useState(true);
  const [boundaryPosition, setBoundaryPosition] = useState<{ x: number; y: number } | null>(null);
  const [boundaryRotation, setBoundaryRotation] = useState<number>(0);

  const handleToggleBoundaryMode = useCallback((enabled: boolean) => {
    setBoundaryMode(enabled);
    if (!enabled) {
      setActiveBoundaryWidth(null);
      setActiveBoundaryHeight(null);
      setBoundaryRotation(0);
    }
  }, []);

  const handleApplyBoundary = useCallback((w: number, h: number) => {
    setActiveBoundaryWidth(w);
    setActiveBoundaryHeight(h);
    setLines((prev) => {
      const nonVirtual = prev.filter((l) => l.layer !== "virtual_boundary");
      const bMinN = -h / 2;
      const bMaxN = h / 2;
      const bMinE = -w / 2;
      const bMaxE = w / 2;
      const corners = [
        { n: bMinN, e: bMinE }, // 0: Bottom-Left
        { n: bMinN, e: bMaxE }, // 1: Bottom-Right
        { n: bMaxN, e: bMaxE }, // 2: Top-Right
        { n: bMaxN, e: bMinE }, // 3: Top-Left
      ];
      const virtualLines: any[] = [];
      for (let i = 0; i < 4; i++) {
        const from = corners[i];
        const to = corners[(i + 1) % 4];
        virtualLines.push({
          id: `vbox-edge-${i}`,
          label: `Virtual Box Edge ${i + 1}`,
          layer: "virtual_boundary",
          from: { id: 800000 + i * 2, x: from.n, y: from.e },
          to: { id: 800000 + i * 2 + 1, x: to.n, y: to.e },
          width: 0.1,
        });
      }
      return [...nonVirtual, ...virtualLines];
    });
  }, [setLines]);

  const {
    activeStep,
    setActiveStep,
    isTransformConfirmed,
    setIsTransformConfirmed,
    isAlignmentComplete,
    setIsAlignmentComplete,
    manipulationMode,
    setManipulationMode,
    transformData,
    setTransformData,
    showMapInteraction,
    setShowMapInteraction,
    resetTransform,
    effectiveLayerVisibility,
  } = useFieldsWorkflow(layerVisibility);

  const protectedResident = isProtectedMissionResident(loadedPathInspection);

  const blockProtectedWorkflowMutation = useCallback(
    (action: string) => {
      if (!protectedResident) return false;
      Alert.alert(
        "Mission conflict",
        `${action} is blocked while protected mission ${getLoadedMissionId(loadedPathInspection) ?? "<unknown>"} is resident.`
      );
      return true;
    },
    [loadedPathInspection, protectedResident]
  );

  const handleSelectPoint = useCallback(
    (pt: { x: number; y: number }) => {
      console.log(`[AlignDXF][Tap] Map tapped: pt.x(north)=${pt.x} pt.y(east)=${pt.y} method=${alignmentMethod}`);
      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      setRefPoints((prev) => {
        const existingIdx = prev.findIndex(
          (point) => Math.abs(point.dxf_y - pt.x) < 0.001 && Math.abs(point.dxf_x - pt.y) < 0.001
        );
        if (existingIdx >= 0) {
          console.log(`[AlignDXF][Tap] Deselecting existing point at index ${existingIdx}`);
          return prev.filter((_, index) => index !== existingIdx);
        }
        if (alignmentMethod === "single_point") {
          const next =
            prev.length >= 1
              ? [{ dxf_x: pt.y, dxf_y: pt.x, lat: prev[0].lat, lon: prev[0].lon }]
              : [{ dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
          console.log("[AlignDXF][Tap] single_point refPoints ->", JSON.stringify(next));
          return next;
        }
        // least_squares: no cap — any number of reference points can be tapped.
        const next = [...prev, { dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
        console.log("[AlignDXF][Tap] least_squares refPoints ->", JSON.stringify(next));
        return next;
      });
    },
    [
      alignmentMethod,
      onInvalidateWorkflow,
      setAlignmentResult,
      setVerifiedAlignmentRequest,
    ]
  );

  // Determine step statuses
  const hasPath = !!selectedPathName || !!importedPlan;
  const uploadDone = hasPath;
  const isDxfPath = importedPlan?.fileType === "dxf" || selectedPathName?.toLowerCase().endsWith(".dxf");
  const alignDone = !isDxfPath || stagedWorkflow.alignment === "verified" || !!verifiedAlignmentRequest || autoOrigin;
  const isGpsPointFlow = gpsPointMission != null;

  const stepStatus = (id: FieldsStepId): "pending" | "active" | "done" => {
    switch (id) {
      case "boundingBox":
        return activeBoundaryWidth != null && activeBoundaryHeight != null
          ? "done"
          : activeStep === "boundingBox"
          ? "active"
          : "pending";
      case "upload":
        return uploadDone ? "done" : activeStep === "upload" ? "active" : "pending";
      case "align":
        return alignDone ? "done" : activeStep === "align" ? "active" : "pending";
      case "orderAndSpray":
        return stagedWorkflow.staged === "verified"
          ? "done"
          : activeStep === "orderAndSpray"
          ? "active"
          : "pending";
      default:
        return "pending";
    }
  };

  const toggleStep = (id: FieldsStepId) => {
    setActiveStep(activeStep === id ? "boundingBox" : id);
  };

  // Confirm transform handler — bakes the plan's current drag/scale/rotate into `lines`
  // (so the view never resets — it locks in exactly where the user left it) and exits
  // plan-editing mode, restoring tap-to-pick-point on the align step's map. Any reference
  // points already set (tapped or CSV-imported) are moved by that SAME transform, so they
  // stay pinned to the same physical spot on the plan and remain valid for Fix Alignment.
  const handleConfirmTransform = useCallback(() => {
    if (refPoints.length > 0 && visualAlignmentItem) {
      const { x, y, rotation = 0, scale = 1 } = visualAlignmentItem;
      const rad = (rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // Mirrors the exact transform App.tsx's stopPlanEditing() applies to `lines`.
      const transformPt = (n: number, e: number) => ({
        n: n * scale * cos - e * scale * sin + y,
        e: e * scale * cos + n * scale * sin + x,
      });
      setRefPoints((prev) =>
        prev.map((point) => {
          const t = transformPt(point.dxf_y, point.dxf_x);
          return { ...point, dxf_y: t.n, dxf_x: t.e };
        })
      );
    }
    onStopPlanEditing?.();
    setIsTransformConfirmed(true);
    setShowMapInteraction(false);
    setManipulationMode("idle");
    setActiveStep("align");
  }, [
    refPoints.length,
    visualAlignmentItem,
    setRefPoints,
    onStopPlanEditing,
    setIsTransformConfirmed,
    setShowMapInteraction,
    setManipulationMode,
    setActiveStep,
  ]);

  // Lets the user re-enter plan editing (drag/scale/rotate) from the Align DXF step —
  // e.g. to eyeball the plan against already-placed reference points — then exit via the
  // same confirm path used right after upload.
  const handleToggleMovePlan = useCallback(() => {
    if (isPlanEditingMode) {
      if (alignmentMethod === "least_squares") {
        // Multi-Point Fit: the reference points are just a visual guide — the manual
        // drag/scale/rotate IS the alignment. Capture wherever the user placed it as the
        // final GPS-referenced corners (same mechanism the Visual method uses), instead of
        // just baking the transform into `lines` with no GPS computed.
        onConfirmVisualAlignment?.();
        setShowMapInteraction(false);
        setManipulationMode("idle");
        return;
      }
      handleConfirmTransform();
      return;
    }
    onStartPlanEditing?.();
    setShowMapInteraction(true);
    setManipulationMode("drag");
  }, [
    isPlanEditingMode,
    alignmentMethod,
    onConfirmVisualAlignment,
    handleConfirmTransform,
    onStartPlanEditing,
    setShowMapInteraction,
    setManipulationMode,
  ]);

  // Navigate home handler
  const handleNavigateHome = useCallback(() => {
    onNavigateHome?.();
  }, [onNavigateHome]);

  // Build mapLLA from visualAlignmentItem or telemetry
  const mapLLA = visualAlignmentItem
    ? { lat: telemetrySnapshot?.lat ?? 0, lon: telemetrySnapshot?.lon ?? 0 }
    : telemetrySnapshot?.lat != null && telemetrySnapshot?.lon != null
    ? { lat: telemetrySnapshot.lat, lon: telemetrySnapshot.lon }
    : null;

  // Compute transform HUD state from visualAlignmentItem
  const hasTransform = !!(
    visualAlignmentItem &&
    (Math.abs(visualAlignmentItem.x ?? 0) > 0.01 ||
      Math.abs(visualAlignmentItem.y ?? 0) > 0.01 ||
      Math.abs(visualAlignmentItem.rotation ?? 0) > 0.1 ||
      Math.abs((visualAlignmentItem.scale ?? 1) - 1) > 0.001)
  );

  return (
    <View style={{ flex: 1, backgroundColor: FIELDS_COLORS.bgBase }}>
      {/* Map preview — full screen background */}
      <View style={{ ...StyleSheet.absoluteFillObject, zIndex: 1, backgroundColor: FIELDS_COLORS.bgBase }}>
        {renderPlanPreview({
          lines,
          mapSourceLines,
          autoOriginReference,
          mapGeometryFrame,
          autoOriginEnabled,
          visibility: effectiveLayerVisibility,
          selectedLineId,
          onSelectLine,
          roverPosN: previewRoverPoint?.north ?? null,
          roverPosE: previewRoverPoint?.east ?? null,
          roverHeadingDeg: telemetrySnapshot?.heading_ned_deg ?? null,
          selectedPoints:
            activeStep === "align"
              ? refPoints.map((point) => {
                  const lat = parseFloat(point.lat);
                  const lon = parseFloat(point.lon);
                  return {
                    x: point.dxf_y,
                    y: point.dxf_x,
                    ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
                  };
                })
              : [],
          onSelectPoint: activeStep === "align" ? handleSelectPoint : undefined,
          alignedRefPoints,
          stagedVerified: stagedWorkflow.staged === "verified",
          mapViewEnabled,
          showRefPointLabels,
          activeRefPointLabelIndex,
          onToggleRefPointLabel: setActiveRefPointLabelIndex,
          isVisualAlignmentMode,
          isPlanEditingMode,
          visualAlignmentItem,
          setVisualAlignmentItem,
          boundaryMode: false,
          boundaryWidth: undefined,
          boundaryHeight: undefined,
          boundaryPosition: boundaryPosition ?? undefined,
          onMoveBoundary: (x: number, y: number) => setBoundaryPosition({ x, y }),
          boundaryRotation,
          onRotateBoundary: (rot: number) => setBoundaryRotation(rot),
          sketchMode,
          showBoundaryPoints: showSnapPoints,
        })}
      </View>

      {/* Map interaction overlay (floating icons on plan) */}
      <MapPlanInteractionOverlay
        visible={showMapInteraction && hasPath}
        manipulationMode={manipulationMode}
        onSetMode={setManipulationMode}
        transformData={{
          scaleMultiplier: visualAlignmentItem?.scale ?? 1,
          boundingWidthM: 0, // TODO: compute from plan bounds
          boundingHeightM: 0,
          rotationDeg: visualAlignmentItem?.rotation ?? 0,
          offsetMeters: {
            x: visualAlignmentItem?.x ?? 0,
            y: visualAlignmentItem?.y ?? 0,
          },
        }}
        onTransformChange={() => {}}
        onConfirm={handleConfirmTransform}
        hasTransform={hasTransform}
      />

      {/* Side panel */}
      <View
        style={{
          position: "absolute",
          right: 16,
          top: 16,
          bottom: 16,
          width: 360,
          maxWidth: "36%",
          backgroundColor: FIELDS_COLORS.panelSolid,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          overflow: "hidden",
          elevation: 10,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.4,
          shadowRadius: 16,
          zIndex: 10,
        }}
      >
        <FieldsClearBar onClear={onClearMission} busy={missionActionBusy} />
        <View style={{ flex: 1, padding: 12, gap: 10, paddingBottom: 24 }}>
          {/* Step 1: Bounding Box */}
          <FieldsStepCard
            stepNumber={1}
            title="Bounding Box"
            status={stepStatus("boundingBox")}
            expanded={activeStep === "boundingBox"}
            onToggle={() => toggleStep("boundingBox")}
          >
            <BoundingBoxStep
              widthStr={boundaryWidthStr}
              onChangeWidthStr={setBoundaryWidthStr}
              heightStr={boundaryHeightStr}
              onChangeHeightStr={setBoundaryHeightStr}
              onApplyBoundary={handleApplyBoundary}
              activeWidth={activeBoundaryWidth}
              activeHeight={activeBoundaryHeight}
              onProceedToUpload={() => setActiveStep("upload")}
            />
          </FieldsStepCard>

          {/* Step 2: Upload & Parse */}
          <FieldsStepCard
            stepNumber={2}
            title="Upload & Parse"
            status={stepStatus("upload")}
            expanded={activeStep === "upload"}
            onToggle={() => toggleStep("upload")}
          >
            <UploadAndPreviewStep
              apiBaseUrl={apiBaseUrl}
              importedPlan={importedPlan}
              setImportedPlan={setImportedPlan}
              onRefreshPaths={onRefreshPaths}
              onSelectPath={(name, skipAdvance) => {
                onSelectPath(name);
                // Auto-enable map interaction when path is loaded
                setShowMapInteraction(true);
                if (isPlanEditingMode !== true) {
                  onStartPlanEditing?.();
                }
                if (!skipAdvance) {
                  setActiveStep("align");
                }
              }}
              onInvalidateWorkflow={onInvalidateWorkflow}
              blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
              protectedResident={protectedResident}
              onGpsPointMissionParsed={onGpsPointMissionParsed}
              renderTemplates={() => (
                <TemplatePanel
                  apiBaseUrl={apiBaseUrl}
                  onRefreshPaths={onRefreshPaths}
                  onSelectPath={(name) => {
                    onSelectPath(name);
                    setShowMapInteraction(true);
                    if (isPlanEditingMode !== true) {
                      onStartPlanEditing?.();
                    }
                    setActiveStep("align");
                  }}
                  boundaryMode={boundaryMode}
                  onToggleBoundaryMode={handleToggleBoundaryMode}
                  boundaryWidthStr={boundaryWidthStr}
                  onChangeBoundaryWidthStr={setBoundaryWidthStr}
                  boundaryHeightStr={boundaryHeightStr}
                  onChangeBoundaryHeightStr={setBoundaryHeightStr}
                  onApplyBoundary={handleApplyBoundary}
                  sketchMode={sketchMode}
                  onToggleSketchMode={setSketchMode}
                  showSnapPoints={showSnapPoints}
                  onToggleShowSnapPoints={setShowSnapPoints}
                  telemetryPosN={telemetrySnapshot?.pos_n ?? null}
                  telemetryPosE={telemetrySnapshot?.pos_e ?? null}
                />
              )}
            />
          </FieldsStepCard>

          {/* Step 3: Align DXF — visible after plan is loaded, hidden for GPS point flow and non-DXF files */}
          {!isGpsPointFlow && isDxfPath && (
          <FieldsStepCard
            stepNumber={3}
            title="Align DXF"
            status={stepStatus("align")}
            expanded={activeStep === "align"}
            onToggle={() => toggleStep("align")}
            disabled={!hasPath}
            scrollableBody
          >
            <AlignDxfPanel
              apiBaseUrl={apiBaseUrl}
              selectedPathName={selectedPathName}
              lines={lines}
              setLines={setLines}
              alignmentResult={alignmentResult}
              setAlignmentResult={setAlignmentResult}
              setVerifiedAlignmentRequest={setVerifiedAlignmentRequest}
              setAlignedRefPoints={setAlignedRefPoints}
              onWorkflowStep={onWorkflowStep}
              onInvalidateWorkflow={onInvalidateWorkflow}
              blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
              refPoints={refPoints}
              setRefPoints={setRefPoints}
              alignmentMethod={alignmentMethod}
              setAlignmentMethod={setAlignmentMethod}
              setMissionSummary={setMissionSummary}
              isVisualAlignmentMode={isVisualAlignmentMode}
              visualAlignmentItem={visualAlignmentItem}
              setVisualAlignmentItem={setVisualAlignmentItem}
              onStartVisualAlignment={onStartVisualAlignment}
              onConfirmVisualAlignment={onConfirmVisualAlignment}
              extractedCorners={extractedCorners}
              setExtractedCorners={setExtractedCorners}
              mapLLA={mapLLA}
              autoOrigin={autoOrigin}
              onToggleAutoOrigin={onToggleAutoOrigin}
              autoOriginReference={autoOriginReference}
              autoOriginEnabled={autoOriginEnabled}
              stagedVerified={stagedWorkflow.staged === "verified"}
              missionRunning={missionRunning}
              isPlanEditingMode={isPlanEditingMode}
              onToggleMovePlan={handleToggleMovePlan}
            />
          </FieldsStepCard>
          )}

          {/* Step 4: Path Order & Load — hidden for GPS point flow */}
          {!isGpsPointFlow && (
          <FieldsStepCard
            stepNumber={4}
            title="Path Order & Load"
            status={stepStatus("orderAndSpray")}
            expanded={activeStep === "orderAndSpray"}
            onToggle={() => toggleStep("orderAndSpray")}
            disabled={!hasPath}
          >
            <PathOrderAndSprayStep
              apiBaseUrl={apiBaseUrl}
              selectedPathName={selectedPathName}
              importedPlan={importedPlan}
              lines={lines}
              setLines={setLines}
              selectedLineId={selectedLineId}
              onSelectLine={onSelectLine}
              onRefreshPaths={onRefreshPaths}
              onSelectPath={onSelectPath}
              onInvalidateWorkflow={onInvalidateWorkflow}
              blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
              protectedResident={protectedResident}
              verifiedAlignmentRequest={verifiedAlignmentRequest}
              onWorkflowStep={onWorkflowStep}
              setSegmentVerification={setSegmentVerification}
              setStagedPlanResult={setStagedPlanResult}
              setStagedMissionInspection={setStagedMissionInspection}
              setStagedMissionId={setStagedMissionId}
              onLoadSelectedPath={onLoadSelectedPath}
              missionActionBusy={missionActionBusy}
              onNavigateHome={handleNavigateHome}
            />
          </FieldsStepCard>
          )}

          {/* GPS Point Mission — single Load to Controller action (replaces steps 3 & 4),
              mirrors the DXF flow: one press stages with the parsed CSV data, commits
              to the controller, and navigates Home. */}
          {isGpsPointFlow && (
            <FieldsStepCard
              stepNumber={3}
              title="Load to Controller"
              status={stagedWorkflow.loaded === "verified" ? "done" : "active"}
              expanded={true}
              onToggle={() => {}}
            >
              <View style={{ gap: 12 }}>
                <Text style={{ color: "#a1a1aa", fontSize: 12, lineHeight: 17 }}>
                  GPS Point Mission detected ({gpsPointMission.num_points} points).{"\n"}
                  Anchor: {gpsPointMission.anchor.lat.toFixed(6)}, {gpsPointMission.anchor.lon.toFixed(6)}{"\n"}
                  Alignment is auto-verified from the CSV anchor. Points are previewed on the map above.
                </Text>

                <Pressable
                  onPress={onStageAndLoadGpsPointMission}
                  disabled={missionActionBusy || stagedWorkflow.loaded === "verified"}
                  style={{
                    height: 44,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor:
                      stagedWorkflow.loaded === "verified"
                        ? "#22c55e"
                        : missionActionBusy
                        ? "#3f3f46"
                        : "#0ea5e9",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
                    {stagedWorkflow.loaded === "verified"
                      ? "✓ Loaded to Controller"
                      : missionActionBusy
                      ? stagedWorkflow.staged === "verified"
                        ? "Loading..."
                        : "Staging..."
                      : "Load to Controller"}
                  </Text>
                </Pressable>
              </View>
            </FieldsStepCard>
          )}
        </View>
      </View>
    </View>
  );
}
