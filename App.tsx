import "react-native-gesture-handler";
import "./global.css";

import { installRuntimeGuards, yieldToUi } from "./src/utils/runtimeGuards";
import {
  createPathPipelineGuard,
  exclusiveBusyMessage,
  type PathExclusiveKind,
} from "./src/utils/pathPipelineGuard";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";
import { LoopProbe } from "./src/components/LoopProbe";
import { loadMapPrefs, useSharedMapEnabled } from "./src/components/sharedMap/mapPrefs";

// Mapbox token is applied on first map mount (MapViewNative),
// not at app entry — keeps the connection screen off the Mapbox native JS path.

// Process-level guards: log fatals + unhandled rejections (common "app closed" cause).
installRuntimeGuards();

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Lazy-loaded: none of these are needed for the initial "connection" screen
// (see the `page` state default below), so deferring them shrinks the JS
// that must be parsed before first paint.
// Read the saved shared-map preference before the first map can mount (no remount flicker).
void loadMapPrefs();

/** Metro HMR can resolve a chunk with a missing default; fail loudly instead of undefined. */
function lazyDefault<T extends React.ComponentType<any>>(
  loader: () => Promise<{ default?: T } & Record<string, unknown>>,
  name: string
) {
  // One shared load per screen so preload() and the first render never fetch twice.
  let pending: Promise<{ default: T }> | null = null;
  const load = (): Promise<{ default: T }> => {
    if (!pending) {
      pending = (async () => {
        const mod = await loader();
        const Comp = (mod.default ?? mod[name]) as T | undefined;
        if (typeof Comp !== "function") {
          throw new Error(
            `[lazy] ${name} failed to load (got ${typeof Comp}). Restart Metro with --reset-cache.`
          );
        }
        return { default: Comp };
      })();
      pending.catch(() => {
        pending = null; // let a later render retry instead of caching the failure
      });
    }
    return pending;
  };
  const Component = lazy(load) as ReturnType<typeof lazy<T>> & { preload: () => Promise<unknown> };
  Component.preload = () => load().catch(() => undefined);
  return Component;
}

