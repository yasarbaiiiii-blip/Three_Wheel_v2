import "react-native-gesture-handler";
import "./global.css";

import { DXF_PLANNER, SMOKE_TEST_MAPBOX, SMOKE_TEST_CENTER } from "./src/config/featureFlags";
import { installRuntimeGuards, yieldToUi } from "./src/utils/runtimeGuards";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";

// Mapbox token is applied on first map mount (MapViewNative / MapboxHelloMap),
// not at app entry — keeps the connection screen off the Mapbox native JS path.

// Process-level guards: log fatals + unhandled rejections (common "app closed" cause).
installRuntimeGuards();

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Lazy-loaded: none of these are needed for the initial "connection" screen
// (see the `page` state default below), so deferring them shrinks the JS
// that must be parsed before first paint.
/** Metro HMR can resolve a chunk with a missing default; fail loudly instead of undefined. */
function lazyDefault<T extends React.ComponentType<any>>(
  loader: () => Promise<{ default?: T } & Record<string, unknown>>,
  name: string
) {
  return lazy(async () => {
    const mod = await loader();
    const Comp = (mod.default ?? mod[name]) as T | undefined;
    if (typeof Comp !== "function") {
      throw new Error(
        `[lazy] ${name} failed to load (got ${typeof Comp}). Restart Metro with --reset-cache.`
      );
    }
    return { default: Comp };
  });
}

