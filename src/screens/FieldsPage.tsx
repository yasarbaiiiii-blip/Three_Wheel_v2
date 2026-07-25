import React, { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
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
import { PathOrderAndSprayStep } from "../components/fields/panels/PathOrderAndSprayStep";
import { TemplatePanel } from "../components/fields/panels/TemplatePanel";
import { UploadAndPreviewStep } from "../components/fields/panels/UploadAndPreviewStep";
import { useFieldsWorkflow } from "../hooks/useFieldsWorkflow";
import { parseGuidePointsCsv } from "../utils/refPointsCsv";
import { classifyCsvFlow, hidesLoadStep } from "../utils/csvFlowKind";
import { designObbFromLines } from "../utils/planResizeHandles";
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
   * parent — reused here so the Path Order & Load Extension row shows the same values
   * as Step 1's Upload panel without a second fetch. */
  extPre?: string;
  extAft?: string;
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

  // Determine step statuses
  const hasPath = !!selectedPathName || !!importedPlan;
  const uploadDone = hasPath;
  // Pre-line = a SURVEY line CSV: uploaded to the rover, previewed via /preview,
  // staged and driven. Distinct from a LOCAL point CSV, which is parsed on-device
  // and never reaches the controller. Both have fileType "csv", so without this
  // flag the page cannot tell them apart — and the load step below was hidden for
  // both, making a pre-line CSV impossible to load.
  const [preLineCsvMode, setPreLineCsvMode] = useState(false);
  const isDxfPath = importedPlan?.fileType === "dxf" || selectedPathName?.toLowerCase().endsWith(".dxf");
  const csvFlowKind = classifyCsvFlow({
    localCsvPreview,
    fileType: importedPlan?.fileType ?? null,
    preLineCsvMode,
  });
  const isLocalCsvFlow = hidesLoadStep(csvFlowKind);
  // Align DXF is hidden for a non-DXF source, so the load step must not keep
  // a hardcoded 4 — a pre-line CSV would read "1, 2, 4".
  const orderStepNumber = !isLocalCsvFlow && isDxfPath ? 4 : 3;
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
    if (!localCsvPreview || localCsvPreview.points.length === 0) return null;
    return localCsvToMapPins(localCsvPreview);
  }, [localCsvPreview]);

  const stepStatus = (id: FieldsStepId): "pending" | "active" | "done" => {
    switch (id) {
      case "templates":
        // No completion criterion — picking a template is optional, so this step
        // is only ever active or pending. (It reported "done" off the bounding
        // box dimensions before that panel was removed from this page.)
        return activeStep === "templates" ? "active" : "pending";
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
    setActiveStep(activeStep === id ? "upload" : id);
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
        <View style={{ flex: 1, minHeight: 0, padding: 12, gap: 10, paddingBottom: 24 }}>
          {/* Step 1: Select file → auto upload/parse → map preview (no manual Parse step) */}
          <FieldsStepCard
            stepNumber={1}
            title="Upload"
            status={stepStatus("upload")}
            expanded={activeStep === "upload"}
            onToggle={() => toggleStep("upload")}
          >
            <UploadAndPreviewStep
              preLineCsvMode={preLineCsvMode}
              onChangePreLineCsvMode={setPreLineCsvMode}
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
              onLocalCsvParsed={(data) => {
                onLocalCsvParsed?.(data);
                // Same as onSelectPath success: show map interaction for local points.
                setShowMapInteraction(true);
              }}
              onClearLocalCsv={onClearLocalCsv}
              onImportRefPointsCsv={handleImportRefPointsCsvFromUpload}
              isImportingRefPointsCsv={isImportingRefPointsCsv}
              guideCsvFileName={guideCsvFileName}
            />
          </FieldsStepCard>

          {/* Step 2: Templates */}
          {/* Bounding Box was removed from this page; Templates was nested
              inside its card and is an independent feature, so it keeps its
              own step here rather than disappearing with it. The boundary
              state it still takes (boundaryMode / boundaryWidthStr / ...) is
              retained for exactly that reason. */}
          <FieldsStepCard
            stepNumber={2}
            title="Templates"
            status={stepStatus("templates")}
            expanded={activeStep === "templates"}
            onToggle={() => toggleStep("templates")}
          >
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
          </FieldsStepCard>

          {/* Step 3: Align DXF — visible after plan is loaded, hidden for local CSV and non-DXF files */}
          {!isLocalCsvFlow && isDxfPath && (
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

          {/* Step 4: Path Order & Load — DXF/waypoints only (local CSV never stages to the rover) */}
          {!isLocalCsvFlow && (
          <FieldsStepCard
            stepNumber={orderStepNumber}
            title="Path Order & Load"
            status={stepStatus("orderAndSpray")}
            expanded={activeStep === "orderAndSpray"}
            onToggle={() => toggleStep("orderAndSpray")}
            disabled={!hasPath}
            // Own scrolling list (DraggableFlatList) — fill leftover panel height so the
            // list viewport is bounded and can scroll; do not use scrollableBody here
            // (nested VirtualizedList inside ScrollView breaks list scroll).
            fillAvailable={activeStep === "orderAndSpray"}
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
            />
          </FieldsStepCard>
          )}

          {/* Local CSV — preview only (no backend upload / plan-and-stage). */}
          {isLocalCsvFlow && localCsvPreview && (
            <FieldsStepCard
              stepNumber={3}
              title="CSV Preview"
              status="done"
              expanded={true}
              onToggle={() => {}}
            >
              <View style={{ gap: 10 }}>
                <Text style={{ color: "#a1a1aa", fontSize: 12, lineHeight: 17 }}>
                  Local preview only — this file is not uploaded to the rover.{"\n"}
                  {localCsvPreview.num_points} point
                  {localCsvPreview.num_points === 1 ? "" : "s"} ·{" "}
                  {localCsvPreview.kind === "gps"
                    ? "GPS pins at CSV lat/lon (same as guide CSV)"
                    : "NED metres path"}
                  {"\n"}
                  Frame: {localCsvPreview.point_source_frame}
                  {localCsvPreview.kind === "gps" && localCsvPreview.anchor
                    ? `\nAnchor: ${localCsvPreview.anchor.lat.toFixed(6)}, ${localCsvPreview.anchor.lon.toFixed(6)}`
                    : ""}
                  {localCsvMapPins && localCsvMapPins.length < localCsvPreview.num_points
                    ? `\nMap shows ${localCsvMapPins.length} pins (sampled) + full path line.`
                    : ""}
                </Text>
                {localCsvPreview.warnings.length > 0 ? (
                  <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}>
                    {localCsvPreview.warnings.length} row warning
                    {localCsvPreview.warnings.length === 1 ? "" : "s"} (skipped invalid rows).
                  </Text>
                ) : null}
              </View>
            </FieldsStepCard>
          )}
        </View>
      </View>
    </View>
  );
}
