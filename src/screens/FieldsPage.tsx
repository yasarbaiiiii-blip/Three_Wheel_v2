import React, { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";

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
import { CsvPathOrderStep } from "../components/fields/panels/CsvPathOrderStep";
import { CsvStageAndLoadPanel } from "../components/fields/panels/CsvStageAndLoadPanel";
import { PathOrderAndSprayStep } from "../components/fields/panels/PathOrderAndSprayStep";
import { TemplatePanel } from "../components/fields/panels/TemplatePanel";
import { UploadAndPreviewStep } from "../components/fields/panels/UploadAndPreviewStep";
import { useFieldsWorkflow } from "../hooks/useFieldsWorkflow";
import { parseGuidePointsCsv } from "../utils/refPointsCsv";
import { designObbFromLines } from "../utils/planResizeHandles";
import { DXF_PLANNER } from "../config/featureFlags";
import {
  applyCsvOrderToPlanLines,
  type CsvPathOrderEntry,
} from "../utils/csvPathOrder";
import {
  DEFAULT_CSV_EXTENSION_CONFIG,
  type CsvExtensionConfig,
} from "../utils/csvExtensions";
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
  onLoadSelectedPath: (missionId?: string) => boolean | Promise<boolean>;
  missionActionBusy: boolean;
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
  }) => React.ReactNode;
  localCsvPreview?: LocalPointCsvResult | null;
  onLocalCsvParsed?: (data: LocalPointCsvResult) => void;
  onLocalDxfParsed?: (data: import("../utils/dxfLocalImport").LocalDxfResult) => void;
  onClearLocalCsv?: () => void;
};

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

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
    onLocalCsvParsed,
    onLocalDxfParsed,
    onClearLocalCsv,
  } = props;

  const [refPoints, setRefPoints] = useState<RefPoint[]>([]);
  /** Which Multi-Point guide row should show Lat/Lon focus (map pin tap). */
  const [focusedGuidePointIndex, setFocusedGuidePointIndex] = useState<number | null>(null);
  /**
   * True after a Multi-Point guide-points CSV is loaded. While active, map tap-to-pick
   * is disabled (CSV is the sole source of ref markers). Cleared with Clear Points /
   * method change / empty list.
   */
  const [csvGuidePointsActive, setCsvGuidePointsActive] = useState(false);
  /** Original guide CSV file name for Upload/Align button labels (not “Reference Points”). */
  const [guideCsvFileName, setGuideCsvFileName] = useState<string | null>(null);
  const [isImportingRefPointsCsv, setIsImportingRefPointsCsv] = useState(false);
  const [missionSummary, setMissionSummary] = useState<any | null>(null);
  /** Align DXF methods: Multi-Point Fit | Visual (1-Point Fit removed). Auto Origin is a separate toggle peer. */
  const [alignmentMethod, setAlignmentMethod] = useState<"least_squares" | "visual_alignment">("least_squares");

  /** DXF nested Templates sub-panel under Bounding Box (not a top-level step card). */
  const [showTemplates, setShowTemplates] = useState(false);
  /** CSV path order / paint flags from CsvPathOrderStep (Phase 3). */
  const [csvPathOrder, setCsvPathOrder] = useState<CsvPathOrderEntry[] | null>(null);
  /** Local CSV PRE/AFT extensions (app-owned; not saved via /extensions). */
  const [csvExtensionConfig, setCsvExtensionConfig] = useState<CsvExtensionConfig>(
    DEFAULT_CSV_EXTENSION_CONFIG
  );
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

  /**
   * Independent click-to-expand state for each step card (true dropdowns).
   * Separate from `activeStep`, which still drives map/align gating.
   */
  type PanelSectionKey =
    | "upload"
    | "pathOrder"
    | "templates"
    | "send"
    | "boundingBox"
    | "align"
    | "orderAndSpray";
  const [openSections, setOpenSections] = useState<Record<PanelSectionKey, boolean>>({
    upload: true,
    pathOrder: true,
    templates: false,
    send: true,
    boundingBox: false,
    align: false,
    orderAndSpray: false,
  });
  const isSectionOpen = useCallback(
    (key: PanelSectionKey) => openSections[key] === true,
    [openSections]
  );
  const toggleSection = useCallback(
    (key: PanelSectionKey, activateStep?: FieldsStepId) => {
      setOpenSections((prev) => {
        const opening = !prev[key];
        if (opening && activateStep) {
          setActiveStep(activateStep);
        }
        return { ...prev, [key]: opening };
      });
    },
    [setActiveStep]
  );

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
   * Lets the operator add reference points right after uploading the plan, instead of only
   * discovering the CSV guide-point uploader once they open the Align step. Reuses the same
   * shared CSV parser as AlignDxfPanel's own "Upload CSV" button; jumps the stepper to Align
   * once points are loaded so the newly-visible map dots are the very next thing shown.
   */
  const handleImportRefPointsCsvFromUpload = useCallback(async () => {
    if (blockProtectedWorkflowMutation("Importing reference points")) return;

    let asset: DocumentPicker.DocumentPickerAsset | null = null;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["*/*"], copyToCacheDirectory: true });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      asset = result.assets[0];
    } catch (err) {
      console.log("[Upload][RefPointsCSV] Error picking CSV:", err);
      Alert.alert("Error", "Could not open the file picker.");
      return;
    }

    const ext = asset.name.split(".").pop()?.toLowerCase();
    if (ext !== "csv") {
      Alert.alert("Invalid File", "Please select a .csv file.");
      return;
    }

    setIsImportingRefPointsCsv(true);
    try {
      let text: string;
      if (Platform.OS === "web") {
        const webFile = (asset as any).file ?? (await (await fetch(asset.uri)).blob());
        text = await webFile.text();
      } else {
        text = await (await fetch(asset.uri)).text();
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      const { points, errors } = parseGuidePointsCsv(text);
      if (points.length === 0) {
        Alert.alert("Import Failed", errors[0] ?? "No valid Latitude/Longitude rows were found in the file.");
        return;
      }

      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      setRefPoints(points.map((p) => ({ dxf_x: 0, dxf_y: 0, lat: p.latRaw, lon: p.lonRaw })));
      setCsvGuidePointsActive(true);
      setGuideCsvFileName(asset.name || "guide.csv");
      setActiveStep("align");
      setOpenSections((prev) => ({
        ...prev,
        upload: false,
        align: true,
        boundingBox: false,
      }));

      if (errors.length > 0) {
        Alert.alert(
          "Imported With Warnings",
          `${points.length} point(s) imported. ${errors.length} row(s) skipped:\n${errors.slice(0, 5).join("\n")}${
            errors.length > 5 ? `\n…and ${errors.length - 5} more` : ""
          }`
        );
      } else {
        Alert.alert(
          "Guide CSV Loaded",
          `${points.length} point(s) from ${asset.name}. Open Align → Move / Rotate Plan, then Resize if needed.`
        );
      }
    } catch (err) {
      console.log("[Upload][RefPointsCSV] Error importing CSV:", err);
      Alert.alert("Error", "Could not read or parse the selected CSV file.");
    } finally {
      setIsImportingRefPointsCsv(false);
    }
  }, [
    blockProtectedWorkflowMutation,
    onInvalidateWorkflow,
    setAlignmentResult,
    setVerifiedAlignmentRequest,
    setActiveStep,
  ]);

  /**
   * Map tap → yellow guide points. Enabled ONLY for Multi-Point Fit when:
   * - Align step is active
   * - not Visual Alignment / Auto Origin
   * - not mid Move-Plan sticker drag
   * - no CSV guide file is loaded
   */
  const canTapGuidePoints =
    activeStep === "align" &&
    alignmentMethod === "least_squares" &&
    !autoOrigin &&
    !isVisualAlignmentMode &&
    !isPlanEditingMode &&
    !csvGuidePointsActive;

  const handleSelectPoint = useCallback(
    (pt: { x: number; y: number }) => {
      if (
        activeStep !== "align" ||
        alignmentMethod !== "least_squares" ||
        autoOrigin ||
        isVisualAlignmentMode ||
        isPlanEditingMode ||
        csvGuidePointsActive
      ) {
        console.log(
          `[AlignDXF][Tap] Ignored (gated): step=${activeStep} method=${alignmentMethod} autoOrigin=${!!autoOrigin} visual=${!!isVisualAlignmentMode} editing=${!!isPlanEditingMode} csv=${csvGuidePointsActive}`
        );
        return;
      }
      console.log(`[AlignDXF][Tap] Map tapped: pt.x(north)=${pt.x} pt.y(east)=${pt.y}`);
      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
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
      activeStep,
      alignmentMethod,
      autoOrigin,
      isVisualAlignmentMode,
      isPlanEditingMode,
      csvGuidePointsActive,
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
  // Determine step statuses
  const hasPath = !!selectedPathName || !!importedPlan || activeCsvPreview != null;
  const uploadDone = hasPath;
  const isDxfPath = importedPlan?.fileType === "dxf" || selectedPathName?.toLowerCase().endsWith(".dxf");
  const planLooksLikeCsv =
    importedPlan?.fileType === "csv" ||
    !!importedPlan?.fileName?.toLowerCase().endsWith(".csv");
  const isLocalCsvFlow = activeCsvPreview != null || planLooksLikeCsv;
  /** Local DXF: parsed on device (DXF_PLANNER=app), no selectedPathName on rover. */
  const isLocalDxfFlow =
    DXF_PLANNER === "app" &&
    isDxfPath &&
    !selectedPathName &&
    importedPlan?.fileType === "dxf";
  const isLocalFlow = isLocalCsvFlow || isLocalDxfFlow;
  const alignDone =
    isLocalCsvFlow ||
    !isDxfPath ||
    stagedWorkflow.alignment === "verified" ||
    !!verifiedAlignmentRequest ||
    autoOrigin ||
    isGeographicDxf;

  /**
   * Upload-plan CSV pins: same direct lat/lon draw path as guide/ref points
   * (MapView selectedPointsFC). Always shown while a local CSV is loaded —
   * not gated on Align step (Align is hidden for local CSV).
   */
  const localCsvMapPins = useMemo(() => {
    if (!activeCsvPreview || activeCsvPreview.points.length === 0) return null;
    return localCsvToMapPins(activeCsvPreview);
  }, [activeCsvPreview]);

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

  /** Legacy helper — prefer toggleSection for card headers (true expand/collapse). */
  const toggleStep = (id: FieldsStepId) => {
    const key: PanelSectionKey =
      id === "boundingBox"
        ? "boundingBox"
        : id === "align"
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
      {/* Map preview — full screen background */}
      <View style={{ ...StyleSheet.absoluteFillObject, zIndex: 1, backgroundColor: FIELDS_COLORS.bgBase }}>
        {renderPlanPreview({
          lines,
          mapSourceLines,
          autoOriginReference,
          mapGeometryFrame,
          autoOriginEnabled,
          geoOrigin,
          visibility: effectiveLayerVisibility,
          selectedLineId,
          onSelectLine,
          highlightLineIds,
          roverPosN: previewRoverPoint?.north ?? null,
          roverPosE: previewRoverPoint?.east ?? null,
          roverHeadingDeg: telemetrySnapshot?.heading_ned_deg ?? null,
          selectedPoints: localCsvMapPins
            ? localCsvMapPins
            : activeStep === "align"
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
          onSelectPoint: localCsvMapPins
            ? undefined
            : canTapGuidePoints
              ? handleSelectPoint
              : undefined,
          onGuidePointFocus: localCsvMapPins
            ? undefined
            : canTapGuidePoints
              ? handleGuidePointFocus
              : undefined,
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
          sketchMode,
          showBoundaryPoints: showSnapPoints,
          snapRefPoints:
            activeStep === "align" && alignmentMethod === "least_squares"
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
          <ScrollView
            style={{
              flexGrow: 0,
              flexShrink: 1,
              maxHeight: isSectionOpen("upload") || isSectionOpen("align") ? 420 : undefined,
            }}
            contentContainerStyle={{ gap: 8 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator={isSectionOpen("upload") || isSectionOpen("align")}
          >
            {renderFieldsSteps(isLocalDxfFlow ? "localDxfTop" : "csvUpload")}
          </ScrollView>
          {/* Path order list (VirtualizedList) + Verify & Load — outside ScrollView. */}
          {renderFieldsSteps("csvPathOrder")}
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1, maxHeight: isSectionOpen("templates") ? 360 : undefined }}
            contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator={isSectionOpen("templates")}
          >
            {renderFieldsSteps("csvScroll")}
          </ScrollView>
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
          <ScrollView
            style={{
              flexGrow: 0,
              flexShrink: 1,
              maxHeight: isSectionOpen("orderAndSpray") ? 280 : undefined,
            }}
            contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator
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
   * Templates body, shared by the two places it can appear: nested under Bounding Box in the
   * rover-planned DXF flow, and as its own trailing step in both local flows.
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
          setOpenSections((prev) => ({ ...prev, align: true, boundingBox: false }));
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
        placementMode={isLocalFlow ? "csvLocal" : "dxf"}
        onAddLocalTemplateLines={
          isLocalFlow
            ? (templateLines) => {
                setLines((prev) => {
                  const existingMarks = prev.filter(
                    (l) => l.layer !== "transit" && l.layer !== "extension"
                  );
                  const marks = [...existingMarks, ...templateLines];
                  const order =
                    csvPathOrder ??
                    marks.map((l) => ({
                      lineId: l.id,
                      label: l.label,
                      paint: true as boolean,
                    }));
                  return applyCsvOrderToPlanLines(marks, order, csvExtensionConfig);
                });
                setShowMapInteraction(true);
              }
            : undefined
        }
      />
    );
  }

  /**
   * Slice the step tree so Path Order VirtualizedLists are never ScrollView children.
   * - csvUpload / csvPathOrder / csvScroll: local-flow sections (CSV and local DXF)
   * - localDxfTop: Upload + Align (scrollable) — no Bounding Box
   * - dxfTop: Upload + Bounding Box + Align (scrollable)
   * - dxfPathOrder: Path Order & Load (flex fill, own list scroll)
   */
  function renderFieldsSteps(
    slice: "csvUpload" | "csvPathOrder" | "csvScroll" | "dxfTop" | "dxfPathOrder" | "localDxfTop"
  ) {
    const showUpload =
      slice === "csvUpload" || slice === "dxfTop" || slice === "localDxfTop";
    const showCsvPathOrder = slice === "csvPathOrder";
    /**
     * Bounding Box is a placement aid for the ROVER-planned DXF flow only. Both local flows
     * drop it: a survey CSV carries its own georeference, and a local DXF is placed by the
     * Align step. It renders only in the rover-DXF top slice, with Templates nested under it.
     */
    const showBoundingBox = slice === "dxfTop" && !isLocalFlow;
    /**
     * Local flows get Templates as their own trailing step, after Path Order. It must come
     * after Align: `placeTemplateLinesInCsvFrame` positions strokes relative to the rover's
     * live position, which is an already-aligned frame — placing them before Align would let
     * the alignment transform move them again.
     */
    const showTemplatesStep = slice === "csvScroll" && isLocalFlow;
    const showDxfAlign = slice === "dxfTop" || slice === "localDxfTop";
    const showDxfPathOrder = slice === "dxfPathOrder" && !isLocalDxfFlow;
    const activeCsvForSend = activeCsvPreview;
    const showLocalDxfPathOrder = showCsvPathOrder && isLocalDxfFlow;
    const showLocalCsvPathOrder = showCsvPathOrder && isLocalCsvFlow;

    /**
     * Card numbering per flow:
     *   local CSV   1 Upload · 2 Path Order & Load · 3 Templates
     *   local DXF   1 Upload · 2 Align · 3 Path Order & Load · 4 Templates
     *   rover DXF   1 Upload · 2 Bounding Box · 3 Align · 4 Path Order & Load
     */
    const stepNo = {
      upload: 1,
      boundingBox: 2,
      align: isLocalDxfFlow ? 2 : 3,
      pathOrder: isLocalCsvFlow ? 2 : isLocalDxfFlow ? 3 : 4,
      templates: isLocalCsvFlow ? 3 : 4,
    };

    return (
      <>
          {/* Step 1: Select file → auto upload/parse → map preview (no manual Parse step) */}
          {showUpload ? (
          <FieldsStepCard
            stepNumber={1}
            title="Upload"
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
              onLocalDxfParsed={(data) => {
                onLocalDxfParsed?.(data);
                setShowMapInteraction(true);
                setCsvPathOrder(null);
                setCsvExtensionConfig(DEFAULT_CSV_EXTENSION_CONFIG);
                setShowTemplates(false);
                // A georeferenced DXF is already placed, so Align has nothing to do and the
                // operator goes straight to ordering. A metric one cannot be sent until it is
                // aligned (plan-trajectory requires origin_gps), so lead with Align open.
                const placed = data.isGeographic && data.geoOrigin != null;
                setActiveStep(placed ? "upload" : "align");
                setOpenSections((prev) => ({
                  ...prev,
                  upload: true,
                  align: !placed,
                  boundingBox: false,
                  pathOrder: placed,
                  templates: false,
                  send: false,
                }));
              }}
              onLocalCsvParsed={(data) => {
                // Flip UI immediately in this screen (do not wait only on App props).
                setMissionCsvPreview(data);
                onLocalCsvParsed?.(data);
                setShowMapInteraction(true);
                setCsvPathOrder(null);
                setCsvExtensionConfig(DEFAULT_CSV_EXTENSION_CONFIG);
                // Keep Upload expanded so CSV Enable Extension stays visible.
                // Path Order is available below; do not auto-collapse Upload.
                setShowTemplates(false);
                setActiveStep("upload");
                setOpenSections((prev) => ({
                  ...prev,
                  upload: true,
                  pathOrder: true,
                  templates: false,
                  send: false,
                }));
              }}
              csvExtensionConfig={csvExtensionConfig}
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
                  return applyCsvOrderToPlanLines(prev, order, next);
                });
              }}
              onClearLocalCsv={() => {
                setMissionCsvPreview(null);
                setCsvPathOrder(null);
                onClearLocalCsv?.();
              }}
              onImportRefPointsCsv={handleImportRefPointsCsvFromUpload}
              isImportingRefPointsCsv={isImportingRefPointsCsv}
              guideCsvFileName={guideCsvFileName}
              hideGuideCsvImport={isLocalCsvFlow}
            />
          </FieldsStepCard>
          ) : null}

          {/* (local DXF Align is rendered via showDxfAlign below) */}

          {/* Local CSV / local DXF: paths + paint + transit + Verify & Load (plan-trajectory). */}
          {(showLocalCsvPathOrder && activeCsvForSend) || showLocalDxfPathOrder ? (
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
              <View style={{ flex: 1, minHeight: 0, gap: 14 }}>
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
                />
                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: FIELDS_COLORS.panelBorder,
                    paddingTop: 12,
                    flexShrink: 0,
                  }}
                >
                  <CsvStageAndLoadPanel
                    apiBaseUrl={apiBaseUrl}
                    localCsvPreview={activeCsvForSend}
                    mapPinCount={localCsvMapPins?.length ?? null}
                    lines={lines}
                    pathOrder={csvPathOrder}
                    extensionConfig={csvExtensionConfig}
                    originGps={
                      isLocalDxfFlow && verifiedAlignmentRequest?.origin_gps
                        ? (verifiedAlignmentRequest.origin_gps as [number, number])
                        : null
                    }
                    missionName={
                      isLocalDxfFlow
                        ? importedPlan?.fileName ?? "dxf_mission"
                        : null
                    }
                    parseWarnings={[]}
                    setLines={setLines}
                    onSelectLine={onSelectLine}
                    setStagedMissionId={setStagedMissionId}
                    setStagedPlanResult={setStagedPlanResult}
                    setStagedMissionInspection={setStagedMissionInspection}
                    setAlignedRefPoints={setAlignedRefPoints}
                    onWorkflowStep={onWorkflowStep}
                    onLoadSelectedPath={onLoadSelectedPath}
                    missionActionBusy={missionActionBusy}
                  />
                </View>
              </View>
            </FieldsStepCard>
          ) : showCsvPathOrder ? (
            <FieldsStepCard
              stepNumber={2}
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

          {/* Step: Bounding Box — ROVER-planned DXF only, with Templates nested under it. */}
          {showBoundingBox ? (
          <FieldsStepCard
            stepNumber={stepNo.boundingBox}
            title="Bounding Box"
            status={stepStatus("boundingBox")}
            expanded={isSectionOpen("boundingBox")}
            onToggle={() => toggleSection("boundingBox", "boundingBox")}
            scrollableBody
            bodyMaxHeight={380}
          >
            <View style={{ gap: 14 }}>
              <BoundingBoxStep
                widthStr={boundaryWidthStr}
                onChangeWidthStr={setBoundaryWidthStr}
                heightStr={boundaryHeightStr}
                onChangeHeightStr={setBoundaryHeightStr}
                onApplyBoundary={handleApplyBoundary}
                activeWidth={activeBoundaryWidth}
                activeHeight={activeBoundaryHeight}
                onProceedNext={() => setActiveStep("align")}
              />

              <View>
                <Pressable
                  onPress={() => setShowTemplates(!showTemplates)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingVertical: 8,
                  }}
                >
                  {showTemplates ? (
                    <ChevronDown size={14} color={FIELDS_COLORS.textMuted} />
                  ) : (
                    <ChevronRight size={14} color={FIELDS_COLORS.textDim} />
                  )}
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "700" }}>
                    Templates
                  </Text>
                </Pressable>
                {showTemplates ? (
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
                ) : (
                  <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 16 }}>
                    Optional. Expand Templates under this step for road / field stamps.
                  </Text>
                )}
              </View>
            </View>
          </FieldsStepCard>
          ) : null}

          {/* Step: Templates — trailing step for both local flows (after Align + Path Order). */}
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

          {/* Align DXF — DXF only (scrollable top section) */}
          {showDxfAlign && isDxfPath && (
          <FieldsStepCard
            stepNumber={stepNo.align}
            title="Align DXF"
            status={stepStatus("align")}
            expanded={isSectionOpen("align")}
            onToggle={() => toggleSection("align", "align")}
            disabled={!hasPath}
            scrollableBody
            bodyMaxHeight={420}
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
              csvGuidePointsActive={csvGuidePointsActive}
              setCsvGuidePointsActive={setCsvGuidePointsActive}
              guideCsvFileName={guideCsvFileName}
              setGuideCsvFileName={setGuideCsvFileName}
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
            />
          </FieldsStepCard>
          )}

          {/* Path Order & Load — DXF/waypoints; hosted outside page ScrollView */}
          {showDxfPathOrder && (
          <FieldsStepCard
            stepNumber={4}
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