const MapboxHelloMap = lazyDefault(() => import("./src/components/MapboxHelloMap"), "MapboxHelloMap");
const ModernHomeUI = lazyDefault(() => import("./src/components/ModernHomeUI"), "ModernHomeUI");
const ModernSettingsPage = lazyDefault(
  () => import("./src/components/ModernSettingsPage"),
  "ModernSettingsPage"
);
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import Slider from "@react-native-community/slider";
import * as FileSystem from "expo-file-system/legacy";
import * as DocumentPicker from "expo-document-picker";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { SafeAreaInsetsContext, SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView, TouchableOpacity as RNGHTouchableOpacity, GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from "react-native-svg";
import type { Socket } from "socket.io-client";
import {
  Battery,
  CircleHelp,
  LayoutTemplate,
  ListChecks,
  File,
  FilePenLine,
  FileUp,
  FileText,
  Info,
  LocateFixed,
  LogOut,
  List,
  Menu,
  RadioTower,
  Settings,
  Signal,
  Tractor,
  Trash2,
  ChevronRight,
  Waves,
  X,
  RotateCcw,
  RotateCw,
  Eye,
  EyeOff,
  Map as MapIcon,
  Check as CheckIcon,
  Gamepad2,
} from "lucide-react-native";

import { BoundaryEditor, PlacedItem } from "./src/components/BoundaryEditor";
import { DeadmanButton } from "./src/components/DeadmanButton";
import { ManualJoystick } from "./src/components/ManualJoystick";
import { useImmersiveMode } from "./src/hooks/useImmersiveMode";
import { useVirtualJoystick } from "./src/hooks/useVirtualJoystick";
import { readImportedPlanFile, normalizePlanLines } from "./src/utils/planImport";
import type { ImportedPlan, PlanLine } from "./src/types/plan";
import * as missionApi from "./src/api/missionApi";
import * as authApi from "./src/api/authApi";
import {
  buildMissionStartPayload,
  classifyMissionError,
  evaluateMissionStartGate,
  getLoadedMissionId,
  invalidateWorkflowFrom,
  isProtectedMissionResident,
  runningMissionMismatch,
  verifyStagedLoadedMission,
  verifyHydratedMarkCount,
} from "./src/api/missionContract";
import {
  clonePlanLinesForSnapshot,
  restageAppTrajectoryWithLiveEntry,
  type AppPlannedStartSnapshot,
} from "./src/utils/appPlannedStartSnapshot";
import {
  classifyLiveEntryStartRequirement,
  entryPoseDrifted,
  isAppPlannedMissionContext,
  pickRoverPoseForEntry,
  telemetryToRoverPoseForEntry,
} from "./src/utils/liveEntryPose";
import { resolveRoverNedInMissionFrame } from "./src/utils/missionTrajectory";
import { buildCsvExtensionLines } from "./src/utils/missionExtensions";
import type { MissionLayer } from "./src/types/missionLayers";
import {
  applyMissionTerminalOutcome,
  createLayerForFile,
  assignFileToLayer,
  markLayersStarted,
  nonEmptyMissionLayers,
  outcomeFromMissionStateTransition,
  pruneMissingFiles,
  resolveVisibleStartLayerIds,
  toggleMissionLayerVisibility,
  unassignFile,
} from "./src/utils/missionLayerAssignment";
import {
  buildAnchorTargetOptions,
  buildLayerScopedStartSnapshot,
  buildMissionLayerLegCatalog,
  countUnassignedFiles,
  fileForLineId,
  filterCanvasLinesByMissionVisibility,
  isolateLinesForAnchorTarget,
  tagLinesWithMissionLayer,
  type AnchorTarget,
  type AnchorTargetOption,
} from "./src/utils/missionLayerLines";
import { splitRoadMarkingPathAtAnchor } from "./src/utils/roadMarkingCsvPath";
import type { AnchorCandidatePoint } from "./src/components/mapViewTypes";
import { recoverCornersAfterHydration } from "./src/utils/cornerLifecycle";
import { SHARP_CORNER_MODE } from "./src/config/featureFlags";
import * as pathApi from "./src/api/pathApi";
// Template generators live only in lazy TemplatesPage (not on the connection entry graph).
import { canAcquireJoystick as canAcquireJoystickForState } from "./src/utils/joystickFrontendSafety";

import type { Page, TelemetrySnapshot, LayerVisibility } from "./src/types/plan";

import { FloatingEStop } from "./src/components/FloatingEStop";
import { PlanPreview } from "./src/components/PlanPreview";
import { ConnectionView } from "./src/features/connection/ConnectionView";
import {
  applyTelemetryPacket,
  clearTelemetryRuntime,
  getTelemetrySnapshot,
  patchTelemetryMissionState,
  setSystemHealth,
  setTelemetrySnapshot,
  useSystemHealth,
  useTelemetrySnapshot,
} from "./src/features/telemetry/telemetryStore";
import type {
  ActivityEntry,
  AppToast,
  DiscoveredRover,
  RTKMode,
  SystemHealth,
  ToastTone,
} from "./src/types/appRuntime";
import {
  formatSocketConnectError,
  SOCKET_CONNECT_TIMEOUT_MS,
  waitForSocketConnect,
} from "./src/utils/socketConnect";
import { rtkModeFromStatus } from "./src/utils/telemetryDeadband";
const SwoziPage = lazyDefault(
  () => import("./src/screens/SecondaryPages").then((m) => ({ default: m.SwoziPage })),
  "SwoziPage"
);
const StatusPage = lazyDefault(
  () => import("./src/screens/SecondaryPages").then((m) => ({ default: m.StatusPage })),
  "StatusPage"
);
const PositioningPage = lazyDefault(
  () => import("./src/screens/SecondaryPages").then((m) => ({ default: m.PositioningPage })),
  "PositioningPage"
);
const SettingsPage = lazyDefault(
  () => import("./src/screens/SecondaryPages").then((m) => ({ default: m.SettingsPage })),
  "SettingsPage"
);
const HowToPage = lazyDefault(
  () => import("./src/screens/SecondaryPages").then((m) => ({ default: m.HowToPage })),
  "HowToPage"
);
const AboutPage = lazyDefault(
  () => import("./src/screens/SecondaryPages").then((m) => ({ default: m.AboutPage })),
  "AboutPage"
);
import { getLineAnchorPoint, isFiniteNumber } from "./src/utils/planPreviewGeometry";
import { getPlanStartPoint } from "./src/utils/planStartPoint";

const TemplatesPage = lazyDefault(
  () => import("./src/screens/TemplatesPage").then((m) => ({ default: m.TemplatesPage })),
  "TemplatesPage"
);
const FieldsPage = lazyDefault(
  () => import("./src/screens/FieldsPage").then((m) => ({ default: m.FieldsPage })),
  "FieldsPage"
);
import {
  coerceFiniteNumber,
  formatFinite,
  formatSprayFlagSample,
  formatWaypointPair,
  getLineLengthM,
  isPrimaryEditableLine,
  normalizeEntityType,
  parsePathSegmentsResponse,
  parsePlanAndStageResponse,
  sanitizePlanLines,
} from "./src/utils/pathWorkflow";
import {
  appendExtensionLegsFromPlanLines,
  buildExtensionLegCatalogFromEntitiesBody,
  buildRuntimeTransitOverlayFromPlan,
  matchNonSprayToExtensionRole,
} from "./src/utils/extensionTransitClassify";
import type {
  AlignmentResultState,
  MultiPointPlacementPhase,
  StagedPlanResultState,
  StagedWorkflowState,
  StagedWorkflowStatus,
  StagedWorkflowStep,
} from "./src/types/fieldsWorkflow";
import { INITIAL_STAGED_WORKFLOW_STATE } from "./src/types/fieldsWorkflow";
import { linesToDxf } from "./src/utils/dxfGenerator";
import {
  buildPlanLineSvgPath,
  computePlanBoundingBoxLegacy,
  getCurveGeometry,
  getPlanLineRenderPoints,
  getPlanLineSegmentKind,
  getPreviewCircleElements,
  isCircleLikeLine,
  isCurveEntity,
  isSegmentKindVisible,
  normalizeDxfEntityGeometry,
  normalizePlanLinesForCurves,
} from "./src/utils/curveGeometry";
import {
  buildVisualAlignmentRefPoints,
  computeLineBoundingBox,
  projectGpsToLocalMeters,
  transformVisualDxfPoint,
} from "./src/utils/visualAlignment";
import {
  transformPlanLinesGeometry,
} from "./src/utils/planLineTransform";
import { computeShapeSnapPoints } from "./src/utils/planShapeSnapPoints";
import { computeBestSimilarityFit } from "./src/utils/similarityRefPointSnap";
import {
  anchorToAlignedRefPoints,
  hydrateStagedMissionForMap,
  stagedMissionMatchesId,
} from "./src/utils/stagedMissionHydration";
import {
  buildCsvTransitLines,
  localCsvPointsToPlanLines,
  localCsvToMapPins,
  mergeLocalPointCsvResults,
  type LocalPointCsvResult,
} from "./src/utils/localPointCsv";
import {
  dxfFileStem,
  prefixDxfLineIds,
  type LocalDxfResult,
} from "./src/utils/dxfLocalImport";
import { alignmentFromGeographic } from "./src/utils/dxfAlignment";
import { rebasePlanLinesToOrigin } from "./src/utils/planOriginRebase";
import type {
  PendingDxfAlignmentEntry,
  UploadedFileEntry,
} from "./src/types/uploadedFiles";
import {
  applyCsvOrderToPlanLines,
  chainMarkLinesByGeometry,
  chainMarkLinesFromSeed,
  defaultPathOrder,
  selectMarkPlanLines,
} from "./src/utils/csvPathOrder";
import { normalizeBearingDeg } from "./src/utils/planOffset";
import { computeOffsetResultLines } from "./src/utils/planOffsetApply";
import { sanitizeUploadFileName } from "./src/utils/surveyCsvExport";
import { enforceAlignmentScale } from "./src/utils/designAlignmentPolicy";
import { rehydrateAlignedPlanLines } from "./src/utils/rehydrateAlignedPlan";
import type { AutoOriginReference, MapGeometryFrame } from "./src/types/autoOrigin";
import {
  applyAutoOriginShift,
  buildAutoOriginReference,
  planStartMatchesReference,
} from "./src/utils/autoOrigin";
import {
  buildPlanManipulationAnchor,
  resolveMapGeometryFrame,
} from "./src/utils/mapGeometryProjection";

function lineAngleDeg(line: PlanLine): number {
  return (Math.atan2(line.to.y - line.from.y, line.to.x - line.from.x) * 180) / Math.PI;
}

type StagedStartGate = {
  isStagedWorkflow: boolean;
  allowed: boolean;
  message: string | null;
};

function evaluateStagedStartGate(
  stagedWorkflow: StagedWorkflowState,
  loadedPathInspection: missionApi.LoadedPathResponse | null,
  stagedMissionId: string | null
): StagedStartGate {
  return evaluateMissionStartGate({
    stagedVerified: stagedWorkflow.staged === "verified",
    loadedVerified: stagedWorkflow.loaded === "verified",
    stagedMissionId,
    loaded: loadedPathInspection,
    alignmentVerified: stagedWorkflow.alignment === "verified",
  });
}

function createUploadFormData(fileUri: string, fileName: string, mimeType: string) {
  const form = new FormData();
  form.append("file", {
    uri: fileUri,
    name: fileName,
    type: mimeType,
  } as any);
  return form;
}

const BG = "#d9d9dc";
const TOP = "#ececee";
const GREEN = "#eef2f7";
const GREEN_DARK = "#f8fafc";
const TEAL = "#0f988f";
const LOCAL_WS_CANDIDATES = [
  "http://localhost:5001",
  "http://127.0.0.1:5001",
];
const PRIORITY_BACKEND_IPS: string[] = [];

const DISCOVERY_REFRESH_MS = 5000;
const DISCOVERY_PORT = 5001;
const SUBNET_HOST_MIN = 1;
const SUBNET_HOST_MAX = 254;
const SUBNET_SCAN_CONCURRENCY = 24;
const DEFAULT_ROVER_BACKEND = "http://192.168.1.102:5001";
const MENU_ITEMS: Array<{ key: Page; label: string; icon: React.ReactNode }> = [
  { key: "fields", label: "Fields", icon: <File size={22} color="#fff" /> },
  { key: "templates", label: "Templates", icon: <LayoutTemplate size={22} color="#fff" /> },
  { key: "swozi", label: "Swozi", icon: <Tractor size={22} color="#fff" /> },
  { key: "status", label: "Status", icon: <Waves size={22} color="#fff" /> },
  { key: "positioning", label: "Positioning", icon: <LocateFixed size={22} color="#fff" /> },
  { key: "settings", label: "Settings", icon: <Settings size={22} color="#fff" /> },
  { key: "howto", label: "How To", icon: <CircleHelp size={22} color="#fff" /> },
  { key: "about", label: "About", icon: <Info size={22} color="#fff" /> },
];

export default function App() {
  // Outer boundary: a render crash in any screen must not force-kill the APK.
  return (
    <AppErrorBoundary name="Root">
      <AppRoot />
    </AppErrorBoundary>
  );
}

function AppRoot() {
  // TEMPORARY (Phase 0.1) on-device basemap smoke test. Flip SMOKE_TEST_MAPBOX
  // in src/config/featureFlags.ts to true, rebuild, and confirm satellite tiles
  // render. This early return is gated by a build-time constant so hook order
  // stays stable. Remove this block once the smoke test is confirmed.
  if (SMOKE_TEST_MAPBOX) {
    return (
      <Suspense fallback={<ActivityIndicator />}>
        <MapboxHelloMap center={SMOKE_TEST_CENTER} zoomLevel={16} />
      </Suspense>
    );
  }

  useImmersiveMode();

  const [page, setPage] = useState<Page>("connection");
  const [menuOpen, setMenuOpen] = useState(true);
  const [selectedWs, setSelectedWs] = useState<string>("");
  const [manualHost, setManualHost] = useState<string>(() => {
    if (typeof window !== "undefined" && window.location && window.location.hostname) {
      const host = window.location.hostname;
      if (host && host !== "localhost" && host !== "127.0.0.1") {
        return `http://${host}:5001`;
      }
    }
    return DEFAULT_ROVER_BACKEND;
  });
  const [wsStatus, setWsStatus] = useState<"idle" | "scanning" | "ready" | "connecting" | "connected" | "error">("idle");
  const [wsError, setWsError] = useState<string>("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [operatorSession, setOperatorSession] = useState<authApi.OperatorSession | null>(null);
  const [operatorPassword, setOperatorPassword] = useState("");
  const [passwordChangeOpen, setPasswordChangeOpen] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);
  const [discoveredRovers, setDiscoveredRovers] = useState<DiscoveredRover[]>([]);
  const [backendPinned, setBackendPinned] = useState(false);
  const [fieldGeneratorOpen, setFieldGeneratorOpen] = useState(false);
  const [importedPlan, setImportedPlan] = useState<ImportedPlan | null>(null);
  const [lines, setLines] = useState<PlanLine[]>([]);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  // Explicit multi-line highlight set (Path Order "Extension" groups). When null, only
  // `selectedLineId` is highlighted. Set atomically via `handleSelectLine` so a list
  // row can never race with a clear-from-single-select path (the previous broadcastLayer
  // + separate setters left multi-highlight always cleared).
  const [highlightLineIds, setHighlightLineIds] = useState<string[] | null>(null);
  const handleSelectLine = useCallback((id: string | null, options?: { highlightLineIds?: string[] | null }) => {
    setSelectedLineId(id);
    setHighlightLineIds(options?.highlightLineIds ?? null);
  }, []);

  // 1. Mode Toggle State
  const [isVisualAlignmentMode, setIsVisualAlignmentMode] = useState(false);
  const [isPlanEditingMode, setIsPlanEditingMode] = useState(false);
  /** Multi-Point Fit: placing → attached (Edit) → resizing (Done) → captured */
  const [multiPointPlacementPhase, setMultiPointPlacementPhase] =
    useState<MultiPointPlacementPhase>("idle");

  // 2. The temporary "Sticker" holding all DXF lines
  const [visualAlignmentItem, setVisualAlignmentItem] = useState<PlacedItem | null>(null);

  // Latched first GPS for fields fallback origin — same role as MapViewNative.stableFallbackOrigin.
  // The effect that fills this must sit after telemetrySnapshot is declared (see below).
  const [latchedPreviewGps, setLatchedPreviewGps] = useState<{ lat: number; lon: number } | null>(null);

  /**
   * Which pending metric DXF the Align step is manipulating, plus the composed line set
   * the map is drawing for it — published by FieldsPage (see onAlignContextChange).
   *
   * A ref, not state: this only needs to be correct at the moment a user action fires one
   * of the handlers below, and mirroring FieldsPage's render output into App state would
   * churn a render on every map recomposition for no gain.
   */
  const alignContextRef = useRef<{ fileId: string | null; displayLines: PlanLine[] }>({
    fileId: null,
    displayLines: [],
  });
  const handleAlignContextChange = useCallback(
    (ctx: { fileId: string | null; displayLines: PlanLine[] }) => {
      alignContextRef.current = ctx;
    },
    []
  );

  /**
   * The geometry the plan-manipulation handlers act on.
   *
   * A metric DXF is deliberately held OUT of mission `lines` until Fix Alignment (see
   * handleLocalDxfParsed) — FieldsPage composes it into the map for display only. Reading
   * `lines` here would hand back an empty array on a first metric-DXF upload (so Move /
   * Rotate Plan, Fit to Reference Points and Visual Alignment all silently no-op on their
   * `length === 0` guards), or, in a mixed batch, another already-verified file's geometry.
   */
  function getManipulationTarget(): { fileId: string | null; lines: PlanLine[] } {
    const fileId = alignContextRef.current.fileId;
    const pending = fileId ? pendingDxfAlignment[fileId] : null;
    if (fileId && pending) return { fileId, lines: pending.rawLines };
    return { fileId: null, lines };
  }

  /** Bake a transform back into wherever the manipulated geometry actually lives. */
  function commitManipulationLines(
    transform: (north: number, east: number) => { north: number; east: number }
  ) {
    const { fileId } = getManipulationTarget();
    if (fileId) {
      setPendingDxfAlignment((prev) => {
        const cur = prev[fileId];
        if (!cur) return prev;
        return {
          ...prev,
          [fileId]: {
            ...cur,
            rawLines: sanitizePlanLines(transformPlanLinesGeometry(cur.rawLines, transform)),
          },
        };
      });
      return;
    }
    setLines((prev) => transformPlanLinesGeometry(prev, transform));
  }

  /**
   * Sticky anchor matching the live fields preview (auto-origin / refs / fallback).
   * Function declaration (not useCallback): may close over state declared later in this
   * component body; only reads those bindings when invoked on user action.
   */
  function buildManipulationAnchorFromPreview() {
    // Mirror autoOriginEligible (declared later) so Move/Rotate uses the same frame as the map.
    const originEligible =
      autoOrigin &&
      stagedWorkflow.staged !== "verified" &&
      alignedRefPoints.length === 0;
    return buildPlanManipulationAnchor({
      previewAnchor: null,
      alignedRefPoints,
      stagedVerified: stagedWorkflow.staged === "verified",
      autoOriginReference,
      autoOriginEnabled: originEligible,
      geoOrigin: geoOriginDxf,
      existingAnchor: visualAlignmentAnchor,
      stableFallbackOrigin:
        latchedPreviewGps ??
        (Number.isFinite(telemetrySnapshot?.lat) && Number.isFinite(telemetrySnapshot?.lon)
          ? { lat: telemetrySnapshot!.lat as number, lon: telemetrySnapshot!.lon as number }
          : null),
      // Raw design lines — same coords the map projects under AUTO_ORIGIN_RAW / fallback.
      // Must be the SAME list the map resolved its origin from, or the plan jumps the
      // instant the sticker appears: with a pending metric DXF the map draws FieldsPage's
      // composed set (boundary + committed + pending), while `lines` alone is still empty.
      lines: sanitizePlanLines(
        alignContextRef.current.fileId && alignContextRef.current.displayLines.length > 0
          ? alignContextRef.current.displayLines
          : lines
      ),
    });
  }

  // 3. Trigger Function: Bundles lines into one item
  function startVisualAlignment() {
    console.log("[Align DXF] startVisualAlignment: Initiating visual alignment mode.");
    const target = getManipulationTarget();
    const planLines = target.lines;
    if (planLines.length === 0) {
      console.log("[Align DXF] startVisualAlignment: No lines available to align, aborting.");
      return;
    }

    const { minX, minY, maxX, maxY } = computePlanBoundingBoxLegacy(planLines);
    // width = east span (maxY−minY), height = north span (maxX−minX) — see planResizeHandles.
    const stickerW = maxY - minY;
    const stickerH = maxX - minX;

    // Must match MapViewNative's live projection origin or the plan jumps on enter.
    const anchor = buildManipulationAnchorFromPreview();
    setVisualAlignmentAnchor(anchor);

    setVisualAlignmentItem({
      id: "visual-alignment-group",
      lines: planLines,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      width: stickerW,
      height: stickerH,
    });

    console.log(`[Align DXF] startVisualAlignment: Created visual sticker. Width: ${stickerW}, Height: ${stickerH}`);
    setIsVisualAlignmentMode(true);
  }

  // Plan Editing: lets user drag/scale/rotate the plan from the 4th dropdown
  function startPlanEditing() {
    const target = getManipulationTarget();
    const planLines = target.lines;
    if (planLines.length === 0) return;
    // Sticker still carries ALL lines (extensions transform with the plan), but OBB
    // width/height use primary geometry only so resize handles stay on the field —
    // not inflated by PRE/AFT run-ups when extensions are enabled.
    const primary = planLines.filter(
      (l) =>
        l.layer !== "extension" &&
        l.layer !== "transit" &&
        l.layer !== "virtual_boundary" &&
        !String(l.id ?? "").startsWith("ext-pre-") &&
        !String(l.id ?? "").startsWith("ext-aft-")
    );
    const bboxSource = primary.length > 0 ? primary : planLines;
    const { minX, minY, maxX, maxY } = computePlanBoundingBoxLegacy(bboxSource);
    // width = east span, height = north span (matches OBB halfE/halfN).
    const stickerW = maxY - minY;
    const stickerH = maxX - minX;
    // Identity sticker + anchor identical to current fields preview → zero on-screen jump.
    const anchor = buildManipulationAnchorFromPreview();
    setVisualAlignmentAnchor(anchor);

    setVisualAlignmentItem({
      id: "plan-editing-group",
      lines: planLines,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      width: stickerW,
      height: stickerH,
    });
    setIsVisualAlignmentMode(false);
    setMapViewEnabled(true);
    setIsPlanEditingMode(true);
    setMultiPointPlacementPhase("placing");
  }

  function stopPlanEditing() {
    if (visualAlignmentItem && isPlanEditingMode) {
      const item = visualAlignmentItem;
      // Shared bake: from/to + preview_points + entity.geometry (circles/arcs stay frame-consistent).
      // Supports non-uniform edge resize via scaleNorth/scaleEast on the sticker.
      const transformPt = (north: number, east: number) => {
        const t = transformVisualDxfPoint(north, east, item);
        return { north: t.north, east: t.east };
      };
      // Routed through commitManipulationLines so a pending metric DXF's drag lands on its
      // own rawLines — writing `lines` here would move every OTHER file in the batch instead.
      commitManipulationLines(transformPt);
    }
    setIsPlanEditingMode(false);
    setVisualAlignmentItem(null);
    setMultiPointPlacementPhase("idle");
  }

  function handlePlanAttached(info: { x: number; y: number; rotation: number; scale: number }) {
    setVisualAlignmentItem((prev) => {
      if (!prev || prev.id !== "plan-editing-group") return prev;
      return {
        ...prev,
        x: info.x,
        y: info.y,
        rotation: info.rotation,
        scale: info.scale,
      };
    });
    setMultiPointPlacementPhase((phase) =>
      phase === "placing" || phase === "idle" ? "attached" : phase
    );
  }

  function handlePlanEditResize() {
    if (!isPlanEditingMode || !visualAlignmentItem) return;
    // Resize is free axis scale — no magnet lock (lock is for drag/rotate only).
    setMultiPointPlacementPhase("resizing");
  }

  /**
   * One-tap similarity fit onto CSV/manual reference points (translate + rotate + scale).
   * The ONLY drag-free path that may rescale the plan — the Move / Rotate Plan magnet is
   * rigid (see MapViewNative.applyPointSnap). Enters Move Plan if needed.
   */
  function handleFitToReferencePoints(
    refList: Array<{ lat: number; lon: number }>
  ) {
    const target = getManipulationTarget();
    if (target.lines.length === 0) {
      Alert.alert("No plan", "Upload a DXF plan before fitting to reference points.");
      return;
    }
    const validRefs = refList.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
    );
    if (validRefs.length < 2) {
      Alert.alert(
        "Need 2+ points",
        "Import or enter at least two Latitude/Longitude reference points first."
      );
      return;
    }

    // Ensure sticker + projection anchor (same as Move / Rotate Plan).
    let item = visualAlignmentItem?.id === "plan-editing-group" ? visualAlignmentItem : null;
    let anchor = visualAlignmentAnchor;
    if (!item || !isPlanEditingMode) {
      const all = sanitizePlanLines(target.lines);
      const primary = all.filter(
        (l) =>
          l.layer !== "extension" &&
          l.layer !== "transit" &&
          l.layer !== "virtual_boundary" &&
          !String(l.id ?? "").startsWith("ext-pre-") &&
          !String(l.id ?? "").startsWith("ext-aft-")
      );
      const bboxSource = primary.length > 0 ? primary : all;
      const { minX, minY, maxX, maxY } = computePlanBoundingBoxLegacy(bboxSource);
      const stickerW = maxY - minY;
      const stickerH = maxX - minX;
      anchor = buildManipulationAnchorFromPreview();
      setVisualAlignmentAnchor(anchor);
      item = {
        id: "plan-editing-group",
        lines: all,
        x: 0,
        y: 0,
        rotation: 0,
        scale: 1,
        width: stickerW,
        height: stickerH,
      };
      setVisualAlignmentItem(item);
      setIsVisualAlignmentMode(false);
      setMapViewEnabled(true);
      setIsPlanEditingMode(true);
    }
    if (!anchor) {
      anchor = buildManipulationAnchorFromPreview();
      setVisualAlignmentAnchor(anchor);
    }

    const candidates = computeShapeSnapPoints(item.lines);
    if (candidates.length < 2) {
      Alert.alert("Fit failed", "Could not derive plan snap features from the geometry.");
      return;
    }

    const snapRefs = validRefs.map((p) => ({
      ...projectGpsToLocalMeters(p.lat, p.lon, anchor!.originLat, anchor!.originLon),
      lat: p.lat,
      lon: p.lon,
    }));

    const fit = computeBestSimilarityFit({
      candidates,
      refs: snapRefs,
      originDxfNorth: anchor.originDxfNorth,
      originDxfEast: anchor.originDxfEast,
      preferScale: item.scale || 1,
      currentRotationDeg: item.rotation || 0,
    });
    if (!fit) {
      Alert.alert(
        "Fit failed",
        "Could not solve a scale/rotate/translate match for these points. Check that at least two refs correspond to plan corners or edge midpoints."
      );
      return;
    }

    setVisualAlignmentItem({
      ...item,
      x: fit.x,
      y: fit.y,
      rotation: fit.rotation,
      scale: fit.scale,
      scaleNorth: fit.scale,
      scaleEast: fit.scale,
    });
    setMultiPointPlacementPhase("attached");
    console.log(
      `[AlignDXF][Fit] residual=${fit.residual.toFixed(3)}m scale=${fit.scale.toFixed(4)} rot=${fit.rotation.toFixed(2)}`
    );
  }

  function handlePlanResizeDone() {
    // Leave Resize → Move mode (drag/rotate), not attach-gated chrome.
    setMultiPointPlacementPhase((phase) => (phase === "resizing" ? "placing" : phase));
  }

  function handleConfirmVisualAlignment() {
    console.log("[Align DXF] handleConfirmVisualAlignment: Confirming visual alignment position.");
    if (!visualAlignmentItem) {
      console.log("[Align DXF] handleConfirmVisualAlignment: visualAlignmentItem is null, aborting.");
      return;
    }

    const target = getManipulationTarget();
    const planLines = target.lines;
    const { minX, minY, maxX, maxY } = computeLineBoundingBox(planLines);
    const dxfCorners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: minX, y: maxY },
    ];

    const baseLat = visualAlignmentAnchor?.originLat ?? alignedRefPoints[0]?.lat ?? telemetrySnapshot?.lat ?? 0;
    const baseLon = visualAlignmentAnchor?.originLon ?? alignedRefPoints[0]?.lon ?? telemetrySnapshot?.lon ?? 0;

    let originDxfNorth = 0;
    let originDxfEast = 0;
    if (visualAlignmentAnchor) {
      originDxfNorth = visualAlignmentAnchor.originDxfNorth;
      originDxfEast = visualAlignmentAnchor.originDxfEast;
    } else if (alignedRefPoints[0]) {
      originDxfNorth = alignedRefPoints[0].dxf_y;
      originDxfEast = alignedRefPoints[0].dxf_x;
    } else if (planLines.length > 0) {
      originDxfNorth = (planLines[0].from?.x ?? 0) - 2;
      originDxfEast = (planLines[0].from?.y ?? 0) - 2;
    }

    /**
     * Per-file metric DXF (multi-file batch): CAPTURE ONLY.
     *
     * Its geometry lives in pendingDxfAlignment, so the local bake below would transform
     * `lines` — where this file is not — and flip the whole batch to alignment: "verified"
     * while other files are still pending. Publishing extractedCorners instead hands the
     * placement to AlignDxfPanel's Fix Alignment, which solves against this file's own
     * rawLines and merges via commitDxfFileAlignment onto sharedOriginGps.
     *
     * Deliberately does NOT touch alignedRefPoints / verifiedAlignmentRequest: in a mixed
     * batch those already describe the shared origin, and repointing them here would
     * re-project every committed file under this DXF's placement.
     */
    if (target.fileId) {
      const item = visualAlignmentItem;
      // Bake the placement into the pending file's own rawLines and retire the sticker.
      // Leaving the sticker up instead would drop the plan back to its design-frame
      // position the moment plan-editing exits: `isPlacedItemActive` needs either an edit
      // mode or a non-empty alignedRefPoints, and this branch has neither. Baking keeps the
      // plan drawn exactly where it was placed, under the still-live visualAlignmentAnchor.
      commitManipulationLines((north, east) => transformVisualDxfPoint(north, east, item));

      // Corners must be reported in the SAME frame as the geometry they pair with — the
      // baked one — or Fix Alignment solves a transform that is then applied a second time
      // on top of the bake. Placed corners + identity sticker gives that pairing.
      const placedCorners = dxfCorners.map((corner) => {
        const t = transformVisualDxfPoint(corner.x, corner.y, item);
        return { x: t.north, y: t.east };
      });
      const capturedLLA = buildVisualAlignmentRefPoints(
        placedCorners,
        { x: 0, y: 0, rotation: 0, scale: 1 },
        baseLat,
        baseLon,
        originDxfNorth,
        originDxfEast
      );
      console.log(
        `[Align DXF] Captured placement for pending file ${target.fileId}:`,
        JSON.stringify(capturedLLA)
      );
      setExtractedCorners(capturedLLA);
      setVisualAlignmentItem(null);
      setIsVisualAlignmentMode(false);
      setIsPlanEditingMode(false);
      setMultiPointPlacementPhase("captured");
      return;
    }

    // Local app-planned DXF: plan-trajectory sends NED vertices as-is about origin_gps.
    // The sticker is only a map preview — bake the real DXF path (placed geometry) into
    // `lines` before enabling Send. Never set origin_gps while leaving design-frame
    // geometry (that used to ship an untransformed DXF trajectory).
    const isLocalAppDxf =
      DXF_PLANNER === "app" &&
      selectedPathName == null &&
      (importedPlan?.fileType === "dxf" || !!importedPlan?.fileName?.toLowerCase().endsWith(".dxf"));

    if (isLocalAppDxf) {
      if (!Number.isFinite(baseLat) || !Number.isFinite(baseLon) || (baseLat === 0 && baseLon === 0)) {
        Alert.alert(
          "Missing map origin",
          "Could not resolve a GPS origin for this placement. Wait for a GPS fix, then place the plan again."
        );
        return;
      }
      const item = visualAlignmentItem;
      const transformPt = (north: number, east: number) => {
        const t = transformVisualDxfPoint(north, east, item);
        // NED about the latched map origin (= origin_gps for plan-trajectory).
        return {
          north: t.north - originDxfNorth,
          east: t.east - originDxfEast,
        };
      };
      setLines((prev) => sanitizePlanLines(transformPlanLinesGeometry(prev, transformPt)));
      setAlignedRefPoints([{ dxf_x: 0, dxf_y: 0, lat: baseLat, lon: baseLon }]);
      setVerifiedAlignmentRequest({
        origin_gps: [baseLat, baseLon],
        rotation_deg: 0, // rotation already baked into vertices
      });
      setAlignmentResult({
        method: "visual_alignment",
        scale: enforceAlignmentScale(item.scale ?? 1),
        rotation_deg: item.rotation ?? 0,
        offset_n: item.y ?? 0,
        offset_e: item.x ?? 0,
        origin_gps: [baseLat, baseLon],
        rmse_m: null,
        sample_coords: null,
        residuals: null,
        warnings: null,
      });
      // Safe at call time (user event) — bindings exist after the full render.
      setStagedWorkflow((prev) => ({
        ...prev,
        alignment: "verified",
        spray: "pending",
        staged: "pending",
        loaded: "pending",
        started: "pending",
      }));
      setExtractedCorners(null);
      setVisualAlignmentItem(null);
      setIsVisualAlignmentMode(false);
      setIsPlanEditingMode(false);
      setMultiPointPlacementPhase("idle");
      console.log(
        `[Align DXF] Local DXF placement baked into lines; origin_gps=[${baseLat}, ${baseLon}] ready for plan-trajectory`
      );
      return;
    }

    const extractedLLA = buildVisualAlignmentRefPoints(
      dxfCorners,
      visualAlignmentItem,
      baseLat,
      baseLon,
      originDxfNorth,
      originDxfEast
    );

    console.log("Captured LLA reference points for rover:", extractedLLA);

    // Rover DXF: keep design lines; Fix Alignment POST applies the server transform.
    setExtractedCorners(extractedLLA);
    setAlignedRefPoints(extractedLLA);
    setVerifiedAlignmentRequest({
      origin_gps: [baseLat, baseLon],
      rotation_deg: visualAlignmentItem.rotation ?? 0,
      ref_points: extractedLLA,
    });
    setIsVisualAlignmentMode(false);
    // Also used from the Multi-Point Fit tab's "Use This Position" (Move Plan flow).
    setIsPlanEditingMode(false);
    setMultiPointPlacementPhase("captured");
  }
  const [extractedCorners, setExtractedCorners] = useState<{ dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null>(null);
  const [visualAlignmentAnchor, setVisualAlignmentAnchor] = useState<{ originLat: number; originLon: number; originDxfNorth: number; originDxfEast: number } | null>(null);

  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    boundary: true,
    marking: true,
    center: true,
    transit: true,
    extension: true,
    rover: true,
    refPoints: true,
    // Opt-in (see LayerVisibility.lengths) — enabled from Layers ▸ Lengths, not by default.
    lengths: false,
    segmentTypes: {},
  });
  const [showRefPointLabels, setShowRefPointLabels] = useState(false);
  const [activeRefPointLabelIndex, setActiveRefPointLabelIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!showRefPointLabels) {
      setActiveRefPointLabelIndex(null);
    }
  }, [showRefPointLabels]);
  // Full live telemetry subscription (baseline-correct). Deadband in the store
  // already skips noise; do not use boolean-only selectors that miss pose updates.
  const telemetrySnapshot = useTelemetrySnapshot();
  const systemHealth = useSystemHealth();
  /**
   * Always-current pose for Start live entry. Updated on every telemetry packet
   * (including when React deadband skips setState) and on REST refresh.
   */
  const telemetrySnapshotRef = useRef<TelemetrySnapshot | null>(null);
  const telemetryReceivedAtMsRef = useRef<number>(0);

  const noteTelemetryForLiveEntry = useCallback(
    (partial: {
      pos_n?: number | null;
      pos_e?: number | null;
      lat?: number | null;
      lon?: number | null;
      gps_fix?: number | null;
      pose_age_ms?: number | null;
    }) => {
      const prev = telemetrySnapshotRef.current ?? getTelemetrySnapshot();
      telemetrySnapshotRef.current = {
        ...(prev ?? {}),
        ...partial,
      } as TelemetrySnapshot;
      telemetryReceivedAtMsRef.current = Date.now();
    },
    []
  );

  // Keep ref aligned whenever the React snapshot advances (map/Start share one truth).
  useEffect(() => {
    if (telemetrySnapshot) {
      telemetrySnapshotRef.current = telemetrySnapshot;
    }
  }, [telemetrySnapshot]);

  // Latch first finite GPS after telemetry exists — must not run above this declaration.
  useEffect(() => {
    if (latchedPreviewGps) return;
    const lat = telemetrySnapshot?.lat;
    const lon = telemetrySnapshot?.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      setLatchedPreviewGps({ lat: lat as number, lon: lon as number });
    }
  }, [telemetrySnapshot?.lat, telemetrySnapshot?.lon, latchedPreviewGps]);

  const [activityFeed, setActivityFeed] = useState<ActivityEntry[]>([]);
  const [discoveryFeed, setDiscoveryFeed] = useState<DiscoveredRover[]>([]);
  const [telemetryError, setTelemetryError] = useState<string>("");
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [missionActionBusy, setMissionActionBusy] = useState(false);
  /** Prevents double-tap Start / re-entrant restage while a previous Start is in flight. */
  const startInFlightRef = useRef(false);
  const [missionFileReady, setMissionFileReady] = useState(false);
  const [missionLoaded, setMissionLoaded] = useState(false);
  const [missionLoadedPanelOpenToken, setMissionLoadedPanelOpenToken] = useState(0);
  const [missionRunning, setMissionRunning] = useState(false);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [rtkModalOpen, setRtkModalOpen] = useState(false);
  const [rtkCaster, setRtkCaster] = useState("");
  const [rtkPort, setRtkPort] = useState("2101");
  const [rtkMountPoint, setRtkMountPoint] = useState("");
  const [rtkUsername, setRtkUsername] = useState("");
  const [rtkPassword, setRtkPassword] = useState("");
  const [rtkConnecting, setRtkConnecting] = useState(false);
  const [rtkMode, setRtkMode] = useState<RTKMode>("idle");
  const [rtkDefaultMode, setRtkDefaultMode] = useState("NTRIP");
  const [rtkHealthy, setRtkHealthy] = useState(false);
  const [rtkAutoConnect, setRtkAutoConnect] = useState(false);
  const [isFloatingEStopEnabled, setIsFloatingEStopEnabled] = useState(false);
  const rtkRunning = rtkMode === "ntrip" || rtkMode === "lora" || rtkMode === "stopping";
  const [toggleA, setToggleA] = useState(false);
  const [toggleB, setToggleB] = useState(false);
  const [toggleC, setToggleC] = useState(true);
  const [toggleD, setToggleD] = useState(false);
  const [delayA, setDelayA] = useState(0.1);
  const [delayB, setDelayB] = useState(0.1);
  const [backendPaths, setBackendPaths] = useState<any[]>([]);
  const [selectedPathName, setSelectedPathName] = useState<string | null>(null);
  const [stagedWorkflow, setStagedWorkflow] = useState<StagedWorkflowState>(INITIAL_STAGED_WORKFLOW_STATE);
  const [alignmentResult, setAlignmentResult] = useState<AlignmentResultState | null>(null);
  // Always-current Fix Alignment params for async path rehydrates (extension toggle, re-select).
  // previewSelectedPath awaits network I/O; reading this ref at setLines time avoids a stale
  // closure that would drop the bake and leave design-frame geometry under a NED origin.
  const alignmentResultRef = useRef<AlignmentResultState | null>(null);
  alignmentResultRef.current = alignmentResult;
  const [verifiedAlignmentRequest, setVerifiedAlignmentRequest] = useState<pathApi.AlignPathRequest | null>(null);
  // Georeferenced DXF: backend auto-places at its own WGS84 origin, so no manual
  // ref-point alignment is required. Threaded to the Fields workflow to relax the
  // alignment gate for these files only (metric DXFs still require alignment).
  const [isGeographicDxf, setIsGeographicDxf] = useState<boolean>(false);
  const [geoOriginDxf, setGeoOriginDxf] = useState<[number, number] | null>(null);
  const [segmentVerification, setSegmentVerification] = useState<pathApi.PathSegmentsResponse | null>(null);
  const [stagedPlanResult, setStagedPlanResult] = useState<StagedPlanResultState | null>(null);
  const [stagedMissionInspection, setStagedMissionInspection] = useState<pathApi.StagedMissionResponse | null>(null);
  const [stagedMissionId, setStagedMissionId] = useState<string | null>(null);
  /**
   * Source geometry from last successful app-planned Send. Start Mission restages
   * from this + live rover pose so entry is always X→A from current position.
   */
  const [appPlannedStartSnapshot, setAppPlannedStartSnapshot] =
    useState<AppPlannedStartSnapshot | null>(null);
  /** Local-only CSV preview (Select File .csv never hits backend path APIs). */
  const [localCsvPreview, setLocalCsvPreview] = useState<LocalPointCsvResult | null>(null);
  /** Per-file parses; preview/export is `mergeLocalPointCsvResults` of this list (not last-wins). */
  const localCsvParsesRef = useRef<LocalPointCsvResult[]>([]);
  /**
   * Local DXF parse meta (app planner). Geometry lives in `lines`; this keeps
   * file name / georef / parse warnings for Send readiness and mission naming.
   */
  const [localDxfMeta, setLocalDxfMeta] = useState<{
    fileName: string;
    isGeographic: boolean;
    warnings: string[];
  } | null>(null);
  /**
   * Local multi-type batch (CSV + metric DXF + geo-DXF). Per-file status gates
   * Path Order & Load; geometry stays flat in `lines` with id prefixes.
   */
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileEntry[]>([]);
  const [pendingDxfAlignment, setPendingDxfAlignment] = useState<
    Record<string, PendingDxfAlignmentEntry>
  >({});
  /** Shared GPS anchor for every contribution currently in `lines`. */
  const [sharedOriginGps, setSharedOriginGps] = useState<[number, number] | null>(null);
  const uploadedFilesRef = useRef<UploadedFileEntry[]>([]);
  uploadedFilesRef.current = uploadedFiles;
  const sharedOriginGpsRef = useRef<[number, number] | null>(null);
  sharedOriginGpsRef.current = sharedOriginGps;

  /** Mission Layers (file groups) — distinct from CAD LayerVisibility. */
  const [missionLayers, setMissionLayers] = useState<MissionLayer[]>([]);
  const [controlModeActive, setControlModeActive] = useState(false);
  const [pendingLayerAssignment, setPendingLayerAssignment] = useState<{
    fileEntryId: string;
  } | null>(null);
  /** Anchor point selection (re-anchor a CSV/DXF plan's start) — Home page only. */
  const [anchorSelectMode, setAnchorSelectMode] = useState(false);
  const [anchorTarget, setAnchorTarget] = useState<AnchorTarget | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<AnchorCandidatePoint | null>(null);
  /** Offset plan (whole-plan rigid shift toward an absolute compass bearing). */
  const [offsetBearingDeg, setOffsetBearingDeg] = useState<number>(0);
  const [offsetDistanceM, setOffsetDistanceM] = useState<number>(0);
  /** Which scope Apply/Reset act on. Defaults to universal so unscoped behavior is unchanged. */
  const [offsetTarget, setOffsetTarget] = useState<AnchorTarget | null>({ kind: "universal" });
  /** Deep clone of `lines` taken just before the FIRST Offset Apply this session. Reset restores it, then clears to null. */
  const [preOffsetSnapshot, setPreOffsetSnapshot] = useState<PlanLine[] | null>(null);
  /**
   * Live drag-time ghost preview while dragging the Offset compass dial.
   * offsetBearingRef always holds the latest raw-sample bearing (updated every
   * touch sample); the RAF-coalesced recompute reads it at fire time, never a
   * stale value captured in a closure at schedule time — see
   * scheduleOffsetGhostFrame below for why this matters.
   */
  const offsetBearingRef = useRef(offsetBearingDeg);
  const isDraggingOffsetDialRef = useRef(false);
  const offsetGhostRafRef = useRef<number | null>(null);
  const [offsetPreviewLines, setOffsetPreviewLines] = useState<PlanLine[] | null>(null);
  const runningLayerIdsRef = useRef<string[]>([]);
  const runningMissionIdRef = useRef<string | null>(null);
  const [loadedPathInspection, setLoadedPathInspection] = useState<missionApi.LoadedPathResponse | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [extensionsEnabled, setExtensionsEnabled] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");

  const [prevMissionState, setPrevMissionState] = useState<string | null>(null);

  const [autoOrigin, setAutoOrigin] = useState(false);
  const [autoOriginReference, setAutoOriginReference] = useState<AutoOriginReference | null>(null);
  const [alignedRefPoints, setAlignedRefPoints] = useState<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>([]);

  // Deliberately does NOT clear on every `visualAlignmentItem` -> null (i.e. every
  // "Done"): stopPlanEditing bakes the drag into `lines` then clears the sticker, and
  // clearing this anchor at that exact moment would make MapViewNative fall back to its
  // generic preview origin — which re-derives itself from `lines[0]`'s CURRENT position
  // on every render, so it silently "chases" whatever the bake just moved and cancels the
  // drag out visually (the plan appears to snap back). Keeping this stable anchor alive
  // across bake operations is what makes a locked-in plan position actually stick.
  //
  // Fix Alignment clears the anchor SYNCHRONOUSLY in AlignDxfPanel (same turn as
  // setAlignedRefPoints + line transform) so the first post-Fix paint uses origin_gps.
  // This effect is only a safety net for other paths that set alignedRefPoints without
  // going through Fix (e.g. staged mission hydrate) while the sticker is already gone.
  useEffect(() => {
    if (!visualAlignmentItem && alignedRefPoints.length > 0) {
      setVisualAlignmentAnchor(null);
    }
  }, [visualAlignmentItem, alignedRefPoints]);

  const protectedMissionResident = isProtectedMissionResident(loadedPathInspection);
  const autoOriginEligible =
    autoOrigin &&
    stagedWorkflow.staged !== "verified" &&
    alignedRefPoints.length === 0;
  const missionStateRef = useRef<string | null>(null);
  const recoveryAttemptedRef = useRef(false);
  const isRecoveringRef = useRef(false);
  // Bumped whenever a mutating mission action (load/stage/clear/reset) starts,
  // so an in-flight refreshMissionIdentity() poll issued before that action
  // can't land afterward and clobber the fresher state with a stale snapshot.
  const missionIdentityGenerationRef = useRef(0);
  const missionIdentityInFlightRef = useRef(false);
  const [mapViewEnabled, setMapViewEnabled] = useState(true);
  const [resetNorthCount, setResetNorthCount] = useState(0);
  // Shared across every page (Home, Fields, Templates) so the top toolbar's
  // Plan/Rover focus buttons drive whichever map instance is currently mounted,
  // instead of each page owning its own disconnected counter pair.
  const [recenterRoverCount, setRecenterRoverCount] = useState(0);
  const [recenterPlanCount, setRecenterPlanCount] = useState(0);

  const toggleAutoOrigin = useCallback(() => {
    setAutoOrigin((prev) => {
      const next = !prev;
      if (!next) {
        setAutoOriginReference(null);
      } else {
        setPage("home");
        setMissionLoadedPanelOpenToken((token) => token + 1);
      }
      return next;
    });
  }, [setPage]);

  useEffect(() => {
    missionStateRef.current = telemetrySnapshot?.mission_state ?? null;
  }, [telemetrySnapshot?.mission_state]);

  useEffect(() => {
    if (!autoOriginEligible) {
      setAutoOriginReference(null);
    }
  }, [autoOriginEligible]);

  useEffect(() => {
    if (!autoOriginEligible || autoOriginReference) return;
    const captured = buildAutoOriginReference(sanitizePlanLines(lines), telemetrySnapshot);
    if (captured) {
      setAutoOriginReference(captured);
    }
  }, [autoOriginEligible, autoOriginReference, lines, telemetrySnapshot]);

  useEffect(() => {
    if (!autoOriginReference) return;
    if (!planStartMatchesReference(lines, autoOriginReference)) {
      setAutoOriginReference(null);
    }
  }, [lines, autoOriginReference]);

  const mapSourceLines = useMemo(() => sanitizePlanLines(lines), [lines]);

  /** Drop stale file ids from mission layers when the upload batch shrinks. */
  useEffect(() => {
    const ids = new Set(uploadedFiles.map((f) => f.id));
    setMissionLayers((prev) => {
      if (prev.length === 0) return prev;
      const next = pruneMissingFiles(prev, ids);
      // Avoid re-render loops when nothing changed
      const same =
        next.length === prev.length &&
        next.every(
          (l, i) =>
            l.id === prev[i].id &&
            l.fileEntryIds.length === prev[i].fileEntryIds.length &&
            l.fileEntryIds.every((id, j) => id === prev[i].fileEntryIds[j])
        );
      return same ? prev : next;
    });
  }, [uploadedFiles]);

  /**
   * Every uploaded file has an established position — CSV is always verified
   * immediately on import; DXF is verified either because the file was inherently
   * geographic or because Fix Alignment has since anchored it (alignment sets
   * `status: "verified"` but never flips `isGeographic`, so checking that flag
   * alone wrongly excluded every aligned metric DXF from Mission Layers).
   */
  const canUseMissionControl = useMemo(
    () =>
      uploadedFiles.length > 0 && uploadedFiles.every((f) => f.status === "verified"),
    [uploadedFiles]
  );

  const displayedLines = useMemo(() => {
    const base = mapSourceLines;
    if (!autoOriginEligible || !autoOriginReference) return base;
    return applyAutoOriginShift(base, autoOriginReference);
  }, [mapSourceLines, autoOriginEligible, autoOriginReference]);

  const csvMapPins = useMemo(
    () => (localCsvPreview ? localCsvToMapPins(localCsvPreview) : null),
    [localCsvPreview]
  );

  /**
   * Geometry catalog to recover mission-layer identity on hydrated (post-Send/Load)
   * lines whose ids no longer carry a file prefix (see tagLinesWithMissionLayer).
   * Rebuilt reactively off current mission-layer state — not just once at the Send/Load
   * callback — so assigning a file to a layer (or creating one) AFTER Send still lets
   * the M-Layer pill affect the map, instead of only working for layers that already
   * existed at the moment Send/Load ran.
   */
  const missionLayerLegCatalog = useMemo(
    () =>
      buildMissionLayerLegCatalog(
        appPlannedStartSnapshot?.paintedLines ?? [],
        uploadedFiles,
        missionLayers,
        appPlannedStartSnapshot?.extensionConfig
      ),
    [appPlannedStartSnapshot, uploadedFiles, missionLayers]
  );

  /** Map/canvas lines with mission-layer visibility applied (CAD filters still apply later). */
  const missionVisibleDisplayedLines = useMemo(
    () =>
      filterCanvasLinesByMissionVisibility(
        tagLinesWithMissionLayer(displayedLines, missionLayerLegCatalog),
        uploadedFiles,
        missionLayers
      ),
    [displayedLines, uploadedFiles, missionLayers, missionLayerLegCatalog]
  );
  const missionVisibleMapSourceLines = useMemo(
    () =>
      filterCanvasLinesByMissionVisibility(
        tagLinesWithMissionLayer(mapSourceLines, missionLayerLegCatalog),
        uploadedFiles,
        missionLayers
      ),
    [mapSourceLines, uploadedFiles, missionLayers, missionLayerLegCatalog]
  );

  // ── Anchor point selection (re-anchor a CSV/DXF plan's start) — Home page only ──
  /** At least one mark line exists; DXF lines must belong to an already-verified file. */
  const anchorAvailable = useMemo(() => {
    const marks = selectMarkPlanLines(lines);
    return marks.some((line) => {
      const file = fileForLineId(line.id, uploadedFiles);
      if (!file) return true;
      if (file.kind === "csv") return true;
      return file.status === "verified";
    });
  }, [lines, uploadedFiles]);

  const anchorTargetOptions = useMemo(
    () => buildAnchorTargetOptions(uploadedFiles, missionLayers),
    [uploadedFiles, missionLayers]
  );

  const isolatedAnchorLines = useMemo(() => {
    if (!anchorTarget) return [];
    return isolateLinesForAnchorTarget(lines, uploadedFiles, missionLayers, anchorTarget);
  }, [lines, uploadedFiles, missionLayers, anchorTarget]);

  /** Selectable dots for the map — CSV raw survey rows, DXF entity endpoints. */
  const anchorCandidates = useMemo((): AnchorCandidatePoint[] => {
    if (!anchorSelectMode || !anchorTarget) return [];
    const marks = selectMarkPlanLines(isolatedAnchorLines);
    const out: AnchorCandidatePoint[] = [];
    for (const line of marks) {
      const isCsv = line.entity?.geometry?.road_marking === true;
      if (isCsv) {
        const sourcePts = line.entity?.geometry?.source_points as
          | { north: number; east: number }[]
          | undefined;
        const pts = sourcePts && sourcePts.length > 0 ? sourcePts : line.entity?.preview_points ?? [];
        for (const p of pts) out.push({ lineId: line.id, north: p.north, east: p.east, kind: "csv" });
        continue;
      }
      // DXF: entity endpoints only — matches chainMarkLinesFromSeed's seed granularity.
      if (line.from) out.push({ lineId: line.id, north: line.from.x, east: line.from.y, kind: "dxf" });
      if (line.to) out.push({ lineId: line.id, north: line.to.x, east: line.to.y, kind: "dxf" });
    }
    return out;
  }, [anchorSelectMode, anchorTarget, isolatedAnchorLines]);

  const mapGeometryFrame = useMemo(
    () =>
      resolveMapGeometryFrame({
        mode: "fields",
        alignedRefPoints,
        stagedVerified: stagedWorkflow.staged === "verified",
        autoOriginReference,
        autoOriginEnabled: autoOriginEligible,
        geoOrigin: geoOriginDxf,
      }),
    [alignedRefPoints, stagedWorkflow.staged, autoOriginReference, autoOriginEligible, geoOriginDxf]
  );

  // [CANVAS] frame-alignment debug. Logs the auto-origin transform whenever the
  // captured origin, run-state, or rover pose changes, so a wrong rover-icon
  // placement can be diagnosed against the drawn path's first point.
  useEffect(() => {
    if (!autoOriginEligible) return;
    const first = getPlanStartPoint(sanitizePlanLines(lines));
    const rover =
      telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
        ? { n: telemetrySnapshot.pos_n, e: telemetrySnapshot.pos_e }
        : null;
    if (!__DEV__) return;
    console.log("[CANVAS] frame", JSON.stringify({
      missionRunning,
      missionState: telemetrySnapshot?.mission_state ?? null,
      autoOriginReference,
      planFirstPoint: first,
      roverTelemetry: rover,
      delta: autoOriginReference && first
        ? {
            dN: autoOriginReference.roverNorth - autoOriginReference.planStartNorth,
            dE: autoOriginReference.roverEast - autoOriginReference.planStartEast,
          }
        : null,
    }));
  }, [
    autoOriginEligible,
    missionRunning,
    autoOriginReference,
    telemetrySnapshot?.mission_state,
    telemetrySnapshot?.pos_n,
    telemetrySnapshot?.pos_e,
    lines,
  ]);

  const previewRoverPoint = useMemo(() => {
    const telemetryPoint =
      telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
        ? { north: telemetrySnapshot.pos_n, east: telemetrySnapshot.pos_e }
        : null;
    const planStartPoint = getPlanStartPoint(displayedLines);
    // Prefer live telemetry so the rover icon tracks the real pose.
    return telemetryPoint ?? planStartPoint;
  }, [displayedLines, telemetrySnapshot?.pos_e, telemetrySnapshot?.pos_n]);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedWsRef = useRef(selectedWs);
  const manualHostRef = useRef(manualHost);
  const backendPinnedRef = useRef(backendPinned);
  // Prevents overlapping discovery sweeps from piling up on a slow/lossy link
  // (each full /24 sweep can outlast the 5s refresh interval).
  const scanInFlightRef = useRef(false);
  // Invalidates in-flight discovery when Connect starts (or a newer scan begins)
  // so late setWsStatus("ready") / setSelectedWs cannot clobber "connected".
  const discoveryScanGenerationRef = useRef(0);
  const connectInFlightRef = useRef(false);
  const pendingSocketRef = useRef<Socket | null>(null);
  const wsStatusRef = useRef(wsStatus);
  const previousSelectedPathRef = useRef<string | null>(null);

  const activeMenu = useMemo(() => MENU_ITEMS.find((x) => x.key === page), [page]);
  const sectionTitle =
    page === "fields"
      ? "Fields"
      : activeMenu?.label ?? "Section";
  const isOffline = wsError.startsWith("Offline");
  const apiBaseUrl = selectedWs || manualHost;

  useEffect(() => {
    authApi.installAuthenticatedFetch();
    void authApi.loadStoredSession().then((stored) => {
      if (stored) setOperatorSession(stored);
    });
  }, []);

  const handleInvalidSession = useCallback(() => {
    setOperatorSession(null);
    setOperatorPassword("");
    void authApi.saveStoredSession(null);
    socket?.disconnect();
    setSocket(null);
    setWsStatus("idle");
    setPage("connection");
    setWsError("Session expired. Enter the rover password again.");
    clearTelemetryRuntime();
  }, [socket]);

  useEffect(() => {
    authApi.setAuthRuntime({
      token: operatorSession?.token ?? null,
      baseUrl: apiBaseUrl || null,
      onInvalidSession: handleInvalidSession,
    });
  }, [apiBaseUrl, handleInvalidSession, operatorSession?.token]);

  const logAction = useCallback((action: string, details?: Record<string, unknown>) => {
    const stamp = new Date().toISOString();
    if (details && Object.keys(details).length > 0) {
      console.log(`[${stamp}] [UI] ${action}`, details);
      return;
    }
    console.log(`[${stamp}] [UI] ${action}`);
  }, []);

  const showToast = useCallback((title: string, message: string, tone: ToastTone = "info") => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    const id = Date.now();
    setToast({ id, title, message, tone });
    toastTimerRef.current = setTimeout(() => {
      setToast((current) => (current?.id === id ? null : current));
    }, 2800);
  }, []);

  const virtualJoystick = useVirtualJoystick({
    socket,
    authToken: operatorSession?.token ?? "",
    socketConnected: wsStatus === "connected",
    onErrorMessage: (title, message) => showToast(title, message, "error"),
  });
  const virtualJoystickRef = useRef(virtualJoystick);
  virtualJoystickRef.current = virtualJoystick;

  const setWorkflowStep = useCallback((step: StagedWorkflowStep, status: StagedWorkflowStatus) => {
    setStagedWorkflow((prev) => (prev[step] === status ? prev : { ...prev, [step]: status }));
  }, []);

  // Promote alignment when every local batch file is verified, or (legacy single-path)
  // when verifiedAlignmentRequest carries an origin.
  useEffect(() => {
    if (uploadedFiles.length > 0) {
      const allVerified = uploadedFiles.every((f) => f.status === "verified");
      if (allVerified && stagedWorkflow.alignment !== "verified") {
        setWorkflowStep("alignment", "verified");
      } else if (!allVerified && stagedWorkflow.alignment === "verified") {
        setWorkflowStep("alignment", "pending");
      }
      return;
    }
    if (
      verifiedAlignmentRequest?.origin_gps &&
      stagedWorkflow.alignment !== "verified"
    ) {
      setWorkflowStep("alignment", "verified");
    }
  }, [
    uploadedFiles,
    verifiedAlignmentRequest,
    stagedWorkflow.alignment,
    setWorkflowStep,
  ]);

  const invalidateStagedWorkflowFrom = useCallback((step: "alignment" | "spray" | "staged" | "loaded") => {
    missionIdentityGenerationRef.current += 1;
    setStagedWorkflow((prev) => invalidateWorkflowFrom(prev, step));

    const localBatchActive = uploadedFilesRef.current.length > 0;

    if (step === "alignment") {
      // Working Align UI only — never drop sharedOriginGps or committed multi-file lines.
      setAlignmentResult(null);
      if (!localBatchActive || sharedOriginGpsRef.current == null) {
        setVerifiedAlignmentRequest(null);
      }
    }
    if (step === "alignment" || step === "spray") {
      setSegmentVerification(null);
    }
    if (step === "alignment" || step === "spray" || step === "staged") {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      // Geometry / order change invalidates frozen Send snapshot (must re-Send).
      setAppPlannedStartSnapshot(null);
      // Same reasoning: Offset's reset baseline is now stale too (e.g. Fix Alignment
      // baked a transform into `lines` after the baseline was captured).
      setPreOffsetSnapshot(null);
    }
    setLoadedPathInspection(null);
    setMissionLoaded(false);
    // Multi-file batch: keep parse metadata and geometry; only demote send/load stages.
    if (!localBatchActive) {
      setLocalCsvPreview(null);
      localCsvParsesRef.current = [];
      setLocalDxfMeta(null);
    }
  }, []);

  /**
   * Recover the frontend visual state (DXF lines, staged mission geometry)
   * from the backend when the app reloads and finds a mission already loaded.
   */
  const recoverLoadedMissionContext = useCallback(async (
    sourceName: string | null | undefined,
    missionId: string | null | undefined
  ) => {
    if (!apiBaseUrl) return;
    try {
      console.log(`[RECOVERY] Recovering loaded mission context: source=${sourceName}, missionId=${missionId}`);
      // Flag to prevent the selectedPathName change effect from wiping staged state
      isRecoveringRef.current = true;

      // Step 1: Only hit the filename-based preview when sourceName actually looks
      // like a real file. /api/path/{name}/preview does a literal file lookup and
      // 404s on anything else — in particular, the backend can report a staged
      // mission's ID as source_name when no real DXF filename is known, and
      // calling previewSelectedPath with that 404s and silently replaces the map
      // with a mock placeholder line. When it IS a real filename, this still runs
      // because it's what refreshes importedPlan/selectedPathName and the
      // per-entity spray/extension editor state.
      const looksLikeFilename = /\.(dxf|csv|waypoints)$/i.test(sourceName || "");
      if (looksLikeFilename) {
        await previewSelectedPath(sourceName!);
      } else if (sourceName) {
        console.warn(`[RECOVERY] sourceName "${sourceName}" is not a real filename, skipping DXF preview.`);
      }

      // Step 2: If we have a mission ID, fetch the staged mission geometry and use
      // it as the authoritative map source — /api/path/staged/{id} works even when
      // Step 1 was skipped or failed, so this always runs last and its geometry
      // wins, guaranteeing the map reflects what's really loaded.
      if (missionId) {
        try {
          const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
          if (stagedRes.ok) {
            const stagedArtifact = (await stagedRes.json()) as pathApi.StagedMissionResponse;
            // Geometry + origin from one hydrator — never set lines without the staged anchor.
            const hydrated = hydrateStagedMissionForMap(stagedArtifact);
            if (hydrated) {
              setAlignedRefPoints(hydrated.alignedRefPoints);
              setLines(sanitizePlanLines(hydrated.lines));
              setSelectedLineId(hydrated.selectedLineId);
            } else {
              console.warn(`[RECOVERY] Staged mission ${missionId} had no drawable waypoints.`);
            }
            setStagedMissionInspection(stagedArtifact);
            setStagedMissionId(missionId);
            // Mark the workflow steps as verified so the UI reflects that
            // the plan is fully staged and loaded
            setStagedWorkflow({
              entities: "verified",
              upload: "verified",
              order: "verified",
              alignment: "verified",
              spray: "verified",
              staged: "verified",
              loaded: "verified",
              started: "pending",
            });
            setMissionLoaded(true);
            console.log(`[RECOVERY] Successfully recovered staged mission ${missionId}`);
          } else {
            console.warn(`[RECOVERY] Staged mission fetch failed: ${stagedRes.status}`);
          }
        } catch (err) {
          console.warn("[RECOVERY] Failed to fetch staged mission:", err);
        }
      } else if (!looksLikeFilename) {
        console.warn("[RECOVERY] No sourceName or missionId provided, skipping map preview.");
      }

      // Step 3: Re-fetch loaded-path inspection since previewSelectedPath clears it
      try {
        const loadedRes = await missionApi.getLoadedPath(apiBaseUrl);
        if (loadedRes.ok) {
          const loadedData = (await loadedRes.json()) as missionApi.LoadedPathResponse;
          setLoadedPathInspection(loadedData);
        }
      } catch (err) {
        console.warn("[RECOVERY] Failed to re-fetch loaded path:", err);
      }
    } catch (err) {
      console.warn("[RECOVERY] Failed to recover loaded mission context:", err);
    } finally {
      isRecoveringRef.current = false;
    }
  }, [apiBaseUrl]);

  const reconcileLoadedMission = useCallback((
    loaded: missionApi.LoadedPathResponse,
    status?: missionApi.MissionStatus
  ) => {
    const inspection = {
      ...loaded,
      running_mission_id: status?.running_mission_id ?? loaded.running_mission_id ?? null,
    };
    setLoadedPathInspection(inspection);

    if (stagedWorkflow.staged === "verified" && stagedMissionId) {
      const verification = verifyStagedLoadedMission(inspection, stagedMissionId);
      setMissionLoaded(verification.verified);
      setStagedWorkflow((prev) => ({
        ...prev,
        loaded: verification.verified ? "verified" : "pending",
        started: verification.verified ? prev.started : "pending",
      }));
      return;
    }

    const targetSourceName = inspection.source_name || inspection.name;

    // If the app just booted blank (no local plan data) but the backend
    // reports a loaded mission, auto-recover the visual state.
    if (
      inspection.loaded &&
      !selectedPathName &&
      !importedPlan &&
      !recoveryAttemptedRef.current
    ) {
      recoveryAttemptedRef.current = true;
      void recoverLoadedMissionContext(targetSourceName, inspection.mission_id);
    }

    setMissionLoaded(Boolean(inspection.loaded && !isProtectedMissionResident(inspection)));
  }, [stagedMissionId, stagedWorkflow.staged, selectedPathName, importedPlan, recoverLoadedMissionContext]);

  useEffect(() => {
    if (previousSelectedPathRef.current === selectedPathName) return;
    previousSelectedPathRef.current = selectedPathName;
    // Skip the reset when we are recovering a loaded mission on reload
    if (isRecoveringRef.current) return;
    // Clearing selection (null) is owned by clear-mission / local CSV import so
    // those flows can set their own map + alignment state without this wipe.
    if (selectedPathName == null) return;
    missionIdentityGenerationRef.current += 1;
    setStagedWorkflow((prev) => ({
      ...prev,
      alignment: "pending",
      spray: "pending",
      staged: "pending",
      loaded: "pending",
      started: "pending",
    }));
    setAlignmentResult(null);
    setVerifiedAlignmentRequest(null);
    setIsGeographicDxf(false);
    setGeoOriginDxf(null);
    setSegmentVerification(null);
    setStagedPlanResult(null);
    setStagedMissionInspection(null);
    setStagedMissionId(null);
    setLoadedPathInspection(null);
  }, [selectedPathName]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (telemetrySnapshot) {
      const currentState = telemetrySnapshot.mission_state;
      const terminal = outcomeFromMissionStateTransition(prevMissionState, currentState);
      if (terminal && runningLayerIdsRef.current.length > 0) {
        const ids = [...runningLayerIdsRef.current];
        setMissionLayers((prev) => applyMissionTerminalOutcome(prev, ids, terminal));
        if (terminal === "completed") {
          runningLayerIdsRef.current = [];
          runningMissionIdRef.current = null;
        } else {
          // stopped — keep refs cleared so a later idle does not re-apply
          runningLayerIdsRef.current = [];
          runningMissionIdRef.current = null;
        }
      }
      if (prevMissionState === "running" && (currentState === "idle" || currentState === "completed")) {
        setTimeout(() => {
          if (currentState === "completed") {
            Alert.alert("Mission Completed", "The rover has successfully finished the mission.");
          }
          // idle after running is stop/abort — do not claim success
        }, 500);
      }
      setPrevMissionState(currentState ?? null);
    }
  }, [telemetrySnapshot?.mission_state, prevMissionState]);

  useEffect(() => {
    selectedWsRef.current = selectedWs;
  }, [selectedWs]);

  useEffect(() => {
    manualHostRef.current = manualHost;
  }, [manualHost]);

  useEffect(() => {
    backendPinnedRef.current = backendPinned;
  }, [backendPinned]);

  useEffect(() => {
    wsStatusRef.current = wsStatus;
  }, [wsStatus]);





  const deleteSelectedLine = () => {
    if (!selectedLineId) return;
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Editing the plan is blocked while a protected surveyed mission is resident.");
      return;
    }
    const targetLine = lines.find((line) => line.id === selectedLineId);
    if (targetLine?.layer === "transit" || targetLine?.layer === "extension") {
      // These are auto-generated from the primary entities + extension/spacing config, not
      // independently editable — deleting one directly would desync from that config.
      Alert.alert("Cannot delete", "Transit and extension segments are generated automatically and can't be deleted directly.");
      return;
    }
    logAction("DELETE_LINE", { selectedLineId });
    setLines((prev) => {
      const next = prev.filter((line) => line.id !== selectedLineId);
      setSelectedLineId(next[0]?.id ?? null);
      if (next.length === 0) {
        setImportedPlan(null);
      }
      return next;
    });
  };

  const deleteEntirePlan = () => {
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Deleting the plan is blocked while a protected surveyed mission is resident.");
      return;
    }
    logAction("DELETE_PLAN");
    setLines([]);
    setSelectedLineId(null);
    setImportedPlan(null);
    setLocalCsvPreview(null);
    localCsvParsesRef.current = [];
    setLocalDxfMeta(null);
    setUploadedFiles([]);
    uploadedFilesRef.current = [];
    setMissionLayers([]);
    setControlModeActive(false);
    setPendingLayerAssignment(null);
    resetAnchorSelection();
    setPendingDxfAlignment({});
    setSharedOriginGps(null);
    sharedOriginGpsRef.current = null;
    setAlignedRefPoints([]);
    setVerifiedAlignmentRequest(null);
    setAlignmentResult(null);
    setIsGeographicDxf(false);
    setGeoOriginDxf(null);
    setAutoOriginReference(null);
    setLayerVisibility({
      boundary: true,
      marking: true,
      center: true,
      transit: true,
      extension: true,
      rover: true,
      refPoints: true,
      segmentTypes: {},
    });
  };

  const connectSelectedWebsocket = async () => {
    const target = selectedWs || manualHost;
    if (!target) return;
    if (connectInFlightRef.current) {
      logAction("WS_CONNECT_SKIPPED", { reason: "already_connecting" });
      return;
    }

    const canReuse = authApi.canReuseSession(operatorSession, target);
    const passwordEntered = Boolean(operatorPassword.trim());
    if (!canReuse && !passwordEntered) {
      setWsError(
        operatorSession && !authApi.sessionMatchesHost(operatorSession, target)
          ? "Saved session is for a different backend. Enter the rover password."
          : "Enter the rover password to connect."
      );
      return;
    }

    connectInFlightRef.current = true;
    // Drop any in-flight discovery results — they must not reset wsStatus after connect.
    discoveryScanGenerationRef.current += 1;
    logAction("WS_CONNECT", { selectedWs: target, reuseSession: canReuse && !passwordEntered });
    setWsStatus("connecting");
    setWsError("");

    let usedStoredSession = false;
    let nextSocket: Socket | null = null;

    try {
      let session: authApi.OperatorSession;
      if (canReuse && !passwordEntered) {
        session = operatorSession!;
        usedStoredSession = true;
        logAction("AUTH_SESSION_REUSE", { target, session_id: session.session_id });
      } else {
        logAction("AUTH_LOGIN_START", { target });
        session = await authApi.login(target, operatorPassword);
        logAction("AUTH_LOGIN_OK", { target, session_id: session.session_id });
      }

      setOperatorSession(session);
      setOperatorPassword("");
      await authApi.saveStoredSession(session);
      authApi.setAuthRuntime({
        token: session.token,
        baseUrl: target,
        onInvalidSession: handleInvalidSession,
      });

      pendingSocketRef.current?.disconnect();
      // Defer socket.io-client until connect so the connection screen JS stays lighter.
      const { io } = await import("socket.io-client");
      nextSocket = io(target, {
        transports: ["websocket"], // Use websocket ONLY - polling is unreliable in APK builds
        timeout: 20000,
        forceNew: true,
        auth: { token: session.token },
      });
      pendingSocketRef.current = nextSocket;

      await waitForSocketConnect(nextSocket, SOCKET_CONNECT_TIMEOUT_MS);

      nextSocket.on("disconnect", (reason) => {
        console.log(`[SOCKET] Disconnected from ${target} — reason: ${reason}`);
      });

      nextSocket.on("auth_revoked", () => {
        handleInvalidSession();
      });

      nextSocket.on("error", (err) => {
        console.error("[SOCKET] Error:", err);
      });

      nextSocket.on("telemetry", (rawData: any) => {
        // Never let a bad packet force-close a release APK (uncaught JS → process kill).
        try {
          let data = rawData;
          if (typeof rawData === "string") {
            try {
              data = JSON.parse(rawData);
            } catch (e) {
              console.error("[SOCKET] Failed to parse telemetry JSON:", e);
              return;
            }
          }
          if (!data || typeof data !== "object") {
            console.warn("[SOCKET] Invalid telemetry format:", data);
            return;
          }

          // Normalize common ROS/backend field aliases so state updates even if backend uses long-form property names
          if (data.lat == null && (data.latitude != null || data.gps_lat != null || data.global_lat != null)) {
            data.lat = data.latitude ?? data.gps_lat ?? data.global_lat;
          }
          if (data.lon == null && (data.longitude != null || data.gps_lon != null || data.global_lon != null)) {
            data.lon = data.longitude ?? data.gps_lon ?? data.global_lon;
          }
          if (data.alt == null && (data.altitude != null || data.gps_alt != null)) {
            data.alt = data.altitude ?? data.gps_alt;
          }
          if (data.heading_ned_deg == null && data.heading != null) {
            data.heading_ned_deg = data.heading;
          }

          try {
            virtualJoystickRef.current?.reconcileTelemetry?.(data);
          } catch (vjErr) {
            console.warn("[SOCKET] reconcileTelemetry failed:", vjErr);
          }

          // Always refresh live-entry pose cache — even when React deadband skips setState.
          noteTelemetryForLiveEntry({
            pos_n: data.pos_n,
            pos_e: data.pos_e,
            lat: data.lat,
            lon: data.lon,
            gps_fix: data.gps_fix,
            pose_age_ms: data.pose_age_ms,
          });

          applyTelemetryPacket(data as TelemetrySnapshot);
          // Keep Start/live-entry ref aligned with store (full merged snapshot).
          telemetrySnapshotRef.current = getTelemetrySnapshot() ?? (data as TelemetrySnapshot);
        } catch (err) {
          console.error("[SOCKET] telemetry handler crash suppressed:", err);
        }
      });

      nextSocket.on("mission_status", (rawData: any) => {
        try {
        let data = rawData;
        if (typeof rawData === "string") {
          try {
            data = JSON.parse(rawData);
          } catch (e) {
            console.error("[SOCKET] Failed to parse mission_status JSON:", e);
            return;
          }
        }
        if (!data || typeof data !== "object") {
          console.warn("[SOCKET] Invalid mission_status format:", data);
          return;
        }

        if (data.state) {
          setMissionRunning(data.state === "running");
          setIsPaused(data.state === "paused");
          patchTelemetryMissionState(String(data.state));
          void refreshMissionIdentity();
        }
        } catch (err) {
          console.error("[SOCKET] mission_status handler crash suppressed:", err);
        }
      });

      pendingSocketRef.current = null;
      setSocket(nextSocket);
      setWsStatus("connected");
      setSelectedWs(target);
      setManualHost(target);
      setBackendPinned(true);
      // Defer home navigation one tick so connect UI settles before Mapbox mounts
      // (avoids release-only race: socket up + map native init on same frame).
      requestAnimationFrame(() => {
        setPage("home");
        setMenuOpen(true);
      });
      logAction("WS_CONNECTED", { apiBaseUrl: target });
    } catch (error) {
      nextSocket?.disconnect();
      if (pendingSocketRef.current === nextSocket) {
        pendingSocketRef.current = null;
      }
      if (usedStoredSession) {
        setOperatorSession(null);
        await authApi.saveStoredSession(null);
      }
      const message = formatSocketConnectError(error);
      setWsStatus("ready");
      setWsError(message);
      logAction("WS_CONNECT_FAILED", { error: message, reusedSession: usedStoredSession });
    } finally {
      connectInFlightRef.current = false;
    }
  };

  const disconnectToConnectionScreen = () => {
    logAction("WS_DISCONNECT");
    socket?.disconnect();
    setSocket(null);
    setWsStatus("idle");
    setBackendPinned(false);
    setPage("connection");
    setMenuOpen(true);
    clearTelemetryRuntime();
  };

  const logoutToConnectionScreen = async () => {
    logAction("LOGOUT");
    if (apiBaseUrl && operatorSession) {
      await authApi.logout(apiBaseUrl);
    }
    await authApi.saveStoredSession(null);
    setOperatorSession(null);
    setOperatorPassword("");
    disconnectToConnectionScreen();
  };

  const submitPasswordChange = async () => {
    if (!apiBaseUrl) return;
    if (newPasswordInput !== confirmPasswordInput) {
      Alert.alert("Password", "New passwords do not match.");
      return;
    }
    if (newPasswordInput.length < 8) {
      Alert.alert("Password", "Use at least 8 characters.");
      return;
    }
    setPasswordChangeBusy(true);
    try {
      const nextSession = await authApi.changePassword(
        apiBaseUrl,
        currentPasswordInput,
        newPasswordInput
      );
      setOperatorSession(nextSession);
      await authApi.saveStoredSession(nextSession);
      authApi.setAuthRuntime({
        token: nextSession.token,
        baseUrl: apiBaseUrl,
        onInvalidSession: handleInvalidSession,
      });
      setCurrentPasswordInput("");
      setNewPasswordInput("");
      setConfirmPasswordInput("");
      setPasswordChangeOpen(false);
      showToast("Password updated", "Other operator sessions were signed out.", "success");
    } catch (err: any) {
      Alert.alert("Password", err?.message || "Password change failed.");
    } finally {
      setPasswordChangeBusy(false);
    }
  };

  const enterOfflinePreview = () => {
    logAction("OFFLINE_PREVIEW");
    socket?.disconnect();
    setSocket(null);
    setSelectedWs("");
    setBackendPinned(false);
    setWsStatus("idle");
    setWsError("");
    setPage("home");
    setMenuOpen(true);
  };

  const scanForWebsockets = async () => {
    // Skip overlapping sweeps: on a lossy link a full /24 sweep can outlast the
    // 5s refresh, and concurrent sweeps flood the radio and break the real WS
    // handshake.
    if (scanInFlightRef.current) {
      return;
    }
    scanInFlightRef.current = true;
    try {
      await runWebsocketScan();
    } finally {
      scanInFlightRef.current = false;
    }
  };

  const runWebsocketScan = async () => {
    if (
      connectInFlightRef.current ||
      wsStatusRef.current === "connecting" ||
      wsStatusRef.current === "connected"
    ) {
      return;
    }

    // Generation tag: Connect (and a newer scan) bumps this so late setState is a no-op.
    const scanGeneration = ++discoveryScanGenerationRef.current;
    const discoveryStillOwnsUi = () => {
      if (discoveryScanGenerationRef.current !== scanGeneration) return false;
      if (connectInFlightRef.current) return false;
      const status = wsStatusRef.current;
      if (status === "connecting" || status === "connected") return false;
      return true;
    };

    const currentSelectedWs = selectedWsRef.current;
    const currentManualHost = manualHostRef.current;
    const isPinned = backendPinnedRef.current;
    logAction("DISCOVERY_SCAN_START", {
      manualHost: currentManualHost,
      selectedWs: currentSelectedWs,
      backendPinned: isPinned,
      scanGeneration,
    });
    if (!discoveryStillOwnsUi()) return;
    setWsStatus("scanning");
    setWsError("");

    // Fast path: if the already-known target (selected or manual host) answers,
    // present it and SKIP the expensive subnet sweep. This keeps the radio quiet
    // so the Socket.IO handshake can succeed on flaky hotspots, and avoids
    // flooding the network once a backend is known.
    const knownTarget = currentSelectedWs || currentManualHost;
    let manualHostReachable = false;
    if (knownTarget) {
      manualHostReachable = await probeHostReachable(knownTarget, 2500, 2);
    }
    if (!discoveryStillOwnsUi()) {
      logAction("DISCOVERY_SCAN_ABORTED", { phase: "after_known_probe", scanGeneration });
      return;
    }
    if (manualHostReachable && knownTarget) {
      const entry = parseHost(knownTarget);
      if (entry) {
        setDiscoveredRovers([{
          id: `${entry.host}-${entry.port}`,
          name: `Rover ${entry.host.split(".").pop() ?? entry.host}`,
          host: entry.host,
          port: entry.port,
          version: "manual",
          responseTime: 0,
        }]);
      }
      setSelectedWs(knownTarget);
      setManualHost(knownTarget);
      setWsStatus("ready");
      setWsError("");
      logAction("DISCOVERY_SCAN_TARGET_REACHABLE", { host: knownTarget });
      return;
    }

    // Detect the device's own LAN IP so we sweep the network the tablet is
    // actually on (e.g. a phone hotspot's 10.169.x.x), not just the hardcoded
    // 192.168.x guesses. React Native has no window.location to derive this.
    let deviceIp: string | null = null;
    try {
      const ip = await Network.getIpAddressAsync();
      if (ip && ip !== "0.0.0.0") {
        deviceIp = ip;
      }
    } catch (err) {
      logAction("DISCOVERY_DEVICE_IP_FAILED", { error: err instanceof Error ? err.message : String(err) });
    }
    if (!discoveryStillOwnsUi()) {
      logAction("DISCOVERY_SCAN_ABORTED", { phase: "after_device_ip", scanGeneration });
      return;
    }
    logAction("DISCOVERY_DEVICE_IP", { deviceIp });

    const candidateHosts = Array.from(
      new Set([
        ...priorityScanHosts(),
        ...LOCAL_WS_CANDIDATES,
        currentManualHost,
        ...buildSubnetSweepCandidates(currentManualHost, deviceIp),
      ])
    );

    const discovered = (
      await runWithConcurrency(candidateHosts, SUBNET_SCAN_CONCURRENCY, async (candidate) => {
        const responseTime = await probeBackendHost(candidate);
        if (responseTime === null) return [] as DiscoveredRover[];

        const beacons = await discoverBackendBeacons(candidate, responseTime);
        if (beacons.length > 0) {
          return beacons;
        }

        const parsed = parseHost(candidate);
        return parsed
          ? [{
            id: `${parsed.host}-${parsed.port}`,
            name: `Rover ${parsed.host.split(".").pop() ?? parsed.host}`,
            host: parsed.host,
            port: parsed.port,
            version: "1.0",
            responseTime,
          }]
          : [];
      })
    ).flat();

    if (!discoveryStillOwnsUi()) {
      logAction("DISCOVERY_SCAN_ABORTED", { phase: "after_subnet_sweep", scanGeneration });
      return;
    }

    discovered.sort((a, b) => {
      const aPriority = PRIORITY_BACKEND_IPS.includes(a.host);
      const bPriority = PRIORITY_BACKEND_IPS.includes(b.host);
      if (aPriority && !bPriority) return -1;
      if (!aPriority && bPriority) return 1;
      return (a.responseTime ?? 9999) - (b.responseTime ?? 9999);
    });

    const seen = new Set<string>();
    const uniqueDiscovered = discovered.filter((entry) => {
      const key = `${entry.host}:${entry.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    setDiscoveredRovers(uniqueDiscovered);

    const bestHost = uniqueDiscovered[0] ? `http://${uniqueDiscovered[0].host}:${uniqueDiscovered[0].port}` : "";
    if (bestHost) {
      const currentTarget = currentSelectedWs || currentManualHost;
      if (!currentTarget || manualHostReachable) {
        // If the manual host is reachable, keep it selected
        if (manualHostReachable && currentManualHost) {
          setSelectedWs(currentManualHost);
          // Auto-connect to the manual host if it was reachable
          logAction("DISCOVERY_SCAN_MANUAL_HOST_REACHABLE", { host: currentManualHost });
        }
        if (!currentTarget) {
          setSelectedWs(bestHost);
          setManualHost(bestHost);
        }
      } else if (!isPinned && !manualHostReachable) {
        // The configured host is unreachable (e.g. stale Jetson IP) and the user
        // hasn't pinned a manual choice — adopt the discovered backend so they can
        // just hit Connect instead of retyping the IP.
        setSelectedWs(bestHost);
        setManualHost(bestHost);
        logAction("DISCOVERY_SCAN_ADOPT_DISCOVERED", { host: bestHost });
      }
      setWsStatus("ready");
      setWsError("");
      logAction("DISCOVERY_SCAN_RESULT", { bestHost, currentTarget, manualHostReachable });
      return;
    }

    // If manual host was reachable but not in discovered list, still allow it
    if (manualHostReachable && currentManualHost) {
      const manualEntry = parseHost(currentManualHost);
      if (manualEntry) {
        const fakeRover: DiscoveredRover = {
          id: `${manualEntry.host}-${manualEntry.port}`,
          name: `Rover ${manualEntry.host.split(".").pop() ?? manualEntry.host}`,
          host: manualEntry.host,
          port: manualEntry.port,
          version: "manual",
          responseTime: 0,
        };
        setDiscoveredRovers([fakeRover]);
        setSelectedWs(currentManualHost);
        setWsStatus("ready");
        setWsError("");
        logAction("DISCOVERY_SCAN_MANUAL_FALLBACK", { host: currentManualHost });
        return;
      }
    }

    setSelectedWs("");
    setWsStatus("idle");
    setWsError("Offline: no backend found on the network.");
    logAction("DISCOVERY_SCAN_EMPTY");
  };

  const handleSelectWebsocket = useCallback(
    (value: string) => {
      logAction("WS_SELECTED", { value });
      setSelectedWs(value);
      setManualHost(value);
      setBackendPinned(true);
    },
    [logAction]
  );

  useEffect(() => {
    if (page !== "connection") return;
    // First paint last-known host; sweep after idle so Connect is tappable immediately.
    const first = setTimeout(() => {
      void scanForWebsockets();
    }, 1500);
    const timer = setInterval(() => {
      void scanForWebsockets();
    }, DISCOVERY_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [page]);

  const fetchBackendPaths = async () => {
    if (!apiBaseUrl) return;
    try {
      console.log("[API GET] /api/paths - Polling paths list...");
      const data = await pathApi.getPaths(apiBaseUrl);
      console.log(`[API GET] /api/paths - Success, found ${data.length} paths`);
      setBackendPaths(data);
    } catch (err) {
      console.log("[API GET] /api/paths - Error fetching paths:", err);
    }
  };

  const fetchWithRetry = async (request: () => Promise<Response>, retries = 2) => {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await request();
        if (res.ok) return res;
        // If not ok, it might be a 404, which shouldn't be retried if the endpoint really doesn't exist
        if (res.status === 404) return res;
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    return request(); // fallback final attempt
  };

  const previewSelectedPath = async (pathName: string) => {
    if (!apiBaseUrl) return;
    setLoadedPathInspection(null);
    // Backend path selection replaces any on-device CSV / local DXF preview.
    setLocalCsvPreview(null);
    localCsvParsesRef.current = [];
    setLocalDxfMeta(null);
    setMissionActionBusy(true);
    try {
      console.log(`[API GET] /api/path/${pathName}/preview - Fetching detailed preview...`);
      setSelectedPathName(pathName);
      let generatedLines: PlanLine[] = [];
      try {
        if (pathName.toLowerCase().endsWith(".dxf")) {
          const res = await fetchWithRetry(() => pathApi.getPathEntities(apiBaseUrl, pathName));
          if (res.ok) {
            const body = await res.json();
            const isEnabled = body.extension_config?.enabled ?? false;
            setExtensionsEnabled(isEnabled);
            if (body.extension_config) {
              setExtPre(String(body.extension_config.pre_extension_m ?? "0.5"));
              setExtAft(String(body.extension_config.aft_extension_m ?? "0.5"));
            }
            console.log(`[API GET] /api/path/${pathName}/entities - Success, loaded ${body.num_entities} entities`);
            setIsGeographicDxf(!!body.is_geographic);
            setGeoOriginDxf(body.geo_origin ?? null);
            setWorkflowStep("entities", "verified");
            const entities = body.entities || [];
            // Mark entities only — extension PRE/AFT and inter-path transit are
            // built on-device (same as CSV) so the map and Path Order stay purple
            // and interleaved consistently.
            entities.forEach((ent: any, i: number) => {
              const layerUpper = String(ent.layer || "").toUpperCase();
              let layerName: PlanLine["layer"] = "marking";
              if (layerUpper.includes("BOUND")) layerName = "boundary";
              else if (layerUpper.includes("CENTER")) layerName = "center";
              else if (layerUpper.includes("MARK")) layerName = "marking";
              // Transit-named layers from CAD stay transit (not painted).
              if (
                layerUpper.includes("TRANSIT") ||
                layerUpper.includes("TRAVEL") ||
                layerUpper.includes("MOVE") ||
                layerUpper.includes("RAPID")
              ) {
                layerName = "transit";
              }

              const pts = ent.preview_points || [];
              const fromPt = pts[0] || { north: 0, east: 0 };
              const toPt = pts[pts.length - 1] || fromPt;

              generatedLines.push({
                id: ent.entity_id || `dxf-ent-${i}`,
                label: `${ent.entity_type || "Entity"} ${ent.entity_id || i}`,
                layer: layerName,
                from: { id: i * 2 + 1, x: fromPt.north, y: fromPt.east },
                to: { id: i * 2 + 2, x: toPt.north, y: toPt.east },
                width: 0.1,
                is_mark: ent.is_mark,
                entity: normalizeDxfEntityGeometry(ent),
              });
            });

            const markLines = selectMarkPlanLines(generatedLines);
            if (markLines.length === 0 && generatedLines.length === 0) {
              throw new Error("Preview entities did not contain valid geometries");
            }
            // Always chain free-ends (per_line=false) — matches rover default freeness.
            const extCfg = {
              enabled: isEnabled,
              preM: Number(body.extension_config?.pre_extension_m ?? 0.5) || 0.5,
              aftM: Number(body.extension_config?.aft_extension_m ?? 0.5) || 0.5,
              perLine: false as const,
            };
            const order = defaultPathOrder(markLines.length > 0 ? markLines : generatedLines);
            generatedLines = applyCsvOrderToPlanLines(
              markLines.length > 0 ? markLines : generatedLines,
              order,
              extCfg
            );
            if (generatedLines.length === 0) {
              throw new Error("Preview entities did not contain valid geometries");
            }
          } else {
            throw new Error(`Entities endpoint failed with status ${res.status}`);
          }
        } else {
          const res = await fetchWithRetry(() => pathApi.getPathPreview(apiBaseUrl, pathName));
          if (res.ok) {
            const body = await res.json();
            console.log(`[API GET] /api/path/${pathName}/preview - Success, loaded ${body.num_points} points`);
            const pts = Array.isArray(body?.waypoints) ? body.waypoints : [];
            if (pts.length === 0) {
              throw new Error("Preview returned no waypoints");
            }
            
            // If only 1 point was drawn, create a zero-length segment so it can still be aligned and previewed
            const effectivePts = pts.length === 1 ? [pts[0], pts[0]] : pts;

            for (let i = 0; i < effectivePts.length - 1; i++) {
              const fromPt = effectivePts[i];
              const toPt = effectivePts[i + 1];
              const fromNorth = coerceFiniteNumber(fromPt?.north);
              const fromEast = coerceFiniteNumber(fromPt?.east);
              const toNorth = coerceFiniteNumber(toPt?.north);
              const toEast = coerceFiniteNumber(toPt?.east);

              if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) {
                continue;
              }

              const sprayFlag = fromPt?.spray ?? true;
              generatedLines.push({
                id: `rpp-line-${i}`,
                label: `Segment ${i + 1}`,
                layer: sprayFlag ? "marking" : "center",
                from: { id: i * 2 + 1, x: fromNorth, y: fromEast },
                to: { id: i * 2 + 2, x: toNorth, y: toEast },
                width: 0.1,
              });
            }
            if (generatedLines.length === 0) {
              throw new Error("Preview waypoints did not contain valid coordinates");
            }
          } else {
            console.error(`[API GET] /api/path/${pathName}/preview - Failed with status ${res.status}`);
            throw new Error("Preview not available");
          }
        }
      } catch (err) {
        console.log("[API GET] /api/path/entities/preview - Endpoint failed/not supported, fallback to mock line:", err);
        generatedLines = [{
          id: "rpp-line-0",
          label: "Segment 1 (Preview fallback)",
          layer: "marking",
          from: { id: 1, x: 0, y: 0 },
          to: { id: 2, x: 0, y: 10 },
          width: 0.1,
        }];
      }
      // Keep backend/imported DXF coordinates canonical until a verified Fix Alignment
      // rehydrate bakes them into NED. Viewport auto-fit must not mutate design coords
      // (e.g. a 0..2 m line becoming -1..1 m would corrupt surveyed ref points).
      if (generatedLines.length > 0) {
        const existingVirtual = lines.filter((l: PlanLine) => l.layer === "virtual_boundary");
        if (existingVirtual.length > 0) {
          generatedLines.push(...existingVirtual);
        }
      }
      const normalized = sanitizePlanLines(
        normalizePlanLinesForCurves(normalizePlanLines(generatedLines))
      );
      // Backend /entities + /plan always return design-frame (raw DXF) geometry. After Fix
      // Alignment, map projection uses origin_gps with local (0,0) and `lines` must stay in
      // that NED frame. Extension toggle / path re-select re-fetch design-frame geometry —
      // re-apply the stored Fix similarity transform here so pose never jumps. Unaligned
      // previews pass through unchanged. Input is always design-frame (never re-bake NED).
      const forMap = rehydrateAlignedPlanLines(normalized, alignmentResultRef.current);
      if (alignmentResultRef.current && forMap !== normalized) {
        console.log(
          `[AlignDXF][Rehydrate] Applied verified Fix transform to ${normalized.length} design-frame line(s) after path preview refresh`
        );
      }
      setLines(forMap);
      // Keep the plan-editing/visual-alignment "sticker" (if one is active) in sync with
      // freshly fetched geometry — e.g. toggling DXF extensions while a Move/Rotate Plan
      // or Visual Alignment session is still open (not yet confirmed). The sticker only
      // holds its own copy of `lines` for live rendering; without this it would keep
      // showing the pre-refresh geometry until the user confirms/re-enters the mode. Its
      // x/y/rotation/scale (the user's in-progress drag) are left untouched — only the
      // underlying line geometry is refreshed (already NED-baked when alignment is verified).
      setVisualAlignmentItem((prev) => (prev ? { ...prev, lines: forMap } : prev));
      setImportedPlan({
        fileName: pathName,
        uri: "",
        fileType: pathName.endsWith(".csv") ? "csv" : pathName.endsWith(".waypoints") ? "waypoints" : "dxf",
        source: "builtin"
      });
      setSelectedLineId(normalized[0]?.id ?? null);
      setMissionFileReady(true);
      setMissionLoaded(false);
      setMissionRunning(false);
    } catch (err) {
      console.log("Error loading path preview:", err);
      Alert.alert("Preview failed", err instanceof Error ? err.message : String(err));
    } finally {
      setMissionActionBusy(false);
    }
  };

  const parseDxfPlan = async () => {
    if (!apiBaseUrl || !importedPlan) return;
    if (protectedMissionResident) {
      const message = "Reparse is blocked while a protected surveyed mission is resident.";
      Alert.alert("Mission conflict", message);
      showToast("Mission conflict", message, "error");
      return;
    }
    setMissionActionBusy(true);
    try {
      showToast("Parse", "Sending modifications to backend...", "info");

      // The user indicated that the parse-dxf payload is still UploadFile
      // So we will reconstruct the DXF or rely on the backend to provide a way
      // Wait, we can't easily generate a perfect DXF on the frontend and upload it
      // if it still expects an UploadFile. BUT the user explicitly confirmed:
      // "it's payload is the file itself will do they didn't changed"
      // If we must send the file itself, we will trigger the upload flow or call plan.
      // But wait! If the user unchecks a box, we need a way to tell the backend!
      // I will send the current entities as JSON to /api/path/plan for actual planning,
      // or simulate it here based on what they approved.
      // For now, I will use /api/path/parse-dxf if it accepts the file, but since the
      // prompt says "at bottom the abutton will appear to send to post for POST /api/path/parse-dxf endpoint"
      // I will implement a POST request.

      // Sending an empty file if the backend expects multipart/form-data for /parse-dxf
      // But passing the modified entities in some way if possible.
      const content = linesToDxf(lines, importedPlan.fileName);
      let form: FormData;
      if (Platform.OS === "web") {
        // Browsers require a real Blob/File in a multipart body. The native
        // {uri,name,type} descriptor serialises to "[object Object]" in the
        // browser, so the backend received garbage and returned 422.
        form = new FormData();
        form.append("file", new Blob([content], { type: "application/dxf" }), importedPlan.fileName);
      } else {
        const tempFileName = `${Date.now()}-${importedPlan.fileName.replace(/[\\/:*?"<>|]/g, "_")}`;
        const tempFileUri = `${FileSystem.cacheDirectory ?? ""}${tempFileName}`;
        await FileSystem.writeAsStringAsync(tempFileUri, content, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        form = createUploadFormData(tempFileUri, importedPlan.fileName, "application/dxf");
      }

      const res = await pathApi.parseDxf(apiBaseUrl, form);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Parse failed");
        throw new Error(errMsg);
      }
      invalidateStagedWorkflowFrom("alignment");
      setWorkflowStep("upload", "verified");

      // Choice A: Refresh preview immediately!
      await previewSelectedPath(importedPlan.fileName);
      showToast("Parsed", "Plan updated successfully.", "success");
    } catch (error) {
      setWorkflowStep("upload", "failed");
      logAction("PARSE_FAILED", { error: error instanceof Error ? error.message : String(error) });
      Alert.alert("Parse failed", error instanceof Error ? error.message : "Could not parse.");
      showToast("Parse failed", error instanceof Error ? error.message : "Parse failed.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  };

  useEffect(() => {
    if (page !== "fields" || !apiBaseUrl || missionActionBusy) return;
    void fetchBackendPaths();
    const timer = setInterval(() => {
      void fetchBackendPaths();
    }, 5000);
    return () => clearInterval(timer);
  }, [page, apiBaseUrl, missionActionBusy]);

  async function refreshTelemetryPanel() {
    if (!apiBaseUrl) return;
    setTelemetryLoading(true);
    setTelemetryError("");
    try {
      const [statusRes, healthRes, telemetryRes, loadedRes] = await Promise.all([
        fetchMissionStatus(apiBaseUrl),
        fetchJson<{
          ros_node: boolean;
          fcu_connected: boolean;
          armed: boolean;
          mode: string;
          rpp_state: number;
          pose_age_ms: number;
          mission_state: string;
        }>(`${apiBaseUrl}/api/healthz`).catch((err) => {
          console.log("healthz failed:", err);
          return null;
        }),
        fetchJson<{
          pos_n: number;
          pos_e: number;
          heading_ned_deg: number;
          xtrack_m: number;
          heading_err_deg: number;
          lookahead_m: number;
          speed_m_s: number;
          measured_speed_m_s?: number | null;
          kappa: number;
          dist_to_goal_m: number;
          pose_age_ms: number;
          rpp_state: number;
          rpp_state_name: string;
          rpp_debug_age_ms?: number | null;
          rpp_debug_fresh?: boolean | null;
          armed: boolean;
          mode: string;
          connected: boolean;
          battery_v: number;
          battery_pct: number;
          gps_fix: number;
          gps_fix_name?: string | null;
          gps_sat: number;
          hrms?: number | null;
          vrms?: number | null;
          lat: number;
          lon: number;
          alt: number;
          spraying?: boolean | null;
          along_track_speed_mps?: number | null;
          cross_track_speed_mps?: number | null;
          projection_segment_index?: number | null;
          projection_s?: number | null;
          projection_xtrack_error_m?: number | null;
          vehicle_state_stale?: boolean | null;
          gps_safety_ok?: boolean | null;
          manual_resume_required?: boolean | null;
        }>(`${apiBaseUrl}/api/telemetry/latest`).catch((err) => {
          console.log("telemetry/latest failed:", err);
          return null;
        }),
        fetchJson<missionApi.LoadedPathResponse>(`${apiBaseUrl}/api/mission/loaded-path`).catch((err) => {
          console.log("loaded-path failed:", err);
          return null;
        }),
      ]);

      if (loadedRes) reconcileLoadedMission(loadedRes, statusRes);
      setMissionRunning(statusRes.state === "running");

      const nextTelemetry = {
        rpp_state: telemetryRes ? telemetryRes.rpp_state : statusRes.rpp_state,
        rpp_state_name: telemetryRes ? telemetryRes.rpp_state_name : statusRes.rpp_state_name,
        dist_to_goal_m: telemetryRes ? telemetryRes.dist_to_goal_m : statusRes.dist_to_goal,
        speed_m_s: telemetryRes ? telemetryRes.speed_m_s : statusRes.speed,
        measured_speed_m_s:
          telemetryRes?.measured_speed_m_s ??
          statusRes?.measured_speed_m_s ??
          null,
        xtrack_m: telemetryRes ? telemetryRes.xtrack_m : statusRes.xtrack,
        battery_pct: telemetryRes ? telemetryRes.battery_pct : 85,
        battery_v: telemetryRes ? telemetryRes.battery_v : null,
        pose_age_ms: telemetryRes ? telemetryRes.pose_age_ms : (healthRes ? healthRes.pose_age_ms : 100),
        gps_sat: telemetryRes ? telemetryRes.gps_sat : 12,
        gps_fix: telemetryRes ? telemetryRes.gps_fix : null,
        gps_fix_name: telemetryRes?.gps_fix_name ?? null,
        hrms: telemetryRes?.hrms ?? null,
        vrms: telemetryRes?.vrms ?? null,
        pos_n: telemetryRes ? telemetryRes.pos_n : 0.0,
        pos_e: telemetryRes ? telemetryRes.pos_e : 0.0,
        heading_ned_deg: telemetryRes ? telemetryRes.heading_ned_deg : 0.0,
        heading_err_deg: telemetryRes ? telemetryRes.heading_err_deg : null,
        lookahead_m: telemetryRes ? telemetryRes.lookahead_m : 0.0,
        kappa: telemetryRes ? telemetryRes.kappa : null,
        lat: telemetryRes ? telemetryRes.lat : null,
        lon: telemetryRes ? telemetryRes.lon : null,
        alt: telemetryRes ? telemetryRes.alt : null,
        armed: telemetryRes ? telemetryRes.armed : (healthRes ? healthRes.armed : (statusRes.state !== "idle" && statusRes.state !== "error")),
        mode: telemetryRes ? telemetryRes.mode : (healthRes ? healthRes.mode : statusRes.state.toUpperCase()),
        mission_state: statusRes.state,
        // Additional fields from API
        along_track_speed_mps: telemetryRes?.along_track_speed_mps ?? null,
        cross_track_speed_mps: telemetryRes?.cross_track_speed_mps ?? null,
        projection_segment_index: telemetryRes?.projection_segment_index ?? null,
        gps_safety_ok: telemetryRes?.gps_safety_ok ?? null,
        manual_resume_required: telemetryRes?.manual_resume_required ?? null,
      } as any;
      if (telemetryRes) {
        noteTelemetryForLiveEntry({
          pos_n: telemetryRes.pos_n,
          pos_e: telemetryRes.pos_e,
          lat: telemetryRes.lat,
          lon: telemetryRes.lon,
          gps_fix: telemetryRes.gps_fix,
          pose_age_ms: telemetryRes.pose_age_ms,
        });
      }
      setTelemetrySnapshot(nextTelemetry);

      if (statusRes.state === "paused") {
        setIsPaused(true);
      } else if (statusRes.state === "running") {
        setIsPaused(false);
      }

      setSystemHealth({
        ros_node: healthRes ? healthRes.ros_node : (telemetryRes ? telemetryRes.connected : false),
        fcu_connected: healthRes ? healthRes.fcu_connected : (telemetryRes ? telemetryRes.connected : false),
        armed: telemetryRes ? telemetryRes.armed : (healthRes ? healthRes.armed : (statusRes.state !== "idle" && statusRes.state !== "error")),
        mode: telemetryRes ? telemetryRes.mode : (healthRes ? healthRes.mode : statusRes.state.toUpperCase()),
        rpp_state: telemetryRes ? telemetryRes.rpp_state : statusRes.rpp_state,
        mission_state: statusRes.state,
      } as any);
    } catch (error) {
      setTelemetryError(error instanceof Error ? error.message : "Unable to load status");
    } finally {
      setTelemetryLoading(false);
    }
  }

  async function refreshMissionIdentity() {
    if (!apiBaseUrl || missionIdentityInFlightRef.current) return;
    missionIdentityInFlightRef.current = true;
    const requestGeneration = missionIdentityGenerationRef.current;
    try {
      const [status, loaded] = await Promise.all([
        fetchMissionStatus(apiBaseUrl),
        fetchJson<missionApi.LoadedPathResponse>(`${apiBaseUrl}/api/mission/loaded-path`),
      ]);
      // A load/stage/clear action started and finished while this request was
      // in flight — its snapshot predates that action, discard it rather than
      // stomp the newer state.
      if (missionIdentityGenerationRef.current !== requestGeneration) return;
      reconcileLoadedMission(loaded, status);
      setMissionRunning(status.state === "running");
    } catch {
      // Telemetry errors are presented by the existing status refresh path.
    } finally {
      missionIdentityInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!apiBaseUrl || wsStatus !== "connected") return;
    void refreshMissionIdentity();
    const timer = setInterval(() => void refreshMissionIdentity(), 3000);
    return () => clearInterval(timer);
  }, [apiBaseUrl, reconcileLoadedMission, wsStatus]);

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchMissionStatus(apiBaseUrl: string): Promise<missionApi.MissionStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      return await missionApi.getMissionStatus(apiBaseUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }



  async function parseFetchError(res: Response, fallbackPrefix: string): Promise<string> {
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json && typeof json.detail === "string") {
          return json.detail;
        }
        if (json && typeof json.message === "string") {
          return json.message;
        }
      } catch {
        if (text) return text;
      }
    } catch {
      // ignore
    }
    return `${fallbackPrefix} (status ${res.status})`;
  }

  async function parseMissionResponseError(res: Response, fallbackPrefix: string) {
    const detail = await parseFetchError(res, fallbackPrefix);
    return classifyMissionError(res.status, detail);
  }

  async function loadMissionOnBackend(
    requestedStagedMissionId?: string,
    opts?: {
      hideRuntimeEntryLine?: boolean;
      extensionLines?: PlanLine[] | null;
      /** When false, caller owns missionActionBusy (Start path). Default true. */
      manageBusy?: boolean;
    }
  ) {
    const manageBusy = opts?.manageBusy !== false;
    const requestedMissionId = requestedStagedMissionId?.trim() || stagedMissionId?.trim() || "";
    const hasExplicitMissionId = Boolean(requestedStagedMissionId?.trim());
    const isStagedLoad = requestedMissionId !== "";

    if (stagedWorkflow.staged === "verified" && !requestedMissionId) {
      setLoadedPathInspection(null);
      setWorkflowStep("loaded", "failed");
      Alert.alert("Load blocked", "Staged mission is verified but the mission ID is missing. Re-run Plan & Stage before loading.");
      showToast("Load blocked", "Missing staged mission ID.", "error");
      return false;
    }

    if (isStagedLoad) {
      if (stagedWorkflow.staged !== "verified" && !hasExplicitMissionId) {
        setLoadedPathInspection(null);
        setWorkflowStep("loaded", "failed");
        Alert.alert("Prerequisites Required", "Plan and stage the mission before loading to the controller.");
        return false;
      }
      if (!apiBaseUrl) {
        setLoadedPathInspection(null);
        setWorkflowStep("loaded", "failed");
        return false;
      }
    } else if (protectedMissionResident) {
      const message = "A protected surveyed mission is resident. Legacy filename load is blocked.";
      Alert.alert("Mission conflict", message);
      showToast("Mission conflict", message, "error");
      return false;
    } else if (!apiBaseUrl || !importedPlan || lines.length === 0) {
      return false;
    }

    logAction("LOAD_REQUEST", { apiBaseUrl, stagedMissionId: requestedMissionId || null, fileName: importedPlan?.fileName });
    if (manageBusy) setMissionActionBusy(true);
    // Invalidate any identity poll already in flight — its snapshot predates
    // this load and must not be allowed to overwrite the result below.
    missionIdentityGenerationRef.current += 1;
    try {
      if (manageBusy) showToast("Load", `Loading path...`, "info");

      if (isStagedLoad) {
        const missionId = requestedMissionId;
        const loadRes = await missionApi.loadMissionToController(apiBaseUrl, { mission_id: missionId });
        if (!loadRes.ok) {
          throw await parseMissionResponseError(loadRes, "Load to controller failed");
        }

        const loadedRes = await missionApi.getLoadedPath(apiBaseUrl);
        if (!loadedRes.ok) {
          const errMsg = await parseFetchError(loadedRes, "Loaded path verification failed");
          throw new Error(errMsg);
        }

        const loadedData = (await loadedRes.json()) as missionApi.LoadedPathResponse;
        const verification = verifyStagedLoadedMission(loadedData, missionId);
        if (!verification.verified) {
          setLoadedPathInspection(loadedData);
          throw classifyMissionError(409, verification.message ?? "Loaded staged mission verification failed.");
        }

        let stagedArtifact: pathApi.StagedMissionResponse | null =
          stagedMissionMatchesId(stagedMissionInspection, missionId) ? stagedMissionInspection : null;
        if (!stagedArtifact) {
          const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
          if (!stagedRes.ok) {
            const errMsg = await parseFetchError(stagedRes, "Staged mission geometry fetch failed");
            throw new Error(errMsg);
          }
          stagedArtifact = (await stagedRes.json()) as pathApi.StagedMissionResponse;
          if (!stagedMissionMatchesId(stagedArtifact, missionId)) {
            throw new Error(`Staged mission ${missionId} could not be loaded for map preview.`);
          }
          setStagedMissionInspection(stagedArtifact);
        }

        // Geometry + origin atomically from the staged artifact (same path as recovery + CSV panel).
        const hydrated = hydrateStagedMissionForMap(stagedArtifact, {
          hideRuntimeEntryLine: opts?.hideRuntimeEntryLine,
          extensionLines: opts?.extensionLines,
        });
        if (!hydrated) {
          throw new Error(`Staged mission ${missionId} has no drawable waypoints for map preview.`);
        }

        // Recover mission-layer identity lost when hydration strips file-prefixed
        // ids, so M-Layers visibility toggles keep affecting the map post-Start —
        // including each layer's extension run-ups/run-outs, not just its marks.
        const layerCatalog = buildMissionLayerLegCatalog(
          appPlannedStartSnapshot?.paintedLines ?? [],
          uploadedFiles,
          missionLayers,
          appPlannedStartSnapshot?.extensionConfig
        );
        const missionLayerTaggedLines = tagLinesWithMissionLayer(hydrated.lines, layerCatalog);
        // Recover corner class / teardrop-vs-pivot so Path Order + map still show
        // corners after densified hydrate (same catalog pattern as mission layers).
        const cornerTaggedLines = recoverCornersAfterHydration(
          missionLayerTaggedLines,
          appPlannedStartSnapshot?.paintedLines ?? [],
          appPlannedStartSnapshot?.sharpCornerMode ?? SHARP_CORNER_MODE
        );

        const expectedMarks = selectMarkPlanLines(
          appPlannedStartSnapshot?.paintedLines ?? lines
        ).length;
        const loadedMarks = selectMarkPlanLines(cornerTaggedLines).length;
        const markCount = verifyHydratedMarkCount(expectedMarks, loadedMarks);
        if (!markCount.ok) {
          throw classifyMissionError(409, markCount.message ?? "Loaded path count mismatch.");
        }

        setAlignedRefPoints(hydrated.alignedRefPoints);
        setLines(sanitizePlanLines(cornerTaggedLines));
        setSelectedLineId(hydrated.selectedLineId);
        setVisualAlignmentItem(null);
        setIsVisualAlignmentMode(false);

        setStagedMissionId(missionId);
        setStagedPlanResult((prev) => prev?.missionId === missionId ? prev : {
          missionId,
          numWaypoints: loadedData.num_waypoints ?? null,
          numSegments: stagedArtifact.segment_runs?.length ?? null,
          totalLengthM: null,
          markLengthM: null,
          transitLengthM: null,
          estimatedPaintL: null,
          estimatedRuntimeS: null,
          rmseM: null,
          warnings: [],
        });
        setLoadedPathInspection(loadedData);
        setMissionLoaded(true);
        setMissionLoadedPanelOpenToken((token) => token + 1);
        setWorkflowStep("staged", "verified");
        setWorkflowStep("loaded", "verified");
        setMissionRunning(false);
        void refreshTelemetryPanel();
        logAction("LOAD_SUCCESS", { stagedMissionId: missionId, fileName: importedPlan?.fileName });
        setPage("home");
        showToast("Mission loaded", "Staged mission loaded to controller and verified.", "success");
        return true;
      }

      const res = await missionApi.loadMission(apiBaseUrl, {
        path_name: importedPlan!.fileName,
        mission_file: "",
      });

      if (!res.ok) {
        throw await parseMissionResponseError(res, "Load failed");
      }

      setLoadedPathInspection(null);
      setMissionLoaded(true);
      setMissionLoadedPanelOpenToken((token) => token + 1);
      setWorkflowStep("loaded", "verified");
      setMissionRunning(false);
      void refreshTelemetryPanel();
      logAction("LOAD_SUCCESS", { fileName: importedPlan?.fileName });
      setPage("home");
      showToast("File loaded", "Load succeeded. Start and Export are now available.", "success");
      return true;
    } catch (error) {
      const missionError = error && typeof error === "object" && "kind" in error
        ? error as ReturnType<typeof classifyMissionError>
        : null;
      if (isStagedLoad && !missionError) {
        setLoadedPathInspection(null);
      }
      setWorkflowStep("loaded", "failed");
      logAction("LOAD_FAILED", {
        fileName: importedPlan?.fileName,
        stagedMissionId: requestedMissionId || null,
        status: missionError?.status ?? null,
        error: missionError?.message ?? (error instanceof Error ? error.message : String(error)),
      });
      const message = missionError?.message ?? (error instanceof Error ? error.message : "Could not load the mission.");
      const title = missionError?.title ?? "Load failed";
      Alert.alert(title, message);
      showToast(title, message, "error");
      if (missionError?.status === 409) void refreshMissionIdentity();
      return false;
    } finally {
      if (manageBusy) setMissionActionBusy(false);
    }
  }

  /** Allocate a unique line-id prefix for a source file within the current batch. */
  function allocateLineIdPrefix(fileName: string, used: Set<string>): string {
    const stem = dxfFileStem(fileName).replace(/[^\w.-]+/g, "_") || "file";
    let prefix = stem;
    let n = 2;
    while (used.has(prefix)) {
      prefix = `${stem}_${n++}`;
    }
    used.add(prefix);
    return prefix;
  }

  function usedPrefixesFromUploaded(files: UploadedFileEntry[]): Set<string> {
    return new Set(files.map((f) => f.lineIdPrefix));
  }

  /**
   * Establish sharedOriginGps from the first GPS-anchored contribution, or rebase
   * geometry onto the existing shared origin. Returns lines ready to append.
   */
  function integrateAnchoredLines(
    rawLines: PlanLine[],
    fileOrigin: { lat: number; lon: number },
    lineIdPrefix: string
  ): PlanLine[] {
    const shared = sharedOriginGpsRef.current;
    let toAppend = rawLines;
    if (shared == null) {
      const origin: [number, number] = [fileOrigin.lat, fileOrigin.lon];
      setSharedOriginGps(origin);
      sharedOriginGpsRef.current = origin;
      setVerifiedAlignmentRequest({
        origin_gps: origin,
        rotation_deg: 0,
      });
      setAlignedRefPoints(
        anchorToAlignedRefPoints({ lat: fileOrigin.lat, lon: fileOrigin.lon })
      );
      setGeoOriginDxf(origin);
    } else {
      toAppend = rebasePlanLinesToOrigin(
        rawLines,
        fileOrigin,
        { lat: shared[0], lon: shared[1] }
      );
    }
    return prefixDxfLineIds(toAppend, lineIdPrefix);
  }

  function demoteWorkflowAfterBatchChange(needsAlignment: boolean) {
    setStagedWorkflow((prev) => ({
      ...prev,
      alignment: needsAlignment ? "pending" : prev.alignment === "verified" ? "verified" : "pending",
      spray: "pending",
      staged: "pending",
      loaded: "pending",
      started: "pending",
    }));
    setMissionFileReady(false);
    setMissionLoaded(false);
    setMissionRunning(false);
    setStagedPlanResult(null);
    setStagedMissionInspection(null);
    setStagedMissionId(null);
    setSegmentVerification(null);
  }

  /**
   * Called by Upload before a non-append local pick so the batch starts clean.
   * Keeps virtual_boundary strokes.
   */
  function handleBeginLocalImportBatch() {
    setUploadedFiles([]);
    uploadedFilesRef.current = [];
    setMissionLayers([]);
    setControlModeActive(false);
    setPendingLayerAssignment(null);
    resetAnchorSelection();
    setPendingDxfAlignment({});
    setSharedOriginGps(null);
    sharedOriginGpsRef.current = null;
    setLocalCsvPreview(null);
    localCsvParsesRef.current = [];
    setLocalDxfMeta(null);
    setIsGeographicDxf(false);
    setGeoOriginDxf(null);
    setLines((prev) => prev.filter((l) => l.layer === "virtual_boundary"));
    setSelectedLineId(null);
    setAlignedRefPoints([]);
    setVerifiedAlignmentRequest(null);
    setAlignmentResult(null);
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);
    previousSelectedPathRef.current = null;
    setSelectedPathName(null);
    demoteWorkflowAfterBatchChange(true);
  }

  /**
   * Local CSV (Select File) — parse result already computed on-device.
   * Appends into the multi-file batch (or starts one). Upload / plan-and-stage
   * / load live in CsvStageAndLoadPanel.
   */
  function handleLocalCsvParsed(data: LocalPointCsvResult) {
    previousSelectedPathRef.current = null;
    setSelectedPathName(null);
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);

    // Local-NED has no GPS anchor — cannot join a GPS-anchored multi-file mission.
    if (data.kind !== "gps" || !data.anchor) {
      if (uploadedFilesRef.current.length > 0 || sharedOriginGpsRef.current != null) {
        Alert.alert(
          "Local NED CSV",
          "Headerless / local-metre CSVs cannot be combined with GPS-anchored files. Import this CSV alone, or use a survey CSV with lat/lon."
        );
        return;
      }
      // Standalone NED: replace-style single file (legacy Auto Origin path).
      localCsvParsesRef.current = [data];
      setLocalCsvPreview(data);
      setLocalDxfMeta(null);
      const previewLines = chainMarkLinesByGeometry(
        localCsvPointsToPlanLines(data.points)
      );
      const transitLines = buildCsvTransitLines(previewLines);
      setLines(sanitizePlanLines([...previewLines, ...transitLines]));
      setSelectedLineId(previewLines[0]?.id ?? null);
      setVerifiedAlignmentRequest(null);
      setAlignedRefPoints([]);
      const prefix = allocateLineIdPrefix(data.fileName, new Set());
      const entry: UploadedFileEntry = {
        id: `${prefix}-csv`,
        fileName: data.fileName,
        kind: "csv",
        isGeographic: false,
        status: "verified",
        lineIdPrefix: prefix,
      };
      uploadedFilesRef.current = [entry];
      setUploadedFiles([entry]);
      demoteWorkflowAfterBatchChange(false);
      setStagedWorkflow((prev) => ({ ...prev, alignment: "pending" }));
      return;
    }

    localCsvParsesRef.current = [...localCsvParsesRef.current, data];
    let previewForPins = data;
    try {
      previewForPins =
        localCsvParsesRef.current.length === 1
          ? data
          : mergeLocalPointCsvResults(localCsvParsesRef.current);
    } catch {
      previewForPins = data;
    }
    setLocalCsvPreview(previewForPins);

    const used = usedPrefixesFromUploaded(uploadedFilesRef.current);
    const prefix = allocateLineIdPrefix(data.fileName, used);
    const fileId = `${prefix}-csv`;

    const previewLines = chainMarkLinesByGeometry(
      localCsvPointsToPlanLines(data.points)
    );
    const transitLines = buildCsvTransitLines(previewLines);
    const integrated = integrateAnchoredLines(
      [...previewLines, ...transitLines],
      data.anchor,
      prefix
    );

    setLines((prev) => {
      const boundary = prev.filter((l) => l.layer === "virtual_boundary");
      const existing = prev.filter((l) => l.layer !== "virtual_boundary");
      return sanitizePlanLines([...boundary, ...existing, ...integrated]);
    });

    setSelectedLineId(integrated[0]?.id ?? null);

    const entry: UploadedFileEntry = {
      id: fileId,
      fileName: data.fileName,
      kind: "csv",
      isGeographic: true,
      status: "verified",
      lineIdPrefix: prefix,
    };
    const nextFiles = [...uploadedFilesRef.current, entry];
    uploadedFilesRef.current = nextFiles;
    setUploadedFiles(nextFiles);

    const stillNeedsAlign = nextFiles.some((f) => f.status === "needs_alignment");
    demoteWorkflowAfterBatchChange(stillNeedsAlign);
    if (!stillNeedsAlign) {
      setStagedWorkflow((prev) => ({ ...prev, alignment: "verified" }));
    }
  }

  /**
   * Local DXF parse (DXF_PLANNER === "app"). Geo-DXF appends (auto-verified);
   * metric DXF is held in pendingDxfAlignment until Fix Alignment.
   */
  function handleLocalDxfParsed(data: LocalDxfResult) {
    previousSelectedPathRef.current = null;
    setSelectedPathName(null);
    setMissionFileReady(false);
    setMissionLoaded(false);
    setMissionRunning(false);
    setExtensionsEnabled(false);
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);

    setLocalDxfMeta({
      fileName: data.fileName,
      isGeographic: !!data.isGeographic,
      warnings: data.warnings.slice(),
    });

    const used = usedPrefixesFromUploaded(uploadedFilesRef.current);
    const prefix = allocateLineIdPrefix(data.fileName, used);
    const fileId = `${prefix}-dxf`;

    // Seed continuous walk + reverse back-facing strokes so auto transit follows
    // the curve instead of zig-zagging DXF entity order (chainMarkLinesByGeometry).
    const markLinesRaw = data.lines.filter(
      (l) => l.layer !== "transit" && l.layer !== "extension"
    );
    const markLines = chainMarkLinesByGeometry(markLinesRaw);
    const order = defaultPathOrder(selectMarkPlanLines(markLines));
    const withTransit = applyCsvOrderToPlanLines(markLines, order, {
      enabled: false,
      preM: 0.5,
      aftM: 0.5,
      perLine: false,
    });

    if (data.isGeographic && data.geoOrigin) {
      setIsGeographicDxf(true);
      const integrated = integrateAnchoredLines(
        withTransit,
        data.geoOrigin,
        prefix
      );
      setLines((prev) => {
        const boundary = prev.filter((l) => l.layer === "virtual_boundary");
        const existing = prev.filter((l) => l.layer !== "virtual_boundary");
        return sanitizePlanLines([...boundary, ...existing, ...integrated]);
      });
      setSelectedLineId(integrated[0]?.id ?? null);

      const entry: UploadedFileEntry = {
        id: fileId,
        fileName: data.fileName,
        kind: "dxf",
        isGeographic: true,
        status: "verified",
        lineIdPrefix: prefix,
      };
      const nextFiles = [...uploadedFilesRef.current, entry];
      uploadedFilesRef.current = nextFiles;
      setUploadedFiles(nextFiles);
      const stillNeedsAlign = nextFiles.some((f) => f.status === "needs_alignment");
      demoteWorkflowAfterBatchChange(stillNeedsAlign);
      if (!stillNeedsAlign) {
        setStagedWorkflow((prev) => ({ ...prev, alignment: "verified" }));
      }
      return;
    }

    // Metric DXF — hold out of mission `lines` until Fix Alignment (map composes pending).
    setPendingDxfAlignment((prev) => ({
      ...prev,
      [fileId]: { fileName: data.fileName, rawLines: sanitizePlanLines(withTransit) },
    }));
    setSelectedLineId(withTransit[0]?.id ?? null);

    if (uploadedFilesRef.current.every((f) => !f.isGeographic)) {
      setIsGeographicDxf(false);
    }

    const entry: UploadedFileEntry = {
      id: fileId,
      fileName: data.fileName,
      kind: "dxf",
      isGeographic: false,
      status: "needs_alignment",
      lineIdPrefix: prefix,
    };
    const nextFiles = [...uploadedFilesRef.current, entry];
    uploadedFilesRef.current = nextFiles;
    setUploadedFiles(nextFiles);
    demoteWorkflowAfterBatchChange(true);
    setStagedWorkflow((prev) => ({ ...prev, alignment: "pending" }));
  }

  /**
   * Merge a Fix-Aligned metric DXF into the shared mission frame.
   */
  function commitDxfFileAlignment(
    fileId: string,
    alignedLines: PlanLine[],
    originGps: [number, number],
    summary: { scale: number | null; rotationDeg: number | null; rmseM: number | null }
  ) {
    const entry = uploadedFilesRef.current.find((f) => f.id === fileId);
    if (!entry) return;

    const integrated = integrateAnchoredLines(
      alignedLines.filter((l) => l.layer !== "transit" && l.layer !== "extension"),
      { lat: originGps[0], lon: originGps[1] },
      entry.lineIdPrefix
    );

    // Drop any temporary design-frame copy of this file from lines (unprefixed or prior).
    setPendingDxfAlignment((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });

    setLines((prev) => {
      const boundary = prev.filter((l) => l.layer === "virtual_boundary");
      const kept = prev.filter(
        (l) =>
          l.layer !== "virtual_boundary" &&
          !l.id.startsWith(`${entry.lineIdPrefix}__`)
      );
      return sanitizePlanLines([...boundary, ...kept, ...integrated]);
    });

    const nextFiles = uploadedFilesRef.current.map((f) =>
      f.id === fileId
        ? {
            ...f,
            status: "verified" as const,
            verifiedSummary: summary,
          }
        : f
    );
    uploadedFilesRef.current = nextFiles;
    setUploadedFiles(nextFiles);

    setSelectedLineId(integrated[0]?.id ?? null);
    setAlignmentResult({
      method: "multi_point",
      scale: summary.scale,
      rotation_deg: summary.rotationDeg,
      offset_n: null,
      offset_e: null,
      origin_gps: originGps,
      rmse_m: summary.rmseM,
      sample_coords: null,
      residuals: null,
      warnings: null,
    });

    const allVerified = nextFiles.every((f) => f.status === "verified");
    demoteWorkflowAfterBatchChange(!allVerified);
    if (allVerified) {
      setStagedWorkflow((prev) => ({ ...prev, alignment: "verified" }));
    }
  }

  function handleClearLocalCsv() {
    // Best-effort: drop a CSV previously written into the rover missions dir by
    // "Send to Rover". 404 is fine if it was never uploaded or already deleted.
    const uploadedName = localCsvPreview
      ? sanitizeUploadFileName(localCsvPreview.fileName)
      : null;
    if (apiBaseUrl && uploadedName) {
      void pathApi.deletePath(apiBaseUrl, uploadedName).catch(() => {});
    }
    setLocalCsvPreview(null);
    localCsvParsesRef.current = [];
    setLocalDxfMeta(null);
    setIsGeographicDxf(false);
    setGeoOriginDxf(null);
    setUploadedFiles([]);
    uploadedFilesRef.current = [];
    setMissionLayers([]);
    setControlModeActive(false);
    setPendingLayerAssignment(null);
    resetAnchorSelection();
    setPendingDxfAlignment({});
    setSharedOriginGps(null);
    sharedOriginGpsRef.current = null;
    setLines((prev) => prev.filter((l) => l.layer === "virtual_boundary"));
    setSelectedLineId(null);
    setAlignedRefPoints([]);
    setVerifiedAlignmentRequest(null);
    setAlignmentResult(null);
    setStagedPlanResult(null);
    setStagedMissionInspection(null);
    setStagedMissionId(null);
    setAppPlannedStartSnapshot(null);
    setPreOffsetSnapshot(null);
    setOffsetTarget({ kind: "universal" }); // stale file/layer scope would no longer exist
    setStagedWorkflow((prev) => ({
      ...prev,
      alignment: "pending",
      spray: "pending",
      staged: "pending",
      loaded: "pending",
      started: "pending",
    }));
  }

  function handleAssignFileToNewLayer(fileEntryId: string) {
    setMissionLayers((prev) => createLayerForFile(prev, fileEntryId));
    setPendingLayerAssignment(null);
  }

  function handleAssignFileToLayer(fileEntryId: string, layerId: string) {
    setMissionLayers((prev) => assignFileToLayer(prev, fileEntryId, layerId));
    setPendingLayerAssignment(null);
  }

  function handleUnassignFileFromLayer(fileEntryId: string) {
    setMissionLayers((prev) => unassignFile(prev, fileEntryId));
    setPendingLayerAssignment(null);
  }

  function handleToggleMissionLayerVisibility(layerId: string) {
    setMissionLayers((prev) => toggleMissionLayerVisibility(prev, layerId));
  }

  function resetAnchorSelection() {
    setAnchorSelectMode(false);
    setAnchorTarget(null);
    setPendingAnchor(null);
  }

  function handleAnchorPress() {
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Anchor selection is blocked while a protected surveyed mission is resident.");
      return;
    }
    if (anchorSelectMode) {
      resetAnchorSelection();
      return;
    }
    setAnchorSelectMode(true);
    setAnchorTarget(null);
    setPendingAnchor(null);
  }

  function handleSelectAnchorTarget(target: AnchorTarget) {
    setAnchorTarget(target);
    setPendingAnchor(null);
  }

  function handleAnchorCandidateSelect(candidate: AnchorCandidatePoint) {
    setPendingAnchor(candidate);
  }

  /**
   * Apply the pending anchor: CSV lines split at the tapped point first (near arm
   * anchor-first, far arm anchor-first), then the whole isolated target — the split
   * arms plus any other lines in that file/layer — is re-chained from the anchor via
   * the same nearest-endpoint walk import-time chaining already uses. Only the
   * isolated target's lines are touched; everything else in `lines` is untouched.
   */
  function handleConfirmAnchor() {
    if (!anchorTarget || !pendingAnchor) return;
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Anchor selection is blocked while a protected surveyed mission is resident.");
      resetAnchorSelection();
      return;
    }

    const targetLines = isolateLinesForAnchorTarget(lines, uploadedFiles, missionLayers, anchorTarget);
    const targetIds = new Set(targetLines.map((l) => l.id));
    const seedLine = targetLines.find((l) => l.id === pendingAnchor.lineId);
    if (!seedLine) {
      resetAnchorSelection();
      return;
    }

    let reordered = targetLines;
    let seedId = pendingAnchor.lineId;

    if (pendingAnchor.kind === "csv") {
      const split = splitRoadMarkingPathAtAnchor(seedLine, pendingAnchor.north, pendingAnchor.east);
      if (!split) {
        showToast("Anchor failed", "That path has no usable geometry to re-anchor.", "error");
        return;
      }
      // near === null: anchor was the path's own current start or end — `far` alone
      // covers the whole path (unchanged, or fully reversed), no split/transit needed.
      const seedArm = split.near ?? split.far;
      reordered = targetLines.flatMap((l) => {
        if (l.id !== seedLine.id) return [l];
        return split.near ? [split.near, split.far] : [split.far];
      });
      seedId = seedArm.id;
    }

    const chained = chainMarkLinesFromSeed(reordered, seedId, false);

    setLines((prev) => {
      const untouched = prev.filter((l) => !targetIds.has(l.id));
      return sanitizePlanLines([...chained, ...untouched]);
    });

    // Anchor mutates geometry after any prior Send — staged mission / app-planned
    // snapshot no longer match what's on the map. Same "plan changed, demote and
    // re-verify" policy already used after any other batch/geometry change (plan
    // Design §5) — reuses the existing demotion helper rather than hand-rolling a
    // partial reset that could miss a consumer of stagedMissionId.
    demoteWorkflowAfterBatchChange(false);
    setAppPlannedStartSnapshot(null);
    // Offset's reset baseline predates this edit — restoring it now would silently
    // discard the anchor change just made.
    setPreOffsetSnapshot(null);
    showToast("Anchor changed", "Plan changed — re-Send before Start.", "info");

    resetAnchorSelection();
  }

  /**
   * RAF-coalesced recompute of the Offset ghost preview. `offsetBearingDeg`
   * updates at raw native-touch-sample rate (60-120Hz) while dragging the
   * compass dial — fine for the cheap needle-rotation render, but running the
   * full isolate+shift+merge+sanitize pipeline on every one of those samples
   * would saturate the JS thread the same way an uncoalesced Align sticker drag
   * would (see MapViewNative.tsx's own pendingDragDeltaRef/previewRafRef
   * pattern, which this mirrors). Every sample writes the cheap
   * offsetBearingRef and requests at most one frame; the frame reads the ref
   * at fire time, so it always uses the latest sample even if several arrived
   * while a frame was already pending — never a value captured stale in a
   * closure at schedule time.
   */
  const scheduleOffsetGhostFrame = useCallback(() => {
    if (offsetGhostRafRef.current !== null) return; // single-flight
    offsetGhostRafRef.current = requestAnimationFrame(() => {
      offsetGhostRafRef.current = null;
      if (!isDraggingOffsetDialRef.current || protectedMissionResident) return;
      const scopeTarget = offsetTarget ?? { kind: "universal" as const };
      const baseLines =
        alignContextRef.current.displayLines.length > 0 ? alignContextRef.current.displayLines : lines;
      const result = computeOffsetResultLines(
        baseLines,
        uploadedFiles,
        missionLayers,
        scopeTarget,
        offsetDistanceM,
        offsetBearingRef.current
      );
      setOffsetPreviewLines(result.ok ? result.lines : null);
    });
  }, [offsetTarget, offsetDistanceM, uploadedFiles, missionLayers, lines, protectedMissionResident]);

  const handleOffsetBearingChange = useCallback(
    (deg: number) => {
      offsetBearingRef.current = deg;
      setOffsetBearingDeg(deg);
      if (isDraggingOffsetDialRef.current) scheduleOffsetGhostFrame();
    },
    [scheduleOffsetGhostFrame]
  );

  const handleOffsetDragStateChange = useCallback((dragging: boolean) => {
    isDraggingOffsetDialRef.current = dragging;
    if (!dragging) {
      if (offsetGhostRafRef.current !== null) {
        cancelAnimationFrame(offsetGhostRafRef.current);
        offsetGhostRafRef.current = null;
      }
      setOffsetPreviewLines(null); // gone the instant the drag ends
    }
  }, []);

  useEffect(() => {
    return () => {
      if (offsetGhostRafRef.current !== null) cancelAnimationFrame(offsetGhostRafRef.current);
    };
  }, []);

  /**
   * Shift the selected scope (a file, a mission layer, or the whole plan) toward
   * an absolute compass bearing by `offsetDistanceM`. One-shot bake into `lines`
   * (like Move/Rotate Plan and Anchor) — not a live-as-you-type field. Safe to
   * press repeatedly: a pure translation composes exactly, so two 0.3 m nudges
   * equal one 0.6 m nudge. Captures a pre-offset baseline on the first Apply so
   * Reset can undo back to it later (see handleResetOffset).
   */
  function handleApplyOffset() {
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Offset is blocked while a protected surveyed mission is resident.");
      return;
    }

    const scopeTarget = offsetTarget ?? { kind: "universal" as const };
    const result = computeOffsetResultLines(
      lines,
      uploadedFiles,
      missionLayers,
      scopeTarget,
      offsetDistanceM,
      offsetBearingDeg
    );

    if (!result.ok) {
      if (result.reason === "no-marks") {
        showToast("No plan to offset", "Upload and paint a plan before applying an offset.", "error");
      } else if (result.reason === "invalid-offset") {
        showToast("Can't offset", "Enter a valid distance and bearing.", "error");
      }
      // "zero-distance": silent no-op, same as before.
      return;
    }

    if (!preOffsetSnapshot) {
      setPreOffsetSnapshot(clonePlanLinesForSnapshot(lines));
    }

    setLines(result.lines);
    demoteWorkflowAfterBatchChange(false);
    setAppPlannedStartSnapshot(null);
    showToast(
      "Plan offset",
      `Shifted ${offsetDistanceM.toFixed(2)} m at ${Math.round(normalizeBearingDeg(offsetBearingDeg))}°. Plan changed — re-Send before Start.`,
      "info"
    );
    setOffsetDistanceM(0);
  }

  /** Restore the plan to how it looked before the first Offset Apply this session. */
  function handleResetOffset() {
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Offset reset is blocked while a protected surveyed mission is resident.");
      return;
    }
    if (!preOffsetSnapshot) return;

    setLines(sanitizePlanLines(preOffsetSnapshot));
    demoteWorkflowAfterBatchChange(false);
    setAppPlannedStartSnapshot(null);
    setPreOffsetSnapshot(null);
    setOffsetDistanceM(0);
    setOffsetBearingDeg(0);
    showToast(
      "Offset reset",
      "Plan restored to its position before the first offset. Plan changed — re-Send before Start.",
      "info"
    );
  }

  async function startLoadedMission() {
    if (!apiBaseUrl || !importedPlan || lines.length === 0) {
      return;
    }
    // Re-entrancy: double-taps + slow restage previously stacked starts and
    // could leave the UI busy or race Mapbox/state updates into a hard close.
    if (startInFlightRef.current || missionActionBusy) {
      showToast("Start", "Start already in progress…", "info");
      return;
    }

    if (virtualJoystick.joystickActive || telemetrySnapshot?.joystick_active) {
      Alert.alert("Joystick active", "Release manual drive before starting a mission.");
      showToast("Start blocked", "Release the joystick lease before starting.", "error");
      return;
    }

    startInFlightRef.current = true;
    setMissionActionBusy(true);
    // Paint busy state before any network / restage work (perceived lag).
    showToast("Start", "Preparing mission…", "info");
    await yieldToUi();

    // Mission-layer Start selection — driven entirely by pill visibility now
    // (missionLayers[].visible), same state MissionLayerPills toggles for map
    // preview. No separate re-pick modal: what's visible is what runs.
    let selectedStartLayerIds: string[] | null = null;
    // Single try/finally so every early return still clears busy + in-flight flags.
    try {
    const startResolution = resolveVisibleStartLayerIds(missionLayers);
    if (startResolution.kind === "blocked") {
      if (startResolution.reason === "no_layers_ready") {
        Alert.alert(
          "No mission layers ready",
          "Files are not assigned to any mission layer. Open Control and assign files, or clear empty layers."
        );
        showToast("Start blocked", "Assign files to a mission layer first.", "error");
      } else {
        Alert.alert(
          "No layers visible",
          "Toggle at least one mission layer on under Control to start."
        );
        showToast("Start blocked", "No visible mission layers.", "error");
      }
      return;
    }
    if (startResolution.kind === "start") {
      selectedStartLayerIds = startResolution.ids;
      const unassigned = countUnassignedFiles(uploadedFiles, missionLayers);
      if (unassigned > 0) {
        showToast(
          "Some files won't run",
          `${unassigned} file${unassigned === 1 ? "" : "s"} not in any mission layer — will not run.`,
          "info"
        );
      }
    }
    // kind === "legacy_full" → selectedStartLayerIds stays null (today's full-snapshot behaviour)

    // Step 1: Re-fetch backend mission status to reconcile local workflow state
    // before evaluating the start gate. setWorkflowStep() below only takes
    // effect on the next render, so evaluating the gate against the
    // `stagedWorkflow`/`loadedPathInspection` closures here would still see
    // the pre-reconcile snapshot — track the freshly-confirmed truth locally
    // instead so a real confirmation isn't ignored by a stale read.
    let effectiveStagedWorkflow = stagedWorkflow;
    let effectiveLoadedInspection = loadedPathInspection;
    try {
      // Full preflight like baseline — always re-check staged/loaded truth.
      // Parallel fetch keeps Start responsive without skipping verification.
      const [missionStatus, stagedStatus] = await Promise.all([
        missionApi.fetchMissionStatus(apiBaseUrl),
        missionApi.fetchStagedMissionStatus(apiBaseUrl, stagedMissionId),
      ]);

      if (stagedStatus?.verified) {
        effectiveStagedWorkflow = { ...effectiveStagedWorkflow, staged: "verified" };
        setWorkflowStep("staged", "verified");
      }
      if (missionStatus.running_mission_id) {
        setMissionRunning(true);
      }

      // Only upgrade "loaded" from a fresh check — never downgrade it here,
      // that stays the background poll's job (reconcileLoadedMission).
      if (
        effectiveStagedWorkflow.staged === "verified" &&
        stagedMissionId &&
        effectiveStagedWorkflow.loaded !== "verified"
      ) {
        const loadedRes = await missionApi.getLoadedPath(apiBaseUrl);
        if (loadedRes.ok) {
          const loadedData = (await loadedRes.json()) as missionApi.LoadedPathResponse;
          const verification = verifyStagedLoadedMission(loadedData, stagedMissionId);
          if (verification.verified) {
            effectiveStagedWorkflow = { ...effectiveStagedWorkflow, loaded: "verified" };
            effectiveLoadedInspection = loadedData;
            setWorkflowStep("loaded", "verified");
            setLoadedPathInspection(loadedData);
          }
        }
      }

      logAction("START_RECONCILE", {
        missionState: missionStatus.state,
        loadedMissionId: missionStatus.loaded_mission_id,
        stagedVerified: stagedStatus?.verified,
      });
    } catch (reconcileErr) {
      // Non-fatal — proceed with existing local state if re-fetch fails
      console.warn("[START] Re-fetch failed, using cached workflow state:", reconcileErr);
    }

    const isCsvMissionEarly =
      localCsvPreview != null ||
      importedPlan.fileType === "csv" ||
      !!importedPlan.fileName?.toLowerCase().endsWith(".csv");
    // Phase 5: never allow path_name fall-through for CSV (including force-start).
    if (
      isCsvMissionEarly &&
      effectiveStagedWorkflow.staged !== "verified"
    ) {
      setWorkflowStep("started", "failed");
      const msg =
        "This CSV mission is not staged and verified. Send/plan the trajectory and load it before starting — a filename start cannot place a surveyed CSV correctly.";
      Alert.alert("Start blocked", msg);
      showToast("Start blocked", msg, "error");
      return;
    }

    let forceStart = false;
    const gateResult = evaluateStagedStartGate(effectiveStagedWorkflow, effectiveLoadedInspection, stagedMissionId);

    if (!gateResult.allowed) {
      // Show dialog with force-start option — await user decision via promise wrapper
      // Temporarily clear busy so the dialog is interactive; restore if force/retry continues.
      setMissionActionBusy(false);
      const userChoice = await new Promise<"cancel" | "force" | "retry">((resolve) => {
        Alert.alert(
          "Cannot Start",
          (gateResult.message ?? "Staged mission is not ready to start.") +
            "\n\n• Cancel to go back\n• Retry to re-stage and verify\n• Force Start to bypass checks",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
            { text: "Retry", onPress: () => resolve("retry") },
            { text: "Force Start", style: "destructive", onPress: () => resolve("force") },
          ]
        );
      });

      if (userChoice === "cancel") {
        setWorkflowStep("started", "failed");
        showToast("Start blocked", gateResult.message ?? "Complete load verification first.", "error");
        return;
      }

      if (userChoice === "retry") {
        showToast("Re-staging", "Triggering plan & stage again...", "info");
        // Trigger re-stage by setting the workflow back to pending
        invalidateStagedWorkflowFrom("staged");
        return;
      }

      // userChoice === "force" — bypass the gate
      forceStart = true;
      setMissionActionBusy(true);
      await yieldToUi();
      logAction("FORCE_START", { reason: gateResult.message });
      showToast("Force starting", "Bypassing workflow verification.", "warning");
    }

    const isStagedStart = forceStart ? false : gateResult.isStagedWorkflow;

    logAction("START_REQUEST", {
      apiBaseUrl,
      fileName: importedPlan.fileName,
      missionRunning,
      autoOrigin,
      isStagedStart,
      stagedMissionId: isStagedStart ? getLoadedMissionId(loadedPathInspection) : null,
      hasAppPlannedSnapshot: appPlannedStartSnapshot != null,
    });
      showToast("Start", "Starting mission…", "info");
      const isCsvMission =
        localCsvPreview != null ||
        importedPlan.fileType === "csv" ||
        !!importedPlan.fileName?.toLowerCase().endsWith(".csv");
      // App-planned = CSV / multi-file batch / local DXF Send snapshot path.
      // Do not treat bare densified rover-path-* lines as app-planned: backend-only
      // staged missions hydrate the same way and must still Start after recovery.
      const isAppPlannedMission = isAppPlannedMissionContext({
        hasAppPlannedSnapshot: appPlannedStartSnapshot != null,
        isCsvMission,
        isLocalDxfAppPlanned: localDxfMeta != null || uploadedFiles.length > 0,
        hasStagedHydrationLines: false,
      });
      const liveEntryClass = classifyLiveEntryStartRequirement({
        hasAppPlannedSnapshot: appPlannedStartSnapshot != null,
        isAppPlannedMission,
      });
      // Local DXF / CSV app-planned Start path — only when snapshot + restage succeed.
      const isAppPlannedStart = liveEntryClass === "restage_with_live_entry";

      if (liveEntryClass === "block_resend_required") {
        throw new Error(
          "Approach path cannot be rebuilt from the current map geometry. " +
            "Re-Send the plan (Path Order & Load), then Start again so entry uses the rover's current position."
        );
      }

      let startMissionId = isStagedStart ? stagedMissionId : null;

      // Every app-planned Start: rebuild entry from a fresh rover pose (X→A, then Y→A, …).
      if (isAppPlannedStart && appPlannedStartSnapshot) {
        showToast("Approach", "Building runtime entry from current rover position…", "info");

        // Pose AFTER gate/dialogs — REST primary, timed socket cache fallback.
        const restPoseRaw = await missionApi.fetchLatestTelemetryPose(apiBaseUrl);
        if (restPoseRaw) {
          noteTelemetryForLiveEntry(restPoseRaw);
        }
        const picked = pickRoverPoseForEntry({
          restPose: telemetryToRoverPoseForEntry(restPoseRaw),
          cachePose: telemetryToRoverPoseForEntry(telemetrySnapshotRef.current),
          cacheReceivedAtMs: telemetryReceivedAtMsRef.current || null,
          nowMs: Date.now(),
        });
        if (!picked.ok) {
          throw new Error(picked.error);
        }
        let livePose = picked.pose;
        let poseSource = picked.source;

        // Scope the frozen Send snapshot to selected mission layers (if any).
        let startSnapshot = appPlannedStartSnapshot;
        if (selectedStartLayerIds && selectedStartLayerIds.length > 0) {
          const scoped = buildLayerScopedStartSnapshot(
            appPlannedStartSnapshot,
            uploadedFiles,
            missionLayers,
            selectedStartLayerIds
          );
          if (!scoped.ok) {
            throw new Error(scoped.error);
          }
          startSnapshot = scoped.snapshot;
        }

        const applyRestageUi = (
          restaged: Extract<
            Awaited<ReturnType<typeof restageAppTrajectoryWithLiveEntry>>,
            { success: true }
          >
        ) => {
          setStagedMissionId(restaged.missionId);
          if (restaged.stagedInspection) {
            setStagedMissionInspection(restaged.stagedInspection);
          }
          setWorkflowStep("staged", "verified");
          const n = (v: unknown): number | null =>
            typeof v === "number" && Number.isFinite(v) ? v : null;
          setStagedPlanResult({
            missionId: restaged.missionId,
            numWaypoints: n(restaged.plan.num_waypoints),
            numSegments: n(restaged.plan.num_segments),
            totalLengthM: n(restaged.plan.total_length_m),
            markLengthM: n(restaged.plan.mark_length_m),
            transitLengthM: n(restaged.plan.transit_length_m),
            estimatedPaintL: n(restaged.plan.mission_summary?.estimated_paint_l),
            estimatedRuntimeS: n(restaged.plan.mission_summary?.estimated_runtime_s),
            rmseM: n(restaged.plan.mission_summary?.rmse_m),
            warnings: Array.isArray(restaged.plan.warnings)
              ? restaged.plan.warnings.filter((w): w is string => typeof w === "string")
              : [],
          });
        };

        let restaged = await restageAppTrajectoryWithLiveEntry(apiBaseUrl, {
          snapshot: startSnapshot,
          roverPose: livePose,
        });
        if (!restaged.success) {
          throw new Error(restaged.error);
        }
        applyRestageUi(restaged);

        // Load the freshly staged mission (with live entry) to the controller.
        // Start owns the busy flag — avoid loadMissionOnBackend clearing it mid-flight.
        let loadedOk = await loadMissionOnBackend(restaged.missionId, {
          hideRuntimeEntryLine: restaged.entryIncluded === true,
          extensionLines: buildCsvExtensionLines(startSnapshot.paintedLines, startSnapshot.extensionConfig),
          manageBusy: false,
        });
        if (!loadedOk) {
          throw new Error(
            "Trajectory restaged with live entry but load to controller failed. Fix load, then Start again."
          );
        }

        // Drift re-check: restage+load can take seconds; rebuild once if rover moved.
        let driftRetry = false;
        const usedNed = resolveRoverNedInMissionFrame(livePose, startSnapshot.originGps);
        const restPoseRaw2 = await missionApi.fetchLatestTelemetryPose(apiBaseUrl);
        if (restPoseRaw2) {
          noteTelemetryForLiveEntry(restPoseRaw2);
        }
        const picked2 = pickRoverPoseForEntry({
          restPose: telemetryToRoverPoseForEntry(restPoseRaw2),
          cachePose: telemetryToRoverPoseForEntry(telemetrySnapshotRef.current),
          cacheReceivedAtMs: telemetryReceivedAtMsRef.current || null,
          nowMs: Date.now(),
        });
        if (picked2.ok && usedNed.ok) {
          const latestNed = resolveRoverNedInMissionFrame(picked2.pose, startSnapshot.originGps);
          if (
            latestNed.ok &&
            entryPoseDrifted(
              [usedNed.north, usedNed.east],
              [latestNed.north, latestNed.east]
            )
          ) {
            driftRetry = true;
            showToast("Approach", "Rover moved — rebuilding entry from new position…", "info");
            livePose = picked2.pose;
            poseSource = picked2.source;
            restaged = await restageAppTrajectoryWithLiveEntry(apiBaseUrl, {
              snapshot: startSnapshot,
              roverPose: livePose,
            });
            if (!restaged.success) {
              throw new Error(restaged.error);
            }
            applyRestageUi(restaged);
            loadedOk = await loadMissionOnBackend(restaged.missionId, {
              hideRuntimeEntryLine: restaged.entryIncluded === true,
              extensionLines: buildCsvExtensionLines(
                startSnapshot.paintedLines,
                startSnapshot.extensionConfig
              ),
              manageBusy: false,
            });
            if (!loadedOk) {
              throw new Error(
                "Trajectory restaged with live entry but load to controller failed. Fix load, then Start again."
              );
            }
          }
        }

        startMissionId = restaged.missionId;
        logAction("START_LIVE_ENTRY", {
          missionId: restaged.missionId,
          entryIncluded: restaged.entryIncluded,
          entryLengthM: restaged.entryLengthM ?? null,
          poseSource,
          lat: livePose.lat ?? null,
          lon: livePose.lon ?? null,
          gps_fix: livePose.gps_fix ?? null,
          pose_age_ms: livePose.pose_age_ms ?? null,
          driftRetry,
        });
      }

      const startPayload = buildMissionStartPayload({
        stagedMissionId: startMissionId,
        stagedVerified: isAppPlannedStart || isStagedStart,
        fileName: importedPlan.fileName,
        autoOrigin,
        // Phase 5: CSV has no meaningful path_name reload — refuse the fallback.
        // App-planned DXF/CSV with snapshot also require staged mission_id after restage.
        // Also refuse for densified app-planned context that blocked without snapshot.
        requireStagedMission: isCsvMission || isAppPlannedStart || isAppPlannedMission,
      });
      const res = await missionApi.startMission(apiBaseUrl, startPayload);
      if (!res.ok) {
        throw await parseMissionResponseError(res, "Start failed");
      }
      setMissionRunning(true);
      setWorkflowStep("started", "verified");
      if (selectedStartLayerIds && selectedStartLayerIds.length > 0) {
        runningLayerIdsRef.current = [...selectedStartLayerIds];
        runningMissionIdRef.current = startMissionId;
        setMissionLayers((prev) =>
          markLayersStarted(prev, selectedStartLayerIds!, startMissionId, Date.now())
        );
      } else {
        runningLayerIdsRef.current = [];
        runningMissionIdRef.current = startMissionId;
      }
      if (!isStagedStart && !isAppPlannedStart && autoOrigin && autoOriginReference) {
        const planStart = getPlanStartPoint(displayedLines);
        console.log("[CANVAS] start-anchor", JSON.stringify({
          capturedOrigin: {
            n: autoOriginReference.roverNorth,
            e: autoOriginReference.roverEast,
          },
          planFirstPoint: planStart,
          expectedDelta: planStart
            ? {
                dN: autoOriginReference.roverNorth - autoOriginReference.planStartNorth,
                dE: autoOriginReference.roverEast - autoOriginReference.planStartEast,
              }
            : null,
        }));
      }
      // Defer non-critical refresh so Start feels instant after backend ACK.
      setTimeout(() => {
        void refreshTelemetryPanel();
      }, 0);
      logAction("START_SUCCESS", {
        fileName: importedPlan.fileName,
        autoOrigin,
        missionId: startMissionId,
        liveEntry: isAppPlannedStart,
      });
      const entryNote =
        isAppPlannedStart
          ? " Approach path was built from the rover's current position."
          : "";
      // Baseline UX: confirm Start; toast for non-blocking HUD feedback.
      showToast("Mission running", `${importedPlan.fileName} is now active.`, "success");
      Alert.alert("Started", `${importedPlan.fileName} started on the rover.${entryNote}`);
    } catch (error) {
      const missionError = error && typeof error === "object" && "kind" in error
        ? error as ReturnType<typeof classifyMissionError>
        : null;
      setWorkflowStep("started", "failed");
      runningLayerIdsRef.current = [];
      runningMissionIdRef.current = null;
      if (selectedStartLayerIds && selectedStartLayerIds.length > 0) {
        setMissionLayers((prev) =>
          applyMissionTerminalOutcome(prev, selectedStartLayerIds!, "failed")
        );
      }
      logAction("START_FAILED", {
        fileName: importedPlan.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      const message = missionError?.message ?? (error instanceof Error ? error.message : "Could not start the mission.");
      const title = missionError?.title ?? "Start failed";
      showToast(title, message, "error");
      Alert.alert(title, message);
      if (missionError?.status === 409) void refreshMissionIdentity();
    } finally {
      startInFlightRef.current = false;
      setMissionActionBusy(false);
    }
  }

  async function startNtrip() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before starting RTK.");
      return;
    }
    if (rtkRunning) return;
    setRtkConnecting(true);
    try {
      if (!rtkCaster || !rtkPort || !rtkMountPoint) {
        Alert.alert("Credentials needed", "Please fill in all RTK NTRIP credentials in Settings before connecting.");
        setRtkConnecting(false);
        return;
      }
      const host = rtkCaster;
      const port = parseInt(rtkPort, 10);
      const mountpoint = rtkMountPoint;
      const user = rtkUsername;
      const pass = rtkPassword;
      logAction("RTK_CONNECT_REQUEST", { caster: host, port, mountpoint });
      showToast("RTK Injection", "Connecting to NTRIP caster...", "info");
      const res = await fetch(`${apiBaseUrl}/api/rtk/ntrip/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host,
          port,
          mountpoint,
          user,
          pass,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "NTRIP start failed.");
      }
      const data = await res.json().catch(() => ({}));
      setRtkMode("ntrip");
      setRtkHealthy(data?.healthy ?? true);
      logAction("RTK_CONNECT_SUCCESS", { caster: rtkCaster });
      Alert.alert("RTK Started", "NTRIP RTK caster started successfully.");
      showToast("RTK Started", "NTRIP RTK stream active.", "success");
      setRtkModalOpen(false);
    } catch (error) {
      logAction("RTK_ACTION_FAILED", { error: error instanceof Error ? error.message : String(error) });
      Alert.alert("RTK Action Failed", error instanceof Error ? error.message : "Failed to perform RTK action.");
      showToast("RTK Failed", error instanceof Error ? error.message : "Failed to perform RTK action.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  async function startLora() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before starting RTK.");
      return;
    }
    if (rtkRunning) return;
    setRtkConnecting(true);
    try {
      showToast("RTK Injection", "Starting LoRA...", "info");
      const res = await fetch(`${apiBaseUrl}/api/rtk/lora/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baudrate: 115200,
          serial_port: "/dev/ttyUSB0",
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "LoRA start failed.");
      }
      const data = await res.json().catch(() => ({}));
      setRtkMode("lora");
      setRtkHealthy(data?.healthy ?? true);
      Alert.alert("LoRA Started", "LoRA RTK stream started successfully.");
      showToast("LoRA Started", "LoRA RTK stream active.", "success");
      setRtkModalOpen(false);
    } catch (error) {
      Alert.alert("LoRA Failed", error instanceof Error ? error.message : "Failed to start LoRA.");
      showToast("LoRA Failed", error instanceof Error ? error.message : "Failed to start LoRA.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  async function stopRtk() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before stopping RTK.");
      return;
    }
    const previousMode = rtkMode;
    setRtkMode("stopping");
    setRtkConnecting(true);
    try {
      showToast("RTK Injection", "Stopping RTK stream...", "warning");
      logAction("RTK_STOP_REQUEST");
      const res = await fetch(`${apiBaseUrl}/api/rtk/stop`, {
        method: "POST",
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Failed to stop RTK correction stream.");
      }
      setRtkMode("idle");
      setRtkHealthy(false);
      logAction("RTK_STOP_SUCCESS");
      Alert.alert("RTK Stopped", "RTK correction stream stopped successfully.");
      showToast("RTK Stopped", "RTK stream stopped.", "success");
      setRtkModalOpen(false);
    } catch (error) {
      setRtkMode(previousMode);
      Alert.alert("Stop Failed", error instanceof Error ? error.message : "Failed to stop RTK action.");
      showToast("Stop Failed", error instanceof Error ? error.message : "Failed to stop RTK action.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  useEffect(() => {
    if (!apiBaseUrl) return;
    const fetchRtkStatus = async () => {
      if (rtkConnecting) return;
      try {
        const res = await fetch(`${apiBaseUrl}/api/rtk/status`);
        if (res.ok) {
          const data = await res.json();
          setRtkMode(rtkModeFromStatus(data));
          setRtkHealthy(data.healthy);
        }
      } catch (err) {
        console.log("Failed to fetch RTK status:", err);
      }
    };
    void fetchRtkStatus();
    const interval = setInterval(fetchRtkStatus, 3000);
    return () => clearInterval(interval);
  }, [apiBaseUrl, rtkConnecting]);

  // ── RTK credential persistence ──────────────────────────────────────
  const RTK_CREDS_KEY = "rtk_credentials";
  const rtkCredsLoadedRef = useRef(false);

  // Load saved RTK credentials once on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(RTK_CREDS_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.caster) setRtkCaster(saved.caster);
          if (saved.port) setRtkPort(saved.port);
          if (saved.mountPoint) setRtkMountPoint(saved.mountPoint);
          if (saved.username) setRtkUsername(saved.username);
          if (saved.password) setRtkPassword(saved.password);
          // defaultMode/autoConnect were added later — older saved blobs won't
          // have them, so only apply when present rather than reset to falsy.
          if (saved.defaultMode) setRtkDefaultMode(saved.defaultMode);
          if (typeof saved.autoConnect === "boolean") setRtkAutoConnect(saved.autoConnect);
          console.log("[RTK] Restored saved credentials from SecureStore");
        }
      } catch (err) {
        console.warn("[RTK] Failed to load saved credentials:", err);
      } finally {
        rtkCredsLoadedRef.current = true;
      }
    })();
  }, []);

  // Save RTK credentials whenever they change (skip the initial load)
  useEffect(() => {
    if (!rtkCredsLoadedRef.current) return;
    const creds = JSON.stringify({
      caster: rtkCaster,
      port: rtkPort,
      mountPoint: rtkMountPoint,
      username: rtkUsername,
      password: rtkPassword,
      defaultMode: rtkDefaultMode,
      autoConnect: rtkAutoConnect,
    });
    SecureStore.setItemAsync(RTK_CREDS_KEY, creds).catch((err) =>
      console.warn("[RTK] Failed to save credentials:", err)
    );
  }, [rtkCaster, rtkPort, rtkMountPoint, rtkUsername, rtkPassword, rtkDefaultMode, rtkAutoConnect]);

  // ── RTK Auto Connect ──────────────────────────────────────────────────
  // Fires once per socket connection: as soon as the WS reaches "connected",
  // if Auto Connect is on and RTK isn't already running, start the saved
  // default source. Gated on rtkCredsLoadedRef so this can't fire before
  // SecureStore finishes restoring rtkAutoConnect/rtkDefaultMode/credentials
  // — otherwise it could race and either use stale defaults or hit
  // startNtrip's "Credentials needed" guard before creds are populated.
  const autoConnectAttemptedRef = useRef(false);
  useEffect(() => {
    if (wsStatus !== "connected") {
      autoConnectAttemptedRef.current = false;
      return;
    }
    if (!rtkAutoConnect || rtkRunning || autoConnectAttemptedRef.current) return;
    if (!rtkCredsLoadedRef.current) return;
    autoConnectAttemptedRef.current = true;
    console.log(`[RTK] Auto Connect triggered (mode=${rtkDefaultMode})`);
    if ((rtkDefaultMode || "").toLowerCase() === "lora") {
      void startLora();
    } else {
      void startNtrip();
    }
  }, [wsStatus, rtkAutoConnect, rtkRunning, rtkDefaultMode]);

  // ── Staged Mission persistence ──────────────────────────────────────
  const STAGED_MISSION_KEY = "staged_mission_cache";
  const stagedMissionLoadedRef = useRef(false);

  // Load saved staged mission once on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STAGED_MISSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.missionId && !recoveryAttemptedRef.current) {
            console.log(`[RECOVERY] Found staged mission ${saved.missionId} in SecureStore. Bypassing backend check.`);
            recoveryAttemptedRef.current = true;
            void recoverLoadedMissionContext(saved.sourceName, saved.missionId);
          }
        }
      } catch (err) {
        console.warn("[RECOVERY] Failed to load saved staged mission:", err);
      } finally {
        stagedMissionLoadedRef.current = true;
      }
    })();
  }, []);

  // Save staged mission whenever it successfully verifies
  useEffect(() => {
    if (!stagedMissionLoadedRef.current) return;
    if (stagedWorkflow.staged === "verified" && stagedMissionId) {
      const sourceName = selectedPathName || importedPlan?.fileName || null;
      const data = JSON.stringify({ missionId: stagedMissionId, sourceName });
      SecureStore.setItemAsync(STAGED_MISSION_KEY, data).catch((err) =>
        console.warn("[RECOVERY] Failed to save staged mission:", err)
      );
    }
  }, [stagedWorkflow.staged, stagedMissionId, selectedPathName, importedPlan]);

  async function stopMissionOnBackend() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before stopping a mission.");
      return;
    }

    logAction("STOP_REQUEST", { apiBaseUrl });
    setMissionActionBusy(true);
    try {
      showToast("Stop", "Stopping mission...", "warning");
      SecureStore.deleteItemAsync(STAGED_MISSION_KEY).catch(() => {});
      const res = await missionApi.stopMission(apiBaseUrl);

      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Stop failed");
        throw new Error(errMsg);
      }

      setMissionRunning(false);
      void refreshTelemetryPanel();
      logAction("STOP_SUCCESS");
      Alert.alert("Stopped", "Mission stop command sent to the backend.");
      showToast("Mission stopped", "Stop command accepted by the backend.", "success");
    } catch (error) {
      logAction("STOP_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      showToast("Stop failed", error instanceof Error ? error.message : "Could not stop the mission.", "error");
      Alert.alert("Stop failed", error instanceof Error ? error.message : "Could not stop the mission.");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function clearResidentMissionOnBackend() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before clearing a mission.");
      return;
    }

    logAction("CLEAR_REQUEST", {
      apiBaseUrl,
      selectedPathName,
      missionRunning,
      missionLoaded,
      missionState: telemetrySnapshot?.mission_state ?? null,
    });
    setMissionActionBusy(true);
    try {
      showToast("Clear", "Clearing resident mission...", "warning");
      SecureStore.deleteItemAsync(STAGED_MISSION_KEY).catch(() => {});
      const res = await missionApi.clearMission(apiBaseUrl);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Clear failed");
        const error = new Error(errMsg) as Error & { status?: number };
        error.status = res.status;
        throw error;
      }

      // Also remove the uploaded survey CSV from the rover missions dir so files
      // do not accumulate across Send-to-Rover cycles. Best-effort: ignore 404.
      const uploadedCsv =
        localCsvPreview != null
          ? sanitizeUploadFileName(localCsvPreview.fileName)
          : selectedPathName && /\.csv$/i.test(selectedPathName)
            ? selectedPathName
            : null;
      if (uploadedCsv) {
        try {
          await pathApi.deletePath(apiBaseUrl, uploadedCsv);
        } catch {
          // Network blip after mission clear succeeded — not fatal.
        }
      }

      setImportedPlan(null);
      setLines([]);
      setSelectedLineId(null);
      setSelectedPathName(null);
      setLocalCsvPreview(null);
      localCsvParsesRef.current = [];
      setLocalDxfMeta(null);
      setUploadedFiles([]);
      uploadedFilesRef.current = [];
      setMissionLayers([]);
      setControlModeActive(false);
      setPendingLayerAssignment(null);
      resetAnchorSelection();
      setPendingDxfAlignment({});
      setSharedOriginGps(null);
      sharedOriginGpsRef.current = null;
      setMissionFileReady(false);
      setMissionLoaded(false);
      setMissionRunning(false);
      setAutoOrigin(false);
      setAutoOriginReference(null);
      setExtractedCorners(null);
      setAlignedRefPoints([]);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      setIsGeographicDxf(false);
      setGeoOriginDxf(null);
      setVisualAlignmentItem(null);
      setIsVisualAlignmentMode(false);
      setSegmentVerification(null);
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      setLoadedPathInspection(null);
      setStagedWorkflow(INITIAL_STAGED_WORKFLOW_STATE);
      missionIdentityGenerationRef.current += 1;

      void refreshMissionIdentity();
      void refreshTelemetryPanel();
      logAction("CLEAR_SUCCESS");
      Alert.alert("Cleared", "Resident mission unloaded successfully.");
      showToast("Mission cleared", "Resident mission has been unloaded.", "success");
    } catch (error) {
      logAction("CLEAR_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      const message = error instanceof Error ? error.message : "Could not clear the mission.";
      Alert.alert("Clear failed", message);
      showToast("Clear failed", message, "error");
      if (typeof error === "object" && error && "status" in error && (error as { status?: number }).status === 409) {
        void refreshMissionIdentity();
      }
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function pauseMissionOnBackend() {
    if (!apiBaseUrl) return;
    setMissionActionBusy(true);
    try {
      showToast("Pause", "Pausing mission...", "info");
      const res = await missionApi.pauseMission(apiBaseUrl);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Pause failed");
        throw new Error(errMsg);
      }
      setIsPaused(true);
      showToast("Mission paused", "Mission has been paused.", "success");
      void refreshTelemetryPanel();
    } catch (error) {
      Alert.alert("Pause failed", error instanceof Error ? error.message : "Could not pause the mission.");
      showToast("Pause failed", error instanceof Error ? error.message : "Could not pause.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function resumeMissionOnBackend() {
    if (!apiBaseUrl) return;
    setMissionActionBusy(true);
    try {
      showToast("Resume", "Resuming mission...", "info");
      const res = await missionApi.resumeMission(apiBaseUrl);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Resume failed");
        throw new Error(errMsg);
      }
      setIsPaused(false);
      showToast("Mission resumed", "Mission has been resumed.", "success");
      void refreshTelemetryPanel();
    } catch (error) {
      Alert.alert("Resume failed", error instanceof Error ? error.message : "Could not resume the mission.");
      showToast("Resume failed", error instanceof Error ? error.message : "Could not resume.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function armVehicle(arm: boolean) {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before sending commands.");
      return;
    }
    logAction("ARM_REQUEST", { apiBaseUrl, arm });
    setMissionActionBusy(true);
    try {
      showToast(arm ? "Arm" : "Disarm", arm ? "Arming vehicle..." : "Disarming vehicle...", "info");
      const res = await fetch(`${apiBaseUrl}/api/arm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ arm }),
      });
      let data;
      try { data = await res.clone().json(); } catch (e) { }

      if (!res.ok || (data && data.success === false)) {
        const errMsg = data?.message || (await parseFetchError(res, arm ? "Arm failed" : "Disarm failed"));
        throw new Error(errMsg);
      }
      void refreshTelemetryPanel();
      logAction("ARM_SUCCESS", { arm });
      Alert.alert(arm ? "Armed" : "Disarmed", `Vehicle was successfully ${arm ? "armed" : "disarmed"}.`);
      showToast(arm ? "Armed" : "Disarmed", `Vehicle is now ${arm ? "armed" : "disarmed"}.`, "success");
    } catch (error) {
      logAction("ARM_FAILED", {
        arm,
        error: error instanceof Error ? error.message : String(error),
      });
      Alert.alert(arm ? "Arm failed" : "Disarm failed", error instanceof Error ? error.message : "Command rejected.");
      showToast(arm ? "Arm failed" : "Disarm failed", error instanceof Error ? error.message : "Command rejected.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function setVehicleMode(targetMode: "MANUAL") {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before sending commands.");
      return;
    }
    logAction("SET_MODE_REQUEST", { apiBaseUrl, targetMode });
    setMissionActionBusy(true);
    try {
      showToast("Mode", `Switching to ${targetMode}...`, "info");
      const res = await fetch(`${apiBaseUrl}/api/set_mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: targetMode })
      });
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Set mode failed");
        throw new Error(errMsg);
      }
      await refreshTelemetryPanel();
      logAction("SET_MODE_SUCCESS", { targetMode });
      Alert.alert("Mode Changed", `Vehicle mode set to ${targetMode}.`);
      showToast("Mode Changed", `Vehicle mode is now ${targetMode}.`, "success");
    } catch (error) {
      logAction("SET_MODE_FAILED", {
        targetMode,
        error: error instanceof Error ? error.message : String(error),
      });
      Alert.alert("Mode Change Failed", error instanceof Error ? error.message : "Command rejected.");
      showToast("Mode Change Failed", error instanceof Error ? error.message : "Command rejected.", "error");
      throw error;
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function estopVehicle() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before sending commands.");
      return;
    }
    virtualJoystick.handleEStop();
    logAction("ESTOP_REQUEST", { apiBaseUrl });
    setMissionActionBusy(true);
    try {
      showToast("E-Stop", "Sending EMERGENCY STOP...", "error");
      
      // Send E-Stop via HTTP API to halt motors immediately
      await fetch(`${apiBaseUrl}/api/estop`, { method: "POST" }).catch((err) => {
        console.warn("HTTP E-Stop failed:", err);
      });

      logAction("ESTOP_SUCCESS");
      Alert.alert("E-STOP Sent", "Emergency Stop command accepted.");
      showToast("E-STOP Sent", "Emergency Stop command active.", "success");
    } catch (error) {
      logAction("ESTOP_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      Alert.alert("E-Stop failed", error instanceof Error ? error.message : "Command rejected.");
      showToast("E-Stop failed", error instanceof Error ? error.message : "Command rejected.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function runTemplateOnBackend(name: string, generatedLines: PlanLine[]) {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before running a template.");
      return;
    }
    if (protectedMissionResident) {
      const message = "Template load is blocked while a protected surveyed mission is resident.";
      Alert.alert("Mission conflict", message);
      showToast("Mission conflict", message, "error");
      return;
    }
    const fileName = `${name.replace(/\s+/g, "_").toLowerCase()}_template.dxf`;
    logAction("LOAD_TEMPLATE_REQUEST", { apiBaseUrl, fileName });
    setMissionActionBusy(true);
    try {
      showToast("Load", `Loading template ${fileName}...`, "info");
      const res = await missionApi.loadMission(apiBaseUrl, {
        path_name: fileName,
        mission_file: "",
      });

      if (!res.ok) {
        throw await parseMissionResponseError(res, "Load failed");
      }

      setImportedPlan({
        fileName,
        uri: "",
        fileType: "dxf",
        source: "generated",
      });
      const safeGeneratedLines = sanitizePlanLines(normalizePlanLinesForCurves(generatedLines));
      setLines(safeGeneratedLines);
      setSelectedLineId(safeGeneratedLines[0]?.id ?? null);
      setMissionLoaded(true);
      setMissionLoadedPanelOpenToken((token) => token + 1);
      setMissionRunning(false);
      void refreshTelemetryPanel();
      setPage("home");
      showToast("Template loaded", "Template path loaded successfully.", "success");
    } catch (error) {
      const missionError = error && typeof error === "object" && "kind" in error
        ? error as ReturnType<typeof classifyMissionError>
        : null;
      logAction("LOAD_TEMPLATE_FAILED", {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      const message = missionError?.message ?? (error instanceof Error ? error.message : "Could not load template.");
      const title = missionError?.title ?? "Load failed";
      Alert.alert(title, message);
      showToast(title, message, "error");
      if (missionError?.status === 409) void refreshMissionIdentity();
    } finally {
      setMissionActionBusy(false);
    }
  }

  function priorityScanHosts() {
    return PRIORITY_BACKEND_IPS.map((ip) => `http://${ip}:${DISCOVERY_PORT}`);
  }

  // Probe a single host's /api/ping with retries. Lossy links (e.g. phone
  // hotspots with packet loss) can drop a single request even when the host is
  // reachable, so we retry before giving up.
  async function probeHostReachable(host: string, timeoutMs = 2500, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${host}/api/ping`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) return true;
      } catch {
        // retry
      }
    }
    return false;
  }

  function parseHost(candidate: string) {
    try {
      const url = new URL(candidate);
      return {
        host: url.hostname,
        port: Number(url.port || 5001),
      };
    } catch {
      return null;
    }
  }

  async function probeBackendHost(candidate: string): Promise<number | null> {
    const start = Date.now();
    const endpoints = ["/api/ping", "/api/healthz"];
    for (const endpoint of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${candidate}${endpoint}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) return Date.now() - start;
      } catch {
        // try next endpoint
      }
    }
    return null;
  }

  function buildSubnetSweepCandidates(seedHost: string, deviceIp?: string | null) {
    const prefixes = new Set<string>();

    // 0. Device's own subnet first — this is the network the tablet is actually
    //    on (e.g. a phone hotspot's 10.169.x.x), so the backend almost certainly
    //    lives here. Added before everything else so it gets scanned first.
    if (deviceIp && isPrivateLanIp(deviceIp)) {
      const octets = deviceIp.split(".");
      if (octets.length === 4) {
        prefixes.add(octets.slice(0, 3).join("."));
      }
    }

    // 1. Check seed host if it's a private IP
    const parsed = parseHost(seedHost);
    if (parsed && isPrivateLanIp(parsed.host)) {
      const octets = parsed.host.split(".");
      if (octets.length === 4) {
        prefixes.add(octets.slice(0, 3).join("."));
      }
    }

    // 2. Check window.location if running in a web environment (will be undefined in React Native APK)
    if (typeof window !== "undefined" && window.location && window.location.hostname) {
      const host = window.location.hostname;
      if (isPrivateLanIp(host)) {
        const octets = host.split(".");
        if (octets.length === 4) {
          prefixes.add(octets.slice(0, 3).join("."));
        }
      }
    }

    // 3. Always include common private subnets
    prefixes.add("192.168.1");
    prefixes.add("192.168.0");
    prefixes.add("192.168.2");
    prefixes.add("10.0.0");
    prefixes.add("172.16.0");

    // 4. Extract subnet from manual host and add it as a priority scan
    //    This helps when user enters an IP manually on a non-192.168.x network
    try {
      const seedParsed = parseHost(seedHost);
      if (seedParsed && isPrivateLanIp(seedParsed.host)) {
        const octets = seedParsed.host.split(".");
        if (octets.length === 4) {
          prefixes.add(octets.slice(0, 3).join("."));
        }
      }
    } catch {
      // ignore
    }

    const candidates: string[] = [];
    for (const prefix of prefixes) {
      for (let hostOctet = SUBNET_HOST_MIN; hostOctet <= SUBNET_HOST_MAX; hostOctet++) {
        candidates.push(`http://${prefix}.${hostOctet}:${DISCOVERY_PORT}`);
      }
    }
    return candidates;
  }

  function isPrivateLanIp(host: string) {
    const octets = host.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
      return false;
    }

    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  async function runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const currentIndex = cursor++;
        const value = items[currentIndex];
        const result = await worker(value);
        results[currentIndex] = result;
      }
    });

    await Promise.all(runners);
    return results;
  }

  async function discoverBackendBeacons(candidate: string, responseTime: number): Promise<DiscoveredRover[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${candidate}/api/discover`, {
        method: "POST",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const body = await res.json();
      return (body.beacons ?? []).map((rover: any) => ({
        id: rover.id ?? rover.rover_id ?? `${rover.host}-${rover.port}`,
        name: rover.name ?? rover.rover_name ?? `Rover ${String(rover.host ?? "").split(".").pop() ?? ""}`,
        host: rover.host ?? rover.ip ?? "",
        port: Number(rover.port ?? 5001),
        version: rover.version ?? "1.0",
        responseTime,
      })).filter((entry: DiscoveredRover) => Boolean(entry.host));
    } catch {
      return [];
    }
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SafeAreaInsetsContext.Consumer>
          {(insets) => (
            <View
              style={{
                flex: 1,
                backgroundColor: BG,
                paddingTop: insets?.top ?? 0,
                paddingRight: insets?.right ?? 0,
                paddingBottom: insets?.bottom ?? 0,
                paddingLeft: insets?.left ?? 0,
              }}
            >
              <Modal transparent visible={passwordChangeOpen} animationType="fade" onRequestClose={() => setPasswordChangeOpen(false)}>
                <Pressable
                  onPress={() => setPasswordChangeOpen(false)}
                  style={{
                    flex: 1,
                    backgroundColor: "rgba(15,23,42,0.45)",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                    zIndex: 100,
                  }}
                >
                  <Pressable
                    onPress={() => {}}
                    style={{
                      width: "100%",
                      maxWidth: 420,
                      borderRadius: 18,
                      backgroundColor: "#ffffff",
                      padding: 18,
                      gap: 12,
                    }}
                  >
                    <Text style={{ color: "#0f172a", fontSize: 20, fontWeight: "900" }}>Change rover password</Text>
                    <TextInput
                      value={currentPasswordInput}
                      onChangeText={setCurrentPasswordInput}
                      placeholder="Current password"
                      placeholderTextColor="#94a3b8"
                      secureTextEntry
                      style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 12, padding: 12, color: "#0f172a" }}
                    />
                    <TextInput
                      value={newPasswordInput}
                      onChangeText={setNewPasswordInput}
                      placeholder="New password"
                      placeholderTextColor="#94a3b8"
                      secureTextEntry
                      style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 12, padding: 12, color: "#0f172a" }}
                    />
                    <TextInput
                      value={confirmPasswordInput}
                      onChangeText={setConfirmPasswordInput}
                      placeholder="Confirm new password"
                      placeholderTextColor="#94a3b8"
                      secureTextEntry
                      style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 12, padding: 12, color: "#0f172a" }}
                    />
                    <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
                      <Pressable
                        onPress={() => setPasswordChangeOpen(false)}
                        style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: "#e2e8f0" }}
                      >
                        <Text style={{ color: "#0f172a", fontWeight: "800" }}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        onPress={submitPasswordChange}
                        disabled={passwordChangeBusy}
                        style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: passwordChangeBusy ? "#94a3b8" : "#2563eb" }}
                      >
                        <Text style={{ color: "#fff", fontWeight: "800" }}>{passwordChangeBusy ? "Saving..." : "Save"}</Text>
                      </Pressable>
                    </View>
                  </Pressable>
                </Pressable>
              </Modal>

              {page === "connection" ? (
                <ConnectionView
                  selectedWs={selectedWs}
                  manualHost={manualHost}
                  wsError={wsError}
                  wsStatus={wsStatus}
                  password={operatorPassword}
                  onPasswordChange={setOperatorPassword}
                  hasStoredSession={Boolean(operatorSession)}
                  isOffline={isOffline}
                  discoveredRovers={discoveredRovers}
                  onRefresh={scanForWebsockets}
                  onSelect={handleSelectWebsocket}
                  onManualHostChange={setManualHost}
                  onConnect={connectSelectedWebsocket}
                  onOfflinePreview={enterOfflinePreview}
                />
              ) : (
                <AppErrorBoundary name="Home">
                <HomeView
                  page={page}
                  autoOrigin={autoOrigin}
                  onToggleAutoOrigin={toggleAutoOrigin}
                  onResetNorth={() => setResetNorthCount((c) => c + 1)}
                  resetNorthCount={resetNorthCount}
                  onFocusRover={() => setRecenterRoverCount((c) => c + 1)}
                  onFocusPlan={() => setRecenterPlanCount((c) => c + 1)}
                  recenterRoverCount={recenterRoverCount}
                  recenterPlanCount={recenterPlanCount}
                  previewRoverPoint={previewRoverPoint}
                  originShiftKey={
                    autoOriginReference
                      ? `${autoOriginReference.roverNorth.toFixed(3)}:${autoOriginReference.roverEast.toFixed(3)}`
                      : autoOrigin
                        ? "pending"
                        : null
                  }
                  importedPlan={importedPlan}
                  setImportedPlan={setImportedPlan}
                  onSelectPath={previewSelectedPath}
                  lines={displayedLines}
                  mapSourceLines={mapSourceLines}
                  missionVisibleLines={missionVisibleDisplayedLines}
                  missionVisibleMapSourceLines={missionVisibleMapSourceLines}
                  autoOriginReference={autoOriginReference}
                  mapGeometryFrame={mapGeometryFrame}
                  autoOriginEnabled={autoOriginEligible}
                  geoOrigin={geoOriginDxf}
                  extensionsEnabled={extensionsEnabled}
                  setLines={setLines}
                  selectedLineId={selectedLineId}
                  onSelectLine={handleSelectLine}
                  onDeleteSelectedLine={deleteSelectedLine}
                  onConfirmDeletePlan={deleteEntirePlan}
                  menuOpen={menuOpen}
                  onToggleMenu={() => setMenuOpen((v) => !v)}
                  onNav={(p) => {
                    logAction("NAVIGATE", { page: p });
                    setPage(p);
                    setMenuOpen(false);
                  }}
                  onDisconnect={() => void logoutToConnectionScreen()}
                  onOpenPasswordChange={() => setPasswordChangeOpen(true)}
                  layerVisibility={layerVisibility}
                  setLayerVisibility={setLayerVisibility}
                  missionLayers={missionLayers}
                  controlModeActive={controlModeActive}
                  canUseMissionControl={canUseMissionControl}
                  onToggleControlMode={() => {
                    if (!canUseMissionControl) {
                      showToast(
                        "Control unavailable",
                        "Finish aligning every uploaded file before assigning mission layers.",
                        "warning"
                      );
                      return;
                    }
                    setControlModeActive((v) => !v);
                    setPendingLayerAssignment(null);
                  }}
                  onToggleMissionLayerVisibility={handleToggleMissionLayerVisibility}
                  onStopPlan={stopMissionOnBackend}
                  onClearMission={clearResidentMissionOnBackend}
                  onStartPlan={startLoadedMission}
                  onPausePlan={pauseMissionOnBackend}
                  onResumePlan={resumeMissionOnBackend}
                  onArmVehicle={armVehicle}
                  onSetMode={setVehicleMode}
                  onEstopVehicle={estopVehicle}
                  virtualJoystick={virtualJoystick}
                  missionActionBusy={missionActionBusy}
                  missionFileReady={missionFileReady}
                  missionLoaded={missionLoaded}
                  missionLoadedPanelOpenToken={missionLoadedPanelOpenToken}
                  missionRunning={missionRunning}
                  systemHealth={systemHealth}
                  telemetrySnapshot={telemetrySnapshot}
                  activityFeed={activityFeed}
                  discoveryFeed={discoveryFeed}
                  telemetryError={telemetryError}
                  telemetryLoading={telemetryLoading}
                  isPaused={isPaused}
                  setIsPaused={setIsPaused}
                  rtkModalOpen={rtkModalOpen}
                  setRtkModalOpen={setRtkModalOpen}
                  rtkCaster={rtkCaster}
                  setRtkCaster={setRtkCaster}
                  rtkPort={rtkPort}
                  setRtkPort={setRtkPort}
                  rtkMountPoint={rtkMountPoint}
                  setRtkMountPoint={setRtkMountPoint}
                  rtkUsername={rtkUsername}
                  setRtkUsername={setRtkUsername}
                  rtkPassword={rtkPassword}
                  setRtkPassword={setRtkPassword}
                  rtkConnecting={rtkConnecting}
                  rtkMode={rtkMode}
                  rtkDefaultMode={rtkDefaultMode}
                  startNtrip={startNtrip}
                  startLora={startLora}
                  stopRtk={stopRtk}
                  rtkRunning={rtkRunning}
                  rtkHealthy={rtkHealthy}
                  onParsePlan={parseDxfPlan}
                  apiBaseUrl={apiBaseUrl}
                  selectedPathName={selectedPathName}
                  onRefreshPaths={() => {
                    const target = selectedPathName || importedPlan?.fileName;
                    if (target) previewSelectedPath(target);
                  }}
                  stagedWorkflow={stagedWorkflow}
                  stagedMissionId={stagedMissionId}
                  loadedPathInspection={loadedPathInspection}
                  onInvalidateWorkflow={invalidateStagedWorkflowFrom}
                  alignedRefPoints={alignedRefPoints}
                  setAlignedRefPoints={setAlignedRefPoints}
                  mapViewEnabled={mapViewEnabled}
                  setMapViewEnabled={setMapViewEnabled}
                  csvMapPins={csvMapPins}
                  showRefPointLabels={showRefPointLabels}
                  setShowRefPointLabels={setShowRefPointLabels}
                  activeRefPointLabelIndex={activeRefPointLabelIndex}
                  setActiveRefPointLabelIndex={setActiveRefPointLabelIndex}
                  visualAlignmentAnchor={visualAlignmentAnchor}
                  renderSectionContent={
                    page !== "home"
                      ? () => (
                          <SectionPages
                            title=""
                            onBack={() => setPage("home")}
                            telemetrySnapshot={telemetrySnapshot}
                            missionRunning={missionRunning}
                            previewRoverPoint={previewRoverPoint}
                            page={page}
                            importedPlan={importedPlan}
                            lines={displayedLines}
                            mapSourceLines={mapSourceLines}
                            autoOriginReference={autoOriginReference}
                            mapGeometryFrame={mapGeometryFrame}
                            autoOriginEnabled={autoOriginEligible}
                            geoOrigin={geoOriginDxf}
                            autoOrigin={autoOrigin}
                            onToggleAutoOrigin={toggleAutoOrigin}
                            setLines={setLines}
                            selectedLineId={selectedLineId}
                            backendPaths={backendPaths}
                            selectedPathName={selectedPathName}
                            onSelectPath={previewSelectedPath}
                            onLoadSelectedPath={loadMissionOnBackend}
                            missionActionBusy={missionActionBusy}
                            onClearMission={clearResidentMissionOnBackend}
                            apiBaseUrl={apiBaseUrl}
                            onRefreshPaths={fetchBackendPaths}
                            showRefPointLabels={showRefPointLabels}
                            setShowRefPointLabels={setShowRefPointLabels}
                            activeRefPointLabelIndex={activeRefPointLabelIndex}
                            setActiveRefPointLabelIndex={setActiveRefPointLabelIndex}
                            resetNorthCount={resetNorthCount}
                            recenterRoverCount={recenterRoverCount}
                            recenterPlanCount={recenterPlanCount}
                            isVisualAlignmentMode={isVisualAlignmentMode}
                            visualAlignmentItem={visualAlignmentItem}
                            setVisualAlignmentItem={setVisualAlignmentItem}
                            setVisualAlignmentAnchor={setVisualAlignmentAnchor}
                            visualAlignmentAnchor={visualAlignmentAnchor}
                            previewFallbackGps={latchedPreviewGps}
                            onStartVisualAlignment={startVisualAlignment}
                            onConfirmVisualAlignment={handleConfirmVisualAlignment}
                            isPlanEditingMode={isPlanEditingMode}
                            onStartPlanEditing={startPlanEditing}
                            onStopPlanEditing={stopPlanEditing}
                            multiPointPlacementPhase={multiPointPlacementPhase}
                            onPlanAttached={handlePlanAttached}
                            onPlanEditResize={handlePlanEditResize}
                            onPlanResizeDone={handlePlanResizeDone}
                            onFitToReferencePoints={handleFitToReferencePoints}
                            extractedCorners={extractedCorners}
                            setExtractedCorners={setExtractedCorners}
                            onNav={(p) => setPage(p)}
                            onSelectLine={handleSelectLine}
                            highlightLineIds={highlightLineIds}
                            onGenerateTemplate={(name, generatedLines) => {
                              if (protectedMissionResident) {
                                Alert.alert("Mission conflict", "Generating a new template is blocked while a protected surveyed mission is resident.");
                                return;
                              }
                              const safeGeneratedLines = sanitizePlanLines(normalizePlanLinesForCurves(generatedLines));
                              setImportedPlan({ fileName: `${name}.dxf`, uri: "", fileType: "dxf", source: "generated" });
                              setLines(safeGeneratedLines);
                              setSelectedLineId(safeGeneratedLines[0]?.id ?? null);
                              setMissionFileReady(false);
                              setMissionLoaded(false);
                              setMissionRunning(false);
                              setPage("home");
                              showToast("Template ready", `${name}.dxf is ready to upload.`, "success");
                            }}
                            layerVisibility={layerVisibility}
                            setLayerVisibility={setLayerVisibility}
                            setImportedPlan={setImportedPlan}
                            onRunTemplate={runTemplateOnBackend}
                            extensionsEnabled={extensionsEnabled}
                            setExtensionsEnabled={setExtensionsEnabled}
                            extPre={extPre}
                            setExtPre={setExtPre}
                            extAft={extAft}
                            setExtAft={setExtAft}
                            missionFileReady={missionFileReady}
                            toggleA={toggleA}
                            toggleB={toggleB}
                            toggleC={toggleC}
                            toggleD={toggleD}
                            delayA={delayA}
                            delayB={delayB}
                            setToggleA={setToggleA}
                            setToggleB={setToggleB}
                            setToggleC={setToggleC}
                            setToggleD={setToggleD}
                            setDelayA={setDelayA}
                            setDelayB={setDelayB}
                            onParsePlan={parseDxfPlan}
                            onWorkflowStep={setWorkflowStep}
                            stagedWorkflow={stagedWorkflow}
                            alignmentResult={alignmentResult}
                            setAlignmentResult={setAlignmentResult}
                            verifiedAlignmentRequest={verifiedAlignmentRequest}
                            setVerifiedAlignmentRequest={setVerifiedAlignmentRequest}
                            isGeographicDxf={isGeographicDxf}
                            segmentVerification={segmentVerification}
                            setSegmentVerification={setSegmentVerification}
                            stagedPlanResult={stagedPlanResult}
                            setStagedPlanResult={setStagedPlanResult}
                            stagedMissionInspection={stagedMissionInspection}
                            setStagedMissionInspection={setStagedMissionInspection}
                            stagedMissionId={stagedMissionId}
                            setStagedMissionId={setStagedMissionId}
                            loadedPathInspection={loadedPathInspection}
                            onInvalidateWorkflow={invalidateStagedWorkflowFrom}
                            onAppPlannedStartSnapshot={setAppPlannedStartSnapshot}
                            alignedRefPoints={alignedRefPoints}
                            setAlignedRefPoints={setAlignedRefPoints}
                            mapViewEnabled={mapViewEnabled}
                            setMapViewEnabled={setMapViewEnabled}
                            isFloatingEStopEnabled={isFloatingEStopEnabled}
                            setIsFloatingEStopEnabled={setIsFloatingEStopEnabled}
                            rtkCaster={rtkCaster}
                            setRtkCaster={setRtkCaster}
                            rtkPort={rtkPort}
                            setRtkPort={setRtkPort}
                            rtkMountPoint={rtkMountPoint}
                            setRtkMountPoint={setRtkMountPoint}
                            rtkUsername={rtkUsername}
                            setRtkUsername={setRtkUsername}
                            rtkPassword={rtkPassword}
                            setRtkPassword={setRtkPassword}
                            rtkRunning={rtkRunning}
                            rtkHealthy={rtkHealthy}
                            rtkMode={rtkMode}
                            rtkDefaultMode={rtkDefaultMode}
                            setRtkDefaultMode={setRtkDefaultMode}
                            rtkAutoConnect={rtkAutoConnect}
                            setRtkAutoConnect={setRtkAutoConnect}
                            stopRtk={stopRtk}
                            localCsvPreview={localCsvPreview}
                            localDxfMeta={localDxfMeta}
                            uploadedFiles={uploadedFiles}
                            pendingDxfAlignment={pendingDxfAlignment}
                            setPendingDxfAlignment={setPendingDxfAlignment}
                            sharedOriginGps={sharedOriginGps}
                            onBeginLocalImportBatch={handleBeginLocalImportBatch}
                            onAlignContextChange={handleAlignContextChange}
                            onCommitDxfFileAlignment={commitDxfFileAlignment}
                            onLocalCsvParsed={handleLocalCsvParsed}
                            onLocalDxfParsed={handleLocalDxfParsed}
                            onClearLocalCsv={handleClearLocalCsv}
                            missionLayers={missionLayers}
                            controlModeActive={controlModeActive}
                            canUseMissionControl={canUseMissionControl}
                            pendingLayerAssignment={pendingLayerAssignment}
                            onPendingLayerAssignment={setPendingLayerAssignment}
                            onAssignFileToNewLayer={handleAssignFileToNewLayer}
                            onAssignFileToLayer={handleAssignFileToLayer}
                            onUnassignFileFromLayer={handleUnassignFileFromLayer}
                            missionVisibleLines={missionVisibleDisplayedLines}
                            missionVisibleMapSourceLines={missionVisibleMapSourceLines}
                            anchorAvailable={anchorAvailable}
                            anchorSelectMode={anchorSelectMode}
                            anchorTargetOptions={anchorTargetOptions}
                            anchorTarget={anchorTarget}
                            pendingAnchor={pendingAnchor}
                            anchorCandidates={anchorCandidates}
                            anchorIsolatedLines={isolatedAnchorLines}
                            onAnchorPress={handleAnchorPress}
                            onSelectAnchorTarget={handleSelectAnchorTarget}
                            onAnchorCandidateSelect={handleAnchorCandidateSelect}
                            onConfirmAnchor={handleConfirmAnchor}
                            offsetDistanceM={offsetDistanceM}
                            offsetBearingDeg={offsetBearingDeg}
                            onOffsetDistanceChange={setOffsetDistanceM}
                            onOffsetBearingChange={handleOffsetBearingChange}
                            onApplyOffset={handleApplyOffset}
                            offsetTargetOptions={anchorTargetOptions}
                            offsetTarget={offsetTarget}
                            onOffsetTargetChange={setOffsetTarget}
                            offsetResetAvailable={preOffsetSnapshot != null}
                            onResetOffset={handleResetOffset}
                            onOffsetDragStateChange={handleOffsetDragStateChange}
                            offsetPreviewLines={offsetPreviewLines}
                          />
                        )
                      : undefined
                  }
                />
                </AppErrorBoundary>
              )}


              {toast ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: 16,
                    right: 16,
                    bottom: 18,
                    zIndex: 999,
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{
                      maxWidth: 560,
                      width: "100%",
                      borderRadius: 16,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      backgroundColor:
                        toast.tone === "success"
                          ? "#0f766e"
                          : toast.tone === "warning"
                            ? "#b45309"
                            : toast.tone === "error"
                              ? "#991b1b"
                              : "#0f172a",
                      borderWidth: 1,
                      borderColor:
                        toast.tone === "success"
                          ? "#5eead4"
                          : toast.tone === "warning"
                            ? "#fdba74"
                            : toast.tone === "error"
                              ? "#fca5a5"
                              : "#334155",
                      shadowColor: "#000",
                      shadowOpacity: 0.16,
                      shadowRadius: 16,
                      shadowOffset: { width: 0, height: 8 },
                      elevation: 10,
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "900", letterSpacing: 0.6, textTransform: "uppercase" }}>
                      {toast.title}
                    </Text>
                    <Text style={{ color: "#e2e8f0", marginTop: 4, fontSize: 13, lineHeight: 18 }}>
                      {toast.message}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>
          )}
        </SafeAreaInsetsContext.Consumer>
      </SafeAreaProvider>
      <FloatingEStop visible={isFloatingEStopEnabled} onEStop={estopVehicle} />
    </GestureHandlerRootView>
  );
}

function TopBar({
  title,
  onBack,
  onMorePress,
  mapViewEnabled,
  setMapViewEnabled,
}: {
  title: string;
  onBack?: () => void;
  onMorePress?: () => void;
  mapViewEnabled?: boolean;
  setMapViewEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <View
      style={{
        height: 76,
        backgroundColor: "#f8fafc",
        borderBottomWidth: 1,
        borderBottomColor: "#d7dee8",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={14}
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: "#eef2f7",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: "#d7dee8",
            }}
          >
            <Text style={{ fontSize: 24, color: "#0f172a", lineHeight: 24 }}>‹</Text>
          </Pressable>
        ) : null}
        <Text style={{ fontSize: 18, color: "#0f172a", fontWeight: "700" }}>{title}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {setMapViewEnabled && (
          <Pressable
            onPress={() => setMapViewEnabled((v) => !v)}
            style={{
              height: 38,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              borderRadius: 12,
              backgroundColor: mapViewEnabled ? "#3b82f6" : "#ffffff",
              borderWidth: 1,
              borderColor: mapViewEnabled ? "#2563eb" : "#d7dee8",
            }}
          >
            <MapIcon size={14} color={mapViewEnabled ? "#ffffff" : "#0f172a"} />
            <Text style={{ color: mapViewEnabled ? "#ffffff" : "#0f172a", fontSize: 11, fontWeight: "800" }}>
              {mapViewEnabled ? "Map On" : "Map"}
            </Text>
          </Pressable>
        )}
        {onMorePress ? (
          <Pressable
            onPress={onMorePress}
            hitSlop={14}
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: "#eef2f7",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: "#d7dee8",
            }}
          >
            <Text style={{ fontSize: 20, color: "#0f172a", lineHeight: 20 }}>⋮</Text>
          </Pressable>
        ) : (
          !setMapViewEnabled && <View style={{ width: 38, height: 38 }} />
        )}
      </View>
    </View>
  );
}

type HomeViewProps = {
  page?: Page;
  renderSectionContent?: () => React.ReactNode;
  autoOrigin: boolean;
  onToggleAutoOrigin: () => void;
  onResetNorth?: () => void;
  resetNorthCount?: number;
  onFocusRover?: () => void;
  onFocusPlan?: () => void;
  recenterRoverCount?: number;
  recenterPlanCount?: number;
  extensionsEnabled?: boolean;
  previewRoverPoint: { north: number; east: number } | null;
  originShiftKey?: string | null;
  mapSourceLines: PlanLine[];
  autoOriginReference: AutoOriginReference | null;
  mapGeometryFrame: MapGeometryFrame;
  autoOriginEnabled: boolean;
  geoOrigin?: [number, number] | null;
  importedPlan: ImportedPlan | null;
  setImportedPlan?: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  onSelectPath?: (name: string) => void;
  lines: PlanLine[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onSelectLine: (id: string | null, options?: { highlightLineIds?: string[] | null }) => void;
  onDeleteSelectedLine: () => void;
  onConfirmDeletePlan: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onNav: (p: Page) => void;
  onDisconnect: () => void;
  onOpenPasswordChange: () => void;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  onStopPlan: () => Promise<void>;
  onClearMission: () => Promise<void>;
  onStartPlan: () => Promise<void>;
  onPausePlan: () => Promise<void>;
  onResumePlan: () => Promise<void>;
  onArmVehicle: (arm: boolean) => Promise<void>;
  onSetMode: (mode: "MANUAL") => Promise<void>;
  onEstopVehicle: () => Promise<void>;
  virtualJoystick: ReturnType<typeof useVirtualJoystick>;
  missionActionBusy: boolean;
  missionFileReady: boolean;
  missionLoaded: boolean;
  missionLoadedPanelOpenToken: number;
  missionRunning: boolean;
  systemHealth: SystemHealth | null;
  telemetrySnapshot: TelemetrySnapshot | null;
  activityFeed: ActivityEntry[];
  discoveryFeed: DiscoveredRover[];
  telemetryError: string;
  telemetryLoading: boolean;
  isPaused: boolean;
  setIsPaused: React.Dispatch<React.SetStateAction<boolean>>;
  rtkModalOpen: boolean;
  setRtkModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  rtkCaster: string;
  setRtkCaster: React.Dispatch<React.SetStateAction<string>>;
  rtkPort: string;
  setRtkPort: React.Dispatch<React.SetStateAction<string>>;
  rtkMountPoint: string;
  setRtkMountPoint: React.Dispatch<React.SetStateAction<string>>;
  rtkUsername: string;
  setRtkUsername: React.Dispatch<React.SetStateAction<string>>;
  rtkPassword: string;
  setRtkPassword: React.Dispatch<React.SetStateAction<string>>;
  rtkConnecting: boolean;
  rtkMode: RTKMode;
  rtkDefaultMode?: string;
  startNtrip: () => Promise<void>;
  startLora: () => Promise<void>;
  stopRtk: () => Promise<void>;
  rtkRunning: boolean;
  rtkHealthy: boolean;
  onParsePlan: () => Promise<void>;
  apiBaseUrl?: string;
  selectedPathName?: string | null;
  onRefreshPaths?: () => void;
  stagedWorkflow: StagedWorkflowState;
  stagedMissionId: string | null;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  onInvalidateWorkflow?: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  setMapViewEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  csvMapPins?: { x: number; y: number; lat?: number; lon?: number }[] | null;
  showRefPointLabels?: boolean;
  setShowRefPointLabels: React.Dispatch<React.SetStateAction<boolean>>;
  activeRefPointLabelIndex?: number | null;
  setActiveRefPointLabelIndex?: React.Dispatch<React.SetStateAction<number | null>>;
  isVisualAlignmentMode?: boolean;
  isPlanEditingMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
  visualAlignmentAnchor?: { originLat: number; originLon: number; originDxfNorth: number; originDxfEast: number } | null;
  /** Mission Layers (file groups) — distinct from CAD LayerVisibility. */
  missionLayers?: MissionLayer[];
  controlModeActive?: boolean;
  canUseMissionControl?: boolean;
  onToggleControlMode?: () => void;
  onToggleMissionLayerVisibility?: (layerId: string) => void;
  missionVisibleLines?: PlanLine[];
  missionVisibleMapSourceLines?: PlanLine[];
};

function HomeView(props: HomeViewProps) {
  // Prefer App-provided live snapshot (single source of truth). Store is fallback only.
  const liveTelemetry = useTelemetrySnapshot();
  const liveHealth = useSystemHealth();
  const {
    page = "home",
    renderSectionContent,
    autoOrigin,
    onToggleAutoOrigin,
    previewRoverPoint: previewRoverPointProp,
    originShiftKey,
    mapSourceLines,
    autoOriginReference,
    mapGeometryFrame,
    autoOriginEnabled,
    geoOrigin = null,
    importedPlan,
    lines,
    setLines,
    selectedLineId,
    onSelectLine,
    onDeleteSelectedLine,
    onConfirmDeletePlan,
    menuOpen,
    onToggleMenu,
    onNav,
    onDisconnect,
    onOpenPasswordChange,
    layerVisibility,
    setLayerVisibility,
    onStopPlan,
    onClearMission,
    onStartPlan,
    onPausePlan,
    onResumePlan,
    onArmVehicle,
    onSetMode,
    onEstopVehicle,
    virtualJoystick,
    missionActionBusy,
    missionFileReady,
    missionLoaded,
    missionRunning,
    systemHealth: systemHealthProp,
    telemetrySnapshot: telemetrySnapshotProp,
    activityFeed,
    discoveryFeed,
    telemetryError,
    telemetryLoading,
    isPaused,
    setIsPaused,
    rtkModalOpen,
    setRtkModalOpen,
    rtkCaster,
    setRtkCaster,
    rtkPort,
    setRtkPort,
    rtkMountPoint,
    setRtkMountPoint,
    rtkUsername,
    setRtkUsername,
    rtkPassword,
    setRtkPassword,
    rtkConnecting,
    rtkMode,
    rtkDefaultMode,
    startNtrip,
    startLora,
    stopRtk,
    rtkRunning,
    rtkHealthy,
    onParsePlan,
    apiBaseUrl,
    selectedPathName,
    onRefreshPaths,
    stagedWorkflow,
    stagedMissionId,
    loadedPathInspection,
    onInvalidateWorkflow,
    alignedRefPoints = [],
    setAlignedRefPoints,
    mapViewEnabled = true,
    setMapViewEnabled,
    showRefPointLabels = false,
    setShowRefPointLabels,
    activeRefPointLabelIndex = null,
    setActiveRefPointLabelIndex,
    isVisualAlignmentMode,
    visualAlignmentItem,
    setVisualAlignmentItem,
    onStartVisualAlignment,
    onConfirmVisualAlignment,
    isPlanEditingMode,
    visualAlignmentAnchor,
    setImportedPlan,
    onFocusRover,
    onFocusPlan,
    recenterRoverCount = 0,
    recenterPlanCount = 0,
  } = props;

  const telemetrySnapshot = telemetrySnapshotProp ?? liveTelemetry;
  const systemHealth = systemHealthProp ?? liveHealth;
  const previewRoverPoint =
    previewRoverPointProp ??
    (telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
      ? { north: telemetrySnapshot.pos_n as number, east: telemetrySnapshot.pos_e as number }
      : null);

  const [sprayModalOpen, setSprayModalOpen] = useState(false);
  const [sprayTab, setSprayTab] = useState<"continuous" | "dashed" | "point">("continuous");
  const [dashDistanceOn, setDashDistanceOn] = useState("0.3");
  const [dashDistanceOff, setDashDistanceOff] = useState("0.3");
  const [pointExecutionMode, setPointExecutionMode] = useState<"auto" | "manual">("auto");
  const [activeSprayMode, setActiveSprayMode] = useState<string>("continuous");
  const [activePointExecutionMode, setActivePointExecutionMode] = useState<string>("auto");
  const [isSprayMasterEnabled, setIsSprayMasterEnabled] = useState(false);
  const [isSprayMasterChanging, setIsSprayMasterChanging] = useState(false);

  const handleSetSprayMode = async () => {
    if (!apiBaseUrl || !selectedPathName) return;
    try {
      let res;
      if (sprayTab === "continuous") {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/path/${encodeURIComponent(selectedPathName)}/spray-mode/continuous`, { 
          method: "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({})
        });
        if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
        setActiveSprayMode("continuous");
      } else if (sprayTab === "dashed") {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/path/${encodeURIComponent(selectedPathName)}/spray-mode/dash`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            dash_on_distance_m: parseFloat(dashDistanceOn) || 0.3,
            dash_off_distance_m: parseFloat(dashDistanceOff) || 0.3,
            dash_phase_reset: "per_mark_region"
          })
        });
        if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
        setActiveSprayMode("dashed");
      } else if (sprayTab === "point") {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/path/${encodeURIComponent(selectedPathName)}/spray-mode/point`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            point_execution_mode: pointExecutionMode
          })
        });
        if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
        setActiveSprayMode("point");
        setActivePointExecutionMode(pointExecutionMode);
      }
      setSprayModalOpen(false);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to set spray mode.");
    }
  };

  const handleSprayMasterToggle = async () => {
    if (!apiBaseUrl) return;
    const nextEnable = !isSprayMasterEnabled;
    setIsSprayMasterChanging(true);
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/spray/${nextEnable ? "enable" : "disable"}`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to ${nextEnable ? "enable" : "disable"} master spray.`);
        return;
      }
      const data = await res.json();
      if (data.enabled !== undefined) {
        setIsSprayMasterEnabled(!!data.enabled);
      } else {
        setIsSprayMasterEnabled(nextEnable);
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend.");
    } finally {
      setIsSprayMasterChanging(false);
    }
  };

  const stagedStartGate = useMemo(
    () => evaluateStagedStartGate(stagedWorkflow, loadedPathInspection, stagedMissionId),
    [stagedWorkflow, loadedPathInspection, stagedMissionId]
  );
  const startBlocked = !stagedStartGate.allowed;
  const protectedResident = isProtectedMissionResident(loadedPathInspection);
  const runningMismatch = runningMissionMismatch(
    getLoadedMissionId(loadedPathInspection),
    loadedPathInspection?.running_mission_id
  );
  const selectedLine = lines.find((line) => line.id === selectedLineId) ?? null;
  const hasPlan = lines.length > 0;
  const hasSelectedLine = Boolean(selectedLine);
  const [safetyControlsEnabled, setSafetyControlsEnabled] = useState(false);
  const [compassExpanded, setCompassExpanded] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"line" | "plan" | null>(null);
  const [rightPanelMode, setRightPanelMode] = useState<"system" | "details">("system");
  const [isSprayingSet, setIsSprayingSet] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPointsModal, setShowPointsModal] = useState(false);
  const [joystickPanelOpen, setJoystickPanelOpen] = useState(false);
  const [crossTrackAlerted, setCrossTrackAlerted] = useState(false);

  const isVehicleArmed = telemetrySnapshot?.armed ?? systemHealth?.armed ?? false;
  const vehicleMode = (telemetrySnapshot?.mode ?? systemHealth?.mode ?? "MANUAL").toUpperCase();
  const hasJoystickLease = Boolean(virtualJoystick.leaseId);
  const stickEnabled =
    hasJoystickLease &&
    (virtualJoystick.state === "ACTIVE" || virtualJoystick.state === "HELD");
  const canAcquireJoystick =
    canAcquireJoystickForState({
      missionRunning,
      frontendState: virtualJoystick.state,
      backendJoystickActive: telemetrySnapshot?.joystick_active,
      controlOwner: telemetrySnapshot?.control_owner,
    });

  const handleOpenJoystickPanel = useCallback(() => {
    if (missionRunning) {
      Alert.alert("Mission Running", "Stop the mission before using manual drive.");
      return;
    }
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a rover backend first.");
      return;
    }
    setJoystickPanelOpen(true);
  }, [apiBaseUrl, missionRunning]);

  const handleCloseJoystickPanel = useCallback(() => {
    virtualJoystick.release();
    setJoystickPanelOpen(false);
  }, [virtualJoystick]);

  useEffect(() => {
    if (!missionRunning) {
      if (crossTrackAlerted) setCrossTrackAlerted(false);
      return;
    }
    const xtrack = telemetrySnapshot?.xtrack_m;
    if (xtrack != null) {
      if (Math.abs(xtrack) >= 0.05) {
        if (!crossTrackAlerted) {
          setCrossTrackAlerted(true);
          Alert.alert(
            "Cross Track Warning",
            `Cross-track error exceeded 5cm (currently ${Math.abs(xtrack).toFixed(2)} m).`,
            [
              { text: "Dismiss", style: "cancel" },
              {
                text: "Pause Mission",
                style: "destructive",
                onPress: onPausePlan,
              }
            ]
          );
        }
      } else {
        if (crossTrackAlerted) {
          setCrossTrackAlerted(false);
        }
      }
    }
  }, [telemetrySnapshot?.xtrack_m, missionRunning, crossTrackAlerted, onPausePlan]);

  const availableLayers = useMemo(() => {
    return {
      boundary: lines.some((l) => l.layer === "boundary"),
      marking: lines.some((l) => l.layer === "marking"),
      center: lines.some((l) => l.layer === "center"),
      transit: lines.some((l) => l.layer === "transit"),
      extension: lines.some((l) => l.layer === "extension"),
    };
  }, [lines]);

  const handleSetSpray = async () => {
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to save overrides to.");
      return;
    }
    setIsSprayingSet(true);
    try {
      const overridesMap = new Map<string, boolean>();
      lines
        .filter(l => l.entity && l.entity.entity_id && l.layer !== "extension" && l.layer !== "transit")
        .forEach(l => {
          overridesMap.set(l.entity!.entity_id, !!l.entity!.is_mark);
        });

      const overrides = Array.from(overridesMap.entries()).map(([entity_id, is_mark]) => ({
        entity_id,
        is_mark
      }));

      const res = await pathApi.saveEntityOverrides(apiBaseUrl, targetPath, overrides);
      if (res.ok) {
        onInvalidateWorkflow?.("spray");
        Alert.alert("Success", "Spray overrides saved.");
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to save spray overrides.");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Network error.");
    } finally {
      setIsSprayingSet(false);
    }
  };

  const pulse = (label: string, ok: boolean | undefined | null) => ({
    label,
    value: ok === undefined || ok === null ? "Unknown" : ok ? "OK" : "Alert",
    tone: ok ? "#16a34a" : ok === false ? "#dc2626" : "#64748b",
  });
  const openExportDialog = () => {
    if (!importedPlan || lines.length === 0) return;
    const baseName = importedPlan.fileName.replace(/\.[^/.]+$/, "") || "generated_plan";
    console.log(`[${new Date().toISOString()}] [UI] EXPORT_OPEN`, { fileName: baseName });
    setExportFileName(baseName);
    setExportDialogOpen(true);
  };

  const saveExportedPlan = async () => {
    if (!importedPlan || lines.length === 0) return;
    const cleanedName = exportFileName.trim().replace(/[\\/:*?"<>|]/g, "_") || "generated_plan";
    const fileContent = linesToDxf(lines, cleanedName);

    try {
      if (Platform.OS === "android") {
        console.log(`[${new Date().toISOString()}] [UI] EXPORT_SAVE_ANDROID`, { fileName: cleanedName });
        const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (permissions.granted) {
          const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
            permissions.directoryUri,
            cleanedName,
            "application/dxf"
          );
          await FileSystem.writeAsStringAsync(fileUri, fileContent, {
            encoding: FileSystem.EncodingType.UTF8,
          });
          setExportDialogOpen(false);
          Alert.alert("Exported", "DXF file saved successfully to your selected folder!");
        } else {
          Alert.alert("Permission Denied", "Cannot export without folder selection permissions.");
        }
      } else {
        const uri = `${FileSystem.documentDirectory ?? ""}${cleanedName}.dxf`;
        console.log(`[${new Date().toISOString()}] [UI] EXPORT_SAVE_FALLBACK`, { fileName: cleanedName, uri });
        await FileSystem.writeAsStringAsync(uri, fileContent, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        setExportDialogOpen(false);
        Alert.alert("Exported", `DXF saved to app storage:\n${uri}`);
      }
    } catch (error: any) {
      console.error("Export save error:", error);
      Alert.alert("Export Failed", error.message || "An unknown error occurred during save.");
    }
  };

  const missionActionButtonStyle = {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  const displayedSpeedMps =
    telemetrySnapshot?.measured_speed_m_s ??
    telemetrySnapshot?.speed_m_s;

  const { page: _page, renderSectionContent: _rsc, setImportedPlan: _sip, ...modernHomeProps } = props;

  return (
    <Suspense fallback={<ActivityIndicator />}>
    <ModernHomeUI
      {...modernHomeProps}
      setImportedPlan={props.setImportedPlan}
      currentPage={page}
      renderSectionContent={renderSectionContent}
      onFocusRover={onFocusRover}
      onFocusPlan={onFocusPlan}
      recenterRoverCount={recenterRoverCount}
      recenterPlanCount={recenterPlanCount}
      onResetNorth={props.onResetNorth}
      resetNorthCount={props.resetNorthCount}
      renderPlanPreview={page === "home" ? () => (
        <PlanPreview
          lines={props.missionVisibleLines ?? lines}
          mapSourceLines={props.missionVisibleMapSourceLines ?? mapSourceLines}
          autoOriginReference={autoOriginReference}
          mapGeometryFrame={mapGeometryFrame}
          autoOriginEnabled={autoOriginEnabled}
          geoOrigin={geoOrigin}
          stagedVerified={stagedWorkflow.staged === "verified"}
          visibility={layerVisibility}
          selectedLineId={selectedLineId}
          onSelectLine={onSelectLine}
          originShiftKey={originShiftKey}
          roverPosN={previewRoverPoint?.north ?? null}
          roverPosE={previewRoverPoint?.east ?? null}
          roverHeadingDeg={telemetrySnapshot?.heading_ned_deg ?? null}
          missionRunning={missionRunning}
          alignedRefPoints={alignedRefPoints}
          telemetryPosN={telemetrySnapshot?.pos_n ?? null}
          telemetryPosE={telemetrySnapshot?.pos_e ?? null}
          telemetryPosLat={telemetrySnapshot?.lat ?? null}
          telemetryPosLon={telemetrySnapshot?.lon ?? null}
          telemetryPosAlt={telemetrySnapshot?.alt ?? null}
          mapViewEnabled={false}
          showRefPointLabels={showRefPointLabels}
          activeRefPointLabelIndex={activeRefPointLabelIndex}
          onToggleRefPointLabel={setActiveRefPointLabelIndex}
          isVisualAlignmentMode={isVisualAlignmentMode}
          visualAlignmentItem={visualAlignmentItem}
          setVisualAlignmentItem={setVisualAlignmentItem}
          visualAlignmentAnchor={visualAlignmentAnchor}
          recenterRoverTrigger={recenterRoverCount}
          recenterPlanTrigger={recenterPlanCount}
          resetNorthTrigger={props.resetNorthCount}
          hideRefocusControls
        />
      ) : undefined}
    />
    </Suspense>
  );
}

function HeaderTelemetryPill({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <View style={headerTelemetryStyles.pill}>
      <View style={headerTelemetryStyles.iconWrap}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={headerTelemetryStyles.label}>{label}</Text>
        <Text style={[headerTelemetryStyles.value, { color: tone }]} numberOfLines={1}>
          {value}
        </Text>
      </View>

    </View>
  );
}

function CompassOverlay({
  telemetrySnapshot,
  expanded,
  onToggleExpanded,
}: {
  telemetrySnapshot: TelemetrySnapshot | null;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const hasPosition = telemetrySnapshot?.pos_n != null || telemetrySnapshot?.pos_e != null;

  return (
    <Pressable style={compassStyles.wrap} hitSlop={10} onPress={onToggleExpanded}>
      <View style={compassStyles.header}>
        <View style={compassStyles.dot} />
        <Text style={compassStyles.title}>{hasPosition ? "Position" : "Compass"}</Text>
      </View>
      <View style={compassStyles.body}>
        <View style={compassStyles.northTick} />
        <View style={compassStyles.centerRing}>
          <Text style={compassStyles.centerText}>
            {expanded ? "N/E" : hasPosition ? "Tap map" : "Tap"}
          </Text>
        </View>
      </View>
      <View style={compassStyles.values}>
        {expanded ? (
          <>
            <Text style={compassStyles.valueText}>
              North {telemetrySnapshot?.pos_n == null ? "--" : telemetrySnapshot.pos_n.toFixed(2)}
            </Text>
            <Text style={compassStyles.valueText}>
              East {telemetrySnapshot?.pos_e == null ? "--" : telemetrySnapshot.pos_e.toFixed(2)}
            </Text>
          </>
        ) : (
          <>
            <Text style={compassStyles.valueText}>
              N {telemetrySnapshot?.pos_n == null ? "--" : telemetrySnapshot.pos_n.toFixed(2)}
            </Text>
            <Text style={compassStyles.valueText}>
              E {telemetrySnapshot?.pos_e == null ? "--" : telemetrySnapshot.pos_e.toFixed(2)}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

function TelemetryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <View style={telemetryStatStyles.card}>
      <Text style={telemetryStatStyles.label}>{label}</Text>
      <Text style={[telemetryStatStyles.value, { color: tone }]}>{value}</Text>
    </View>
  );
}

function boolText(value: boolean | null | undefined) {
  if (value == null) return "n/a";
  return value ? "YES" : "NO";
}

function boolTone(value: boolean | null | undefined) {
  if (value == null) return "#94a3b8";
  return value ? "#22c55e" : "#ef4444";
}

function telemetryTone(value: number | null | undefined, lowGood: number, highGood: number) {
  if (value == null) return "#94a3b8";
  if (value >= highGood) return "#22c55e";
  if (value >= lowGood) return "#d97706";
  return "#ef4444";
}

const compassStyles = {
  wrap: {
    position: "absolute" as const,
    left: 12,
    bottom: 12,
    width: 160,
    borderRadius: 18,
    backgroundColor: "rgba(15,23,42,0.9)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.24)",
    padding: 12,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 99,
    backgroundColor: "#22c55e",
  },
  title: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800" as const,
    letterSpacing: 0.8,
    textTransform: "uppercase" as const,
  },
  body: {
    marginTop: 10,
    height: 58,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    position: "relative" as const,
  },
  northTick: {
    position: "absolute" as const,
    top: 7,
    width: 2,
    height: 12,
    borderRadius: 99,
    backgroundColor: "#38bdf8",
  },
  centerRing: {
    width: 36,
    height: 36,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  centerText: {
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: "700" as const,
  },
  values: {
    marginTop: 10,
    gap: 2,
  },
  valueText: {
    color: "#e2e8f0",
    fontSize: 11,
    fontWeight: "700" as const,
  },
} as const;

const telemetryStatStyles = {
  card: {
    minWidth: 92,
    flexGrow: 1,
    flexBasis: "30%" as const,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
  },
  value: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "800" as const,
    marginTop: 4,
  },
} as const;

const headerTelemetryStyles = {
  pill: {
    minWidth: 94,
    flex: 1,
    flexBasis: "48%" as const,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: "#e2e8f0",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  label: {
    color: "#64748b",
    fontSize: 9,
    fontWeight: "800" as const,
    letterSpacing: 0.7,
    textTransform: "uppercase" as const,
  },
  value: {
    color: "#0f172a",
    fontSize: 11,
    fontWeight: "800" as const,
    marginTop: 2,
  },
} as const;

const telemetryCtaStyles = {
  outer: {
    width: "100%",
    minHeight: 84,
    borderRadius: 18,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#d7e0ea",
    overflow: "hidden" as const,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  inner: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  leftRail: {
    width: 18,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 99,
    backgroundColor: "#0f172a",
  },
  line: {
    width: 2,
    height: 30,
    borderRadius: 999,
    backgroundColor: "#cbd5e1",
  },
  title: {
    color: "#0f172a",
    fontSize: 17,
    fontWeight: "900" as const,
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1,
  },
  chevronWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "#e2e8f0",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
} as const;

function LineDetailsDrawer({
  visible,
  onClose,
  selectedLine,
  hasPlan,
  layerVisibility,
  setLayerVisibility,
  showRefPointLabels,
  setShowRefPointLabels,
}: {
  visible: boolean;
  onClose: () => void;
  selectedLine: PlanLine | null;
  hasPlan: boolean;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  showRefPointLabels: boolean;
  setShowRefPointLabels: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.2)" }} onPress={onClose}>
        <View style={drawerStyles.sheet}>
          <Pressable style={drawerStyles.close} onPress={onClose}>
            <Text style={drawerStyles.closeText}>×</Text>
          </Pressable>
          <View style={{ marginTop: 4 }}>
            <Text style={{ color: "#64748b", fontSize: 9.5, fontWeight: "800", letterSpacing: 1.4, textTransform: "uppercase" }}>
              Rover Ops
            </Text>
            <Text style={{ color: "#fff", fontSize: 22, fontWeight: "900", marginTop: 2 }}>
              Line Details
            </Text>
          </View>
          <Text style={{ color: "#94a3b8", fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 4 }}>
                      Tap a line on the canvas, then inspect geometry and spray overrides here.
          </Text>

          <View style={drawerStyles.grid}>
            <StatCard
              label="Selection"
              value={{
                label: "Current line",
                value: selectedLine ? selectedLine.label : "No line selected",
                tone: selectedLine ? "#ffffff" : "#64748b",
              }}
            />
            <StatCard
              label="Status"
              value={{
                label: "Drawer state",
                value: selectedLine ? "Loaded" : "Empty",
                tone: selectedLine ? "#16a34a" : "#d97706",
              }}
            />
            <StatCard
              label="Layer"
              value={{
                label: "Visible layers",
                value: hasPlan ? "Available" : "No plan",
                tone: hasPlan ? "#ffffff" : "#64748b",
              }}
            />
            <StatCard
              label="Info"
              value={{
                label: "Line geometry",
                value: selectedLine ? `${getLineLengthM(selectedLine).toFixed(2)} m` : "n/a",
                tone: "#ffffff",
              }}
            />
          </View>

          {selectedLine ? (
            <>
              <View style={drawerStyles.stripRow}>
                <StripMetric label="Length" value={`${getLineLengthM(selectedLine).toFixed(2)} m`} tone="#ffffff" />
                <StripMetric label="Angle" value={`${lineAngleDeg(selectedLine).toFixed(2)}°`} tone="#ffffff" />
                <StripMetric label="Width" value={`${selectedLine.width.toFixed(2)} m`} tone="#ffffff" />
              </View>

              <View style={drawerStyles.section}>
                <SectionTitle title="Geometry" />
                <View style={{ borderRadius: 16, padding: 12, backgroundColor: "#111827", borderWidth: 1, borderColor: "rgba(148,163,184,0.16)", gap: 10 }}>
                  <ListRow left="Line label" right={selectedLine.label} tone="#fff" />
                  <ListRow left="Layer" right={selectedLine.layer} tone="#fff" />
                  <ListRow left="From" right={`(${selectedLine.from.x.toFixed(2)}, ${selectedLine.from.y.toFixed(2)})`} tone="#fff" />
                  <ListRow left="To" right={`(${selectedLine.to.x.toFixed(2)}, ${selectedLine.to.y.toFixed(2)})`} tone="#fff" />
                  <ListRow left="Point IDs" right={`${selectedLine.from.id} -> ${selectedLine.to.id}`} tone="#fff" />
                  <ListRow left="Line ID" right={selectedLine.id} tone="#fff" />
                </View>
              </View>

              <View style={drawerStyles.section}>
                <SectionTitle title="Visible layers" />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <CompactLayerToggle
                    label="Boundary"
                    value={layerVisibility.boundary}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, boundary: !prev.boundary }))}
                  />
                  <CompactLayerToggle
                    label="Marking"
                    value={layerVisibility.marking}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, marking: !prev.marking }))}
                  />
                  <CompactLayerToggle
                    label="Center"
                    value={layerVisibility.center}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, center: !prev.center }))}
                  />
                  <CompactLayerToggle
                    label="Transit"
                    value={layerVisibility.transit}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, transit: !prev.transit }))}
                  />
                  <CompactLayerToggle
                    label="Extension"
                    value={layerVisibility.extension}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, extension: !prev.extension }))}
                  />
                </View>
                <View style={{ marginTop: 12 }}>
                  <CompactLayerToggle
                    label="Show Reference Point Labels"
                    value={showRefPointLabels}
                    onToggle={() => setShowRefPointLabels(prev => !prev)}
                  />
                </View>
              </View>
            </>
          ) : (
            <View style={[drawerStyles.section, { marginTop: 18 }]}>
              <EmptyLine text="Tap a highlighted line in the canvas to see its details here." />
            </View>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

function StatCard({ label, value, fullWidth, light }: { label: string; value: { label: string; value: string; tone: string }; fullWidth?: boolean; light?: boolean }) {
  const accentColor = (value.tone === "#ffffff" || value.tone === "#fff" || value.tone === "#0f172a") ? "#3b82f6" : value.tone || "#475569";

  let cardBg = undefined;
  if (light) {
    if (value.tone === "#16a34a") {
      cardBg = "#f0fdf4"; // Very soft green tint
    } else if (value.tone === "#dc2626") {
      cardBg = "#fef2f2"; // Very soft red tint
    } else if (value.tone === "#d97706") {
      cardBg = "#fffbeb"; // Very soft amber tint
    }
  }

  return (
    <View style={[
      light ? drawerStyles.lightCard : drawerStyles.card,
      cardBg && { backgroundColor: cardBg },
      fullWidth && { width: "100%", flexBasis: "100%" },
      { borderLeftWidth: 3, borderLeftColor: accentColor }
    ]}>
      <Text style={light ? drawerStyles.lightCardLabel : drawerStyles.cardLabel}>{label}</Text>
      <Text style={[light ? drawerStyles.lightCardValue : drawerStyles.cardValue, { color: light ? "#0f172a" : "#ffffff" }]}>{value.value}</Text>
      <Text style={light ? drawerStyles.lightCardMeta : drawerStyles.cardMeta}>{value.label}</Text>
    </View>
  );
}

function StripMetric({ label, value, tone, icon, progressPct, light }: { label: string; value: string; tone: string; icon?: React.ReactNode; progressPct?: number; light?: boolean }) {
  const isLightText = tone === "#ffffff" || tone === "#fff";
  const displayTone = light && isLightText ? "#0f172a" : tone;
  return (
    <View style={[light ? drawerStyles.lightStrip : drawerStyles.strip, { position: "relative", overflow: "hidden" }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {icon}
        <Text style={light ? drawerStyles.lightStripLabel : drawerStyles.stripLabel}>{label}</Text>
      </View>
      <Text style={[light ? drawerStyles.lightStripValue : drawerStyles.stripValue, { color: displayTone }]}>{value}</Text>
      {progressPct !== undefined && (
        <View style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 4,
          backgroundColor: light ? "#e2e8f0" : "rgba(255,255,255,0.06)",
        }}>
          <View style={{
            width: `${Math.min(100, Math.max(0, progressPct))}%`,
            height: "100%",
            backgroundColor: displayTone,
          }} />
        </View>
      )}
    </View>
  );
}

function SectionTitle({ title, light }: { title: string; light?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, marginTop: 12 }}>
      <View style={{ width: 3, height: 10, backgroundColor: "#3b82f6", borderRadius: 1.5 }} />
      <Text style={light ? drawerStyles.lightSectionTitle : drawerStyles.sectionTitle}>{title}</Text>
      {light && (
        <View style={{ flex: 1, height: 1, backgroundColor: "#e2e8f0", marginLeft: 4 }} />
      )}
    </View>
  );
}