const ModernHomeUI = lazyDefault(() => import("./src/components/ModernHomeUI"), "ModernHomeUI");
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import * as Network from "expo-network";
import { SafeAreaInsetsContext, SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import type { Socket } from "socket.io-client";

import { PlacedItem } from "./src/components/BoundaryEditor";
import { useImmersiveMode } from "./src/hooks/useImmersiveMode";
import { useVirtualJoystick } from "./src/hooks/useVirtualJoystick";
import type { ImportedPlan, PlanLine } from "./src/types/plan";
import * as authApi from "./src/api/authApi";
import {
  clonePlanLinesForSnapshot,
  restageAppTrajectoryWithLiveEntry,
  type AppPlannedStartSnapshot,
} from "./src/utils/appPlannedStartSnapshot";
import { stagedPlanResultFromAdmitted } from "./src/utils/missionStaging";
import type { DashPattern } from "./src/utils/appPlannedMissionBuilder";
import {
  canSkipLiveEntryRestage,
  entryPoseDrifted,
  pickRoverPoseForEntry,
} from "./src/utils/liveEntryPose";
import {
  buildTrajectory,
  resolveRoverNedInMissionFrame,
} from "./src/utils/missionTrajectory";
import type { MissionLayer } from "./src/types/missionLayers";
import {
  applyMissionTerminalOutcome,
  createLayerForFile,
  assignFileToLayer,
  markLayersStarted,
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
import type { AnchorCandidatePoint } from "./src/components/mapViewTypes";
// Template generators live only in lazy TemplatesPage (not on the connection entry graph).

import type { Page, TelemetrySnapshot, LayerVisibility } from "./src/types/plan";

import { FloatingEStop } from "./src/components/FloatingEStop";
import { PlanPreview } from "./src/components/PlanPreview";
import { ConnectionView } from "./src/features/connection/ConnectionView";
import {
  clearTelemetryRuntime,
  useSystemHealth,
  useTelemetrySelector,
  useThrottledTelemetrySnapshot,
} from "./src/features/telemetry/telemetryStore";
import { getAppTransport } from "./src/services/appTransport";
import { roverBeaconListener, type BeaconRover } from "./src/services/roverBeacon";
import { loadLastRoverId } from "./src/api/prodStorage";
import { MissionStateEnum } from "./src/contract/prod/realtime";
import { getRoverEventsState, selectEstop, useRoverEvents } from "./src/features/telemetry/roverEventStore";
import { missionControls, missionIsActive, selectMission } from "./src/features/mission/missionLifecycle";
import { beginStartTap } from "./src/features/mission/startTap";
import {
  CommandFailedError,
  pauseMissionCommand,
  resumeMissionCommand,
  startMissionCommand,
  stopMissionCommand,
} from "./src/features/mission/missionCommands";
import {
  subscribeProdTelemetry,
  getProdTelemetryState,
  telemetryNow,
  evaluateMissionStartTelemetry,
  getMissionStartTelemetryPose,
} from "./src/features/telemetry/prodTelemetryStore";
import type {
  ActivityEntry,
  AppToast,
  DiscoveredRover,
  RTKStatus,
  SystemHealth,
  ToastTone,
} from "./src/types/appRuntime";
import { EMPTY_RTK_STATUS, normalizeRtkStatus } from "./src/api/rtkStatus";
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
  sanitizePlanLines,
} from "./src/utils/pathWorkflow";
import type {
  AlignmentResultState,
  MultiPointPlacementPhase,
  StagedPlanResultState,
  StagedWorkflowState,
  StagedWorkflowStatus,
  StagedWorkflowStep,
  VerifiedAlignment,
} from "./src/types/fieldsWorkflow";
import { INITIAL_STAGED_WORKFLOW_STATE, invalidateWorkflowFrom } from "./src/types/fieldsWorkflow";
import {
  computePlanBoundingBoxLegacy,
} from "./src/utils/curveGeometry";
import {
  buildVisualAlignmentRefPoints,
  computeLineBoundingBox,
  transformVisualDxfPoint,
} from "./src/utils/visualAlignment";
import { projectGpsToLocalMeters } from "./src/utils/geoProjection";
import {
  transformPlanLinesGeometry,
} from "./src/utils/planLineTransform";
import { computeShapeSnapPoints } from "./src/utils/planShapeSnapPoints";
import { computeBestSimilarityFit } from "./src/utils/similarityRefPointSnap";
import {
  anchorToAlignedRefPoints,
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
import { rebasePlanLinesToOrigin } from "./src/utils/planOriginRebase";
import {
  bakeTemplateInstance,
  buildTemplateFileEntry,
  createPlacedTemplateInstance,
  replacePrefixedLines,
  removePrefixedLines,
} from "./src/utils/templateInstance";
import type {
  PendingDxfAlignmentEntry,
  UploadedFileEntry,
  PlacedTemplateInstance,
} from "./src/types/uploadedFiles";
import {
  applyCsvOrderToPlanLines,
  chainMarkLinesByGeometry,
  defaultPathOrder,
  selectMarkPlanLines,
} from "./src/utils/missionPathOrder";
import { normalizeBearingDeg } from "./src/utils/planOffset";
import { reanchorTargetLines } from "./src/utils/anchorReorder";
import { computeOffsetResultLines } from "./src/utils/planOffsetApply";
import { enforceAlignmentScale } from "./src/utils/designAlignmentPolicy";
import type { MapGeometryFrame } from "./src/types/mapGeometry";
import {
  buildPlanManipulationAnchor,
  resolveMapGeometryFrame,
} from "./src/utils/mapGeometryProjection";

const BG = "#d9d9dc";
// No fixed rover addresses: rovers announce themselves by UDP beacon (src/services/roverBeacon.ts);
// the HTTP sweep below is only a fallback over the tablet's own subnet.
const LOCAL_WS_CANDIDATES: string[] = [];
const PRIORITY_BACKEND_IPS: string[] = [];

const DISCOVERY_REFRESH_MS = 5000;
const DISCOVERY_PORT = 8000;
const SUBNET_HOST_MIN = 1;
const SUBNET_HOST_MAX = 254;
// The HTTP sweep is only the fallback when no beacon is heard; keep it short so it never stalls the UI.
const SUBNET_SCAN_CONCURRENCY = 64;
const DEFAULT_ROVER_BACKEND = "";
function rootTelemetryKey(s: TelemetrySnapshot | null): string {
  if (!s) return "none";
  const fix = Number.isFinite(s.lat) && Number.isFinite(s.lon);
  const n = s.pos_n == null ? "x" : String(Math.round((s.pos_n as number) * 2));
  const e = s.pos_e == null ? "x" : String(Math.round((s.pos_e as number) * 2));
  return `${s.mission_state ?? ""}|${fix}|${n}|${e}`;
}
const selectRootTelemetry = (s: TelemetrySnapshot | null) => s;
const rootTelemetryEqual = (a: TelemetrySnapshot | null, b: TelemetrySnapshot | null) =>
  rootTelemetryKey(a) === rootTelemetryKey(b);

export default function App() {
  // Outer boundary: a render crash in any screen must not force-kill the APK.
  return (
    <AppErrorBoundary name="Root">
      <AppRoot />
    </AppErrorBoundary>
  );
}

function AppRoot() {
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
  const [wsStatus, setWsStatus] = useState<"idle" | "scanning" | "ready" | "connecting" | "connected" | "disconnected" | "unauthorized" | "error">("idle");
  const [wsError, setWsError] = useState<string>("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [operatorSession, setOperatorSession] = useState<authApi.OperatorSession | null>(null);
  const [operatorPassword, setOperatorPassword] = useState("");
  // True when the rover address on the connect screen has a saved operator token.
  const [hasSavedToken, setHasSavedToken] = useState(false);
  const [passwordChangeOpen, setPasswordChangeOpen] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);
  const [discoveredRovers, setDiscoveredRovers] = useState<DiscoveredRover[]>([]);
  // Rovers heard by UDP beacon (instant, any network, no fixed IP). Merged ahead of HTTP-sweep results.
  const [beaconRovers, setBeaconRovers] = useState<BeaconRover[]>([]);
  // After a manual Disconnect the app waits for the operator; otherwise it auto-connects to a known rover.
  const userDisconnectedRef = useRef(false);
  const autoConnectTriedRef = useRef<Set<string>>(new Set());
  const [backendPinned, setBackendPinned] = useState(false);
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
    return buildPlanManipulationAnchor({
      previewAnchor: null,
      alignedRefPoints,
      stagedVerified: stagedWorkflow.staged === "verified",
      geoOrigin: geoOriginDxf,
      existingAnchor: visualAlignmentAnchor,
      stableFallbackOrigin:
        latchedPreviewGps ??
        (Number.isFinite(telemetrySnapshot?.lat) && Number.isFinite(telemetrySnapshot?.lon)
          ? { lat: telemetrySnapshot!.lat as number, lon: telemetrySnapshot!.lon as number }
          : null),
      // Raw design lines — same coords the map projects under its fallback frame.
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

    // Local app-planned DXF: the mission sends NED vertices as-is about the GPS anchor.
    // The sticker is only a map preview — bake the real DXF path (placed geometry) into
    // `lines` before enabling Send. Never set origin_gps while leaving design-frame
    // geometry (that used to ship an untransformed DXF trajectory).
    const isLocalAppDxf =
      importedPlan?.fileType === "dxf" || !!importedPlan?.fileName?.toLowerCase().endsWith(".dxf");

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
        // NED about the latched map origin (= the mission anchor origin_gps).
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
        `[Align DXF] Local DXF placement baked into lines; origin_gps=[${baseLat}, ${baseLon}] ready for the mission upload`
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
  // Throttled (~4 Hz, instant on armed/mode/mission/link/staleness changes): this component
  // is thousands of lines of render + hundreds of child props, so re-rendering it at packet
  // rate starved the JS thread and made nav taps lag. The map marker reads the raw store
  // itself (MapViewNative), and start/safety gating reads store getters, not this value.
  // The root re-renders only when what IT uses changes: mission state, "has a GPS fix", and the
  // rover position at 0.5 m. Home / Fields / the map subscribe to live telemetry themselves; a
  // root subscription at packet rate re-rendered the whole tree 8-10x/s and starved the JS
  // thread (socket ping timeouts, stale pose). Exact values are read with getTelemetrySnapshot().
  const telemetrySnapshot = useTelemetrySelector(selectRootTelemetry, rootTelemetryEqual);
  const systemHealth = useSystemHealth();
  // Latch first finite GPS after telemetry exists — must not run above this declaration.
  useEffect(() => {
    if (latchedPreviewGps) return;
    const lat = telemetrySnapshot?.lat;
    const lon = telemetrySnapshot?.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      setLatchedPreviewGps({ lat: lat as number, lon: lon as number });
    }
  }, [telemetrySnapshot?.lat, telemetrySnapshot?.lon, latchedPreviewGps]);

  const [activityFeed] = useState<ActivityEntry[]>([]);
  const [discoveryFeed] = useState<DiscoveredRover[]>([]);
  const [missionActionBusy, setMissionActionBusy] = useState(false);
  /** Prevents double-tap Start / re-entrant restage while a previous Start is in flight. */
  const startInFlightRef = useRef(false);
  /** Shared preview/send/start/load generation + exclusive lock. */
  const pathPipelineRef = useRef(createPathPipelineGuard());
  const [missionPanelOpenToken, setMissionPanelOpenToken] = useState(0);
  // Mission status comes from `mission_state` rover events only: never from a command's answer
  // and never from a poll. Unknown (gateway down, no socket, stale) is not "idle".
  const roverEvents = useRoverEvents();
  const missionView = useMemo(() => selectMission(roverEvents), [roverEvents]);
  const missionViewRef = useRef(missionView);
  missionViewRef.current = missionView;
  /** An execution holds the vehicle: LOADING ... RUNNING ... PAUSED. */
  const missionRunning = missionIsActive(missionView);
  const isPaused = missionView.known && missionView.run.state === MissionStateEnum.PAUSED;
  const [toast, setToast] = useState<AppToast | null>(null);
  const [rtkConnecting, setRtkConnecting] = useState(false);
  const [rtkStatus, setRtkStatus] = useState<RTKStatus>(EMPTY_RTK_STATUS);
  const [isFloatingEStopEnabled, setIsFloatingEStopEnabled] = useState(false);
  const [toggleA, setToggleA] = useState(false);
  const [toggleB, setToggleB] = useState(false);
  const [toggleC, setToggleC] = useState(true);
  const [toggleD, setToggleD] = useState(false);
  const [delayA, setDelayA] = useState(0.1);
  const [delayB, setDelayB] = useState(0.1);
  const [stagedWorkflow, setStagedWorkflow] = useState<StagedWorkflowState>(INITIAL_STAGED_WORKFLOW_STATE);
  const [alignmentResult, setAlignmentResult] = useState<AlignmentResultState | null>(null);
  // Always-current Fix Alignment params for async rehydrates of design-frame geometry.
  const alignmentResultRef = useRef<AlignmentResultState | null>(null);
  alignmentResultRef.current = alignmentResult;
  const [verifiedAlignmentRequest, setVerifiedAlignmentRequest] = useState<VerifiedAlignment | null>(null);
  /** WGS84 origin of a georeferenced DXF already in the plan (it needs no alignment). */
  const [geoOriginDxf, setGeoOriginDxf] = useState<[number, number] | null>(null);
  const [stagedPlanResult, setStagedPlanResult] = useState<StagedPlanResultState | null>(null);
  const [stagedMissionId, setStagedMissionId] = useState<string | null>(null);
  /**
   * Source geometry from last successful app-planned Send. Start Mission restages
   * from this + live rover pose so entry is always X→A from current position.
   */
  const [appPlannedStartSnapshot, setAppPlannedStartSnapshot] =
    useState<AppPlannedStartSnapshot | null>(null);
  /** Dashed spray pattern for the next Send (null = continuous lines). */
  const [dashPattern, setDashPattern] = useState<DashPattern | null>(null);
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
  const [placedTemplates, setPlacedTemplates] = useState<PlacedTemplateInstance[]>([]);
  const placedTemplatesRef = useRef<PlacedTemplateInstance[]>([]);
  placedTemplatesRef.current = placedTemplates;
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
  /** Bumped when an anchor is confirmed so the Path Order step re-seeds its order from the re-chained plan. */
  const [anchorAppliedToken, setAnchorAppliedToken] = useState(0);
  /** Offset plan: compass shift, or inner/outer buffer of the marks. */
  const [offsetMode, setOffsetMode] = useState<"shift" | "buffer">("shift");
  const [offsetBufferDirection, setOffsetBufferDirection] = useState<"out" | "in">("out");
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

  const prevMissionStateRef = useRef<string | null>(null);

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

  /** A mission holds the vehicle: the plan on the map is the path being driven and is not edited meanwhile. */
  const planLocked = missionRunning;
  const [mapViewEnabled, setMapViewEnabled] = useState(true);
  const [resetNorthCount, setResetNorthCount] = useState(0);
  // Shared across every page (Home, Fields, Templates) so the top toolbar's
  // Plan/Rover focus buttons drive whichever map instance is currently mounted,
  // instead of each page owning its own disconnected counter pair.
  const [recenterRoverCount, setRecenterRoverCount] = useState(0);
  const [recenterPlanCount, setRecenterPlanCount] = useState(0);

  const displayedLines = useMemo(() => sanitizePlanLines(lines), [lines]);

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
        geoOrigin: geoOriginDxf,
      }),
    [alignedRefPoints, stagedWorkflow.staged, geoOriginDxf]
  );

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
  const socketRef = useRef<Socket | null>(null);
  const invalidSessionLockRef = useRef(false);
  const wsStatusRef = useRef(wsStatus);
  socketRef.current = socket;

  const isOffline = wsError.startsWith("Offline");
  const apiBaseUrl = selectedWs || manualHost;

  useEffect(() => {
    authApi.installAuthenticatedFetch();
    void authApi.loadStoredSession().then((stored) => {
      if (stored) setOperatorSession(stored);
    });
  }, []);

  const handleInvalidSession = useCallback(() => {
    if (invalidSessionLockRef.current) return;
    invalidSessionLockRef.current = true;
    try {
      setOperatorSession(null);
      setOperatorPassword("");
      void authApi.saveStoredSession(null);
      try {
        socketRef.current?.disconnect();
      } catch {
        // Socket may already be dead after a rover restart.
      }
      setSocket(null);
      setWsStatus("idle");
      setPage("connection");
      setWsError("The rover rejected the token (401). Paste a new token for this rover.");
      clearTelemetryRuntime();
    } catch (err) {
      console.error("[AUTH] invalid session handler failed:", err);
    }
  }, []);

  useEffect(() => {
    if (operatorSession?.token) invalidSessionLockRef.current = false;
  }, [operatorSession?.token]);

  useEffect(() => {
    // The production rover token lives in AppTransportService; the prototype session is a fallback.
    // Without this, a change of apiBaseUrl after connect reset the runtime token to null and every
    // authenticated fetch (e.g. NTRIP profiles) lost its Bearer header.
    authApi.setAuthRuntime({
      token: operatorSession?.token ?? getAppTransport().getActiveToken() ?? null,
      baseUrl: apiBaseUrl || null,
      onInvalidSession: handleInvalidSession,
    });
  }, [apiBaseUrl, handleInvalidSession, operatorSession?.token, wsStatus]);

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

  const beginPathExclusive = useCallback((kind: PathExclusiveKind): boolean => {
    const acquired = pathPipelineRef.current.tryExclusive(kind);
    if (!acquired.ok) {
      showToast("Busy", exclusiveBusyMessage(acquired.holder), "info");
      return false;
    }
    setMissionActionBusy(true);
    return true;
  }, [showToast]);

  const endPathExclusive = useCallback((kind: PathExclusiveKind) => {
    pathPipelineRef.current.releaseExclusive(kind);
    if (!pathPipelineRef.current.isExclusive()) {
      setMissionActionBusy(false);
    }
  }, []);

  /**
   * Send stored the mission on the rover and verified what it stored. There is no load step: go to the
   * mission screen, where Start does everything (entry leg, start, then the rover's own lifecycle).
   */
  const handleMissionStored = useCallback(
    (missionId: string) => {
      setStagedMissionId(missionId);
      setMissionPanelOpenToken((token) => token + 1);
      setPage("home");
      logAction("MISSION_STORED", { missionId });
      showToast("Mission sent", "Stored on the rover. Press Start Mission when ready.", "success");
    },
    [logAction, showToast]
  );

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

  const invalidateStagedWorkflowFrom = useCallback((step: StagedWorkflowStep) => {
    setStagedWorkflow((prev) => invalidateWorkflowFrom(prev, step));

    const localBatchActive = uploadedFilesRef.current.length > 0;

    if (step === "alignment") {
      // Working Align UI only — never drop sharedOriginGps or committed multi-file lines.
      setAlignmentResult(null);
      if (!localBatchActive || sharedOriginGpsRef.current == null) {
        setVerifiedAlignmentRequest(null);
      }
    }
    if (step === "alignment" || step === "spray" || step === "staged") {
      setStagedPlanResult(null);
      setStagedMissionId(null);
      // Geometry / order change invalidates frozen Send snapshot (must re-Send).
      setAppPlannedStartSnapshot(null);
      // Same reasoning: Offset's reset baseline is now stale too (e.g. Fix Alignment
      // baked a transform into `lines` after the baseline was captured).
      setPreOffsetSnapshot(null);
    }
    // Multi-file batch: keep parse metadata and geometry; only demote the stored (sent) mission.
    if (!localBatchActive) {
      setLocalCsvPreview(null);
      localCsvParsesRef.current = [];
      setLocalDxfMeta(null);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // A mission that ends while we watch (COMPLETED / ABORTED / ERROR after an active state) settles the
  // layer bookkeeping. A first state seen after a (re)connect is never read as an outcome.
  const missionStateName = telemetrySnapshot?.mission_state ?? null;
  useEffect(() => {
    const previous = prevMissionStateRef.current;
    prevMissionStateRef.current = missionStateName;
    if (previous === missionStateName) return;
    const terminal = outcomeFromMissionStateTransition(previous, missionStateName);
    if (!terminal) return;
    if (runningLayerIdsRef.current.length > 0) {
      const ids = [...runningLayerIdsRef.current];
      setMissionLayers((prev) => applyMissionTerminalOutcome(prev, ids, terminal));
      runningLayerIdsRef.current = [];
      runningMissionIdRef.current = null;
    }
    if (terminal === "completed") {
      Alert.alert("Mission completed", "The rover has finished the mission.");
    }
  }, [missionStateName]);

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
    if (planLocked) {
      Alert.alert("Mission active", "Editing the plan is blocked while a mission is active. Stop the mission first.");
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
    if (planLocked) {
      Alert.alert("Mission active", "Deleting the plan is blocked while a mission is active. Stop the mission first.");
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
    setPlacedTemplates([]);
    placedTemplatesRef.current = [];
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
    setGeoOriginDxf(null);
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

  // Listen to AppTransport connection status and honest staleness
  useEffect(() => {
    const transport = getAppTransport();
    const unsub = transport.subscribeStatus((status, detail) => {
      if (status === "connected") {
        setWsStatus("connected");
      } else if (status === "disconnected") {
        setWsStatus("disconnected");
      } else if (status === "unauthorized") {
        setWsStatus("unauthorized");
        setWsError("Session expired or token rejected (401). Paste valid rover token.");
        setPage("connection");
      } else if (status === "error") {
        setWsStatus("ready");
        if (detail) setWsError(detail);
      }
    });
    return unsub;
  }, []);

  // Warm every lazy screen shortly after launch so a nav tap never waits on a pending
  // Suspense boundary (in a dev build that wait is a Metro fetch — seconds).
  useEffect(() => {
    const t = setTimeout(() => {
      void ModernHomeUI.preload();
      void FieldsPage.preload();
      void TemplatesPage.preload();
      void SwoziPage.preload(); // SecondaryPages module — shared by the other secondary pages
      // Settings is a second-level lazy chunk inside SecondaryPages; warm it too, otherwise
      // the first visit shows a spinner while it loads.
      void import("./src/screens/SecondaryPages")
        .then((m) => m.preloadSettingsPage())
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  // Show whether the rover on the connect screen already has a saved token.
  useEffect(() => {
    const target = selectedWs || manualHost;
    let cancelled = false;
    if (!target) {
      setHasSavedToken(false);
      return;
    }
    void getAppTransport()
      .getSavedTokenFor(target, roverBeaconListener.findByHost(target)?.roverId ?? null)
      .then((token) => {
        if (!cancelled) setHasSavedToken(Boolean(token));
      })
      .catch(() => {
        if (!cancelled) setHasSavedToken(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWs, manualHost, beaconRovers]);

  // Listen for rover beacons for the whole app lifetime (cheap: one UDP socket).
  useEffect(() => roverBeaconListener.subscribe(setBeaconRovers), []);

  // Auto-connect like the 4WD app: when a rover with a saved token is heard (last-used rover first),
  // connect with that token. Each rover is tried once per screen visit; a manual Disconnect pauses it.
  useEffect(() => {
    if (page !== "connection" || userDisconnectedRef.current || beaconRovers.length === 0) return;
    if (connectInFlightRef.current || wsStatusRef.current === "connecting" || wsStatusRef.current === "connected") return;
    let cancelled = false;
    void (async () => {
      const lastId = await loadLastRoverId();
      const ordered = [...beaconRovers].sort((a, b) => Number(b.roverId === lastId) - Number(a.roverId === lastId));
      for (const rover of ordered) {
        if (cancelled || autoConnectTriedRef.current.has(rover.roverId)) continue;
        const token = await getAppTransport().getSavedTokenFor(rover.host, rover.roverId);
        if (!token || cancelled) continue;
        autoConnectTriedRef.current.add(rover.roverId);
        logAction("AUTO_CONNECT", { roverId: rover.roverId, host: rover.host });
        setSelectedWs(rover.host);
        setManualHost(rover.host);
        await connectSelectedWebsocket(rover.host, rover.roverId);
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beaconRovers, page]);

  // Load saved credentials on startup
  useEffect(() => {
    void (async () => {
      const creds = await getAppTransport().loadSavedCredentials();
      if (creds.host) {
        setManualHost(creds.host);
      }
    })();
  }, []);

  const connectSelectedWebsocket = async (targetOverride?: string, roverIdOverride?: string | null) => {
    const target = targetOverride || selectedWs || manualHost;
    if (!target) {
      setWsError("No rover selected yet. Wait for it to appear below, or type its address.");
      return;
    }
    const roverId = roverIdOverride ?? roverBeaconListener.findByHost(target)?.roverId ?? null;
    if (connectInFlightRef.current) {
      logAction("WS_CONNECT_SKIPPED", { reason: "already_connecting" });
      return;
    }

    const typedToken = operatorPassword.trim();
    const savedToken = await getAppTransport().getSavedTokenFor(target, roverId);
    const tokenToUse = typedToken || savedToken || "";
    if (!tokenToUse) {
      setWsError("Enter or paste the Operator Bearer Token to connect.");
      return;
    }

    connectInFlightRef.current = true;
    discoveryScanGenerationRef.current += 1;
    logAction("WS_CONNECT", { selectedWs: target });
    setWsStatus("connecting");
    setWsError("");

    try {
      const transport = getAppTransport();
      await transport.connect(target, tokenToUse);

      setOperatorPassword("");
      setHasSavedToken(true);
      userDisconnectedRef.current = false;
      autoConnectTriedRef.current.clear();
      setSelectedWs(target);
      setManualHost(target);
      setBackendPinned(true);
      setWsStatus("connected");

      // Defer home navigation one tick so connect UI settles before Mapbox mounts
      requestAnimationFrame(() => {
        setPage("home");
        setMenuOpen(true);
      });
      logAction("WS_CONNECTED", { apiBaseUrl: target });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuth =
        message.includes("401") ||
        message.toLowerCase().includes("unauthoriz") ||
        message.toLowerCase().includes("forbidden");
      setWsStatus(isAuth ? "unauthorized" : "ready");
      setWsError(
        isAuth
          ? typedToken
            ? "Invalid token: unauthorized (401). Paste a valid token for this rover."
            : "The saved token for this rover was rejected (401). Paste a new token for this rover."
          : message
      );
      logAction("WS_CONNECT_FAILED", { error: message });
    } finally {
      connectInFlightRef.current = false;
    }
  };

  const disconnectToConnectionScreen = () => {
    logAction("WS_DISCONNECT");
    userDisconnectedRef.current = true;
    getAppTransport().disconnect();
    setSocket(null);
    setWsStatus("idle");
    setBackendPinned(false);
    setPage("connection");
    setMenuOpen(true);
    clearTelemetryRuntime();
  };

  const forgetSavedTokenForTarget = async () => {
    const target = selectedWs || manualHost;
    if (!target) return;
    const roverId = roverBeaconListener.findByHost(target)?.roverId ?? null;
    logAction("FORGET_TOKEN", { target, roverId });
    await getAppTransport().forgetSavedToken(target, roverId);
    setOperatorPassword("");
    setHasSavedToken(false);
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
      manualHostReachable = await probeHostReachable(knownTarget, 800, 0);
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
    setStagedPlanResult(null);
    setStagedMissionId(null);
  }

  /**
   * Called by Upload before a non-append local pick so the batch starts clean.
   * Keeps virtual_boundary strokes.
   */
  function handleBeginLocalImportBatch() {
    setUploadedFiles([]);
    uploadedFilesRef.current = [];
    setPlacedTemplates([]);
    placedTemplatesRef.current = [];
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
    setGeoOriginDxf(null);
    setLines((prev) => prev.filter((l) => l.layer === "virtual_boundary"));
    setSelectedLineId(null);
    setAlignedRefPoints([]);
    setVerifiedAlignmentRequest(null);
    setAlignmentResult(null);
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);
    demoteWorkflowAfterBatchChange(true);
  }

  function handlePlaceTemplate(args: {
    kind: "sign" | "characters";
    fileName: string;
    sourceLines: PlanLine[];
    north: number;
    east: number;
  }) {
    const used = usedPrefixesFromUploaded(uploadedFilesRef.current);
    const prefix = allocateLineIdPrefix(args.fileName, used);
    const instance = createPlacedTemplateInstance({
      id: `${prefix}-tpl`,
      fileName: args.fileName,
      kind: args.kind,
      lineIdPrefix: prefix,
      sourceLines: args.sourceLines,
      north: args.north,
      east: args.east,
    });
    const baked = bakeTemplateInstance(instance);
    if (baked.length === 0) {
      Alert.alert("Empty template", "That template has no drawable strokes.");
      return;
    }
    setLines((prev) => sanitizePlanLines(replacePrefixedLines(prev, prefix, baked)));
    const entry = buildTemplateFileEntry(instance);
    const nextFiles = [...uploadedFilesRef.current, entry];
    uploadedFilesRef.current = nextFiles;
    setUploadedFiles(nextFiles);
    placedTemplatesRef.current = [...placedTemplatesRef.current, instance];
    setPlacedTemplates(placedTemplatesRef.current);
    setSelectedLineId(baked[0]?.id ?? null);
    demoteWorkflowAfterBatchChange(nextFiles.some((f) => f.status === "needs_alignment"));
    return instance.id;
  }

  function handleUpdateTemplateInstance(
    id: string,
    patch: Partial<Pick<PlacedTemplateInstance, "north" | "east" | "rotationDeg" | "scale">>
  ) {
    const current = placedTemplatesRef.current.find((item) => item.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    const baked = bakeTemplateInstance(next);
    if (baked.length === 0) return;
    setLines((prev) => sanitizePlanLines(replacePrefixedLines(prev, next.lineIdPrefix, baked)));
    placedTemplatesRef.current = placedTemplatesRef.current.map((item) =>
      item.id === id ? next : item
    );
    setPlacedTemplates(placedTemplatesRef.current);
  }

  function handleRemoveUploadedFile(id: string) {
    const entry = uploadedFilesRef.current.find((f) => f.id === id);
    if (!entry) return;

    const remaining = uploadedFilesRef.current.filter((f) => f.id !== id);
    if (remaining.length === 0) {
      handleClearLocalCsv();
      return;
    }

    if (entry.kind === "template") {
      handleRemoveTemplate(id);
      return;
    }

    setLines((prev) => sanitizePlanLines(removePrefixedLines(prev, entry.lineIdPrefix)));
    uploadedFilesRef.current = remaining;
    setUploadedFiles(remaining);
    setMissionLayers((prev) => unassignFile(prev, id));
    setPendingLayerAssignment((prev) => (prev?.fileEntryId === id ? null : prev));
    setPendingDxfAlignment((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

    if (entry.kind === "csv") {
      const idx = localCsvParsesRef.current.findIndex((p) => p.fileName === entry.fileName);
      if (idx >= 0) {
        localCsvParsesRef.current = localCsvParsesRef.current.filter((_, i) => i !== idx);
      }
      const parses = localCsvParsesRef.current;
      if (parses.length === 0) {
        setLocalCsvPreview(null);
      } else if (parses.length === 1) {
        setLocalCsvPreview(parses[0]);
      } else {
        try {
          setLocalCsvPreview(mergeLocalPointCsvResults(parses));
        } catch {
          setLocalCsvPreview(parses[parses.length - 1] ?? null);
        }
      }
    }

    if (!remaining.some((f) => f.kind === "dxf")) {
      setLocalDxfMeta(null);
    }

    setSelectedLineId((prev) =>
      prev &&
      (prev.startsWith(`${entry.lineIdPrefix}__`) || prev.startsWith(`${entry.lineIdPrefix}-`))
        ? null
        : prev
    );

    const stillNeedsAlign = remaining.some((f) => f.status === "needs_alignment");
    demoteWorkflowAfterBatchChange(stillNeedsAlign);
    if (!stillNeedsAlign) {
      setStagedWorkflow((prev) => ({ ...prev, alignment: "verified" }));
    }
  }

  function handleRemoveTemplate(id: string) {
    const current = placedTemplatesRef.current.find((item) => item.id === id);
    if (!current) return;
    setLines((prev) => sanitizePlanLines(removePrefixedLines(prev, current.lineIdPrefix)));
    placedTemplatesRef.current = placedTemplatesRef.current.filter((item) => item.id !== id);
    setPlacedTemplates(placedTemplatesRef.current);
    const nextFiles = uploadedFilesRef.current.filter((f) => f.id !== id);
    uploadedFilesRef.current = nextFiles;
    setUploadedFiles(nextFiles);
    setMissionLayers((prev) => unassignFile(prev, id));
    setSelectedLineId((prev) =>
      prev &&
      (prev.startsWith(`${current.lineIdPrefix}__`) ||
        prev.startsWith(`${current.lineIdPrefix}-`))
        ? null
        : prev
    );
  }

  /**
   * Local CSV (Select File) — parse result already computed on-device.
   * Appends into the multi-file batch (or starts one). Upload / plan-and-stage
   * / load live in CsvStageAndLoadPanel.
   */
  function handleLocalCsvParsed(data: LocalPointCsvResult) {
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);
    setVisualAlignmentAnchor(null);

    // Local-NED has no GPS anchor — cannot join a GPS-anchored multi-file mission.
    if (data.kind !== "gps" || !data.anchor) {
      if (uploadedFilesRef.current.length > 0 || sharedOriginGpsRef.current != null) {
        Alert.alert(
          "Local NED CSV",
          "Headerless / local-metre CSVs cannot be combined with GPS-anchored files. Import this CSV alone, or use a survey CSV with lat/lon."
        );
        return;
      }
      // Standalone NED: replace-style single file.
      localCsvParsesRef.current = [data];
      setLocalCsvPreview(data);
      setLocalDxfMeta(null);
      const previewLines = chainMarkLinesByGeometry(
        localCsvPointsToPlanLines(data.points, data.anchor)
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
      localCsvPointsToPlanLines(data.points, data.anchor)
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
   * Local DXF parse. Geo-DXF appends (auto-verified);
   * metric DXF is held in pendingDxfAlignment until Fix Alignment.
   */
  function handleLocalDxfParsed(data: LocalDxfResult) {
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);

    // Blocking warnings (assumed unit scale) travel with the ordinary ones so the
    // send-readiness gate sees them as critical parse warnings and demands an
    // acknowledgement before the mission can be staged or loaded. A batch keeps the
    // warnings of every file, not only the last one parsed.
    const fileWarnings = [...data.blockingWarnings, ...data.warnings].map(
      (w) => `${data.fileName}: ${w}`
    );
    setLocalDxfMeta((prev) => ({
      fileName: data.fileName,
      isGeographic: !!data.isGeographic,
      warnings: Array.from(new Set([...(prev?.warnings ?? []), ...fileWarnings])),
    }));

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
    setLocalCsvPreview(null);
    localCsvParsesRef.current = [];
    setLocalDxfMeta(null);
    setGeoOriginDxf(null);
    setUploadedFiles([]);
    uploadedFilesRef.current = [];
    setPlacedTemplates([]);
    placedTemplatesRef.current = [];
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
    if (planLocked) {
      Alert.alert("Mission active", "Anchor selection is blocked while a mission is active. Stop the mission first.");
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
    if (planLocked) {
      Alert.alert("Mission active", "Anchor selection is blocked while a mission is active. Stop the mission first.");
      resetAnchorSelection();
      return;
    }

    const targetLines = isolateLinesForAnchorTarget(lines, uploadedFiles, missionLayers, anchorTarget);
    const targetIds = new Set(targetLines.map((l) => l.id));
    const reanchored = reanchorTargetLines(targetLines, pendingAnchor);
    if (!reanchored.ok) {
      if (reanchored.reason === "seed-missing") {
        resetAnchorSelection();
        return;
      }
      showToast("Anchor failed", "That path has no usable geometry to re-anchor.", "error");
      return;
    }
    const chained = reanchored.chained;

    setLines((prev) => {
      const untouched = prev.filter((l) => !targetIds.has(l.id));
      return sanitizePlanLines([...chained, ...untouched]);
    });
    // Path Order keeps its own saved order; without this it keeps painting the pre-anchor sequence.
    setAnchorAppliedToken((t) => t + 1);

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
      if (!isDraggingOffsetDialRef.current || planLocked) return;
      const scopeTarget = offsetTarget ?? { kind: "universal" as const };
      const baseLines =
        alignContextRef.current.displayLines.length > 0 ? alignContextRef.current.displayLines : lines;
      const result = computeOffsetResultLines(
        baseLines,
        uploadedFiles,
        missionLayers,
        scopeTarget,
        offsetDistanceM,
        offsetBearingRef.current,
        { mode: offsetMode, bufferDirection: offsetBufferDirection }
      );
      setOffsetPreviewLines(result.ok ? result.lines : null);
    });
  }, [offsetTarget, offsetDistanceM, uploadedFiles, missionLayers, lines, planLocked, offsetMode, offsetBufferDirection]);

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

  const handleOffsetModeChange = useCallback((mode: "shift" | "buffer") => {
    setOffsetMode(mode);
    setOffsetPreviewLines(null);
  }, []);

  useEffect(() => {
    return () => {
      if (offsetGhostRafRef.current !== null) cancelAnimationFrame(offsetGhostRafRef.current);
    };
  }, []);

  useEffect(() => {
    if (offsetMode !== "buffer") return;
    if (planLocked || offsetDistanceM <= 0) {
      setOffsetPreviewLines(null);
      return;
    }
    const scopeTarget = offsetTarget ?? { kind: "universal" as const };
    const baseLines =
      alignContextRef.current.displayLines.length > 0 ? alignContextRef.current.displayLines : lines;
    const result = computeOffsetResultLines(
      baseLines,
      uploadedFiles,
      missionLayers,
      scopeTarget,
      offsetDistanceM,
      offsetBearingDeg,
      { mode: "buffer", bufferDirection: offsetBufferDirection }
    );
    setOffsetPreviewLines(result.ok ? result.lines : null);
  }, [
    offsetMode,
    offsetBufferDirection,
    offsetDistanceM,
    offsetTarget,
    uploadedFiles,
    missionLayers,
    lines,
    planLocked,
    offsetBearingDeg,
  ]);

  /**
   * Shift or buffer the selected scope (a file, a mission layer, or the whole
   * plan). One-shot bake into `lines` (like Move/Rotate Plan and Anchor).
   * Captures a pre-offset baseline on the first Apply so Reset can undo.
   */
  function handleApplyOffset() {
    if (planLocked) {
      Alert.alert("Mission active", "Offset is blocked while a mission is active. Stop the mission first.");
      return;
    }

    const scopeTarget = offsetTarget ?? { kind: "universal" as const };
    const result = computeOffsetResultLines(
      lines,
      uploadedFiles,
      missionLayers,
      scopeTarget,
      offsetDistanceM,
      offsetBearingDeg,
      { mode: offsetMode, bufferDirection: offsetBufferDirection }
    );

    if (!result.ok) {
      if (result.reason === "no-marks") {
        showToast("No plan to offset", "Upload and paint a plan before applying an offset.", "error");
      } else if (result.reason === "invalid-offset") {
        showToast("Can't offset", "Enter a valid distance and bearing.", "error");
      } else if (result.reason === "collapsed") {
        showToast("Can't offset", "Inward distance is larger than the shape.", "error");
      }
      return;
    }

    if (!preOffsetSnapshot) {
      setPreOffsetSnapshot(clonePlanLinesForSnapshot(lines));
    }

    setLines(result.lines);
    demoteWorkflowAfterBatchChange(false);
    setAppPlannedStartSnapshot(null);
    const summary =
      offsetMode === "buffer"
        ? `${offsetBufferDirection === "out" ? "Expanded" : "Shrunk"} ${offsetDistanceM.toFixed(2)} m.`
        : `Shifted ${offsetDistanceM.toFixed(2)} m at ${Math.round(normalizeBearingDeg(offsetBearingDeg))}°.`;
    showToast("Plan offset", `${summary} Plan changed — re-Send before Start.`, "info");
    setOffsetDistanceM(0);
    setOffsetPreviewLines(null);
  }

  /** Restore the plan to how it looked before the first Offset Apply this session. */
  function handleResetOffset() {
    if (planLocked) {
      Alert.alert("Mission active", "Offset reset is blocked while a mission is active. Stop the mission first.");
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

  /**
   * Start: one tap, everything else is the rover's. The app (1) rebuilds the entry leg from the
   * rover's live pose and re-uploads when needed, (2) sends `POST /api/missions/{sha}/start` with a
   * fresh request id, and (3) watches the lifecycle (LOADING, PLACING, ARMING, ENGAGING, READY,
   * RUNNING) arrive as `mission_state` rover events. The operator never arms or changes mode.
   */
  async function startMissionOnBackend() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to the rover before starting a mission.");
      return;
    }
    // Re-entrancy: double-taps + a slow re-upload must never stack two starts.
    if (startInFlightRef.current || missionActionBusy || pathPipelineRef.current.isExclusive()) {
      const holder = pathPipelineRef.current.exclusiveKind();
      showToast(
        "Start",
        holder ? exclusiveBusyMessage(holder) : "Start already in progress…",
        "info"
      );
      return;
    }

    // The buttons are enabled from the lifecycle; the same rule is checked here so a start is
    // only sent when the rover reports no active execution and a mission is stored.
    const controls = missionControls(missionViewRef.current, {
      busy: false,
      hasMission: Boolean(stagedMissionId) && stagedWorkflow.staged === "verified",
    });
    if (!controls.canStart) {
      showToast("Start blocked", controls.startBlockedReason ?? "The mission cannot be started now.", "warning");
      return;
    }

    if (!beginPathExclusive("start")) return;
    startInFlightRef.current = true;
    // Mission-layer Start selection is driven by pill visibility (missionLayers[].visible).
    let selectedStartLayerIds: string[] | null = null;
    let startSha: string | null = null;
    // Single try/finally so every early return still clears busy + in-flight flags.
    try {
      // Link / pose gate FIRST (socket, gateway, live telemetry, fresh pose), so the operator is told
      // now instead of after a re-upload. The operator heartbeat is not a start condition.
      {
        const earlyOrigin = appPlannedStartSnapshot?.originGps;
        if (earlyOrigin) {
          const early = evaluateMissionStartTelemetry(earlyOrigin);
          if (!early.ok) throw new Error(early.reasons.join(" "));
        }
      }
      const startT0 = Date.now();
      const phase = (name: string, extra?: Record<string, unknown>) =>
        logAction("START_PHASE", { phase: name, ms: Date.now() - startT0, ...(extra ?? {}) });
      showToast("Start", "Preparing mission…", "info");
      await yieldToUi();

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
      // kind === "legacy_full" → selectedStartLayerIds stays null (the full Send snapshot runs)

      // Every mission is app-planned: the Send snapshot is the source. Without it (cleared,
      // re-imported, or the app restarted) the stored mission cannot be re-entered from the
      // rover's pose, so Start is refused instead of starting an old entry.
      const snapshot = appPlannedStartSnapshot;
      if (!snapshot || !stagedMissionId || stagedWorkflow.staged !== "verified") {
        throw new Error("Send the mission to the rover first (Path Order → Send), then Start.");
      }

      logAction("START_REQUEST", {
        apiBaseUrl,
        fileName: importedPlan?.fileName ?? null,
        storedMissionId: stagedMissionId,
      });
      showToast("Start", "Starting mission…", "info");

      // Entry leg from a live pose (socket telemetry only: status never comes from a poll).
      const eligibility = evaluateMissionStartTelemetry(snapshot.originGps);
      if (!eligibility.ok) throw new Error(eligibility.reasons.join(" "));
      const picked = pickRoverPoseForEntry({
        eligibility,
        cachePose: getMissionStartTelemetryPose(snapshot.originGps),
        cacheReceivedAtMs: getProdTelemetryState().lastReceivedAt,
        nowMs: telemetryNow(),
      });
      if (!picked.ok) throw new Error(picked.error);
      let livePose = picked.pose;
      const poseSource = picked.source;

      let startSnapshot = snapshot;
      const scopedLayerIds = selectedStartLayerIds ?? [];
      const layerScoped = scopedLayerIds.length > 0;
      if (layerScoped) {
        const scoped = buildLayerScopedStartSnapshot(snapshot, uploadedFiles, missionLayers, scopedLayerIds);
        if (!scoped.ok) throw new Error(scoped.error);
        startSnapshot = scoped.snapshot;
      }

      const previewed = buildTrajectory(startSnapshot.paintedLines, {
        markSpeedMs: 0.35,
        travelSpeedMs: 0.5,
        extensions: startSnapshot.extensionConfig,
        roverPose: livePose,
        originGps: startSnapshot.originGps,
        includeEntryTransit: true,
        requireEntryTransit: true,
      });
      if (previewed.entryTransit?.error) throw new Error(previewed.entryTransit.error);
      phase("entry_built");
      await yieldToUi(); // let the heartbeat timer and the toast run between the heavy steps

      const skipRestage = canSkipLiveEntryRestage({
        entryIncluded: previewed.entryTransit?.included === true,
        storedVerified: stagedWorkflow.staged === "verified",
        layerScoped,
      });

      if (skipRestage) {
        startSha = stagedMissionId;
        logAction("START_SKIP_RESTAGE", {
          missionId: stagedMissionId,
          reason: previewed.entryTransit?.skipReason ?? "entry omitted",
          poseSource,
        });
      } else {
        showToast("Approach", "Building runtime entry from current rover position…", "info");
        let restaged = await restageAppTrajectoryWithLiveEntry({
          snapshot: startSnapshot,
          roverPose: livePose,
          prebuilt: previewed,
          onStep: (step) => {
            phase(`stage_${step}`);
            if (step === "upload") showToast("Approach", "Uploading the mission with the entry leg…", "info");
          },
        });
        if (!restaged.success) throw new Error(restaged.error);
        phase("restaged");

        // The upload takes time: if the rover moved, rebuild the entry from where it is now.
        const usedNed = resolveRoverNedInMissionFrame(livePose, startSnapshot.originGps);
        const picked2 = pickRoverPoseForEntry({
          eligibility: evaluateMissionStartTelemetry(startSnapshot.originGps),
          cachePose: getMissionStartTelemetryPose(startSnapshot.originGps),
          cacheReceivedAtMs: getProdTelemetryState().lastReceivedAt,
          nowMs: telemetryNow(),
        });
        let driftRetry = false;
        if (picked2.ok && usedNed.ok) {
          const latestNed = resolveRoverNedInMissionFrame(picked2.pose, startSnapshot.originGps);
          if (
            latestNed.ok &&
            entryPoseDrifted([usedNed.north, usedNed.east], [latestNed.north, latestNed.east])
          ) {
            driftRetry = true;
            showToast("Approach", "Rover moved — rebuilding entry from new position…", "info");
            livePose = picked2.pose;
            restaged = await restageAppTrajectoryWithLiveEntry({ snapshot: startSnapshot, roverPose: livePose });
            if (!restaged.success) throw new Error(restaged.error);
          }
        }
        setStagedMissionId(restaged.missionId);
        setWorkflowStep("staged", "verified");
        setStagedPlanResult(stagedPlanResultFromAdmitted(restaged.admitted));
        startSha = restaged.missionId;
        logAction("START_LIVE_ENTRY", {
          missionId: restaged.missionId,
          entryIncluded: restaged.entryIncluded,
          entryLengthM: restaged.entryLengthM ?? null,
          poseSource,
          driftRetry,
        });
      }

      const finalTelemetryGate = evaluateMissionStartTelemetry(snapshot.originGps);
      if (!finalTelemetryGate.ok) throw new Error(finalTelemetryGate.reasons.join(" "));
      phase("sending_start");

      // One tap = one request id. The id is reused only if the outcome of this very send is unknown.
      const tap = beginStartTap(startSha);
      const result = await startMissionCommand(tap);
      if (!result.ok) throw new CommandFailedError(result);

      if (selectedStartLayerIds && selectedStartLayerIds.length > 0) {
        runningLayerIdsRef.current = [...selectedStartLayerIds];
        runningMissionIdRef.current = startSha;
        setMissionLayers((prev) =>
          markLayersStarted(prev, selectedStartLayerIds!, startSha, Date.now())
        );
      } else {
        runningLayerIdsRef.current = [];
        runningMissionIdRef.current = startSha;
      }
      logAction("START_ACCEPTED", {
        missionId: startSha,
        executionId: result.missionId ?? null,
        duplicate: result.duplicate === true,
        requestId: result.requestId ?? null,
      });
      // 202 is an acknowledgement. The lifecycle is on screen from the rover's events.
      showToast("Start accepted", result.message, "success");
    } catch (error) {
      runningLayerIdsRef.current = [];
      runningMissionIdRef.current = null;
      const failure = error instanceof CommandFailedError ? error.failure : null;
      // A start whose outcome is unknown may be running: keep the layer bookkeeping untouched then.
      if (selectedStartLayerIds && selectedStartLayerIds.length > 0 && failure?.kind !== "unknown") {
        setMissionLayers((prev) => applyMissionTerminalOutcome(prev, selectedStartLayerIds!, "failed"));
      }
      logAction("START_FAILED", {
        fileName: importedPlan?.fileName ?? null,
        code: failure?.code ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      const title = failure?.title ?? "Start failed";
      const message = failure?.message ?? (error instanceof Error ? error.message : "Could not start the mission.");
      showToast(title, message, "error");
      Alert.alert(title, message);
    } finally {
      startInFlightRef.current = false;
      endPathExclusive("start");
    }
  }

  async function startLora() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before starting RTK.");
      return;
    }
    if (rtkStatus.running || rtkStatus.desired_mode === "ntrip") {
      Alert.alert("RTK managed by backend", "NTRIP startup and recovery are managed by the rover backend.");
      return;
    }
    setRtkConnecting(true);
    try {
      showToast("RTK Injection", "Starting LoRA...", "info");
      let res: Response;
      if (apiBaseUrl.includes(":8000")) {
        await fetch(`${apiBaseUrl}/api/rtk/source`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "LORA" }),
        });
        res = await fetch(`${apiBaseUrl}/api/rtk/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || "LoRA start failed.");
        }
      } else {
        res = await fetch(`${apiBaseUrl}/api/rtk/lora/start`, {
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
      }
      const data = await res.json().catch(() => ({}));
      setRtkStatus(normalizeRtkStatus(data));
      Alert.alert("LoRA Started", "LoRA RTK stream started successfully.");
      showToast("LoRA Started", "LoRA RTK stream active.", "success");
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
    if (rtkStatus.mode !== "lora" || !rtkStatus.running) return;
    const previousStatus = rtkStatus;
    setRtkStatus((current) => ({ ...current, source_state: "stopping" }));
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
      const data = await res.json().catch(() => null);
      setRtkStatus(data ? normalizeRtkStatus(data) : EMPTY_RTK_STATUS);
      logAction("RTK_STOP_SUCCESS");
      Alert.alert("RTK Stopped", "RTK correction stream stopped successfully.");
      showToast("RTK Stopped", "RTK stream stopped.", "success");
    } catch (error) {
      setRtkStatus(previousStatus);
      Alert.alert("Stop Failed", error instanceof Error ? error.message : "Failed to stop RTK action.");
      showToast("Stop Failed", error instanceof Error ? error.message : "Failed to stop RTK action.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  // RTK status comes from the pushed telemetry (ntrip_status + rtk_status), never from a poll.
  useEffect(() => {
    if (!apiBaseUrl) {
      setRtkStatus(EMPTY_RTK_STATUS);
      return;
    }
    let lastKey = "";
    const update = () => {
      const snap = getProdTelemetryState().snapshot;
      const ntrip = snap?.ntrip_status?.fresh ? (snap.ntrip_status.data as Record<string, any>) : null;
      const rtk = snap?.rtk_status?.fresh ? snap.rtk_status.data : null;
      const next: RTKStatus = ntrip
        ? {
            ...EMPTY_RTK_STATUS,
            mode: ntrip.connected || ntrip.state > 0 ? "ntrip" : "idle",
            desired_mode: ntrip.connected || ntrip.state > 0 ? "ntrip" : "idle",
            running: Boolean(ntrip.connected),
            healthy: Boolean(ntrip.streaming) && rtk?.corrections_fresh === true,
            source_state: ntrip.streaming ? "streaming" : ntrip.connected ? "connected" : ntrip.state > 0 ? "reconnecting" : "idle",
            frames: Number.isFinite(ntrip.valid_rtcm_frames) ? ntrip.valid_rtcm_frames : 0,
            bytes: Number.isFinite(ntrip.source_bytes_received) ? ntrip.source_bytes_received : 0,
            last_frame_age_s: Number.isFinite(ntrip.correction_age_s) ? ntrip.correction_age_s : null,
            last_error: typeof ntrip.last_error === "string" && ntrip.last_error ? ntrip.last_error : null,
          }
        : { ...EMPTY_RTK_STATUS, source_state: snap ? "unavailable" : "idle" };
      const key = `${next.mode}|${next.running}|${next.healthy}|${next.source_state}|${next.last_error}|${Math.round((next.last_frame_age_s ?? -1) * 2)}`;
      if (key === lastKey) return; // re-render only when what the chip shows changes
      lastKey = key;
      setRtkStatus((current) => ({ ...next, active_profile_id: current.active_profile_id, active_profile_revision: current.active_profile_revision }));
    };
    update();
    return subscribeProdTelemetry(update);
  }, [apiBaseUrl]);


  /**
   * Stop = abort the active mission (reason: operator). Always allowed while a mission is active
   * or its state is unknown. The result arrives as an ABORTED `mission_state` event; the rover
   * releases OFFBOARD and disarms itself.
   */
  async function stopMissionOnBackend() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to the rover before stopping a mission.");
      return;
    }
    logAction("STOP_REQUEST", { apiBaseUrl });
    setMissionActionBusy(true);
    try {
      const result = await stopMissionCommand();
      if (!result.ok) {
        logAction("STOP_FAILED", { code: result.code, kind: result.kind });
        showToast(result.title, result.message, "error");
        Alert.alert(result.title, result.message);
        return;
      }
      logAction("STOP_ACCEPTED");
      showToast("Stop", "Stop requested. Watching the rover.", "warning");
    } finally {
      setMissionActionBusy(false);
    }
  }

  /**
   * Clear the plan on the tablet. The rover keeps its stored missions (content-addressed files), so
   * there is nothing resident to unload and the rover is not called. Refused while a mission is active:
   * the map would lose the path that is being driven.
   */
  function clearPlan() {
    if (missionRunning) {
      showToast("Clear blocked", "Stop the mission before clearing the plan.", "warning");
      return;
    }
    logAction("CLEAR_PLAN", { selectedLines: lines.length });
    setImportedPlan(null);
    setLines([]);
    setSelectedLineId(null);
    setLocalCsvPreview(null);
    localCsvParsesRef.current = [];
    setLocalDxfMeta(null);
    setUploadedFiles([]);
    uploadedFilesRef.current = [];
    setPlacedTemplates([]);
    placedTemplatesRef.current = [];
    setMissionLayers([]);
    runningLayerIdsRef.current = [];
    runningMissionIdRef.current = null;
    setControlModeActive(false);
    setPendingLayerAssignment(null);
    resetAnchorSelection();
    setPendingDxfAlignment({});
    setSharedOriginGps(null);
    sharedOriginGpsRef.current = null;
    setExtractedCorners(null);
    setAlignedRefPoints([]);
    setAlignmentResult(null);
    setVerifiedAlignmentRequest(null);
    setGeoOriginDxf(null);
    setVisualAlignmentItem(null);
    setIsVisualAlignmentMode(false);
    setAppPlannedStartSnapshot(null);
    setStagedPlanResult(null);
    setStagedMissionId(null);
    setStagedWorkflow(INITIAL_STAGED_WORKFLOW_STATE);
    showToast("Plan cleared", "The plan was removed from the tablet. Stored missions stay on the rover.", "success");
  }

  /** Pause the running mission. The PAUSED state arrives as a `mission_state` event. */
  async function pauseMissionOnBackend() {
    if (!apiBaseUrl) return;
    setMissionActionBusy(true);
    try {
      const result = await pauseMissionCommand();
      if (!result.ok) {
        showToast(result.title, result.message, "error");
        Alert.alert(result.title, result.message);
        return;
      }
      showToast("Pause", "Pause requested.", "info");
    } finally {
      setMissionActionBusy(false);
    }
  }

  /** Resume a paused mission. Never automatic: only this explicit action. */
  async function resumeMissionOnBackend() {
    if (!apiBaseUrl) return;
    setMissionActionBusy(true);
    try {
      const result = await resumeMissionCommand();
      if (!result.ok) {
        showToast(result.title, result.message, "error");
        Alert.alert(result.title, result.message);
        return;
      }
      showToast("Resume", "Resume requested.", "info");
    } finally {
      setMissionActionBusy(false);
    }
  }

  /** No argument: the button toggles by the rover's E-stop state (asserted -> offer Clear). */
  async function estopVehicle(requested?: boolean) {
    const current = selectEstop(getRoverEventsState());
    const asserted = requested ?? !(current.known && current.asserted);
    if (asserted) {
      virtualJoystick.handleEStop();
      logAction("ESTOP_REQUEST", { asserted: true });
      showToast("E-Stop", "EMERGENCY STOP DISPATCHED!", "error");
      try {
        await getAppTransport().estop(true);
        logAction("ESTOP_SUCCESS");
        Alert.alert("EMERGENCY STOP", "Motors halted. Rover E-stop is active.");
        showToast("E-STOP Active", "Rover emergency stop confirmed.", "success");
      } catch (error) {
        logAction("ESTOP_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
        Alert.alert(
          "E-STOP DELIVERY FAILED",
          "Rover did not acknowledge the software E-stop! HIT THE PHYSICAL RC TRANSMITTER E-STOP IMMEDIATELY!"
        );
        showToast("E-STOP FAILED", "Network delivery failed! Use RC transmitter!", "error");
      }
    } else {
      Alert.alert(
        "Clear Emergency Stop",
        "Clear E-stop and restore rover motor readiness?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Clear E-Stop",
            style: "destructive",
            onPress: async () => {
              try {
                showToast("E-Stop", "Clearing E-stop...", "info");
                await getAppTransport().estop(false);
                Alert.alert("E-Stop Cleared", "Rover E-stop cleared successfully.");
                showToast("E-Stop Cleared", "Rover ready.", "success");
              } catch (error) {
                Alert.alert("Clear Failed", error instanceof Error ? error.message : "Could not clear E-stop.");
              }
            },
          },
        ]
      );
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
    // Production backend answers /api/ping without auth; one short probe per host keeps a /24 sweep ~3 s.
    const endpoints = ["/api/ping"];
    for (const endpoint of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 600);
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
                  hasStoredSession={hasSavedToken}
                  onForgetToken={() => void forgetSavedTokenForTarget()}
                  isOffline={isOffline}
                  discoveredRovers={[
                    ...beaconRovers.map((r) => ({
                      id: r.roverId,
                      name: r.roverName,
                      host: r.ip,
                      port: r.port,
                      version: "beacon",
                      responseTime: 0,
                    })),
                    ...discoveredRovers.filter((d) => !beaconRovers.some((b) => b.ip === d.host && b.port === d.port)),
                  ]}
                  onRefresh={scanForWebsockets}
                  onSelect={handleSelectWebsocket}
                  onManualHostChange={setManualHost}
                  onConnect={() => {
                    userDisconnectedRef.current = false;
                    void connectSelectedWebsocket();
                  }}
                  onOfflinePreview={enterOfflinePreview}
                />
              ) : (
                <AppErrorBoundary name="Home">
                <LoopProbe id="HomeView">
                <HomeView
                  page={page}
                  onResetNorth={() => setResetNorthCount((c) => c + 1)}
                  resetNorthCount={resetNorthCount}
                  onFocusRover={() => setRecenterRoverCount((c) => c + 1)}
                  onFocusPlan={() => setRecenterPlanCount((c) => c + 1)}
                  recenterRoverCount={recenterRoverCount}
                  recenterPlanCount={recenterPlanCount}
                  previewRoverPoint={previewRoverPoint}
                  importedPlan={importedPlan}
                  setImportedPlan={setImportedPlan}
                  lines={displayedLines}
                  missionVisibleLines={missionVisibleDisplayedLines}
                  mapGeometryFrame={mapGeometryFrame}
                  geoOrigin={geoOriginDxf}
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
                  onDisconnect={disconnectToConnectionScreen}
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
                  onClearMission={clearPlan}
                  onStartPlan={startMissionOnBackend}
                  onPausePlan={pauseMissionOnBackend}
                  onResumePlan={resumeMissionOnBackend}
                  onEstopVehicle={estopVehicle}
                  onBeginLocalImportBatch={handleBeginLocalImportBatch}
                  onLocalCsvParsed={handleLocalCsvParsed}
                  missionActionBusy={missionActionBusy}
                  missionPanelOpenToken={missionPanelOpenToken}
                  missionRunning={missionRunning}
                  systemHealth={systemHealth}
                  telemetrySnapshot={telemetrySnapshot}
                  activityFeed={activityFeed}
                  discoveryFeed={discoveryFeed}
                  isPaused={isPaused}
                  rtkConnecting={rtkConnecting}
                  rtkStatus={rtkStatus}
                  startLora={startLora}
                  apiBaseUrl={apiBaseUrl}
                  stagedWorkflow={stagedWorkflow}
                  stagedMissionId={stagedMissionId}
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
                            mapGeometryFrame={mapGeometryFrame}
                            geoOrigin={geoOriginDxf}
                            setLines={setLines}
                            selectedLineId={selectedLineId}
                            onMissionStored={handleMissionStored}
                            missionActionBusy={missionActionBusy}
                            onBeginPathExclusive={beginPathExclusive}
                            onEndPathExclusive={endPathExclusive}
                            onClearMission={clearPlan}
                            apiBaseUrl={apiBaseUrl}
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
                            layerVisibility={layerVisibility}
                            setLayerVisibility={setLayerVisibility}
                            setImportedPlan={setImportedPlan}
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
                            onWorkflowStep={setWorkflowStep}
                            stagedWorkflow={stagedWorkflow}
                            alignmentResult={alignmentResult}
                            setAlignmentResult={setAlignmentResult}
                            verifiedAlignmentRequest={verifiedAlignmentRequest}
                            setVerifiedAlignmentRequest={setVerifiedAlignmentRequest}
                            stagedPlanResult={stagedPlanResult}
                            setStagedPlanResult={setStagedPlanResult}
                            stagedMissionId={stagedMissionId}
                            setStagedMissionId={setStagedMissionId}
                            onInvalidateWorkflow={invalidateStagedWorkflowFrom}
                            onAppPlannedStartSnapshot={setAppPlannedStartSnapshot}
                            dashPattern={dashPattern}
                            onDashPatternChange={setDashPattern}
                            alignedRefPoints={alignedRefPoints}
                            setAlignedRefPoints={setAlignedRefPoints}
                            mapViewEnabled={mapViewEnabled}
                            setMapViewEnabled={setMapViewEnabled}
                            isFloatingEStopEnabled={isFloatingEStopEnabled}
                            setIsFloatingEStopEnabled={setIsFloatingEStopEnabled}
                            rtkStatus={rtkStatus}
                            stopRtk={stopRtk}
                            localCsvPreview={localCsvPreview}
                            localDxfMeta={localDxfMeta}
                            uploadedFiles={uploadedFiles}
                            placedTemplates={placedTemplates}
                            onPlaceTemplate={handlePlaceTemplate}
                            onUpdateTemplateInstance={handleUpdateTemplateInstance}
                            onRemoveTemplate={handleRemoveTemplate}
                            onRemoveUploadedFile={handleRemoveUploadedFile}
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
                            anchorAppliedToken={anchorAppliedToken}
                            offsetDistanceM={offsetDistanceM}
                            offsetBearingDeg={offsetBearingDeg}
                            offsetMode={offsetMode}
                            onOffsetModeChange={handleOffsetModeChange}
                            offsetBufferDirection={offsetBufferDirection}
                            onOffsetBufferDirectionChange={setOffsetBufferDirection}
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
                </LoopProbe>
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

type HomeViewProps = {
  page?: Page;
  renderSectionContent?: () => React.ReactNode;
  onResetNorth?: () => void;
  resetNorthCount?: number;
  onFocusRover?: () => void;
  onFocusPlan?: () => void;
  recenterRoverCount?: number;
  recenterPlanCount?: number;
  previewRoverPoint: { north: number; east: number } | null;
  mapGeometryFrame: MapGeometryFrame;
  geoOrigin?: [number, number] | null;
  importedPlan: ImportedPlan | null;
  setImportedPlan?: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
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
  onClearMission: () => void;
  onStartPlan: () => Promise<void>;
  onPausePlan: () => Promise<void>;
  onResumePlan: () => Promise<void>;
  onEstopVehicle: () => Promise<void>;
  /** Hand a plan drawn on the Home map to the same on-device import as a picked file. */
  onBeginLocalImportBatch?: () => void;
  onLocalCsvParsed?: (data: LocalPointCsvResult) => void;
  missionActionBusy: boolean;
  missionPanelOpenToken: number;
  missionRunning: boolean;
  systemHealth: SystemHealth | null;
  telemetrySnapshot: TelemetrySnapshot | null;
  activityFeed: ActivityEntry[];
  discoveryFeed: DiscoveredRover[];
  isPaused: boolean;
  rtkConnecting: boolean;
  rtkStatus: RTKStatus;
  startLora: () => Promise<void>;
  apiBaseUrl?: string;
  stagedWorkflow: StagedWorkflowState;
  stagedMissionId: string | null;
  onInvalidateWorkflow?: (step: StagedWorkflowStep) => void;
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
};

function HomeView(props: HomeViewProps) {
  // Prefer App-provided live snapshot (single source of truth). Store is fallback only.
  const liveTelemetry = useThrottledTelemetrySnapshot();
  const {
    page = "home",
    renderSectionContent,
    previewRoverPoint: previewRoverPointProp,
    mapGeometryFrame,
    geoOrigin = null,
    lines,
    selectedLineId,
    onSelectLine,
    layerVisibility,
    onPausePlan,
    missionRunning,
    telemetrySnapshot: telemetrySnapshotProp,
    stagedWorkflow,
    alignedRefPoints = [],
    showRefPointLabels = false,
    activeRefPointLabelIndex = null,
    setActiveRefPointLabelIndex,
    isVisualAlignmentMode,
    visualAlignmentItem,
    setVisualAlignmentItem,
    visualAlignmentAnchor,
    onFocusRover,
    onFocusPlan,
    recenterRoverCount = 0,
    recenterPlanCount = 0,
  } = props;

  const telemetrySnapshot = liveTelemetry ?? telemetrySnapshotProp;
  const previewRoverPoint =
    previewRoverPointProp ??
    (telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
      ? { north: telemetrySnapshot.pos_n as number, east: telemetrySnapshot.pos_e as number }
      : null);

  const [crossTrackAlerted, setCrossTrackAlerted] = useState(false);

  // Cross-track warning while the rover is driving (RUNNING, from mission_state events), with a one-tap Pause.
  const driving = telemetrySnapshot?.mission_state === "running";
  useEffect(() => {
    if (!driving) {
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
  }, [telemetrySnapshot?.xtrack_m, driving, crossTrackAlerted, onPausePlan]);

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
          mapGeometryFrame={mapGeometryFrame}
          geoOrigin={geoOrigin}
          stagedVerified={stagedWorkflow.staged === "verified"}
          visibility={layerVisibility}
          selectedLineId={selectedLineId}
          onSelectLine={onSelectLine}
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

function SectionPages(props: {
  title: string;
  page: Page;
  telemetrySnapshot: TelemetrySnapshot | null;
  missionRunning: boolean;
  previewRoverPoint: { north: number; east: number } | null;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  mapGeometryFrame?: MapGeometryFrame;
  geoOrigin?: [number, number] | null;
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onBack: () => void;
  onSelectLine: (id: string | null, options?: { highlightLineIds?: string[] | null }) => void;
  /** Multi-line highlight set from Path Order Extension group selection. */
  highlightLineIds?: string[] | null;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
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
  /** Send stored the mission on the rover (verified). There is no load step. */
  onMissionStored: (missionId: string) => void;
  missionActionBusy: boolean;
  onBeginPathExclusive?: (kind: PathExclusiveKind) => boolean;
  onEndPathExclusive?: (kind: PathExclusiveKind) => void;
  apiBaseUrl: string;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  stagedWorkflow: StagedWorkflowState;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  verifiedAlignmentRequest: VerifiedAlignment | null;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<VerifiedAlignment | null>>;
  stagedPlanResult: StagedPlanResultState | null;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  stagedMissionId: string | null;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  onInvalidateWorkflow: (step: StagedWorkflowStep) => void;
  onAppPlannedStartSnapshot?: (snapshot: AppPlannedStartSnapshot) => void;
  dashPattern?: DashPattern | null;
  onDashPatternChange?: (pattern: DashPattern | null) => void;
  onNav: (page: Page) => void;
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
  rtkStatus: RTKStatus;
  stopRtk?: () => Promise<void>;
  onClearMission: () => void;
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
  placedTemplates?: import("./src/types/uploadedFiles").PlacedTemplateInstance[];
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
  anchorAppliedToken?: number;
  /** Offset plan (whole-plan rigid shift toward an absolute compass bearing) — Fields Upload step. */
  offsetDistanceM?: number;
  offsetBearingDeg?: number;
  offsetMode?: "shift" | "buffer";
  onOffsetModeChange?: (mode: "shift" | "buffer") => void;
  offsetBufferDirection?: "out" | "in";
  onOffsetBufferDirectionChange?: (direction: "out" | "in") => void;
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
  const { page, mapViewEnabled } = props;
  const sharedMapEnabled = useSharedMapEnabled();
  // Prefer App props; store fallback if a screen mounts without a parent snapshot.
  const liveTelemetry = useThrottledTelemetrySnapshot();
  const telemetrySnapshot = liveTelemetry ?? props.telemetrySnapshot;
  const previewRoverPoint =
    props.previewRoverPoint ??
    (telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
      ? { north: telemetrySnapshot.pos_n as number, east: telemetrySnapshot.pos_e as number }
      : null);

  return (
    <Suspense fallback={<ActivityIndicator />}>
    <View
      style={{ flex: 1, backgroundColor: page === "fields" && sharedMapEnabled && mapViewEnabled ? "transparent" : "#09090b" }}
      pointerEvents={page === "fields" ? "box-none" : "auto"}
    >
      {page === "fields" ? (
        <LoopProbe id="FieldsPage">
        <FieldsPage
          {...props}
          previewRoverPoint={previewRoverPoint}
          onClearMission={props.onClearMission}
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
        </LoopProbe>
      ) : null}
      {page === "templates" ? (
        <LoopProbe id="TemplatesPage">
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
        </LoopProbe>
      ) : null}
      {page === "swozi" ? (
        <SwoziPage
          delayA={props.delayA}
          delayB={props.delayB}
          setDelayA={props.setDelayA}
          setDelayB={props.setDelayB}
          toggleA={props.toggleA}
          toggleB={props.toggleB}
          setToggleA={props.setToggleA}
          setToggleB={props.setToggleB}
          apiBaseUrl={props.apiBaseUrl}
          isFloatingEStopEnabled={props.isFloatingEStopEnabled}
          setIsFloatingEStopEnabled={props.setIsFloatingEStopEnabled}
        />
      ) : null}
      {page === "status" ? <StatusPage /> : null}
      {page === "positioning" ? (
        <PositioningPage
          toggleA={props.toggleA}
          toggleB={props.toggleB}
          toggleC={props.toggleC}
          toggleD={props.toggleD}
          setToggleA={props.setToggleA}
          setToggleB={props.setToggleB}
          setToggleC={props.setToggleC}
          setToggleD={props.setToggleD}
        />
      ) : null}
      {page === "settings" ? (
        <SettingsPage
          toggleA={props.toggleA}
          toggleB={props.toggleB}
          toggleC={props.toggleC}
          setToggleA={props.setToggleA}
          setToggleB={props.setToggleB}
          setToggleC={props.setToggleC}
          rtkStatus={props.rtkStatus}
          stopRtk={props.stopRtk}
          apiBaseUrl={props.apiBaseUrl}
          dashPattern={props.dashPattern}
          onDashPatternChange={props.onDashPatternChange}
        />
      ) : null}
      {page === "howto" ? <HowToPage /> : null}
      {page === "about" ? <AboutPage /> : null}
    </View>
    </Suspense>
  );
}

