import React, { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";

import * as missionApi from "../api/missionApi";
import * as pathApi from "../api/pathApi";
import {
  getLoadedMissionId,
  isProtectedMissionResident,
} from "../api/missionContract";
import { PlacedItem } from "../components/BoundaryEditor";
import { FieldsAccordion } from "../components/fields/FieldsAccordion";
import { FieldsClearBar } from "../components/fields/FieldsClearBar";
import { FIELDS_COLORS } from "../components/fields/fieldsTheme";
import { AlignDxfPanel } from "../components/fields/panels/AlignDxfPanel";
import { PathOrderPanel } from "../components/fields/panels/PathOrderPanel";
import { PlanEditingPanel } from "../components/fields/panels/PlanEditingPanel";
import { PlanPreviewPanel } from "../components/fields/panels/PlanPreviewPanel";
import { PlanStagePanel } from "../components/fields/panels/PlanStagePanel";
import { SegmentVerificationPanel } from "../components/fields/panels/SegmentVerificationPanel";
import { SprayVerificationPanel } from "../components/fields/panels/SprayVerificationPanel";
import { TemplatePanel } from "../components/fields/panels/TemplatePanel";
import { UploadParsePanel } from "../components/fields/panels/UploadParsePanel";
import { useFieldsWorkflow } from "../hooks/useFieldsWorkflow";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
import type {
  AlignmentResultState,
  FieldsAccordionId,
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
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  previewRoverPoint: { north: number; east: number } | null;
  missionRunning: boolean;
  telemetrySnapshot: TelemetrySnapshot | null;
  selectedLineId: string | null;
  layerVisibility: LayerVisibility;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  onLoadSelectedPath: (missionId?: string) => void;
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
    selectedPoints?: { x: number; y: number }[];
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
};

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

const ACCORDION_DEFS: { id: FieldsAccordionId; title: string }[] = [
  { id: "upload", title: "Upload & Parse" },
  { id: "templates", title: "Templates" },
  { id: "planPreview", title: "Plan Preview" },
  { id: "planEditing", title: "Plan Editing" },
  { id: "pathOrder", title: "Path Order" },
  { id: "alignDxf", title: "Align DXF" },
  { id: "sprayVerify", title: "Spray Verification" },
  { id: "segmentVerify", title: "Segment Verification" },
  { id: "planStage", title: "Plan & Stage" },
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
    setLines,
    previewRoverPoint,
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
    renderPlanPreview,
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
  }, []);

  const {
    activeAccordion,
    setActiveAccordion,
    planPreviewConfirmed,
    setPlanPreviewConfirmed,
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
      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      setRefPoints((prev) => {
        const existingIdx = prev.findIndex(
          (point) => Math.abs(point.dxf_y - pt.x) < 0.001 && Math.abs(point.dxf_x - pt.y) < 0.001
        );
        if (existingIdx >= 0) {
          return prev.filter((_, index) => index !== existingIdx);
        }
        if (alignmentMethod === "single_point") {
          if (prev.length >= 1) {
            return [{ dxf_x: pt.y, dxf_y: pt.x, lat: prev[0].lat, lon: prev[0].lon }];
          }
          return [{ dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
        }
        if (prev.length >= 2) return prev;
        return [...prev, { dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
      });
    },
    [
      alignmentMethod,
      onInvalidateWorkflow,
      setAlignmentResult,
      setVerifiedAlignmentRequest,
    ]
  );

  const accordionStatus = (id: FieldsAccordionId) => {
    switch (id) {
      case "upload":
        return stagedWorkflow.upload;
      case "planPreview":
        return selectedPathName ? (planPreviewConfirmed ? "verified" : "pending") : "idle";
      case "pathOrder":
        return stagedWorkflow.order;
      case "alignDxf":
        return stagedWorkflow.alignment;
      case "sprayVerify":
        return stagedWorkflow.entities === "verified" ? "verified" : "pending";
      case "segmentVerify":
        return stagedWorkflow.spray;
      case "planStage":
        return stagedWorkflow.staged;
      default:
        return "idle";
    }
  };

  const toggleAccordion = (id: FieldsAccordionId) => {
    setActiveAccordion((current) => (current === id ? null : id));
  };

  const renderPanel = (id: FieldsAccordionId) => {
    switch (id) {
      case "upload":
        return (
          <UploadParsePanel
            apiBaseUrl={apiBaseUrl}
            importedPlan={importedPlan}
            setImportedPlan={setImportedPlan}
            onRefreshPaths={onRefreshPaths}
            onInvalidateWorkflow={onInvalidateWorkflow}
            blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
            protectedResident={protectedResident}
          />
        );
      case "templates":
        return (
          <TemplatePanel
            apiBaseUrl={apiBaseUrl}
            onRefreshPaths={onRefreshPaths}
            onSelectPath={onSelectPath}
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
        );
      case "planPreview":
        return (
          <PlanPreviewPanel
            apiBaseUrl={apiBaseUrl}
            backendPaths={backendPaths}
            selectedPathName={selectedPathName}
            onSelectPath={onSelectPath}
            loadedPathInspection={loadedPathInspection}
            setAlignmentResult={setAlignmentResult}
            setVerifiedAlignmentRequest={setVerifiedAlignmentRequest}
            setSegmentVerification={setSegmentVerification}
            setStagedPlanResult={setStagedPlanResult}
            setStagedMissionInspection={setStagedMissionInspection}
            setStagedMissionId={setStagedMissionId}
            setMissionSummary={setMissionSummary}
            onRefreshPaths={onRefreshPaths}
            blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
            onContinue={() => {
              setPlanPreviewConfirmed(true);
              setActiveAccordion("planEditing");
            }}
          />
        );
      case "planEditing":
        return (
          <PlanEditingPanel
            apiBaseUrl={apiBaseUrl}
            selectedPathName={selectedPathName}
            importedPlan={importedPlan}
            lines={lines}
            onSelectPath={onSelectPath}
            onInvalidateWorkflow={onInvalidateWorkflow}
            blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
            visualAlignmentItem={visualAlignmentItem}
            isPlanEditingMode={isPlanEditingMode}
            mapViewEnabled={mapViewEnabled}
            onStartPlanEditing={onStartPlanEditing}
            onStopPlanEditing={onStopPlanEditing}
          />
        );
      case "pathOrder":
        return (
          <PathOrderPanel
            apiBaseUrl={apiBaseUrl}
            selectedPathName={selectedPathName}
            importedPlan={importedPlan}
            lines={lines}
            onRefreshPaths={onRefreshPaths}
            onSelectPath={onSelectPath}
            onInvalidateWorkflow={onInvalidateWorkflow}
            blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
            protectedResident={protectedResident}
          />
        );
      case "alignDxf":
        return (
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
          />
        );
      case "sprayVerify":
        return (
          <SprayVerificationPanel
            apiBaseUrl={apiBaseUrl}
            selectedPathName={selectedPathName}
            importedPlan={importedPlan}
            lines={lines}
            setLines={setLines}
            selectedLineId={selectedLineId}
            onSelectLine={onSelectLine}
            onInvalidateWorkflow={onInvalidateWorkflow}
            blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
          />
        );
      case "segmentVerify":
        return (
          <SegmentVerificationPanel
            apiBaseUrl={apiBaseUrl}
            selectedPathName={selectedPathName}
            importedPlan={importedPlan}
            segmentVerification={segmentVerification}
            setSegmentVerification={setSegmentVerification}
            onWorkflowStep={onWorkflowStep}
            onInvalidateWorkflow={onInvalidateWorkflow}
          />
        );
      case "planStage":
        return (
          <PlanStagePanel
            apiBaseUrl={apiBaseUrl}
            selectedPathName={selectedPathName}
            stagedWorkflow={stagedWorkflow}
            verifiedAlignmentRequest={verifiedAlignmentRequest}
            stagedPlanResult={stagedPlanResult}
            setStagedPlanResult={setStagedPlanResult}
            stagedMissionInspection={stagedMissionInspection}
            setStagedMissionInspection={setStagedMissionInspection}
            stagedMissionId={stagedMissionId}
            setStagedMissionId={setStagedMissionId}
            loadedPathInspection={loadedPathInspection}
            onLoadSelectedPath={onLoadSelectedPath}
            missionActionBusy={missionActionBusy}
            onWorkflowStep={onWorkflowStep}
            onInvalidateWorkflow={onInvalidateWorkflow}
          />
        );
      default:
        return null;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: FIELDS_COLORS.bgBase }}>
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
          selectedPoints: activeAccordion === "alignDxf" ? refPoints.map((point) => ({ x: point.dxf_y, y: point.dxf_x })) : [],
          onSelectPoint: activeAccordion === "alignDxf" ? handleSelectPoint : undefined,
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
          boundaryMode,
          boundaryWidth: boundaryMode && activeBoundaryWidth ? activeBoundaryWidth : undefined,
          boundaryHeight: boundaryMode && activeBoundaryHeight ? activeBoundaryHeight : undefined,
          boundaryPosition: boundaryPosition ?? undefined,
          onMoveBoundary: (x: number, y: number) => setBoundaryPosition({ x, y }),
          boundaryRotation,
          onRotateBoundary: (rot: number) => setBoundaryRotation(rot),
          sketchMode,
          showBoundaryPoints: showSnapPoints,
        })}
      </View>

      <View
        style={{
          position: "absolute",
          right: 20,
          top: 20,
          bottom: 20,
          width: 380,
          maxWidth: "38%",
          backgroundColor: FIELDS_COLORS.panelSolid,
          borderRadius: 20,
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
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {ACCORDION_DEFS.map((accordion) => (
            <FieldsAccordion
              key={accordion.id}
              id={accordion.id}
              title={accordion.title}
              status={accordionStatus(accordion.id)}
              expanded={activeAccordion === accordion.id}
              onToggle={() => toggleAccordion(accordion.id)}
            >
              {renderPanel(accordion.id)}
            </FieldsAccordion>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}