function MiniGrid({ items, light }: { items: Array<[string, string]>; light?: boolean }) {
  return (
    <View style={{
      borderRadius: 12,
      backgroundColor: light ? "#f8fafc" : "#111827",
      borderWidth: 1,
      borderColor: light ? "#e2e8f0" : "rgba(255, 255, 255, 0.05)",
      overflow: "hidden",
      marginTop: 4,
    }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {items.map(([label, value], index) => {
          const isRightColumn = index % 2 === 1;
          const isBottomRow = index >= items.length - 2;
          return (
            <View
              key={label}
              style={{
                width: "50%",
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRightWidth: isRightColumn ? 0 : 1,
                borderRightColor: light ? "#e2e8f0" : "rgba(255, 255, 255, 0.05)",
                borderBottomWidth: isBottomRow ? 0 : 1,
                borderBottomColor: light ? "#e2e8f0" : "rgba(255, 255, 255, 0.05)",
              }}
            >
              <Text style={{ color: "#64748b", fontSize: 8.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {label}
              </Text>
              <Text style={{ color: light ? "#0f172a" : "#ffffff", fontSize: 12, fontWeight: "800", marginTop: 2 }}>
                {value}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ListRow({ left, right, tone }: { left: string; right: string; tone: string }) {
  return (
    <View style={drawerStyles.row}>
      <Text style={drawerStyles.rowLeft} numberOfLines={1}>{left}</Text>
      <Text style={[drawerStyles.rowRight, { color: tone }]} numberOfLines={1}>{right}</Text>
    </View>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <Text style={drawerStyles.empty}>{text}</Text>;
}

const drawerStyles = {
  sheet: {
    position: "absolute" as const,
    right: 0,
    top: 0,
    bottom: 0,
    width: "42%",
    minWidth: 340,
    maxWidth: 520,
    backgroundColor: "#070c17",
    padding: 14,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(255,255,255,0.08)",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: -8, height: 0 },
    elevation: 8,
  },
  close: {
    alignSelf: "flex-end" as const,
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: "rgba(148,163,184,0.12)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginBottom: 8,
  },
  closeText: { color: "#fff", fontSize: 22, lineHeight: 22, marginTop: -2 },
  kicker: { color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.6, textTransform: "uppercase" as const },
  title: { color: "#fff", fontSize: 28, fontWeight: "900", marginTop: 6 },
  subtitle: { color: "#cbd5e1", fontSize: 13, lineHeight: 19, marginTop: 8, maxWidth: 380 },
  error: { color: "#fecaca", marginTop: 10, fontWeight: "700" as const },
  loading: { color: "#bfdbfe", marginTop: 10, fontWeight: "700" as const },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 10 },
  card: { flexGrow: 1, width: "48%", minWidth: 120, borderRadius: 12, backgroundColor: "#111827", borderWidth: 1, borderColor: "rgba(255,255,255,0.06)", paddingVertical: 10, paddingHorizontal: 12, flexDirection: "column" as const, overflow: "hidden" as const },
  cardLabel: { color: "#64748b", fontSize: 9, fontWeight: "800" as const, letterSpacing: 0.8, textTransform: "uppercase" as const },
  cardValue: { color: "#fff", fontSize: 15, fontWeight: "800" as const, marginTop: 4 },
  cardMeta: { color: "#94a3b8", fontSize: 9.5, marginTop: 2 },
  lightCard: { flexGrow: 1, width: "48%", minWidth: 120, borderRadius: 12, backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#e2e8f0", paddingVertical: 10, paddingHorizontal: 12, flexDirection: "column" as const, overflow: "hidden" as const },
  lightCardLabel: { color: "#64748b", fontSize: 9, fontWeight: "800" as const, letterSpacing: 0.8, textTransform: "uppercase" as const },
  lightCardValue: { color: "#0f172a", fontSize: 15, fontWeight: "800" as const, marginTop: 4 },
  lightCardMeta: { color: "#475569", fontSize: 9.5, marginTop: 2 },
  stripRow: { flexDirection: "row" as const, gap: 8, marginTop: 8 },
  strip: { flex: 1, borderRadius: 10, backgroundColor: "#111827", paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  stripLabel: { color: "#64748b", fontSize: 8.5, fontWeight: "800" as const, textTransform: "uppercase" as const },
  stripValue: { color: "#fff", fontSize: 12.5, fontWeight: "800" as const, marginTop: 3 },
  lightStrip: { flex: 1, borderRadius: 10, backgroundColor: "#f8fafc", paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: "#e2e8f0" },
  lightStripLabel: { color: "#64748b", fontSize: 8.5, fontWeight: "800" as const, textTransform: "uppercase" as const },
  lightStripValue: { color: "#0f172a", fontSize: 12.5, fontWeight: "800" as const, marginTop: 3 },
  section: { marginTop: 12 },
  sectionTitle: { color: "#94a3b8", fontSize: 10.5, fontWeight: "800" as const, letterSpacing: 1, textTransform: "uppercase" as const, marginBottom: 0 },
  lightSectionTitle: { color: "#0f172a", fontSize: 10.5, fontWeight: "800" as const, letterSpacing: 1, textTransform: "uppercase" as const, marginBottom: 0 },
  miniGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
  miniCell: { width: "31.5%", minWidth: 88, borderRadius: 10, backgroundColor: "#111827", padding: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  miniLabel: { color: "#64748b", fontSize: 9, fontWeight: "800" as const, textTransform: "uppercase" as const },
  miniValue: { color: "#fff", fontSize: 12, fontWeight: "800" as const, marginTop: 4 },
  list: { gap: 6 },
  row: { flexDirection: "row" as const, justifyContent: "space-between", gap: 10, borderRadius: 8, backgroundColor: "#111827", paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  rowLeft: { color: "#e2e8f0", fontSize: 11.5, flexShrink: 1, paddingRight: 8 },
  rowRight: { color: "#fff", fontSize: 11, fontWeight: "800" as const },
  empty: { color: "#94a3b8", fontSize: 12, paddingVertical: 8 },
} as const;

function CompactLayerToggle({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: value ? "#0f172a" : "#cbd5e1",
        backgroundColor: value ? "#e2e8f0" : "#f8fafc",
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: value ? "#0f172a" : "#94a3b8",
          backgroundColor: value ? "#0f172a" : "#fff",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>✓</Text> : null}
      </View>
      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function DetailStatCard({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexBasis: "48%",
        flexGrow: 1,
        minWidth: 120,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: "#d8e1eb",
        backgroundColor: "#ffffff",
        paddingHorizontal: 12,
        paddingVertical: 12,
        gap: 6,
      }}
    >
      <Text style={{ color: "#64748b", fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.8 }}>
        {label}
      </Text>
      <Text style={{ color: "#0f172a", fontSize: 15, fontWeight: "800" }}>
        {value}
      </Text>
    </View>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <Text
        style={{
          color: "#64748b",
          fontSize: 12,
          fontWeight: "800",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          width: 92,
          flexShrink: 0,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: "#0f172a",
          fontSize: 13,
          fontWeight: "700",
          flex: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
function SectionPages(props: {
  title: string;
  page: Page;
  telemetrySnapshot: TelemetrySnapshot | null;
  missionRunning: boolean;
  previewRoverPoint: { north: number; east: number } | null;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  mapSourceLines?: PlanLine[];
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  autoOriginEnabled?: boolean;
  geoOrigin?: [number, number] | null;
  autoOrigin?: boolean;
  onToggleAutoOrigin?: () => void;
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onBack: () => void;
  onSelectLine: (id: string | null, options?: { highlightLineIds?: string[] | null }) => void;
  /** Multi-line highlight set from Path Order Extension group selection. */
  highlightLineIds?: string[] | null;
  onGenerateTemplate: (name: string, lines: PlanLine[]) => void;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  onRunTemplate: (name: string, lines: PlanLine[]) => Promise<void>;
  missionFileReady: boolean;
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  toggleD: boolean;
  delayA: number;
  delayB: number;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  setToggleD: (v: boolean) => void;
  setDelayA: (v: number) => void;
  setDelayB: (v: number) => void;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  onLoadSelectedPath: (missionId?: string) => boolean | Promise<boolean>;
  missionActionBusy: boolean;
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onParsePlan?: () => Promise<void>;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  stagedWorkflow: StagedWorkflowState;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApi.AlignPathRequest | null>>;
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
  onAppPlannedStartSnapshot?: (snapshot: AppPlannedStartSnapshot) => void;
  onNav: (page: Page) => void;
  extensionsEnabled?: boolean;
  setExtensionsEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  extPre?: string;
  setExtPre?: React.Dispatch<React.SetStateAction<string>>;
  extAft?: string;
  setExtAft?: React.Dispatch<React.SetStateAction<string>>;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  setMapViewEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  showRefPointLabels: boolean;
  setShowRefPointLabels?: React.Dispatch<React.SetStateAction<boolean>>;
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
  multiPointPlacementPhase?: MultiPointPlacementPhase;
  onPlanAttached?: (info: { x: number; y: number; rotation: number; scale: number }) => void;
  onPlanEditResize?: () => void;
  onPlanResizeDone?: () => void;
  onFitToReferencePoints?: (refs: Array<{ lat: number; lon: number }>) => void;
  extractedCorners?: { dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null;
  setExtractedCorners?: React.Dispatch<React.SetStateAction<{ dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null>>;
  isFloatingEStopEnabled: boolean;
  setIsFloatingEStopEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  rtkCaster: string;
  setRtkCaster: React.Dispatch<React.SetStateAction<string>>;
  rtkPort: string;
  setRtkPort: React.Dispatch<React.SetStateAction<string>>;
  rtkMountPoint: string;
  setRtkMountPoint: React.Dispatch<React.SetStateAction<string>>;
  rtkUsername: string;
  setRtkUsername: React.Dispatch<React.SetStateAction<string>>;
  rtkPassword: string;
  setRtkPassword: React.Dispatch<React.SetStateAction<string>>;
  rtkRunning: boolean;
  rtkHealthy?: boolean;
  rtkMode?: string;
  rtkDefaultMode?: string;
  setRtkDefaultMode?: React.Dispatch<React.SetStateAction<string>>;
  rtkAutoConnect?: boolean;
  setRtkAutoConnect?: React.Dispatch<React.SetStateAction<boolean>>;
  stopRtk?: () => Promise<void>;
  onClearMission: () => Promise<void>;
  resetNorthCount?: number;
  recenterRoverCount?: number;
  recenterPlanCount?: number;
  visualAlignmentAnchor?: { originLat: number; originLon: number; originDxfNorth: number; originDxfEast: number } | null;
  setVisualAlignmentAnchor?: React.Dispatch<
    React.SetStateAction<{
      originLat: number;
      originLon: number;
      originDxfNorth: number;
      originDxfEast: number;
    } | null>
  >;
  previewFallbackGps?: { lat: number; lon: number } | null;
  localCsvPreview?: LocalPointCsvResult | null;
  localDxfMeta?: {
    fileName: string;
    isGeographic: boolean;
    warnings: string[];
  } | null;
  uploadedFiles?: UploadedFileEntry[];
  pendingDxfAlignment?: Record<string, PendingDxfAlignmentEntry>;
  setPendingDxfAlignment?: React.Dispatch<
    React.SetStateAction<Record<string, PendingDxfAlignmentEntry>>
  >;
  sharedOriginGps?: [number, number] | null;
  onBeginLocalImportBatch?: () => void;
  onAlignContextChange?: (ctx: { fileId: string | null; displayLines: PlanLine[] }) => void;
  onCommitDxfFileAlignment?: (
    fileId: string,
    alignedLines: PlanLine[],
    originGps: [number, number],
    summary: { scale: number | null; rotationDeg: number | null; rmseM: number | null }
  ) => void;
  onLocalCsvParsed?: (data: LocalPointCsvResult) => void;
  onLocalDxfParsed?: (data: LocalDxfResult) => void;
  onClearLocalCsv?: () => void;
  missionLayers?: MissionLayer[];
  controlModeActive?: boolean;
  canUseMissionControl?: boolean;
  pendingLayerAssignment?: { fileEntryId: string } | null;
  onPendingLayerAssignment?: React.Dispatch<
    React.SetStateAction<{ fileEntryId: string } | null>
  >;
  onAssignFileToNewLayer?: (fileEntryId: string) => void;
  onAssignFileToLayer?: (fileEntryId: string, layerId: string) => void;
  onUnassignFileFromLayer?: (fileEntryId: string) => void;
  missionVisibleLines?: PlanLine[];
  missionVisibleMapSourceLines?: PlanLine[];
  /** Anchor point selection (re-anchor a CSV/DXF plan's start) — Fields only, before Send. */
  anchorAvailable?: boolean;
  anchorSelectMode?: boolean;
  anchorTargetOptions?: AnchorTargetOption[];
  anchorTarget?: AnchorTarget | null;
  pendingAnchor?: AnchorCandidatePoint | null;
  anchorCandidates?: AnchorCandidatePoint[];
  anchorIsolatedLines?: PlanLine[];
  onAnchorPress?: () => void;
  onSelectAnchorTarget?: (target: AnchorTarget) => void;
  onAnchorCandidateSelect?: (candidate: AnchorCandidatePoint) => void;
  onConfirmAnchor?: () => void;
  /** Offset plan (whole-plan rigid shift toward an absolute compass bearing) — Fields Upload step. */
  offsetDistanceM?: number;
  offsetBearingDeg?: number;
  onOffsetDistanceChange?: (m: number) => void;
  onOffsetBearingChange?: (deg: number) => void;
  onApplyOffset?: () => void;
  offsetTargetOptions?: AnchorTargetOption[];
  offsetTarget?: AnchorTarget | null;
  onOffsetTargetChange?: (target: AnchorTarget) => void;
  offsetResetAvailable?: boolean;
  onResetOffset?: () => void;
  onOffsetDragStateChange?: (dragging: boolean) => void;
  offsetPreviewLines?: PlanLine[] | null;
}) {
  const { page, mapViewEnabled, setMapViewEnabled } = props;
  // Prefer App props; store fallback if a screen mounts without a parent snapshot.
  const liveTelemetry = useTelemetrySnapshot();
  const telemetrySnapshot = props.telemetrySnapshot ?? liveTelemetry;
  const previewRoverPoint =
    props.previewRoverPoint ??
    (telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
      ? { north: telemetrySnapshot.pos_n as number, east: telemetrySnapshot.pos_e as number }
      : null);

  return (
    <Suspense fallback={<ActivityIndicator />}>
    <View style={{ flex: 1, backgroundColor: "#09090b" }}>
      {page === "fields" ? (
        <FieldsPage
          {...props}
          previewRoverPoint={previewRoverPoint}
          onClearMission={props.onClearMission}
          mapHostedExternally={!!mapViewEnabled}
          renderPlanPreview={(previewProps) => (
            <PlanPreview
              {...previewProps}
              mapViewEnabled={mapViewEnabled}
              telemetryPosN={telemetrySnapshot?.pos_n ?? null}
              telemetryPosE={telemetrySnapshot?.pos_e ?? null}
              telemetryPosLat={telemetrySnapshot?.lat ?? null}
              telemetryPosLon={telemetrySnapshot?.lon ?? null}
              telemetryPosAlt={telemetrySnapshot?.alt ?? null}
              showRefPointLabels={props.showRefPointLabels}
              activeRefPointLabelIndex={props.activeRefPointLabelIndex}
              onToggleRefPointLabel={props.setActiveRefPointLabelIndex}
              isVisualAlignmentMode={props.isVisualAlignmentMode}
              visualAlignmentItem={props.visualAlignmentItem}
              setVisualAlignmentItem={props.setVisualAlignmentItem}
              visualAlignmentAnchor={props.visualAlignmentAnchor}
              previewFallbackGps={props.previewFallbackGps}
              isPlanEditingMode={props.isPlanEditingMode}
              multiPointPlacementPhase={props.multiPointPlacementPhase}
              onPlanAttached={props.onPlanAttached}
              resetNorthTrigger={props.resetNorthCount}
              recenterRoverTrigger={props.recenterRoverCount}
              recenterPlanTrigger={props.recenterPlanCount}
              hideRefocusControls
            />
          )}
        />
      ) : null}
      {page === "templates" ? (
        <TemplatesPage
          {...props}
          previewRoverPoint={previewRoverPoint}
          renderPlanPreview={(previewProps) => (
            <PlanPreview
              {...previewProps}
              mapMode="templates"
              alignedRefPoints={props.alignedRefPoints}
              telemetryPosN={telemetrySnapshot?.pos_n ?? null}
              telemetryPosE={telemetrySnapshot?.pos_e ?? null}
              telemetryPosLat={telemetrySnapshot?.lat ?? null}
              telemetryPosLon={telemetrySnapshot?.lon ?? null}
              telemetryPosAlt={telemetrySnapshot?.alt ?? null}
              mapViewEnabled={mapViewEnabled}
              showRefPointLabels={props.showRefPointLabels}
              activeRefPointLabelIndex={props.activeRefPointLabelIndex}
              onToggleRefPointLabel={props.setActiveRefPointLabelIndex}
              isVisualAlignmentMode={props.isVisualAlignmentMode}
              visualAlignmentItem={props.visualAlignmentItem}
              setVisualAlignmentItem={props.setVisualAlignmentItem}
              visualAlignmentAnchor={props.visualAlignmentAnchor}
              previewFallbackGps={props.previewFallbackGps}
              resetNorthTrigger={props.resetNorthCount}
              recenterRoverTrigger={props.recenterRoverCount}
              recenterPlanTrigger={props.recenterPlanCount}
              hideRefocusControls
            />
          )}
        />
      ) : null}
      {page === "swozi" ? <SwoziPage {...props} /> : null}
      {page === "status" ? <StatusPage /> : null}
      {page === "positioning" ? <PositioningPage {...props} /> : null}
      {page === "settings" ? <SettingsPage {...props} /> : null}
      {page === "howto" ? <HowToPage /> : null}
      {page === "about" ? <AboutPage /> : null}
    </View>
    </Suspense>
  );
}

function LayerRow({ label, value, onToggle }: { label: string; value: boolean; onToggle: () => void }) {
  return (
    <Pressable onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: "#555",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: value ? "#111" : "#fff",
        }}
      >
        {value ? <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>✓</Text> : null}
      </View>
      <Text style={{ color: "#333", fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}

function ActionBar({
  title,
  subtitle,
  icon,
  onPress,
  tone,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onPress: () => void;
  tone: "light" | "dark" | "teal";
}) {
  const palette =
    tone === "light"
      ? { bg: "#e2e8f0", fg: "#0f172a", sub: "#475569" }
      : tone === "teal"
        ? { bg: "#0b6b68", fg: "#fff", sub: "#cdeeed" }
        : { bg: "#0f172a", fg: "#fff", sub: "#cbd5e1" };
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        minWidth: 110,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 12,
        minHeight: 86,
        backgroundColor: palette.bg,
        justifyContent: "space-between",
        borderWidth: 1,
        borderColor: tone === "light" ? "#cbd5e1" : "rgba(255,255,255,0.12)",
      }}
    >
      <View style={{ width: 28, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: tone === "light" ? "#fff" : "rgba(255,255,255,0.12)" }}>
        {icon}
      </View>
      <View style={{ marginTop: 8 }}>
        <Text style={{ color: palette.fg, fontSize: 13, fontWeight: "800" }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: palette.sub, fontSize: 11, lineHeight: 15, marginTop: 3 }} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {label}
      </Text>
      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "700", flex: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

function ActionTile({
  title,
  subtitle,
  icon,
  onPress,
  accent,
  foreground,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onPress: () => void;
  accent: string;
  foreground: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        minWidth: 110,
        padding: 14,
        borderRadius: 18,
        backgroundColor: accent,
        borderWidth: 1,
        borderColor: "rgba(148,163,184,0.16)",
        justifyContent: "space-between",
        minHeight: 112,
      }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 12,
          backgroundColor: foreground === "#fff" ? "rgba(255,255,255,0.16)" : "rgba(15,23,42,0.08)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={{ color: foreground, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: foreground === "#fff" ? "#cbd5e1" : "#64748b", fontSize: 11, lineHeight: 15, marginTop: 4 }}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}
