import React, { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import * as missionApi from "../api/missionApi";
import * as pathApi from "../api/pathApi";
import {
  getLoadedMissionId,
  isProtectedMissionResident,
} from "../api/missionContract";
import { type PlacedItem } from "../components/BoundaryEditor";
import { FieldsStepCard } from "../components/fields/FieldsStepCard";
import { FieldsClearBar } from "../components/fields/FieldsClearBar";
import { MapPlanInteractionOverlay } from "../components/fields/MapPlanInteractionOverlay";
import { FIELDS_COLORS } from "../components/fields/fieldsTheme";
import { AlignDxfPanel } from "../components/fields/panels/AlignDxfPanel";
import { AnchorPanel } from "../components/fields/panels/AnchorPanel";
import { CsvPathOrderStep } from "../components/fields/panels/CsvPathOrderStep";
import { CsvStageAndLoadPanel } from "../components/fields/panels/CsvStageAndLoadPanel";
import { PathOrderAndSprayStep } from "../components/fields/panels/PathOrderAndSprayStep";
import { TemplatePanel } from "../components/fields/panels/TemplatePanel";
import { UploadAndPreviewStep } from "../components/fields/panels/UploadAndPreviewStep";
import { useFieldsWorkflow } from "../hooks/useFieldsWorkflow";
import { designObbFromLines } from "../utils/planResizeHandles";
import {
  ghostLinesForPose,
  instanceForLineId,
  toCenteredPlanFrameLines,
} from "../utils/templateInstance";
import {
  shouldRenderAlignCard,
  type FieldsStepSlice,
} from "../utils/fieldsStepSlicing";
import { DXF_PLANNER } from "../config/featureFlags";
import {
  applyCsvOrderToPlanLines,
  defaultPathOrder,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
  type CsvPathOrderEntry,
} from "../utils/missionPathOrder";
import {
  buildCsvExtensionLines,
  DEFAULT_CSV_EXTENSION_CONFIG,
  isMissionClosedLoop,
  type CsvExtensionConfig,
} from "../utils/missionExtensions";
import {
  localCsvToMapPins,
  type LocalPointCsvResult,
} from "../utils/localPointCsv";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
import type {
  AlignmentResultState,
  FieldsStepId,
  MultiPointPlacementPhase,
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
  geoOrigin?: [number, number] | null;
  autoOrigin?: boolean;
  onToggleAutoOrigin?: () => void;
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  previewRoverPoint: { north: number; east: number } | null;
  missionRunning: boolean;
  telemetrySnapshot: TelemetrySnapshot | null;
  selectedLineId: string | null;
  layerVisibility: LayerVisibility;
  setLayerVisibility?: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  onLoadSelectedPath: (
    missionId?: string,
    opts?: import("../api/missionApi").LoadMissionOptions
  ) => boolean | Promise<boolean>;
  missionActionBusy: boolean;
  onBeginPathExclusive?: (kind: "send" | "load") => boolean;
  onEndPathExclusive?: (kind: "send" | "load") => void;
  onSelectLine: (id: string | null, options?: { highlightLineIds?: string[] | null }) => void;
  /**
   * Explicit multi-line highlight set from Path Order Extension group selection.
   * When set, the plan preview highlights every listed line (not only selectedLineId).
   */
  highlightLineIds?: string[] | null;
  /** Global DXF extension config (enabled + pre/aft distance), already fetched by the
   * parent — reused so Path Order builds purple PRE/AFT client-side like CSV. */
  extPre?: string;
  extAft?: string;
  extensionsEnabled?: boolean;
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  stagedWorkflow: StagedWorkflowState;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApi.AlignPathRequest | null>>;
  /** True when the selected DXF is georeferenced (carries WGS84 coords); the backend
   * auto-places it, so manual ref-point alignment is not required. */
  isGeographicDxf?: boolean;
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
  /** Frozen painted geometry from successful Send — Start restages with live entry. */
  onAppPlannedStartSnapshot?: (snapshot: import("../utils/appPlannedStartSnapshot").AppPlannedStartSnapshot) => void;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  showRefPointLabels?: boolean;
  activeRefPointLabelIndex?: number | null;
  setActiveRefPointLabelIndex?: React.Dispatch<React.SetStateAction<number | null>>;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  setVisualAlignmentAnchor?: React.Dispatch<
    React.SetStateAction<{
      originLat: number;
      originLon: number;
      originDxfNorth: number;
      originDxfEast: number;
    } | null>
  >;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
  isPlanEditingMode?: boolean;
  onStartPlanEditing?: () => void;
  onStopPlanEditing?: () => void;
  multiPointPlacementPhase?: MultiPointPlacementPhase;
  onPlanAttached?: (info: { x: number; y: number; rotation: number; scale: number }) => void;
  onPlanEditResize?: () => void;
  onPlanResizeDone?: () => void;
  onFitToReferencePoints?: (refs: Array<{ lat: number; lon: number }>) => void;
  extractedCorners?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[] | null;
  setExtractedCorners?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[] | null>>;
  onClearMission: () => Promise<void>;
  onNavigateHome?: () => void;
  renderPlanPreview: (props: {
    lines: PlanLine[];
    mapSourceLines?: PlanLine[];
    /** Live drag-time Offset preview overlay — null unless actively dragging the compass dial. */
    ghostLines?: PlanLine[] | null;
    onMapPlacePoint?: (pt: { x: number; y: number }) => void;
    templateEditItem?: PlacedItem | null;
    onUpdateTemplateEditItem?: (updates: Partial<PlacedItem>) => void;
    templateToolMode?: "both" | "scale" | "rotate";
    templateGestureTools?: { drag?: boolean; scale?: boolean; rotate?: boolean };
    onTemplateEditDeselect?: () => void;
    autoOriginReference?: AutoOriginReference | null;
    mapGeometryFrame?: MapGeometryFrame;
    autoOriginEnabled?: boolean;
    geoOrigin?: [number, number] | null;
    visibility: LayerVisibility;
    selectedLineId: string | null;
    onSelectLine?: (id: string | null, options?: { highlightLineIds?: string[] | null }) => void;
    highlightLineIds?: string[] | null;
    roverPosN?: number | null;
    roverPosE?: number | null;
    roverHeadingDeg?: number | null;
    selectedPoints?: { x: number; y: number; lat?: number; lon?: number }[];
    pathCsvPins?: { x: number; y: number; lat?: number; lon?: number }[];
    onSelectPoint?: (pt: { x: number; y: number }) => void;
    onGuidePointFocus?: (index: number) => void;
    alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
    stagedVerified?: boolean;
    mapViewEnabled?: boolean;
    showRefPointLabels?: boolean;
    activeRefPointLabelIndex?: number | null;
    onToggleRefPointLabel?: React.Dispatch<React.SetStateAction<number | null>>;
    isVisualAlignmentMode?: boolean;
    isPlanEditingMode?: boolean;
    multiPointPlacementPhase?: MultiPointPlacementPhase;
    onPlanAttached?: (info: { x: number; y: number; rotation: number; scale: number }) => void;
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
    snapRefPoints?: { lat: number; lon: number }[];
    anchorCandidates?: import("../components/mapViewTypes").AnchorCandidatePoint[];
    onAnchorCandidateSelect?: (
      candidate: import("../components/mapViewTypes").AnchorCandidatePoint
    ) => void;
  }) => React.ReactNode;
  localCsvPreview?: LocalPointCsvResult | null;
  /**
   * Local DXF parse meta (app planner). Geometry is in `lines`; this carries
   * name / georef / warnings for Path Order → plan-trajectory Send.
   */
  localDxfMeta?: {
    fileName: string;
    isGeographic: boolean;
    warnings: string[];
  } | null;
  /** Multi-type local batch (CSV + metric/geo DXF). */
  uploadedFiles?: import("../types/uploadedFiles").UploadedFileEntry[];
  placedTemplates?: import("../types/uploadedFiles").PlacedTemplateInstance[];
  onPlaceTemplate?: (args: {
    kind: "sign" | "characters";
    fileName: string;
    sourceLines: PlanLine[];
    north: number;
    east: number;
  }) => string | void;
  onUpdateTemplateInstance?: (
    id: string,
    patch: Partial<{ north: number; east: number; rotationDeg: number; scale: number }>
  ) => void;
  onRemoveTemplate?: (id: string) => void;
  onRemoveUploadedFile?: (id: string) => void;
  pendingDxfAlignment?: Record<
    string,
    import("../types/uploadedFiles").PendingDxfAlignmentEntry
  >;
  setPendingDxfAlignment?: React.Dispatch<
    React.SetStateAction<
      Record<string, import("../types/uploadedFiles").PendingDxfAlignmentEntry>
    >
  >;
  sharedOriginGps?: [number, number] | null;
  onBeginLocalImportBatch?: () => void;
  /**
   * Tells App which pending metric DXF the Align step is manipulating, and the exact
   * composed line set the map is drawing for it. A metric DXF is held OUT of `lines`
   * until Fix Alignment, so without this every plan-manipulation handler in App (Move /
   * Rotate Plan, Fit to Reference Points, Visual Alignment) reads `lines` and finds the
   * pending geometry missing.
   */
  onAlignContextChange?: (ctx: { fileId: string | null; displayLines: PlanLine[] }) => void;
  onCommitDxfFileAlignment?: (
    fileId: string,
    alignedLines: PlanLine[],
    originGps: [number, number],
    summary: { scale: number | null; rotationDeg: number | null; rmseM: number | null }
  ) => void;
  onLocalCsvParsed?: (data: LocalPointCsvResult) => void;
  onLocalDxfParsed?: (data: import("../utils/dxfLocalImport").LocalDxfResult) => void;
  onClearLocalCsv?: () => void;
  /** Mission Layers (file groups) — distinct from CAD LayerVisibility. */
  missionLayers?: import("../types/missionLayers").MissionLayer[];
  controlModeActive?: boolean;
  canUseMissionControl?: boolean;
  pendingLayerAssignment?: { fileEntryId: string } | null;
  onPendingLayerAssignment?: (v: { fileEntryId: string } | null) => void;
  onAssignFileToNewLayer?: (fileEntryId: string) => void;
  onAssignFileToLayer?: (fileEntryId: string, layerId: string) => void;
  onUnassignFileFromLayer?: (fileEntryId: string) => void;
  /** Map-only filtered geometry (mission-layer visibility). */
  missionVisibleLines?: PlanLine[];
  missionVisibleMapSourceLines?: PlanLine[];
  /** Anchor point selection (re-anchor a CSV/DXF plan's start) — before Send. */
  anchorAvailable?: boolean;
  anchorSelectMode?: boolean;
  anchorTargetOptions?: import("../utils/missionLayerLines").AnchorTargetOption[];
  anchorTarget?: import("../utils/missionLayerLines").AnchorTarget | null;
  pendingAnchor?: import("../components/mapViewTypes").AnchorCandidatePoint | null;
  anchorCandidates?: import("../components/mapViewTypes").AnchorCandidatePoint[];
  anchorIsolatedLines?: PlanLine[];
  onAnchorPress?: () => void;
  onSelectAnchorTarget?: (target: import("../utils/missionLayerLines").AnchorTarget) => void;
  onAnchorCandidateSelect?: (
    candidate: import("../components/mapViewTypes").AnchorCandidatePoint
  ) => void;
  onConfirmAnchor?: () => void;
  /** Offset plan (whole-plan rigid shift toward an absolute compass bearing) — Upload step, before Path Order. */
  offsetDistanceM?: number;
  offsetBearingDeg?: number;
  onOffsetDistanceChange?: (m: number) => void;
  onOffsetBearingChange?: (deg: number) => void;
  onApplyOffset?: () => void;
  offsetTargetOptions?: import("../utils/missionLayerLines").AnchorTargetOption[];
  offsetTarget?: import("../utils/missionLayerLines").AnchorTarget | null;
  onOffsetTargetChange?: (target: import("../utils/missionLayerLines").AnchorTarget) => void;
  offsetResetAvailable?: boolean;
  onResetOffset?: () => void;
  onOffsetDragStateChange?: (dragging: boolean) => void;
  /** Live drag-time preview of the whole plan post-Apply — null unless actively dragging the dial. */
  offsetPreviewLines?: PlanLine[] | null;
};

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

/** Committed (verified) geometry plus every pending metric DXF still awaiting Fix Alignment. */
function mergePendingDxfLines(
  committedBase: PlanLine[],
  pending: Record<string, { rawLines?: PlanLine[] } | undefined>
): PlanLine[] {
  const pendingRaw: PlanLine[] = [];
  for (const entry of Object.values(pending)) {
    if (entry?.rawLines?.length) pendingRaw.push(...entry.rawLines);
  }
  if (pendingRaw.length === 0) return committedBase;
  const boundary = committedBase.filter((l) => l.layer === "virtual_boundary");
  const committed = committedBase.filter((l) => l.layer !== "virtual_boundary");
  return [...boundary, ...committed, ...pendingRaw];
}

export function FieldsPage(props: FieldsPageProps) {
  const {
    importedPlan,
    setImportedPlan,
    lines,
    mapSourceLines,
    autoOriginReference = null,
    mapGeometryFrame = "NONE",
    autoOriginEnabled = false,
    geoOrigin = null,
    autoOrigin = false,
    onToggleAutoOrigin,
    setLines,
    previewRoverPoint,
    missionRunning,
    telemetrySnapshot,
    selectedLineId,
    layerVisibility,
    setLayerVisibility,
    backendPaths,
    selectedPathName,
    onSelectPath,
    onLoadSelectedPath,
    missionActionBusy,
    onBeginPathExclusive,
    onEndPathExclusive,
    onSelectLine,
    highlightLineIds = null,
    extPre,
    extAft,
    extensionsEnabled = false,
    apiBaseUrl,
    onRefreshPaths,
    onWorkflowStep,
    stagedWorkflow,
    alignmentResult,
    setAlignmentResult,
    verifiedAlignmentRequest,
    setVerifiedAlignmentRequest,
    isGeographicDxf = false,
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
    onAppPlannedStartSnapshot,
    alignedRefPoints = [],
    setAlignedRefPoints,
    mapViewEnabled = true,
    showRefPointLabels = false,
    activeRefPointLabelIndex = null,
    setActiveRefPointLabelIndex,
    isVisualAlignmentMode,
    visualAlignmentItem,
    setVisualAlignmentItem,
    setVisualAlignmentAnchor,
    onStartVisualAlignment,
    onConfirmVisualAlignment,
    isPlanEditingMode,
    onStartPlanEditing,
    onStopPlanEditing,
    multiPointPlacementPhase = "idle",
    onPlanAttached,
    onPlanEditResize,
    onPlanResizeDone,
    onFitToReferencePoints,
    extractedCorners,
    setExtractedCorners,
    onClearMission,
    onNavigateHome,
    renderPlanPreview,
    localCsvPreview = null,
    localDxfMeta = null,
    uploadedFiles = [],
    placedTemplates = [],
    onPlaceTemplate,
    onUpdateTemplateInstance,
    onRemoveTemplate,
    onRemoveUploadedFile,
    pendingDxfAlignment = {},
    setPendingDxfAlignment,
    sharedOriginGps = null,
    onBeginLocalImportBatch,
    onAlignContextChange,
    onCommitDxfFileAlignment,
    onLocalCsvParsed,
    onLocalDxfParsed,
    onClearLocalCsv,
    missionLayers = [],
    controlModeActive = false,
    canUseMissionControl = false,
    pendingLayerAssignment = null,
    onPendingLayerAssignment,
    onAssignFileToNewLayer,
    onAssignFileToLayer,
    onUnassignFileFromLayer,
    missionVisibleLines,
    missionVisibleMapSourceLines,
    anchorAvailable = false,
    anchorSelectMode = false,
    anchorTargetOptions = [],
    anchorTarget = null,
    pendingAnchor = null,
    anchorCandidates = [],
    anchorIsolatedLines = [],
    onAnchorPress,
    onSelectAnchorTarget,
    onAnchorCandidateSelect,
    onConfirmAnchor,
    offsetDistanceM = 0,
    offsetBearingDeg = 0,
    onOffsetDistanceChange,
    onOffsetBearingChange,
    onApplyOffset,
    offsetTargetOptions = [],
    offsetTarget = null,
    onOffsetTargetChange,
    offsetResetAvailable = false,
    onResetOffset,
    onOffsetDragStateChange,
    offsetPreviewLines = null,
  } = props;

  const [selectedUploadedFileId, setSelectedUploadedFileId] = useState<string | null>(null);

  const [refPoints, setRefPoints] = useState<RefPoint[]>([]);
  /** Which Multi-Point guide row should show Lat/Lon focus (map pin tap). */
  const [focusedGuidePointIndex, setFocusedGuidePointIndex] = useState<number | null>(null);
  /**
   * True after a Multi-Point guide-points CSV is loaded. While active, map tap-to-pick
   * is disabled (CSV is the sole source of ref markers). Cleared with Clear Points /
   * method change / empty list.
   */
  const [csvGuidePointsActive, setCsvGuidePointsActive] = useState(false);
  /** Imported guide CSV file names for Upload/Align button labels (supports multiple files). */
  const [guideCsvFileNames, setGuideCsvFileNames] = useState<string[]>([]);
  const [missionSummary, setMissionSummary] = useState<any | null>(null);
  /** Align DXF methods: Multi-Point Fit | Visual (1-Point Fit removed). Auto Origin is a separate toggle peer. */
  const [alignmentMethod, setAlignmentMethod] = useState<"least_squares" | "visual_alignment">("least_squares");

  /** CSV path order / paint flags from CsvPathOrderStep (Phase 3). */
  const [csvPathOrder, setCsvPathOrder] = useState<CsvPathOrderEntry[] | null>(null);
  /** Local CSV PRE/AFT extensions (app-owned; not saved via /extensions). */
  const [csvExtensionConfig, setCsvExtensionConfig] = useState<CsvExtensionConfig>(
    DEFAULT_CSV_EXTENSION_CONFIG
  );
  const [boundaryMode, setBoundaryMode] = useState(false);
  const [boundaryWidthStr, setBoundaryWidthStr] = useState("4.0");
  const [boundaryHeightStr, setBoundaryHeightStr] = useState("3.0");
  const [boundaryPosition, setBoundaryPosition] = useState<{ x: number; y: number } | null>(null);
  const [boundaryRotation, setBoundaryRotation] = useState<number>(0);

  const handleToggleBoundaryMode = useCallback((enabled: boolean) => {
    setBoundaryMode(enabled);
    if (!enabled) {
      setBoundaryRotation(0);
    }
  }, []);

  const handleApplyBoundary = useCallback((w: number, h: number) => {
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

  /**
   * Independent click-to-expand state for each step card (true dropdowns).
   * Separate from `activeStep`, which still drives map/align gating.
   */
  type PanelSectionKey =
    | "upload"
    | "pathOrder"
    | "templates"
    | "send"
    | "align"
    | "orderAndSpray";
  const ALL_SECTIONS_CLOSED: Record<PanelSectionKey, boolean> = {
    upload: false,
    pathOrder: false,
    templates: false,
    send: false,
    align: false,
    orderAndSpray: false,
  };

  /**
   * Accordion: at most ONE section open at a time.
   *
   * The panel is a fixed-height column holding three stacked containers (top scroller,
   * Path Order, Templates scroller). Two expanded bodies cannot both fit, so the second
   * one gets clipped — which is what made Align look like it vanished behind Path Order.
   * Enforcing exclusivity here means the open body always has the whole column to grow
   * into, and every collapsed card is just its header.
   */
  const [openSections, setOpenSections] = useState<Record<PanelSectionKey, boolean>>({
    ...ALL_SECTIONS_CLOSED,
    upload: true,
  });
  const isSectionOpen = useCallback(
    (key: PanelSectionKey) => openSections[key] === true,
    [openSections]
  );
  /** Open exactly `key` (closing everything else), or close it if it was already open. */
  const openOnlySection = useCallback((key: PanelSectionKey | null) => {
    setOpenSections(key ? { ...ALL_SECTIONS_CLOSED, [key]: true } : { ...ALL_SECTIONS_CLOSED });
  }, []);
  const toggleSection = useCallback(
    (key: PanelSectionKey, activateStep?: FieldsStepId) => {
      setOpenSections((prev) => {
        const opening = !prev[key];
        if (opening && activateStep) {
          setActiveStep(activateStep);
        }
        return opening ? { ...ALL_SECTIONS_CLOSED, [key]: true } : { ...ALL_SECTIONS_CLOSED };
      });
    },
    [setActiveStep]
  );

  const [tplSession, setTplSession] = useState<"idle" | "picking" | "ghost">("idle");
  const [tplDraft, setTplDraft] = useState<{
    kind: "sign" | "characters";
    fileName: string;
    sourceLines: PlanLine[];
  } | null>(null);
  const [tplGhostPose, setTplGhostPose] = useState<{ north: number; east: number } | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [tplDrag, setTplDrag] = useState(false);
  const [tplScale, setTplScale] = useState(false);
  const [tplRotate, setTplRotate] = useState(false);

  const needsAlign = uploadedFiles.some((f) => f.status === "needs_alignment");
  const hasMissionFrame = Boolean(
    sharedOriginGps ||
      (verifiedAlignmentRequest?.origin_gps &&
        Array.isArray(verifiedAlignmentRequest.origin_gps) &&
        verifiedAlignmentRequest.origin_gps.length >= 2) ||
      selectMarkPlanLines(lines).length > 0
  );
  const canPlaceTemplates = hasMissionFrame && !needsAlign;
  const placeBlockedReason = needsAlign
    ? "Align the metric DXF first so the template is not moved twice."
    : "Import a survey or aligned plan first so the template has a map frame.";

  const templateGhostLines = useMemo(() => {
    if (tplSession !== "ghost" || !tplDraft || !tplGhostPose) return null;
    return ghostLinesForPose(tplDraft.sourceLines, {
      north: tplGhostPose.north,
      east: tplGhostPose.east,
      rotationDeg: 0,
      scale: 1,
    });
  }, [tplSession, tplDraft, tplGhostPose]);

  // useMemo so the .find() doesn't run on every prop change.
  const selectedTemplate = useMemo(
    () => placedTemplates.find((item) => item.id === selectedTemplateId) ?? null,
    [placedTemplates, selectedTemplateId]
  );
  const templateToolsOn = Boolean(selectedTemplate && (tplDrag || tplScale || tplRotate));

  const templateEditItem = useMemo((): PlacedItem | null => {
    if (!selectedTemplate || !templateToolsOn) return null;
    const local = toCenteredPlanFrameLines(selectedTemplate.sourceLines);
    const obb = designObbFromLines(local);
    return {
      id: selectedTemplate.id,
      lines: local,
      x: selectedTemplate.east,
      y: selectedTemplate.north,
      rotation: selectedTemplate.rotationDeg,
      scale: selectedTemplate.scale,
      width: Math.max(0.5, obb.width),
      height: Math.max(0.5, obb.height),
    };
  }, [selectedTemplate, templateToolsOn]);

  const templateToolMode: "both" | "scale" | "rotate" = tplScale && tplRotate
    ? "both"
    : tplScale
      ? "scale"
      : "rotate";
  const templateGestureTools = useMemo(
    () => ({ drag: tplDrag, scale: tplScale, rotate: tplRotate }),
    [tplDrag, tplScale, tplRotate]
  );

  /**
   * Fully deselect the active template: clear all tool flags AND the selected ID.
   * Called when the user taps empty map space while transform tools are active.
   */
  const handleTemplateEditDeselect = useCallback(() => {
    setTplDrag(false);
    setTplScale(false);
    setTplRotate(false);
    setSelectedTemplateId(null);
  }, []);


  /**
   * Map onSelectLine: if the tapped line belongs to a placed template, select that
   * template and open the panel; otherwise clear template selection.
   */
  const handleMapSelectLine = useCallback(
    (id: string | null, options?: { highlightLineIds?: string[] | null }) => {
      const inst = instanceForLineId(placedTemplates, id);
      if (inst) {
        setSelectedTemplateId(inst.id);
        openOnlySection("templates");
      } else if (tplSession === "idle") {
        setSelectedTemplateId(null);
        setTplDrag(false);
        setTplScale(false);
        setTplRotate(false);
      }
      onSelectLine(id, options);
    },
    [placedTemplates, tplSession, onSelectLine, openOnlySection]
  );

  /**
   * Called from TemplatePanel's placed-templates dropdown.
   * Selects the chosen template, opens the Templates section, and opens
   * Templates panel so Drag/Scale/Rotate are immediately accessible.
   */
  const handleSelectPlacedTemplate = useCallback(
    (id: string) => {
      setSelectedTemplateId(id);
      openOnlySection("templates");
      // Highlight the template's lines on the map for visual feedback.
      const tpl = placedTemplates.find((t) => t.id === id);
      if (tpl) {
        const firstLine = tpl.sourceLines[0];
        if (firstLine) {
          const prefixed = `${tpl.lineIdPrefix}__${firstLine.id}`;
          onSelectLine(prefixed, { highlightLineIds: null });
        }
      }
    },
    [placedTemplates, openOnlySection, onSelectLine]
  );

  /**
   * How many PRE/AFT runs the current config actually produces, and — when that is zero —
   * why. Extensions are geometry-gated: a shape that closes on itself has no open end to run
   * off, so `buildCsvExtensionLines` correctly returns nothing. Without this the operator
   * flips Enable Extension on a 2 × 2 square, sees no purple, and reads it as broken.
   */
  const extensionStatus = useMemo(() => {
    if (!csvExtensionConfig.enabled) return null;
    const marks = selectMarkPlanLines(lines);
    if (marks.length === 0) {
      return { count: 0, hint: "No paintable paths yet." };
    }
    const order = csvPathOrder ?? defaultPathOrder(marks);
    const painted = resolveOrderedPaintedLines(marks, order);
    const built = buildCsvExtensionLines(painted, csvExtensionConfig);
    if (built.length > 0) return { count: built.length, hint: null };
    if (!csvExtensionConfig.perLine && isMissionClosedLoop(painted)) {
      return {
        count: 0,
        hint: "This path closes on itself, so there is no open end to run off.",
      };
    }
    return {
      count: 0,
      hint: "No free path ends — every endpoint continues straight into another path, so a run-up would only retrace it.",
    };
  }, [lines, csvPathOrder, csvExtensionConfig]);

  /** True when the section living in the top scroller (Upload / Templates / Align) is open. */
  const topSectionOpen =
    isSectionOpen("upload") || isSectionOpen("align") || isSectionOpen("templates");

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

  /**
   * Update the placed template's position/rotation/scale from a map gesture.
   * Stable reference — only re-creates when the selected template or tool flags change.
   * Placed AFTER blockProtectedWorkflowMutation so the dep is in scope.
   */
  const handleUpdateTemplateEditItem = useCallback(
    (updates: Partial<{ x: number; y: number; rotation: number; scale: number }>) => {
      if (!selectedTemplate) return;
      if (blockProtectedWorkflowMutation("Editing a template")) return;
      const patch: Partial<{ north: number; east: number; rotationDeg: number; scale: number }> = {};
      if (tplDrag) {
        if (typeof updates.y === "number") patch.north = updates.y;
        if (typeof updates.x === "number") patch.east = updates.x;
      }
      if (tplRotate && typeof updates.rotation === "number") patch.rotationDeg = updates.rotation;
      if (tplScale && typeof updates.scale === "number") patch.scale = updates.scale;
      if (Object.keys(patch).length === 0) return;
      onUpdateTemplateInstance?.(selectedTemplate.id, patch);
    },
    [selectedTemplate, tplDrag, tplRotate, tplScale, blockProtectedWorkflowMutation, onUpdateTemplateInstance]
  );

  /**
   * Map tap → yellow guide points. Enabled ONLY for Multi-Point Fit when:
   * - Align step is active
   * - not Visual Alignment / Auto Origin
   * - not mid Move-Plan sticker drag
   * - no CSV guide file is loaded
   */
  const canTapGuidePoints =
    isSectionOpen("align") &&
    alignmentMethod === "least_squares" &&
    !autoOrigin &&
    !isVisualAlignmentMode &&
    !isPlanEditingMode &&
    !csvGuidePointsActive;

  const handleSelectPoint = useCallback(
    (pt: { x: number; y: number }) => {
      if (
        !isSectionOpen("align") ||
        alignmentMethod !== "least_squares" ||
        autoOrigin ||
        isVisualAlignmentMode ||
        isPlanEditingMode ||
        csvGuidePointsActive
      ) {
        console.log(
          `[AlignDXF][Tap] Ignored (gated): alignOpen=${isSectionOpen("align")} method=${alignmentMethod} autoOrigin=${!!autoOrigin} visual=${!!isVisualAlignmentMode} editing=${!!isPlanEditingMode} csv=${csvGuidePointsActive}`
        );
        return;
      }
      console.log(`[AlignDXF][Tap] Map tapped: pt.x(north)=${pt.x} pt.y(east)=${pt.y}`);
      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      // Multi-file batch keeps sharedOriginGps / verifiedAlignmentRequest via App invalidate.
      if (uploadedFiles.length === 0) {
        setVerifiedAlignmentRequest(null);
      }
      setRefPoints((prev) => {
        // Same location again → focus that row for Lat/Lon entry (do not remove).
        const existingIdx = prev.findIndex(
          (point) => Math.hypot(point.dxf_y - pt.x, point.dxf_x - pt.y) < 0.35
        );
        if (existingIdx >= 0) {
          console.log(`[AlignDXF][Tap] Focusing existing point at index ${existingIdx} for Lat/Lon`);
          setFocusedGuidePointIndex(existingIdx);
          return prev;
        }
        // Multi-Point Fit: append — no cap on guide markers.
        const next = [...prev, { dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
        console.log(
          `[AlignDXF][Tap] Added guide #${next.length}: north=${pt.x.toFixed(3)} east=${pt.y.toFixed(3)}`
        );
        setFocusedGuidePointIndex(next.length - 1);
        return next;
      });
    },
    [
      isSectionOpen,
      alignmentMethod,
      autoOrigin,
      isVisualAlignmentMode,
      isPlanEditingMode,
      csvGuidePointsActive,
      uploadedFiles.length,
      onInvalidateWorkflow,
      setAlignmentResult,
      setVerifiedAlignmentRequest,
    ]
  );

  const handleGuidePointFocus = useCallback((index: number) => {
    if (!Number.isFinite(index) || index < 0) return;
    setFocusedGuidePointIndex(index);
  }, []);

  // Local mirror of mission CSV so UI (hide bounding box / guide, show Send to Rover)
  // flips immediately on parse — even if parent props lag one frame or App state
  // is slow to re-render into this lazy Fields page.
  const [missionCsvPreview, setMissionCsvPreview] = useState<LocalPointCsvResult | null>(null);
  React.useEffect(() => {
    if (localCsvPreview) setMissionCsvPreview(localCsvPreview);
  }, [localCsvPreview]);
  React.useEffect(() => {
    // Parent cleared CSV (Clear bar / new DXF import).
    if (localCsvPreview == null && importedPlan?.fileType !== "csv") {
      setMissionCsvPreview(null);
    }
  }, [localCsvPreview, importedPlan?.fileType]);

  const activeCsvPreview = missionCsvPreview ?? localCsvPreview;
  const hasLocalBatch = uploadedFiles.length > 0;
  const allFilesVerified =
    hasLocalBatch && uploadedFiles.every((f) => f.status === "verified");
  const hasPendingAlignment = uploadedFiles.some((f) => f.status === "needs_alignment");
  const batchHasDxf = uploadedFiles.some((f) => f.kind === "dxf");
  const batchHasCsv = uploadedFiles.some((f) => f.kind === "csv");
  // Determine step statuses
  const hasPath =
    !!selectedPathName ||
    !!importedPlan ||
    activeCsvPreview != null ||
    hasLocalBatch;
  const uploadDone = hasPath;
  const isDxfPath =
    importedPlan?.fileType === "dxf" ||
    selectedPathName?.toLowerCase().endsWith(".dxf") ||
    (hasLocalBatch && batchHasDxf && !batchHasCsv);
  const planLooksLikeCsv =
    importedPlan?.fileType === "csv" ||
    !!importedPlan?.fileName?.toLowerCase().endsWith(".csv");
  /** Pure CSV local flow (no DXF in batch). */
  const isLocalCsvFlow =
    (hasLocalBatch && batchHasCsv && !batchHasDxf) ||
    (!hasLocalBatch && (activeCsvPreview != null || planLooksLikeCsv));
  /** Local DXF-only (or mixed batch treated as DXF-style steps with Align). */
  const isLocalDxfFlow =
    (hasLocalBatch && batchHasDxf) ||
    (DXF_PLANNER === "app" &&
      isDxfPath &&
      !selectedPathName &&
      importedPlan?.fileType === "dxf" &&
      !hasLocalBatch);
  const isLocalFlow = isLocalCsvFlow || isLocalDxfFlow || hasLocalBatch;
  /**
   * Local multi-file batch: `allFilesVerified` is authoritative (every local CSV/DXF import
   * goes through `uploadedFiles` now, so `hasPendingAlignment` can't disagree with it). The
   * remaining clauses only matter for the rover/backend DXF path, where `uploadedFiles` stays
   * empty — kept verbatim from before the batch existed.
   */
  const alignDone = hasLocalBatch
    ? allFilesVerified
    : !isDxfPath ||
      autoOrigin ||
      stagedWorkflow.alignment === "verified" ||
      !!verifiedAlignmentRequest ||
      isGeographicDxf;

  // Prefer explicit selection; otherwise the first file that still needs alignment.
  const effectiveAlignFileId = useMemo(() => {
    if (selectedUploadedFileId && pendingDxfAlignment[selectedUploadedFileId]) {
      return selectedUploadedFileId;
    }
    const firstPending = uploadedFiles.find((f) => f.status === "needs_alignment");
    return firstPending?.id ?? null;
  }, [selectedUploadedFileId, pendingDxfAlignment, uploadedFiles]);

  const selectedPending =
    effectiveAlignFileId != null
      ? pendingDxfAlignment[effectiveAlignFileId] ?? null
      : null;

  const resetWorkingAlignState = useCallback(() => {
    setRefPoints([]);
    setFocusedGuidePointIndex(null);
    setCsvGuidePointsActive(false);
    setGuideCsvFileNames([]);
    setAlignmentMethod("least_squares");
    setExtractedCorners?.(null);
    setVisualAlignmentItem?.(null);
    setAlignmentResult(null);
  }, [setExtractedCorners, setVisualAlignmentItem, setAlignmentResult]);

  const handleSelectUploadedFile = useCallback(
    (fileId: string) => {
      setSelectedUploadedFileId(fileId);
      const entry = uploadedFiles.find((f) => f.id === fileId);
      if (!entry) return;
      // Highlight this file's committed geometry when present.
      const prefixed = lines
        .filter((l) => l.id.startsWith(`${entry.lineIdPrefix}__`))
        .map((l) => l.id);
      if (prefixed.length > 0) {
        onSelectLine(prefixed[0] ?? null, { highlightLineIds: prefixed });
      }
      if (entry.kind === "template") {
        setSelectedTemplateId(entry.id);
        openOnlySection("templates");
        return;
      }
      if (entry.status === "needs_alignment") {
        setActiveStep("align");
        openOnlySection("align");
      } else {
        setActiveStep("upload");
        openOnlySection("upload");
      }
    },
    [
      uploadedFiles,
      lines,
      onSelectLine,
      setActiveStep,
      openOnlySection,
    ]
  );

  /** Map shows committed mission lines + every pending metric DXF (not only the selected file). */
  const mapDisplayLines = useMemo(
    () => mergePendingDxfLines(missionVisibleLines ?? lines, pendingDxfAlignment),
    [lines, missionVisibleLines, pendingDxfAlignment]
  );

  /** Raw (pre-auto-origin-shift) copy so Mapbox still sees sibling plans while aligning. */
  const mapSourceWithPending = useMemo(
    () =>
      mergePendingDxfLines(
        missionVisibleMapSourceLines ?? mapSourceLines ?? [],
        pendingDxfAlignment
      ),
    [missionVisibleMapSourceLines, mapSourceLines, pendingDxfAlignment]
  );

  const mapDisplayWithoutEditingTemplate = useMemo(() => {
    if (!selectedTemplate || !templateToolsOn) return mapDisplayLines;
    const token = `${selectedTemplate.lineIdPrefix}__`;
    return mapDisplayLines.filter((line) => !line.id.startsWith(token));
  }, [mapDisplayLines, selectedTemplate, templateToolsOn]);

  const mapSourceWithoutEditingTemplate = useMemo(() => {
    if (!selectedTemplate || !templateToolsOn) return mapSourceWithPending;
    const token = `${selectedTemplate.lineIdPrefix}__`;
    return mapSourceWithPending.filter((line) => !line.id.startsWith(token));
  }, [mapSourceWithPending, selectedTemplate, templateToolsOn]);

  /**
   * Keep App's plan-manipulation handlers pointed at the geometry actually on screen.
   * `selectedPending` is the only case where the plan being aligned is NOT in `lines`;
   * reporting null otherwise leaves the rover/committed flows on their existing path.
   */
  React.useEffect(() => {
    onAlignContextChange?.({
      fileId: selectedPending ? effectiveAlignFileId : null,
      displayLines: mapDisplayLines,
    });
  }, [onAlignContextChange, selectedPending, effectiveAlignFileId, mapDisplayLines]);

  const setPendingAlignLines = useCallback(
    (updater: React.SetStateAction<PlanLine[]>) => {
      if (!effectiveAlignFileId || !setPendingDxfAlignment) return;
      setPendingDxfAlignment((prev) => {
        const cur = prev[effectiveAlignFileId];
        if (!cur) return prev;
        const nextLines =
          typeof updater === "function" ? updater(cur.rawLines) : updater;
        return {
          ...prev,
          [effectiveAlignFileId]: { ...cur, rawLines: nextLines },
        };
      });
    },
    [effectiveAlignFileId, setPendingDxfAlignment]
  );

  /**
   * Upload-plan path CSV vertices. Independent of Align guide pins — a path file
   * must never replace guide CSV markers on the map.
   */
  const localCsvMapPins = useMemo(() => {
    if (!activeCsvPreview || activeCsvPreview.points.length === 0) return null;
    return localCsvToMapPins(activeCsvPreview);
  }, [activeCsvPreview]);

  const EMPTY_MAP_PINS = useMemo(() => [] as { x: number; y: number; lat?: number; lon?: number }[], []);
  const alignSectionOpen = isSectionOpen("align");
  /** Gold numbered guide pins — only while the Align DXF card is open. */
  const alignGuidePins = useMemo(() => {
    if (!alignSectionOpen) return EMPTY_MAP_PINS;
    return refPoints.map((point) => {
      const lat = parseFloat(point.lat);
      const lon = parseFloat(point.lon);
      return {
        x: point.dxf_y,
        y: point.dxf_x,
        ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
      };
    });
  }, [alignSectionOpen, refPoints, EMPTY_MAP_PINS]);
  /** Path vertices hide while Align is open so they cannot be mistaken for guides. */
  const pathCsvPins = alignSectionOpen ? null : localCsvMapPins;

  const stepStatus = (id: FieldsStepId): "pending" | "active" | "done" => {
    switch (id) {
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

  /** Legacy helper — prefer toggleSection for card headers (true expand/collapse). */
  const toggleStep = (id: FieldsStepId) => {
    const key: PanelSectionKey =
      id === "align"
        ? "align"
        : id === "orderAndSpray"
        ? "orderAndSpray"
        : "upload";
    toggleSection(key, id);
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
      // Don't capture while mid-resize — Done first.
      if (multiPointPlacementPhase === "resizing") {
        onPlanResizeDone?.();
        return;
      }
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
    multiPointPlacementPhase,
    onPlanResizeDone,
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

  // Toggles whether the extension (run-up/run-out) layer draws on the plan preview.
  const handleToggleExtensionVisible = useCallback(() => {
    setLayerVisibility?.((prev) => ({ ...prev, extension: prev.extension === false }));
  }, [setLayerVisibility]);

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

  // Live bounding-box size in meters (design-space OBB × current scale) for the transform
  // HUD — was hardcoded to 0 before since nothing computed it from the plan's own bounds.
  const liveBoundingSizeM = useMemo(() => {
    if (!visualAlignmentItem?.lines?.length) return { widthM: 0, heightM: 0 };
    const obb = designObbFromLines(visualAlignmentItem.lines);
    const scale = visualAlignmentItem.scale ?? 1;
    const sE = visualAlignmentItem.scaleEast ?? scale;
    const sN = visualAlignmentItem.scaleNorth ?? scale;
    return { widthM: obb.width * sE, heightM: obb.height * sN };
  }, [
    visualAlignmentItem?.lines,
    visualAlignmentItem?.scale,
    visualAlignmentItem?.scaleEast,
    visualAlignmentItem?.scaleNorth,
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: FIELDS_COLORS.bgBase }}>
      {/* Fields owns this MapView. Sharing Home's map under a full-screen overlay
          made native Mapbox invisible on Android. */}
      <View style={{ ...StyleSheet.absoluteFillObject, zIndex: 1, backgroundColor: FIELDS_COLORS.bgBase }}>
        {renderPlanPreview({
          lines: anchorSelectMode && anchorTarget
            ? anchorIsolatedLines
            : mapDisplayWithoutEditingTemplate,
          ghostLines: templateGhostLines ?? offsetPreviewLines,
          onMapPlacePoint:
            tplSession === "picking" || tplSession === "ghost"
              ? (pt) => {
                  setTplGhostPose({ north: pt.x, east: pt.y });
                  setTplSession("ghost");
                }
              : undefined,
          templateEditItem,
          templateToolMode,
          templateGestureTools,
          onTemplateEditDeselect: handleTemplateEditDeselect,
          onUpdateTemplateEditItem: selectedTemplate ? handleUpdateTemplateEditItem : undefined,
          mapSourceLines:
            anchorSelectMode && anchorTarget
              ? anchorIsolatedLines
              : mapSourceWithoutEditingTemplate,
          anchorCandidates: anchorSelectMode ? anchorCandidates : undefined,
          onAnchorCandidateSelect,
          autoOriginReference,
          mapGeometryFrame,
          autoOriginEnabled,
          geoOrigin,
          visibility: effectiveLayerVisibility,
          selectedLineId,
          onSelectLine: handleMapSelectLine,
          highlightLineIds,
          roverPosN: previewRoverPoint?.north ?? null,
          roverPosE: previewRoverPoint?.east ?? null,
          roverHeadingDeg: telemetrySnapshot?.heading_ned_deg ?? null,
          selectedPoints: alignGuidePins,
          pathCsvPins: pathCsvPins ?? undefined,
          onSelectPoint: canTapGuidePoints ? handleSelectPoint : undefined,
          onGuidePointFocus: alignSectionOpen ? handleGuidePointFocus : undefined,
          alignedRefPoints,
          stagedVerified: stagedWorkflow.staged === "verified",
          mapViewEnabled,
          showRefPointLabels,
          activeRefPointLabelIndex,
          onToggleRefPointLabel: setActiveRefPointLabelIndex,
          isVisualAlignmentMode,
          isPlanEditingMode,
          multiPointPlacementPhase,
          onPlanAttached,
          visualAlignmentItem,
          setVisualAlignmentItem,
          boundaryMode: false,
          boundaryWidth: undefined,
          boundaryHeight: undefined,
          boundaryPosition: boundaryPosition ?? undefined,
          onMoveBoundary: (x: number, y: number) => setBoundaryPosition({ x, y }),
          boundaryRotation,
          onRotateBoundary: (rot: number) => setBoundaryRotation(rot),
          // Sketch dimming and snap-point markers are no longer operator-toggleable from
          // Templates — the plan draws at full opacity with snap points on.
          sketchMode: false,
          showBoundaryPoints: true,
          snapRefPoints:
            alignSectionOpen && alignmentMethod === "least_squares"
              ? refPoints
                  .map((p) => ({ lat: parseFloat(p.lat), lon: parseFloat(p.lon) }))
                  .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
              : [],
        })}
      </View>

      {/* Move / Resize chrome — visible as soon as Move/Rotate Plan is active */}
      {isPlanEditingMode &&
      (multiPointPlacementPhase === "placing" ||
        multiPointPlacementPhase === "attached" ||
        multiPointPlacementPhase === "resizing") ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: 24,
            left: 0,
            right: 0,
            alignItems: "center",
            zIndex: 60,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              backgroundColor: "rgba(15,23,42,0.92)",
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderWidth: 1,
              borderColor:
                multiPointPlacementPhase === "resizing"
                  ? FIELDS_COLORS.stepActive
                  : FIELDS_COLORS.success,
              elevation: 12,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.4,
              shadowRadius: 10,
            }}
          >
            <View style={{ alignItems: "flex-start" }}>
              <Text
                style={{
                  color: FIELDS_COLORS.textMuted,
                  fontSize: 10,
                  fontWeight: "700",
                  letterSpacing: 0.6,
                }}
              >
                {multiPointPlacementPhase === "resizing" ? "RESIZE" : "MOVE"}
              </Text>
              <Text
                style={{
                  color: FIELDS_COLORS.textMain,
                  fontSize: 16,
                  fontWeight: "800",
                  fontFamily: "monospace",
                }}
              >
                {(visualAlignmentItem?.scale ?? 1).toFixed(2)}×
              </Text>
            </View>
            {multiPointPlacementPhase === "resizing" ? (
              <Pressable
                onPress={() => onPlanResizeDone?.()}
                style={({ pressed }) => ({
                  paddingHorizontal: 18,
                  paddingVertical: 10,
                  borderRadius: 10,
                  backgroundColor: pressed ? FIELDS_COLORS.success : "#10b981",
                })}
              >
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>Done</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => onPlanEditResize?.()}
                style={({ pressed }) => ({
                  paddingHorizontal: 18,
                  paddingVertical: 10,
                  borderRadius: 10,
                  backgroundColor: pressed ? FIELDS_COLORS.stepActive : "#0ea5e9",
                })}
              >
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>Resize</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : null}

      {/* Map interaction overlay (floating icons on plan) */}
      <MapPlanInteractionOverlay
        visible={
          showMapInteraction &&
          hasPath &&
          multiPointPlacementPhase !== "placing" &&
          multiPointPlacementPhase !== "attached" &&
          multiPointPlacementPhase !== "resizing"
        }
        transformData={{
          scaleMultiplier: visualAlignmentItem?.scale ?? 1,
          boundingWidthM: liveBoundingSizeM.widthM,
          boundingHeightM: liveBoundingSizeM.heightM,
          rotationDeg: visualAlignmentItem?.rotation ?? 0,
          offsetMeters: {
            x: visualAlignmentItem?.x ?? 0,
            y: visualAlignmentItem?.y ?? 0,
          },
        }}
        onConfirm={handleConfirmTransform}
        hasTransform={hasTransform}
      />

      {/* Side panel — UI chrome only; workflow / expand logic unchanged */}
      <View
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          bottom: 12,
          width: 360,
          maxWidth: "36%",
          backgroundColor: FIELDS_COLORS.panelSolid,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          overflow: "hidden",
          elevation: 12,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.4,
          shadowRadius: 18,
          zIndex: 10,
        }}
      >
        <FieldsClearBar onClear={onClearMission} busy={missionActionBusy} />
        {/* Path Order uses DraggableFlatList (VirtualizedList) — never nest it
            inside the page ScrollView (same orientation). CSV and DXF both
            host that section outside ScrollView. */}
        {isLocalFlow ? (
        <View
          style={{
            flex: 1,
            minHeight: 0,
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 16,
            gap: 8,
          }}
        >
          {/*
            These containers size to their content (flexGrow:0) and shrink only when the
            column runs out of room. Never flexGrow:1 — a scroller that grows past its
            content pads the leftover space *inside* itself, which is what opened a dead gap
            between Align DXF and Path Order & Load. The only element allowed to claim
            leftover space is the open Path Order card, via `fillAvailable`.
          */}
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}
            contentContainerStyle={{ gap: 8 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator={topSectionOpen}
          >
            {renderFieldsSteps(isLocalDxfFlow ? "localDxfTop" : "csvUpload")}
          </ScrollView>
          {/* Path order list (VirtualizedList) + Verify & Load — outside ScrollView. */}
          {renderFieldsSteps("csvPathOrder")}
        </View>
        ) : (
        <View
          style={{
            flex: 1,
            minHeight: 0,
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 16,
            gap: 8,
          }}
        >
          {/* Same rule as the local column: size to content, shrink only when out of room. */}
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}
            contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator={topSectionOpen}
          >
            {renderFieldsSteps("dxfTop")}
          </ScrollView>
          {/* DXF Path Order DraggableFlatList — outside ScrollView (fixes VirtualizedList warning). */}
          {renderFieldsSteps("dxfPathOrder")}
        </View>
        )}
      </View>
    </View>
  );

  /**
   * Templates body, shared by every flow's Templates step card — second card in the
   * rover-planned DXF flow, trailing card in both local flows.
   *
   * `placementMode` is what keeps a local flow local — "csvLocal" adds strokes straight to
   * `lines`, while "dxf" round-trips a generated DXF through POST /parse-dxf.
   */
  function renderTemplatePanel() {
    return (
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
          openOnlySection("align");
        }}
        boundaryMode={boundaryMode}
        onToggleBoundaryMode={handleToggleBoundaryMode}
        boundaryWidthStr={boundaryWidthStr}
        onChangeBoundaryWidthStr={setBoundaryWidthStr}
        boundaryHeightStr={boundaryHeightStr}
        onChangeBoundaryHeightStr={setBoundaryHeightStr}
        onApplyBoundary={handleApplyBoundary}
        telemetryPosN={telemetrySnapshot?.pos_n ?? null}
        telemetryPosE={telemetrySnapshot?.pos_e ?? null}
        placementMode={isLocalFlow ? "csvLocal" : "dxf"}
        canPlace={canPlaceTemplates}
        placeBlockedReason={placeBlockedReason}
        session={tplSession}
        selectedLabel={selectedTemplate?.fileName ?? null}
        dragEnabled={tplDrag}
        scaleEnabled={tplScale}
        rotateEnabled={tplRotate}
        onBeginPlace={(draft) => {
          if (blockProtectedWorkflowMutation("Placing a template")) return;
          if (!canPlaceTemplates) {
            Alert.alert("Cannot place yet", placeBlockedReason);
            return;
          }
          setTplDraft(draft);
          setTplGhostPose(null);
          setTplSession("picking");
          setSelectedTemplateId(null);
          setTplDrag(false);
          setTplScale(false);
          setTplRotate(false);
          setShowMapInteraction(true);
        }}
        onCancelPlace={() => {
          setTplSession("idle");
          setTplDraft(null);
          setTplGhostPose(null);
        }}
        onConfirmPlace={() => {
          if (!tplDraft || !tplGhostPose || !onPlaceTemplate) return;
          if (blockProtectedWorkflowMutation("Placing a template")) return;
          const placedId = onPlaceTemplate({
            kind: tplDraft.kind,
            fileName: tplDraft.fileName,
            sourceLines: tplDraft.sourceLines,
            north: tplGhostPose.north,
            east: tplGhostPose.east,
          });
          setTplSession("idle");
          setTplDraft(null);
          setTplGhostPose(null);
          setShowMapInteraction(true);
          if (typeof placedId === "string") {
            setSelectedTemplateId(placedId);
            openOnlySection("templates");
          }
        }}
        onToggleDrag={() => {
          if (blockProtectedWorkflowMutation("Editing a template")) return;
          setTplDrag((v) => !v);
        }}
        onToggleScale={() => {
          if (blockProtectedWorkflowMutation("Editing a template")) return;
          setTplScale((v) => !v);
        }}
        onToggleRotate={() => {
          if (blockProtectedWorkflowMutation("Editing a template")) return;
          setTplRotate((v) => !v);
        }}
        onRemoveSelected={
          selectedTemplate && onRemoveTemplate
            ? () => {
                if (blockProtectedWorkflowMutation("Removing a template")) return;
                onRemoveTemplate(selectedTemplate.id);
                setSelectedTemplateId(null);
                setTplDrag(false);
                setTplScale(false);
                setTplRotate(false);
              }
            : undefined
        }
        onAddLocalTemplateLines={undefined}
        placedTemplates={placedTemplates.map((tpl) => ({ id: tpl.id, fileName: tpl.fileName }))}
        selectedTemplateId={selectedTemplateId}
        onSelectPlacedTemplate={handleSelectPlacedTemplate}
      />
    );
  }

  /**
   * Slice the step tree so Path Order VirtualizedLists are never ScrollView children.
   * - csvUpload: Upload + Templates (local CSV)
   * - localDxfTop: Upload + Align + Templates (local / batch DXF)
   * - csvPathOrder / dxfPathOrder: Path Order & Load (own list scroll)
   * - dxfTop: Upload + Align + Templates (rover DXF)
   */
  function renderFieldsSteps(slice: FieldsStepSlice) {
    const showUpload =
      slice === "csvUpload" || slice === "dxfTop" || slice === "localDxfTop";
    const showCsvPathOrder = slice === "csvPathOrder";
    /**
     * Templates sits above Path Order in every flow. Align (when shown) stays above
     * Templates so a metric DXF is fitted before a sign can be baked into that frame.
     */
    const showTemplatesStep =
      (slice === "csvUpload" && isLocalCsvFlow && !hasLocalBatch) ||
      (slice === "csvUpload" && hasLocalBatch && !isLocalDxfFlow) ||
      (slice === "localDxfTop" && (isLocalDxfFlow || hasLocalBatch)) ||
      (slice === "dxfTop" && !isLocalFlow);
    const showDxfPathOrder = slice === "dxfPathOrder" && !isLocalDxfFlow;
    const activeCsvForSend = activeCsvPreview;
    // Multi-file / local app batch: single Path Order card once every file is verified.
    const showLocalBatchPathOrder =
      showCsvPathOrder &&
      hasLocalBatch &&
      allFilesVerified;
    const showLocalDxfPathOrder =
      showCsvPathOrder && isLocalDxfFlow && !hasLocalBatch;
    const showLocalCsvPathOrder =
      showCsvPathOrder && isLocalCsvFlow && !hasLocalBatch;
    // Only a file that's actually pending gets an Align card — selecting an already-verified
    // file (its pendingDxfAlignment entry is gone) would otherwise fall back to a blank,
    // generic "Align DXF" panel with no indication it's already done.
    //
    // NOTE: unlike every other show* flag here this one carries no `slice` term — it answers
    // "does this batch need aligning", not "does Align belong in this pass". Only ever feed
    // it to shouldRenderAlignCard(), which adds the slice gate.
    const showAlignForBatch =
      hasLocalBatch &&
      (hasPendingAlignment ||
        (selectedUploadedFileId != null &&
          uploadedFiles.some(
            (f) => f.id === selectedUploadedFileId && f.status === "needs_alignment"
          )));

    /**
     * Card numbering per flow:
     *   local CSV   1 Upload · 2 Templates · 3 Path Order & Load
     *   local DXF   1 Upload · 2 Align · 3 Templates · 4 Path Order & Load
     *   multi batch 1 Upload · 2 Align (if needed) · 3 Templates · 4 Path Order
     *   rover DXF   1 Upload · 2 Align · 3 Templates · 4 Path Order & Load
     */
    const stepNo = {
      upload: 1,
      align: 2,
      templates: isLocalCsvFlow && !hasPendingAlignment ? 2 : 3,
      pathOrder: isLocalCsvFlow && !hasPendingAlignment ? 3 : 4,
    };

    return (
      <>
          {/* Step 1: Select file → auto upload/parse → map preview (no manual Parse step) */}
          {showUpload ? (
          <FieldsStepCard
            stepNumber={1}
            title="Upload"
            badge={activeCsvPreview ? "path CSV" : undefined}
            badgeVariant="path"
            status={stepStatus("upload")}
            expanded={isSectionOpen("upload")}
            onToggle={() => toggleSection("upload", "upload")}
            scrollableBody
            bodyMaxHeight={400}
          >
            <UploadAndPreviewStep
              apiBaseUrl={apiBaseUrl}
              importedPlan={importedPlan}
              setImportedPlan={setImportedPlan}
              onRefreshPaths={onRefreshPaths}
              onSelectPath={(name, refreshOnly) => {
                onSelectPath(name);
                // refreshOnly is set by the extension toggle/apply handlers, which call
                // back in here purely to re-fetch `lines` after the backend recomputes
                // extension geometry — they must NOT also flip on plan-editing mode or
                // the map interaction overlay, or the Move/Rotate Plan button lights up
                // uninvited and the live `lines` update gets masked by the frozen
                // plan-editing sticker (see PlanPreview's isPlacedItemActive in App.tsx).
                if (refreshOnly) return;
                // Stay on Upload after import. Operator opens Align DXF
                // (or Bounding Box) when ready — do not auto-jump the accordion.
                setShowMapInteraction(true);
              }}
              onInvalidateWorkflow={onInvalidateWorkflow}
              blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
              protectedResident={protectedResident}
              localCsvPreview={activeCsvPreview}
              localDxfSnapshot={
                (isLocalDxfFlow || hasLocalBatch) && localDxfMeta
                  ? {
                      fileName: localDxfMeta.fileName,
                      unitScale: 1,
                      unitScaleSource: "insunits" as const,
                      insunits: 6,
                      isGeographic: localDxfMeta.isGeographic,
                      geoOrigin:
                        localDxfMeta.isGeographic && geoOrigin
                          ? { lat: geoOrigin[0], lon: geoOrigin[1] }
                          : null,
                      // Mark geometry only — transit/extension are rebuilt on re-parse.
                      lines: lines.filter(
                        (l) =>
                          l.layer !== "transit" &&
                          l.layer !== "extension" &&
                          l.layer !== "virtual_boundary"
                      ),
                      entityCount: lines.filter(
                        (l) =>
                          l.layer !== "transit" &&
                          l.layer !== "extension" &&
                          l.layer !== "virtual_boundary"
                      ).length,
                      ignoredCount: 0,
                      warnings: localDxfMeta.warnings.slice(),
                    }
                  : null
              }
              uploadedFiles={uploadedFiles}
              selectedUploadedFileId={selectedUploadedFileId}
              onSelectUploadedFile={handleSelectUploadedFile}
              onRemoveUploadedFile={(id) => {
                if (blockProtectedWorkflowMutation("Removing a file")) return;
                onRemoveUploadedFile?.(id);
                if (selectedUploadedFileId === id) setSelectedUploadedFileId(null);
                if (selectedTemplateId === id) setSelectedTemplateId(null);
              }}
              onBeginLocalImportBatch={onBeginLocalImportBatch}
              missionLayers={missionLayers}
              controlModeActive={controlModeActive && canUseMissionControl}
              pendingLayerAssignment={pendingLayerAssignment}
              onPendingLayerAssignment={onPendingLayerAssignment}
              onAssignFileToNewLayer={onAssignFileToNewLayer}
              onAssignFileToLayer={onAssignFileToLayer}
              onUnassignFileFromLayer={onUnassignFileFromLayer}
              onLocalDxfParsed={(data) => {
                onLocalDxfParsed?.(data);
                setShowMapInteraction(true);
                setCsvPathOrder(null);
                setCsvExtensionConfig(DEFAULT_CSV_EXTENSION_CONFIG);
                // A georeferenced DXF is already placed, so Align has nothing to do and the
                // operator goes straight to ordering. A metric one cannot be sent until it is
                // aligned (plan-trajectory requires origin_gps), so lead with Align open.
                const placed = data.isGeographic && data.geoOrigin != null;
                setActiveStep(placed ? "upload" : "align");
                openOnlySection(placed ? "upload" : "align");
              }}
              onLocalCsvParsed={(data) => {
                // Flip UI immediately in this screen (do not wait only on App props).
                setMissionCsvPreview(data);
                onLocalCsvParsed?.(data);
                setShowMapInteraction(true);
                setCsvPathOrder(null);
                setCsvExtensionConfig(DEFAULT_CSV_EXTENSION_CONFIG);
                // Land on Upload so the Enable Extension card is the next thing seen.
                // Path Order sits right below as a collapsed header.
                setActiveStep("upload");
                openOnlySection("upload");
              }}
              csvExtensionConfig={csvExtensionConfig}
              extensionStatus={extensionStatus}
              offsetDistanceM={offsetDistanceM}
              offsetBearingDeg={offsetBearingDeg}
              onOffsetDistanceChange={onOffsetDistanceChange}
              onOffsetBearingChange={onOffsetBearingChange}
              onApplyOffset={onApplyOffset}
              offsetTargetOptions={offsetTargetOptions}
              offsetTarget={offsetTarget}
              onOffsetTargetChange={onOffsetTargetChange}
              offsetResetAvailable={offsetResetAvailable}
              onResetOffset={onResetOffset}
              onOffsetDragStateChange={onOffsetDragStateChange}
              onCsvExtensionConfigChange={(next) => {
                setCsvExtensionConfig(next);
                setLines((prev) => {
                  const order =
                    csvPathOrder ??
                    prev
                      .filter(
                        (l) =>
                          l.layer !== "transit" &&
                          l.layer !== "extension" &&
                          l.layer !== "virtual_boundary"
                      )
                      .map((l) => ({
                        lineId: l.id,
                        label: l.label,
                        paint: true as boolean,
                      }));
                  const rebuilt = applyCsvOrderToPlanLines(prev, order, next);
                  const prevSig = prev.map((l) => `${l.id}:${l.layer}`).join("|");
                  const nextSig = rebuilt.map((l) => `${l.id}:${l.layer}`).join("|");
                  if (prevSig === nextSig) {
                    const prevGeom = prev.map((l) => `${l.id}:${l.from.x},${l.from.y}:${l.to.x},${l.to.y}`).join("|");
                    const nextGeom = rebuilt
                      .map((l) => `${l.id}:${l.from.x},${l.from.y}:${l.to.x},${l.to.y}`)
                      .join("|");
                    if (prevGeom === nextGeom) return prev;
                  }
                  return rebuilt;
                });
              }}
              onClearLocalCsv={() => {
                setMissionCsvPreview(null);
                setCsvPathOrder(null);
                setSelectedUploadedFileId(null);
                onClearLocalCsv?.();
              }}
            />
          </FieldsStepCard>
          ) : null}

          {/* (local DXF Align is rendered via shouldRenderAlignCard below) */}

          {/* Local multi-file batch + single CSV/DXF: Path Order once alignment gate passes. */}
          {(showLocalBatchPathOrder ||
            (showLocalCsvPathOrder && activeCsvForSend) ||
            showLocalDxfPathOrder) ? (
            <FieldsStepCard
              stepNumber={stepNo.pathOrder}
              title="Path Order & Load"
              status={
                stagedWorkflow.loaded === "verified" || stagedWorkflow.staged === "verified"
                  ? "done"
                  : "active"
              }
              expanded={isSectionOpen("pathOrder") || isSectionOpen("orderAndSpray")}
              onToggle={() => {
                if (isLocalDxfFlow) toggleSection("orderAndSpray", "orderAndSpray");
                else toggleSection("pathOrder");
              }}
              fillAvailable={
                isSectionOpen("pathOrder") || isSectionOpen("orderAndSpray")
              }
            >
              {/* Send panel rides in the row list's footer so the whole step scrolls as one —
                  the rows are a VirtualizedList and cannot live inside a ScrollView. */}
              <View style={{ flex: 1, minHeight: 0 }}>
                <CsvPathOrderStep
                  lines={lines}
                  extensionConfig={csvExtensionConfig}
                  onOrderChange={(_painted, fullOrder) => {
                    setCsvPathOrder((prev) => {
                      const same =
                        prev != null &&
                        prev.length === fullOrder.length &&
                        prev.every(
                          (e, i) =>
                            e.lineId === fullOrder[i]?.lineId && e.paint === fullOrder[i]?.paint
                        );
                      return same ? prev : fullOrder;
                    });
                    // Rebuild map transit + extensions only when topology changes.
                    setLines((prev) => {
                      const next = applyCsvOrderToPlanLines(
                        prev,
                        fullOrder,
                        csvExtensionConfig
                      );
                      const prevSig = prev.map((l) => `${l.id}:${l.layer}`).join("|");
                      const nextSig = next.map((l) => `${l.id}:${l.layer}`).join("|");
                      return prevSig === nextSig ? prev : next;
                    });
                  }}
                  listFooter={
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: FIELDS_COLORS.panelBorder,
                        paddingTop: 12,
                      }}
                    >
                      <AnchorPanel
                        anchorAvailable={anchorAvailable}
                        anchorSelectMode={anchorSelectMode}
                        anchorTargetOptions={anchorTargetOptions}
                        anchorTarget={anchorTarget}
                        pendingAnchor={pendingAnchor}
                        onAnchorPress={onAnchorPress}
                        onSelectAnchorTarget={onSelectAnchorTarget}
                        onConfirmAnchor={onConfirmAnchor}
                      />
                      <CsvStageAndLoadPanel
                        apiBaseUrl={apiBaseUrl}
                        sourceKind={
                          batchHasDxf ||
                          isLocalDxfFlow ||
                          (hasLocalBatch && uploadedFiles.length > 1)
                            ? "dxf"
                            : "csv"
                        }
                        localCsvPreview={
                          batchHasDxf || isLocalDxfFlow || uploadedFiles.length > 1
                            ? null
                            : activeCsvForSend
                        }
                        mapPinCount={localCsvMapPins?.length ?? null}
                        lines={lines}
                        missionLayers={missionLayers}
                        uploadedFiles={uploadedFiles}
                        pathOrder={csvPathOrder}
                        extensionConfig={csvExtensionConfig}
                        originGps={
                          sharedOriginGps ??
                          (verifiedAlignmentRequest?.origin_gps
                            ? (verifiedAlignmentRequest.origin_gps as [number, number])
                            : null)
                        }
                        roverPose={
                          telemetrySnapshot
                            ? {
                                pos_n: telemetrySnapshot.pos_n,
                                pos_e: telemetrySnapshot.pos_e,
                                lat: telemetrySnapshot.lat,
                                lon: telemetrySnapshot.lon,
                                gps_fix: telemetrySnapshot.gps_fix,
                                pose_age_ms: telemetrySnapshot.pose_age_ms,
                              }
                            : null
                        }
                        onAppPlannedStartSnapshot={onAppPlannedStartSnapshot}
                        missionName={
                          hasLocalBatch || isLocalDxfFlow
                            ? localDxfMeta?.fileName ??
                              importedPlan?.fileName ??
                              (batchHasCsv ? activeCsvForSend?.fileName : null) ??
                              "mission"
                            : null
                        }
                        parseWarnings={
                          isLocalDxfFlow || batchHasDxf
                            ? localDxfMeta?.warnings ?? []
                            : []
                        }
                        setLines={setLines}
                        onSelectLine={onSelectLine}
                        setStagedMissionId={setStagedMissionId}
                        setStagedPlanResult={setStagedPlanResult}
                        setStagedMissionInspection={setStagedMissionInspection}
                        setAlignedRefPoints={setAlignedRefPoints}
                        onWorkflowStep={onWorkflowStep}
                        onLoadSelectedPath={onLoadSelectedPath}
                        missionActionBusy={missionActionBusy}
                        onBeginPathExclusive={onBeginPathExclusive}
                        onEndPathExclusive={onEndPathExclusive}
                      />
                    </View>
                  }
                />
              </View>
            </FieldsStepCard>
          ) : showCsvPathOrder ? (
            <FieldsStepCard
              stepNumber={stepNo.pathOrder}
              title="Path Order & Load"
              status="pending"
              expanded={isSectionOpen("pathOrder")}
              onToggle={() => toggleSection("pathOrder")}
            >
              <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 16 }}>
                Load a survey CSV or DXF first, then order paths, review transit, and verify & load.
              </Text>
            </FieldsStepCard>
          ) : null}

          {/* Align DXF — rover DXF, local metric DXF, or multi-file pending file. */}
          {shouldRenderAlignCard({
            slice,
            isDxfPath: !!isDxfPath,
            needsBatchAlignment: showAlignForBatch,
          }) && (
          <FieldsStepCard
            stepNumber={stepNo.align}
            title={
              selectedPending
                ? `Align · ${selectedPending.fileName}`
                : "Align DXF"
            }
            badge={
              refPoints.length > 0
                ? `${refPoints.length} guide${refPoints.length === 1 ? "" : "s"}`
                : undefined
            }
            status={stepStatus("align")}
            expanded={isSectionOpen("align")}
            onToggle={() => toggleSection("align", "align")}
            disabled={!hasPath}
            scrollableBody
            bodyMaxHeight={420}
          >
            <AlignDxfPanel
              apiBaseUrl={apiBaseUrl}
              selectedPathName={selectedPending ? null : selectedPathName}
              lines={selectedPending ? selectedPending.rawLines : lines}
              setLines={selectedPending ? setPendingAlignLines : setLines}
              alignmentResult={alignmentResult}
              setAlignmentResult={setAlignmentResult}
              setVerifiedAlignmentRequest={setVerifiedAlignmentRequest}
              setAlignedRefPoints={setAlignedRefPoints}
              onWorkflowStep={onWorkflowStep}
              onInvalidateWorkflow={onInvalidateWorkflow}
              blockProtectedWorkflowMutation={blockProtectedWorkflowMutation}
              refPoints={refPoints}
              setRefPoints={setRefPoints}
              csvGuidePointsActive={csvGuidePointsActive}
              setCsvGuidePointsActive={setCsvGuidePointsActive}
              guideCsvFileNames={guideCsvFileNames}
              setGuideCsvFileNames={setGuideCsvFileNames}
              alignmentMethod={alignmentMethod}
              setAlignmentMethod={setAlignmentMethod}
              setMissionSummary={setMissionSummary}
              isVisualAlignmentMode={isVisualAlignmentMode}
              visualAlignmentItem={visualAlignmentItem}
              setVisualAlignmentItem={setVisualAlignmentItem}
              setVisualAlignmentAnchor={setVisualAlignmentAnchor}
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
              onFitToReferencePoints={onFitToReferencePoints}
              focusedGuidePointIndex={focusedGuidePointIndex}
              onFocusedGuidePointIndexChange={setFocusedGuidePointIndex}
              onLocalFixApplied={
                effectiveAlignFileId &&
                selectedPending &&
                onCommitDxfFileAlignment
                  ? (result) => {
                      onCommitDxfFileAlignment(
                        effectiveAlignFileId,
                        result.alignedLines,
                        result.originGps,
                        {
                          scale: result.scale,
                          rotationDeg: result.rotationDeg,
                          rmseM: result.rmseM,
                        }
                      );
                      resetWorkingAlignState();
                      setSelectedUploadedFileId(null);
                      openOnlySection("upload");
                      setActiveStep("upload");
                    }
                  : undefined
              }
            />
          </FieldsStepCard>
          )}

          {/* Templates — above Path Order in every flow; after Align when Align is shown. */}
          {showTemplatesStep ? (
          <FieldsStepCard
            stepNumber={stepNo.templates}
            title="Templates"
            status={isSectionOpen("templates") ? "active" : "pending"}
            expanded={isSectionOpen("templates")}
            onToggle={() => toggleSection("templates")}
            scrollableBody
            bodyMaxHeight={380}
          >
            <View
              style={{
                borderRadius: 10,
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
                padding: 12,
              }}
            >
              {renderTemplatePanel()}
            </View>
          </FieldsStepCard>
          ) : null}

          {/* Path Order & Load — DXF/waypoints; hosted outside page ScrollView */}
          {showDxfPathOrder && (
          <FieldsStepCard
            stepNumber={stepNo.pathOrder}
            title="Path Order & Load"
            status={stepStatus("orderAndSpray")}
            expanded={isSectionOpen("orderAndSpray")}
            onToggle={() => toggleSection("orderAndSpray", "orderAndSpray")}
            disabled={!hasPath}
            fillAvailable={isSectionOpen("orderAndSpray")}
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
              isGeographicDxf={isGeographicDxf}
              onWorkflowStep={onWorkflowStep}
              setSegmentVerification={setSegmentVerification}
              setStagedPlanResult={setStagedPlanResult}
              setStagedMissionInspection={setStagedMissionInspection}
              setStagedMissionId={setStagedMissionId}
              onLoadSelectedPath={onLoadSelectedPath}
              missionActionBusy={missionActionBusy}
              onBeginPathExclusive={onBeginPathExclusive}
              onEndPathExclusive={onEndPathExclusive}
              onNavigateHome={handleNavigateHome}
              extensionVisible={layerVisibility.extension !== false}
              onToggleExtensionVisible={handleToggleExtensionVisible}
              highlightLineIds={highlightLineIds}
              extPre={extPre}
              extAft={extAft}
              extensionsEnabled={extensionsEnabled}
            />
          </FieldsStepCard>
          )}
      </>
    );
  }
}
