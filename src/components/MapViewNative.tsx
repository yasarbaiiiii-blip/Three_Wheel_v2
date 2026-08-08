/**
 * Native Mapbox implementation of the map, behind the USE_NATIVE_MAPBOX flag.
 *
 * Goal: full backward compatibility with the legacy Leaflet `MapView` — it
 * accepts the exact same `MapViewProps` so `App.tsx` / `TemplatesPage.tsx` need
 * zero changes. This file focuses on RENDERING PARITY (Phase 1, first milestone):
 * basemap, plan lines, rover + heading + range circle, next-target, reference
 * points, rover FROM→GO start direction, boundary + control points, placed items,
 * selection highlight, camera recenter/fit, and tap selection. Gesture editing
 * (drag/scale/rotate, boundary drag, snap) is deliberately NOT implemented here
 * yet (Phase 2).
 *
 * API references (verified against installed @rnmapbox/maps v10.3.1; see §14 of
 * docs/Mapbox-Migration-Plan.md):
 * - MapView:     https://rnmapbox.github.io/docs/components/MapView   (onPress → Feature<Point>)
 * - Camera:      https://rnmapbox.github.io/docs/components/Camera    (setCamera, fitBounds)
 * - ShapeSource: https://rnmapbox.github.io/docs/components/ShapeSource (shape, onPress → OnPressEvent)
 * - LineLayer / FillLayer / CircleLayer / SymbolLayer / MarkerView
 * Coordinate order is converted ONLY through toMapboxCoord/fromMapboxCoord.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View, Text } from "react-native";
import {
  MapView as RNMapboxMapView,
  Camera,
  ShapeSource,
  LineLayer,
  FillLayer,
  CircleLayer,
  SymbolLayer,
  MarkerView,
} from "@rnmapbox/maps";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSharedValue, runOnJS } from "react-native-reanimated";

/**
 * Local mirror of the documented `OnPressEvent` (the type is not re-exported at
 * the package root in v10.3.1). Matches @rnmapbox/maps' OnPressEvent shape.
 */
type ShapeSourcePressEvent = {
  features: GeoJSON.Feature[];
  coordinates: { latitude: number; longitude: number };
  point: { x: number; y: number };
};
import Svg, { Circle as SvgCircle, Polygon as SvgPolygon } from "react-native-svg";
import circle from "@turf/circle";

import type { PlanLine } from "../types/plan";
import type { PlacedItem } from "./BoundaryEditor";
import {
  projectPlanLineToGpsSegments,
  projectPlanNorthEastToGps,
  resolvePreviewProjectionOrigin,
  type MapProjectionOrigin,
} from "../utils/mapGeometryProjection";
import {
  getCurveSelectionAnchors,
  getPlanLineRenderPoints,
  isCircleLikeLine,
  isCurveEntity,
} from "../utils/curveGeometry";
import {
  transformVisualDxfPoint,
  projectGpsToLocalMeters,
  projectLocalMetersToGps,
} from "../utils/visualAlignment";
import { type LocalMeters } from "../utils/refPointSnap";
import { computeShapeSnapPoints } from "../utils/planShapeSnapPoints";
import {
  applyRigidPlanSnap,
  type RigidSnapLock,
  type SnapRefPoint,
} from "../utils/rigidRefPointSnap";
import {
  applyAxisResize,
  designObbFromLines,
  edgeHandleArrowBearingDeg,
  effectiveScaleEast,
  effectiveScaleNorth,
  findNearestHandle,
  getEdgeHandleWorldPoints,
  getObbResizeHandles,
  handleGrabRadiusM,
  handleHitRadiusM,
  isEdgeHandleId,
  isWorldPointInPlanObb,
  type PlanStickerPose,
  type ResizeHandle,
} from "../utils/planResizeHandles";
import { buildPlanLengthLabels } from "../utils/planLengthLabels";
import { toMapboxCoord, fromMapboxCoord } from "../utils/mapboxCoords";
import { getLineLengthM, formatFinite } from "../utils/pathWorkflow";
import { getPlanStartPoint, isPrimaryEditableLine } from "../utils/planGeometry";
import { MAPBOX_STYLE_URL } from "../config/mapbox";
import type { MapViewProps } from "./mapViewTypes";
import { pixelDeltaToMetres, clampToIndent, type BoundingRect } from "../utils/mapGestureUtils";
import { deriveMetersPerPixel, screenToGeo } from "../utils/mapScreenGeo";
import type { MultiPointPlacementPhase } from "../types/fieldsWorkflow";

/** Same precedence as getPlanStartPoint — first segment the rover will drive. */
function getPlanStartTravelLine(lines: PlanLine[]): PlanLine | null {
  const runtimeStart = lines.find((line) => line.id === "runtime-transit-0");
  const preExt = lines.find(
    (line) => line.layer === "extension" && String(line.id).startsWith("ext-pre-")
  );
  return runtimeStart ?? preExt ?? lines.find(isPrimaryEditableLine) ?? lines[0] ?? null;
}

/** Max vertices per line while live-dragging plan-editing-group (LOD). Full quality on commit. */
const DRAG_PREVIEW_MAX_VERTICES = 12;

/** Stable string key for matching a SnapRefPoint against a `selectedPoints` entry by value. */
function refPointKey(p: { lat: number; lon: number }): string {
  return `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
}

// ── Layer colours (parity with legacy LAYER_COLORS in MapView.tsx) ──
const LAYER_COLORS: Record<string, string> = {
  boundary: "#0f172a",
  marking: "#16a34a",
  marking_false: "#86efac",
  center: "#f59e0b",
  transit: "#94a3b8",
  extension: "#8b5cf6",
  virtual_boundary: "#06b6d4",
};
const DEFAULT_LINE_COLOR = "#0f172a";
const PLAN_SOURCE_MAX_ZOOM = 22;
const PLAN_SOURCE_TOLERANCE = 0;

/** Colour for a plan line layer, with a safe fallback for unknown values. */
function colorForLayer(layer: string): string {
  return LAYER_COLORS[layer] ?? DEFAULT_LINE_COLOR;
}

/** Distance (metres, planar) from point (px,py) to segment (x1,y1)-(x2,y2). */
function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  return nearestOnSegment(px, py, x1, y1, x2, y2).dist;
}

/**
 * Closest point on segment (x1,y1)-(x2,y2) to (px,py). All coords in the same
 * planar frame (typically plan north/east metres).
 */
function nearestOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { dist: number; x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) {
    return { dist: Math.hypot(px - x1, py - y1), x: x1, y: y1 };
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { dist: Math.hypot(px - x, py - y), x, y };
}

type Coord = [number, number]; // [lon, lat]

function featureCollection(
  features: GeoJSON.Feature[]
): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

function lineFeature(
  coords: Coord[],
  properties: GeoJSON.GeoJsonProperties = {}
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties,
    geometry: { type: "LineString", coordinates: coords },
  };
}

function pointFeature(
  coord: Coord,
  properties: GeoJSON.GeoJsonProperties = {}
): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: coord },
  };
}

function isClosedCoordRing(coords: Coord[]): boolean {
  if (coords.length < 4) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12;
}

/** A looping pulsing dot used for the next-target waypoint (parity with the
 *  legacy `.pulsing-circle`). Animation runs on the RN driver, off the map
 *  style hot path (see plan §2.4). */
function PulsingDot({
  color = "#f59e0b",
  size = 12,
}: {
  color?: string;
  size?: number;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.2] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  return (
    <View style={{ width: size * 2, height: size * 2, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: ringOpacity,
          transform: [{ scale: ringScale }],
        }}
      />
      <View
        style={{
          width: size * 0.8,
          height: size * 0.8,
          borderRadius: (size * 0.8) / 2,
          backgroundColor: color,
          opacity: 0.85,
        }}
      />
    </View>
  );
}

/**
 * Rover vehicle icon — react-native-svg port of the legacy inline SVG.
 *
 * MarkerView content is always screen/viewport-aligned (Mapbox never rotates a
 * view annotation's own content to match the camera — only its projected screen
 * position). Rotating just by `heading` therefore only looks correct at camera
 * bearing 0: the moment the user twists the map, the icon stays fixed in screen
 * orientation while the plan lines/basemap rotate underneath it, which reads as
 * the rover "spinning" relative to its own plan. Subtracting the live camera
 * bearing counter-rotates the icon so it keeps tracking its true heading exactly
 * as it appears on the (possibly rotated) map — i.e. it turns WITH the map
 * instead of appearing to drift/spin against it.
 */
function RoverVehicle({ heading, mapBearing }: { heading: number | null | undefined; mapBearing?: number }) {
  const rotationDeg = (heading ?? 0) - (mapBearing ?? 0);
  return (
    <View style={{ transform: [{ rotate: `${rotationDeg}deg` }] }}>
      <Svg width={40} height={40} viewBox="-20 -20 40 40">
        <SvgCircle cx={0} cy={0} r={18.7} fill="rgba(14,165,233,0.12)" />
        <SvgPolygon
          points="-6.5,11 6.5,11 6.5,-4 0,-7.5 -6.5,-4"
          fill="#0ea5e9"
          stroke="#ffffff"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
        <SvgPolygon points="-9.5,5 -6.5,5 -6.5,11 -9.5,11" fill="#0f172a" />
        <SvgPolygon points="9.5,5 6.5,5 6.5,11 9.5,11" fill="#0f172a" />
        <SvgPolygon points="-2.5,3 2.5,3 2.5,-3 -2.5,-3" fill="#0f172a" />
        <SvgPolygon points="-4.5,-2 4.5,-2 3.5,2 -3.5,2" fill="rgba(186,230,253,0.85)" />
        <SvgCircle cx={0} cy={-7.5} r={2.5} fill="#fbbf24" stroke="#fff" strokeWidth={1} />
      </Svg>
    </View>
  );
}

export function MapViewNative(props: MapViewProps) {
  const {
    telemetrySnapshot,
    lines,
    ghostLines,
    alignedRefPoints,
    visible,
    showRover = true,
    // Opt-in (see LayerVisibility.lengths) — path detail labels are off unless asked for.
    showLengths = false,
    recenterRoverTrigger,
    recenterPlanTrigger,
    resetNorthTrigger,
    onSelectPoint,
    onGuidePointFocus,
    onSelectLine,
    selectedLineId,
    highlightedLines,
    selectedPoints,
    mode = "fields",
    placedItems,
    selectedItemIds,
    boundaryWidth,
    boundaryHeight,
    indentSpacing,
    showRefPointLabels,
    boundaryPosition,
    onMoveBoundary,
    boundaryRotation = 0,
    onRotateBoundary,
    showBoundaryPoints,
    activeSnapPointId,
    onSelectionChange,
    previewAnchor,
    autoOriginReference,
    mapGeometryFrame,
    stagedVerified = false,
    autoOriginEnabled = false,
    geoOrigin = null,
    visualAlignmentAnchor,
    previewFallbackGps = null,
    lockPanDrag,
    lockZoom,
    sketchMode,
    onUpdatePlacedItem,
    onUpdatePlacedItems,
    multiTouchMode = "both",
    onMapClickToMark,
    drawnWaypoints,
    manualDrawingEnabled,
    screenToGeoRef,
    snapRefPoints,
    planPlacementPhase = "idle",
    onPlanAttached,
    anchorCandidates,
    onAnchorCandidateSelect,
  } = props;

  const planPlacementPhaseRef = useRef<MultiPointPlacementPhase>(planPlacementPhase);
  useEffect(() => {
    planPlacementPhaseRef.current = planPlacementPhase;
  }, [planPlacementPhase]);

  const onPlanAttachedRef = useRef(onPlanAttached);
  useEffect(() => {
    onPlanAttachedRef.current = onPlanAttached;
  }, [onPlanAttached]);

  useEffect(() => {
    if (screenToGeoRef) {
      screenToGeoRef.current = async (screen) => {
        if (!mapViewRef.current) return null;
        return screenToGeo(mapViewRef.current, screen);
      };
    }
    return () => {
      if (screenToGeoRef) {
        screenToGeoRef.current = null;
      }
    };
  }, [screenToGeoRef]);

  const cameraRef = useRef<Camera>(null);
  const mapViewRef = useRef<RNMapboxMapView>(null);
  const hasAutoCenteredRef = useRef(false);
  /** Native map style finished loading — setCamera before this can SIGSEGV on some devices. */
  const mapLoadedRef = useRef(false);
  // Live camera bearing (0 = north-up), tracked so heading-indicator markers can
  // counter-rotate against it — otherwise a marker's screen-fixed rotation only
  // shows the correct facing direction at bearing 0, and visibly drifts out of
  // alignment with the map's own content the moment the user rotates the camera.
  const [cameraBearing, setCameraBearing] = useState(0);
  const handleCameraChanged = useCallback((state: { properties?: { heading?: number } } | null | undefined) => {
    // Release builds: Mapbox sometimes delivers incomplete camera events; never throw.
    try {
      const heading = state?.properties?.heading;
      setCameraBearing(typeof heading === "number" && Number.isFinite(heading) ? heading : 0);
    } catch (err) {
      console.warn("[MapViewNative] onCameraChanged ignored:", err);
    }
  }, []);
  const safeSetCamera = useCallback((opts: Record<string, unknown>) => {
    if (!mapLoadedRef.current) return;
    try {
      cameraRef.current?.setCamera(opts as never);
    } catch (err) {
      console.warn("[MapViewNative] setCamera failed:", err);
    }
  }, []);
  const safeFitBounds = useCallback(
    (sw: [number, number], ne: [number, number], padding: number, duration: number) => {
      if (!mapLoadedRef.current) return;
      try {
        cameraRef.current?.fitBounds(sw, ne, padding, duration);
      } catch (err) {
        console.warn("[MapViewNative] fitBounds failed:", err);
      }
    },
    []
  );
  // Track the last trigger value we acted on, so recenter/fit fire exactly once
  // per button press and never on telemetry/geometry changes.
  const lastRecenterRoverRef = useRef(0);
  const lastRecenterPlanRef = useRef(0);
  const lastResetNorthRef = useRef(0);
  // Baseline for the "selected points grew" auto-fit below — initialized to the
  // mount-time count so it never fires on first render, only on real growth.
  const lastSelectedPointsCountRef = useRef(selectedPoints?.length ?? 0);
  // Baseline for the "alignment just completed" auto-fit below — same reasoning.
  const lastAlignedRefPointsCountRef = useRef(alignedRefPoints?.length ?? 0);

  // ── Gesture state ──
  // GestureType enum for the in-progress gesture (items drag or boundary drag).
  // Only set during an active gesture — null = idle (no editing active).
  type GestureEditType = "items" | "boundary" | null;
  const [gestureEditType, setGestureEditType] = useState<GestureEditType>(null);

  // Raw gesture deltas on the Reanimated UI thread — do NOT drive React state here.
  // These are read in gesture callbacks and committed to parent only on gesture end.
  const panDeltaN = useSharedValue(0); // north delta in metres (accumulated)
  const panDeltaE = useSharedValue(0); // east delta in metres
  const pinchScale = useSharedValue(1); // multiplicative scale factor
  const rotationDelta = useSharedValue(0); // rotation delta in degrees

  // Cached meters-per-pixel at gesture start (calibrated once, used for all moves).
  // Uses a Reanimated shared value so worklets can read it without warnings.
  // (A plain useRef would trigger "tried to modify key `current`" in Reanimated.)

  // Starting positions snapshot — captured at gesture begin (JS thread only, no worklet).
  // Maps itemId → { x, y, rotation, scale } at drag start. Used to compute absolute final
  // position from accumulated delta (avoids floating-point drift from incremental additions).
  const dragStartPositionsRef = useRef<Record<string, { x: number; y: number; rotation: number; scale: number }>>({});

  // Multi-Point Fit rigid lock: which plan feature is currently pinned onto which ref point.
  // Translate + rotate only — the lock never carries a scale-to-fit. Cleared at drag
  // begin/end only; reported to the parent as "attached" on commit.
  const snapLockRef = useRef<RigidSnapLock | null>(null);

  // Resize-mode session: edge-midpoint axis resize only (n/e/s/w).
  // startCursor is the HANDLE world position (not the finger). Finger motion is applied
  // as dN/dE so a tap (0 delta) never jumps scale toward the touch.
  const resizeSessionRef = useRef<{
    handle: ResizeHandle;
    opposite: ResizeHandle;
    startPose: PlanStickerPose;
    startCursor: { north: number; east: number };
  } | null>(null);

  /**
   * Minimum finger travel (m) before resize applies.
   * Low enough to feel snappy; high enough that a pure tap (deselect) never bakes scale.
   */
  const RESIZE_MIN_DRAG_M = 0.12;

  /** Bumps on every drag-begin so stale screenToGeo results cannot win. */
  const resizeGestureGenRef = useRef(0);
  /**
   * Resolves when the current resize hit-test finishes (hit or miss).
   * Commit awaits this so a fast finger-up still applies after async geo resolves.
   */
  const resizeSessionReadyRef = useRef<Promise<void>>(Promise.resolve());
  const resolveResizeSessionReadyRef = useRef<(() => void) | null>(null);

  /** Fire onPlanAttached at most once per gesture. */
  const notifiedAttachRef = useRef(false);

  // Magnet / ref-point lock is for drag & rotate only — clear when entering resize.
  useEffect(() => {
    if (planPlacementPhase === "resizing") {
      snapLockRef.current = null;
      notifiedAttachRef.current = false;
    }
  }, [planPlacementPhase]);

  /** Screen coords at drag-begin — used to treat a near-zero pan as a tap for deselect. */
  const gestureStartScreenRef = useRef<{ x: number; y: number } | null>(null);

  // Preview FeatureCollection for live drag feedback (set via RAF-coalesced JS callback).
  // Null = use the normal committed sources (no active drag preview).
  // Atomic bundle: one setState per frame for items + snap guide + active ref highlight
  // (three separate setStates were causing extra reconciles / lag under drag).
  const [dragPreview, setDragPreview] = useState<{
    itemsGeo: {
      lines: GeoJSON.FeatureCollection;
      boxes: GeoJSON.FeatureCollection;
    };
    guideFC: GeoJSON.FeatureCollection;
    activeRefKey: string | null;
    lengthLabelsFC: GeoJSON.FeatureCollection;
    handlesFC: GeoJSON.FeatureCollection;
  } | null>(null);
  const previewItemsGeo = dragPreview?.itemsGeo ?? null;
  const snapGuideFC = dragPreview?.guideFC ?? featureCollection([]);
  const activeSnapRefPointKey = dragPreview?.activeRefKey ?? null;
  const previewLengthLabelsFC = dragPreview?.lengthLabelsFC ?? null;
  const previewHandlesFC = dragPreview?.handlesFC ?? null;

  const [previewBoundary, setPreviewBoundary] = useState<{
    x: number;
    y: number;
    rotation: number;
  } | null>(null);

  // rAF coalescing for preview updates — avoids full rebuilds on every native touch sample.
  const previewRafRef = useRef<number | null>(null);

  // Stable fallback origin so the plan doesn't jitter with every telemetry tick during preview.
  // Prefer App's latched GPS when provided so Move/Rotate enter uses the same fallback frame.
  const [stableFallbackOrigin, setStableFallbackOrigin] = useState<{lat: number, lon: number} | null>(null);

  // ── Templates floating origin (parity with legacy) ──
  const [templatesFloatingOrigin, setTemplatesFloatingOrigin] = useState<{
    lat: number;
    lon: number;
  } | null>(null);

  useEffect(() => {
    if (
      previewFallbackGps &&
      Number.isFinite(previewFallbackGps.lat) &&
      Number.isFinite(previewFallbackGps.lon)
    ) {
      // Keep local latch aligned with App — single source of truth for fallback GPS.
      if (
        !stableFallbackOrigin ||
        stableFallbackOrigin.lat !== previewFallbackGps.lat ||
        stableFallbackOrigin.lon !== previewFallbackGps.lon
      ) {
        setStableFallbackOrigin({
          lat: previewFallbackGps.lat,
          lon: previewFallbackGps.lon,
        });
      }
      return;
    }
    if (!stableFallbackOrigin && telemetrySnapshot?.lat != null && telemetrySnapshot?.lon != null) {
      setStableFallbackOrigin({ lat: telemetrySnapshot.lat, lon: telemetrySnapshot.lon });
    } else if (!stableFallbackOrigin && templatesFloatingOrigin) {
      setStableFallbackOrigin(templatesFloatingOrigin);
    }
  }, [
    previewFallbackGps?.lat,
    previewFallbackGps?.lon,
    telemetrySnapshot?.lat,
    telemetrySnapshot?.lon,
    templatesFloatingOrigin,
    stableFallbackOrigin,
  ]);

  useEffect(() => {
    if (!visible || mode !== "templates") {
      setTemplatesFloatingOrigin(null);
      setPreviewBoundary(null);
      return;
    }
    if (previewAnchor || (alignedRefPoints && alignedRefPoints.length > 0) || templatesFloatingOrigin) {
      return;
    }
    if (telemetrySnapshot?.lat != null && telemetrySnapshot?.lon != null) {
      setTemplatesFloatingOrigin({ lat: telemetrySnapshot.lat, lon: telemetrySnapshot.lon });
    } else if (stableFallbackOrigin) {
      setTemplatesFloatingOrigin(stableFallbackOrigin);
    } else {
      setTemplatesFloatingOrigin({ lat: 0, lon: 0 });
    }
  }, [
    visible,
    mode,
    previewAnchor,
    alignedRefPoints,
    telemetrySnapshot?.lat,
    telemetrySnapshot?.lon,
    templatesFloatingOrigin,
    stableFallbackOrigin,
  ]);

  // ── Projection frame + origin (shared with App startPlanEditing — no jump) ──
  const projectionOrigin = useMemo((): MapProjectionOrigin | null => {
    // Shared resolver with App.tsx startPlanEditing / startVisualAlignment — identity enter
    // of Move/Rotate must not rebuild a different frame than the live fields preview.
    // visualAlignmentAnchor stays sticky after bake so the origin does not "chase" geometry.
    const manipulationItem = placedItems?.find(
      (it) => it.id === "visual-alignment-group" || it.id === "plan-editing-group"
    );
    const fallbackGps =
      previewFallbackGps &&
      Number.isFinite(previewFallbackGps.lat) &&
      Number.isFinite(previewFallbackGps.lon)
        ? previewFallbackGps
        : stableFallbackOrigin;
    return resolvePreviewProjectionOrigin({
      mode,
      previewAnchor,
      alignedRefPoints: alignedRefPoints ?? [],
      stagedVerified,
      autoOriginReference: autoOriginReference ?? null,
      autoOriginEnabled,
      geoOrigin,
      // Parent fields-frame wins so switching MapView mode to "templates" for stickers
      // does not re-pick a different projection family mid-session.
      forcedFrame: mapGeometryFrame ?? null,
      visualAlignmentAnchor,
      stableFallbackOrigin: fallbackGps,
      templatesFloatingOrigin,
      lines,
      placedItemLines: manipulationItem?.lines ?? null,
    });
  }, [
    mode,
    previewAnchor,
    alignedRefPoints,
    stagedVerified,
    autoOriginReference,
    autoOriginEnabled,
    geoOrigin,
    mapGeometryFrame,
    templatesFloatingOrigin,
    stableFallbackOrigin,
    previewFallbackGps?.lat,
    previewFallbackGps?.lon,
    lines,
    placedItems,
    visualAlignmentAnchor,
  ]);

  // ── Stable primitive signatures (perf) ──
  // The projection origin object and some incoming array props (e.g. an empty
  // alignedRefPoints default) can change REFERENCE on every telemetry tick even
  // when their CONTENT is unchanged. Deriving cheap primitive signatures and
  // using them as memo deps keeps the heavy FeatureCollection builders (and the
  // native ShapeSource updates they drive) from re-running on every rover tick.
  const originSig = projectionOrigin
    ? `${projectionOrigin.frame}|${projectionOrigin.originLat}|${projectionOrigin.originLon}|${projectionOrigin.originDxfNorth}|${projectionOrigin.originDxfEast}`
    : "none";

  // `placedItems` is passed as an inline array literal from the parent (e.g.
  // `placedItems={isPlacedItemActive && visualAlignmentItem ? [visualAlignmentItem] : []}`
  // in App.tsx), so it gets a NEW reference on every parent render even when it's the
  // same empty/unchanged list — same class of problem originSig solves above.
  const placedItemsSig = placedItems && placedItems.length > 0
    ? placedItems
        .map((it) => `${it.id}:${it.x}:${it.y}:${it.rotation}:${it.scale}:${it.width}:${it.height}:${it.lines.length}`)
        .join("|")
    : "none";

  // Logs only when the resolved origin's CONTENT actually changes (originSig), not on
  // every render/telemetry tick — so this stays readable instead of flooding the console.
  useEffect(() => {
    console.log(
      `[AlignDXF][Map] projectionOrigin -> frame=${projectionOrigin?.frame ?? "null"} ` +
        `originLat=${projectionOrigin?.originLat} originLon=${projectionOrigin?.originLon} ` +
        `originDxfNorth=${projectionOrigin?.originDxfNorth} originDxfEast=${projectionOrigin?.originDxfEast} ` +
        `| mode=${mode} alignedRefPoints=${JSON.stringify(alignedRefPoints)} ` +
        `visualAlignmentAnchor=${JSON.stringify(visualAlignmentAnchor)}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originSig]);

  // ── Multi-Point Fit reference-point snap ──
  // Purely anchored to the reference points' own real-world position — has nothing to do with
  // the DXF plan's coordinate system. All snap math happens in "metres relative to (originLat,
  // originLon)" — the SAME frame `current` is computed in inside onDragMove/onDragCommit below
  // (see the DXF-offset subtraction there), so a point computed here is directly comparable to
  // a point computed there without any extra step.
  const snapRefLocalPoints = useMemo((): SnapRefPoint[] => {
    if (!snapRefPoints || snapRefPoints.length === 0 || !projectionOrigin) return [];
    return snapRefPoints
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({
        ...projectGpsToLocalMeters(p.lat, p.lon, projectionOrigin.originLat, projectionOrigin.originLon),
        lat: p.lat,
        lon: p.lon,
      }));
  }, [snapRefPoints, projectionOrigin?.originLat, projectionOrigin?.originLon]);

  // Fixed DXF-space snap candidates the plan tracks — shape-aware (corners, edge-midpoints,
  // overall center; quadrants+center for a circle/ellipse) rather than just its bounding-box
  // center, so a specific corner/edge can snap onto a reference point, not only the middle.
  // computeShapeSnapPoints excludes extension/transit/virtual_boundary so enabling DXF
  // extensions never moves magnets onto run-up tips. Computed once per geometry change.
  const planEditingSnapCandidates = useMemo((): LocalMeters[] => {
    const item = placedItems?.find((it) => it.id === "plan-editing-group");
    if (!item || !item.lines || item.lines.length === 0) return [];
    return computeShapeSnapPoints(item.lines);
  }, [placedItems]);

  const refPointsSig = useMemo(
    () =>
      (alignedRefPoints ?? [])
        .map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`)
        .join("|"),
    [alignedRefPoints]
  );

  // ── Plan lines (Fields) → FeatureCollection of LineStrings ──
  // Reuses projectPlanLineToGpsSegments (preview_points-first / from→to fallback).
  const planLinesFC = useMemo(() => {
    if (mode === "templates" || !projectionOrigin || lines.length === 0) {
      return featureCollection([]);
    }
    const features: GeoJSON.Feature[] = [];
    for (const line of lines) {
      const segs = projectPlanLineToGpsSegments(line, projectionOrigin);
      if (segs.length >= 2) {
        const coords = segs.map(([lat, lon]) => toMapboxCoord(lat, lon));
        // Road-marking CSV (and any line tagged closed:false) must never render as a
        // closed polygon ring — only explicit geometry.closed === true may close.
        const allowClosed =
          line.entity?.geometry?.closed === true &&
          line.entity?.geometry?.road_marking !== true;
        features.push(
          lineFeature(coords, {
            id: line.id,
            layer: line.layer,
            color: colorForLayer(line.layer),
            closedRing: allowClosed && isClosedCoordRing(coords),
          })
        );
      }
    }
    return featureCollection(features);
  }, [lines, originSig, mode]);

  // ── Offset ghost preview: live drag-only, never committed, not mode-gated ──
  // Offset only exists in Fields, so `ghostLines` is simply never populated when
  // the map is in "templates" mode — no explicit gate needed here.
  const ghostLinesFC = useMemo(() => {
    if (!projectionOrigin || !ghostLines || ghostLines.length === 0) {
      return featureCollection([]);
    }
    const features: GeoJSON.Feature[] = [];
    for (const line of ghostLines) {
      const segs = projectPlanLineToGpsSegments(line, projectionOrigin);
      if (segs.length >= 2) {
        const coords = segs.map(([lat, lon]) => toMapboxCoord(lat, lon));
        features.push(lineFeature(coords, { id: line.id }));
      }
    }
    return featureCollection(features);
  }, [ghostLines, originSig]);

  // ── Rover start pin: exact first vertex of the start travel segment.
  // Uses the same GPS projection as the drawn plan stroke so the red pin sits on
  // the real path start (not a different line and not a screen-space offset).
  const startDirectionFC = useMemo((): GeoJSON.FeatureCollection => {
    if (!projectionOrigin) return featureCollection([]);

    // ── Move / Multi-Point sticker: start line in sticker design, transformed to world ──
    if (mode === "templates") {
      const sticker = placedItems?.find(
        (it) => it.id === "plan-editing-group" || it.id === "visual-alignment-group"
      );
      if (!sticker?.lines?.length) return featureCollection([]);

      const startLine = getPlanStartTravelLine(sticker.lines);
      if (!startLine) return featureCollection([]);

      const renderPts = getPlanLineRenderPoints(startLine, true);
      if (renderPts.length < 2 && !(startLine.from && startLine.to)) {
        return featureCollection([]);
      }
      const n0 = renderPts[0]?.north ?? startLine.from!.x;
      const e0 = renderPts[0]?.east ?? startLine.from!.y;
      const n1 = renderPts[1]?.north ?? startLine.to!.x;
      const e1 = renderPts[1]?.east ?? startLine.to!.y;

      // During drag, stick to the live preview polyline that matches this start line
      // index so the pin tracks the finger-moved plan.
      // Only `previewItemsGeo` here — `placedItemsGeo` is declared later in this
      // component (temporal dead zone / TS2448). Off-drag we fall through to
      // transformVisualDxfPoint from sticker pose, which is the committed truth.
      const startLineIdx = sticker.lines.findIndex((l) => l.id === startLine.id);
      const liveLines = previewItemsGeo?.lines?.features ?? [];
      const liveFeat =
        startLineIdx >= 0 &&
        liveLines[startLineIdx]?.geometry?.type === "LineString" &&
        (liveLines[startLineIdx].geometry as GeoJSON.LineString).coordinates.length >= 2
          ? (liveLines[startLineIdx].geometry as GeoJSON.LineString)
          : null;

      let startCoord: Coord;
      let bearing: number;
      let planNorth: number;
      let planEast: number;

      if (liveFeat) {
        const coords = liveFeat.coordinates as Coord[];
        startCoord = coords[0];
        const [lon1, lat1] = coords[0];
        const [lon2, lat2] = coords[1];
        const dLat = lat2 - lat1;
        const dLon = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
        bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
        // World metres under current sticker pose (committed or last bake mid-drag).
        const w0 = transformVisualDxfPoint(n0, e0, sticker);
        planNorth = w0.north;
        planEast = w0.east;
      } else {
        const w0 = transformVisualDxfPoint(n0, e0, sticker);
        const w1 = transformVisualDxfPoint(n1, e1, sticker);
        planNorth = w0.north;
        planEast = w0.east;
        const startGps = projectPlanNorthEastToGps(w0.north, w0.east, projectionOrigin);
        const tipGps = projectPlanNorthEastToGps(w1.north, w1.east, projectionOrigin);
        startCoord = toMapboxCoord(startGps.lat, startGps.lon);
        const dLat = tipGps.lat - startGps.lat;
        const dLon =
          (tipGps.lon - startGps.lon) * Math.cos((startGps.lat * Math.PI) / 180);
        bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
      }

      return featureCollection([
        pointFeature(startCoord, {
          kind: "start-origin",
          bearing,
          label: "FROM",
          planNorth,
          planEast,
        }),
      ]);
    }

    // ── Fields: identical first vertex as planLinesFC stroke ──
    if (lines.length === 0) return featureCollection([]);
    const startLine = getPlanStartTravelLine(lines);
    if (!startLine) return featureCollection([]);

    const segs = projectPlanLineToGpsSegments(startLine, projectionOrigin);
    if (segs.length < 2) return featureCollection([]);

    const [lat1, lon1] = segs[0];
    const [lat2, lon2] = segs[1];
    const startCoord = toMapboxCoord(lat1, lon1);

    const dLat = lat2 - lat1;
    const dLon = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
    const bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;

    const renderPts = getPlanLineRenderPoints(startLine, true);
    const planNorth = renderPts[0]?.north ?? startLine.from?.x ?? 0;
    const planEast = renderPts[0]?.east ?? startLine.from?.y ?? 0;

    return featureCollection([
      pointFeature(startCoord, {
        kind: "start-origin",
        bearing,
        label: "FROM",
        planNorth,
        planEast,
      }),
    ]);
  }, [lines, originSig, mode, projectionOrigin, placedItems, previewItemsGeo]);

  // ── Multi-Point pickable vertex anchors (shown only while guide-point mode is on) ──
  // Clickable dots on path endpoints / corners so operators do not need a perfect path hit.
  const multiPointPickAnchorsFC = useMemo((): GeoJSON.FeatureCollection => {
    if (!onSelectPoint || mode === "templates" || !projectionOrigin || lines.length === 0) {
      return featureCollection([]);
    }

    const keyOf = (n: number, e: number) => `${n.toFixed(3)},${e.toFixed(3)}`;
    const seen = new Set<string>();
    const features: GeoJSON.Feature[] = [];

    const pushVertex = (north: number, east: number, isStart = false) => {
      if (!Number.isFinite(north) || !Number.isFinite(east)) return;
      const key = keyOf(north, east);
      if (seen.has(key)) return;
      seen.add(key);
      const gps = projectPlanNorthEastToGps(north, east, projectionOrigin);
      features.push(
        pointFeature(toMapboxCoord(gps.lat, gps.lon), {
          kind: isStart ? "pick-start" : "pick-vertex",
          planNorth: north,
          planEast: east,
        })
      );
    };

    // Plan start first so it stays in the set even if filtered layers skip its line.
    const startPt = getPlanStartPoint(lines);
    if (startPt) pushVertex(startPt.north, startPt.east, true);

    for (const line of lines) {
      if (
        line.layer === "virtual_boundary" ||
        line.layer === "transit" ||
        line.layer === "extension"
      ) {
        continue;
      }

      if (isCurveEntity(line) || isCircleLikeLine(line)) {
        for (const pt of getCurveSelectionAnchors(line)) {
          pushVertex(pt.north, pt.east);
        }
        continue;
      }

      const pts = getPlanLineRenderPoints(line, true);
      if (pts.length >= 2) {
        // Endpoints + a few mid vertices (skip dense curve samples)
        pushVertex(pts[0].north, pts[0].east);
        pushVertex(pts[pts.length - 1].north, pts[pts.length - 1].east);
        if (pts.length <= 8) {
          for (let i = 1; i < pts.length - 1; i++) {
            pushVertex(pts[i].north, pts[i].east);
          }
        } else {
          // Sparse intermediate samples for long polylines
          const step = Math.max(1, Math.floor(pts.length / 6));
          for (let i = step; i < pts.length - 1; i += step) {
            pushVertex(pts[i].north, pts[i].east);
          }
        }
      } else {
        if (line.from) pushVertex(line.from.x, line.from.y);
        if (line.to) pushVertex(line.to.x, line.to.y);
      }
    }

    return featureCollection(features);
  }, [onSelectPoint, mode, projectionOrigin, originSig, lines]);

  // ── Anchor point selection: selectable candidate dots for the isolated target ──
  // Caller (App) resolves the candidate list from the Anchor target's isolated
  // lines only (CSV raw survey rows / DXF entity endpoints) — this component just
  // renders whatever it's given and reports back which one was tapped.
  const anchorCandidatesFC = useMemo((): GeoJSON.FeatureCollection => {
    if (!anchorCandidates || anchorCandidates.length === 0 || !projectionOrigin) {
      return featureCollection([]);
    }
    const features: GeoJSON.Feature[] = [];
    for (const c of anchorCandidates) {
      if (!Number.isFinite(c.north) || !Number.isFinite(c.east)) continue;
      const gps = projectPlanNorthEastToGps(c.north, c.east, projectionOrigin);
      features.push(
        pointFeature(toMapboxCoord(gps.lat, gps.lon), {
          lineId: c.lineId,
          planNorth: c.north,
          planEast: c.east,
          kind: c.kind,
        })
      );
    }
    return featureCollection(features);
  }, [anchorCandidates, projectionOrigin]);

  const handleAnchorCandidatePress = useCallback(
    (event: ShapeSourcePressEvent) => {
      const f = event.features?.[0];
      const props2 = (f?.properties ?? {}) as Record<string, unknown>;
      const north = Number(props2.planNorth);
      const east = Number(props2.planEast);
      const lineId = String(props2.lineId ?? "");
      const kind = props2.kind === "dxf" ? "dxf" : "csv";
      if (!lineId || !Number.isFinite(north) || !Number.isFinite(east)) return;
      onAnchorCandidateSelect?.({ lineId, north, east, kind });
    },
    [onAnchorCandidateSelect]
  );

  // ── Fields selection: highlighted line(s) + corner points ──
  // `highlightedLines`, when provided, is an explicit, already-resolved set (e.g. every
  // extension-layer or transit-layer line for a "select all of this type" broadcast click
  // from the Path Order & Load list) — it may include lines this component's own `lines`
  // prop doesn't contain (that prop is already visibility-filtered by the caller), so the
  // caller resolves the set rather than this component re-deriving it from `lines`.
  // Falls back to the single `selectedLineId` match against `lines` when absent, matching
  // the original single-select behavior used by every other caller of this component.
  const linesToHighlight = useMemo(() => {
    if (highlightedLines && highlightedLines.length > 0) return highlightedLines;
    if (!selectedLineId) return [];
    const selected = lines.find((l) => l.id === selectedLineId);
    return selected ? [selected] : [];
  }, [highlightedLines, selectedLineId, lines]);

  const selectionFC = useMemo(() => {
    if (mode !== "fields" || !projectionOrigin || linesToHighlight.length === 0) {
      return { line: featureCollection([]), corners: featureCollection([]), labels: featureCollection([]) };
    }
    const lineFeatures: GeoJSON.Feature[] = [];
    const cornerFeatures: GeoJSON.Feature[] = [];
    const labelFeatures: GeoJSON.Feature[] = [];
    for (const selected of linesToHighlight) {
      const segs = projectPlanLineToGpsSegments(selected, projectionOrigin);
      if (segs.length < 2) continue;
      const coords = segs.map(([lat, lon]) => toMapboxCoord(lat, lon));
      const allowClosed =
        selected.entity?.geometry?.closed === true &&
        selected.entity?.geometry?.road_marking !== true;
      const closedRing = allowClosed && isClosedCoordRing(coords);
      lineFeatures.push(lineFeature(coords, { closedRing }));

      // Road-marking CSV paths are densely sampled (straights + arcs). Plotting a blue
      // corner dot on every vertex floods the map — keep the blue stroke only.
      const isRoadMarkingCsv =
        selected.id === "local-csv-path" ||
        selected.entity?.geometry?.road_marking === true ||
        selected.entity?.entity_id === "local-csv-path";
      if (!isRoadMarkingCsv) {
        const cornerAnchors = isCurveEntity(selected) || isCircleLikeLine(selected)
          ? getCurveSelectionAnchors(selected).map((pt) => {
              const gps = projectPlanNorthEastToGps(pt.north, pt.east, projectionOrigin);
              return pointFeature(toMapboxCoord(gps.lat, gps.lon));
            })
          : coords.map((c) => pointFeature(c));
        cornerFeatures.push(...cornerAnchors);
      }

      const midSeg = segs[Math.floor(segs.length / 2)];
      const lengthM = getLineLengthM(selected);
      if (midSeg && lengthM != null) {
        const [midLat, midLon] = midSeg;
        labelFeatures.push(
          pointFeature(toMapboxCoord(midLat, midLon), {
            label: `${formatFinite(lengthM, 2)} m`,
            offset: [0, -1.4],
          })
        );
      }
    }
    return {
      line: featureCollection(lineFeatures),
      corners: featureCollection(cornerFeatures),
      labels: featureCollection(labelFeatures),
    };
  }, [mode, originSig, linesToHighlight]);

  // ── Reference points (labels only — no green map dots; multi-point uses gold pins) ──
  const refPointsFC = useMemo(() => {
    if (!alignedRefPoints || alignedRefPoints.length === 0) return featureCollection([]);
    const features = alignedRefPoints.map((p, i) =>
      pointFeature(toMapboxCoord(p.lat, p.lon), {
        label: `Ref #${i + 1}`,
      })
    );
    return featureCollection(features);
  }, [refPointsSig]);

  // ── Selected alignment points (highlighted in yellow — or brighter/bigger, per
  // isSnapActive, while the Multi-Point Fit plan is being dragged close to one of them) ──
  const selectedPointsFC = useMemo(() => {
    if (!selectedPoints || selectedPoints.length === 0) {
      return featureCollection([]);
    }
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    selectedPoints.forEach((p, i) => {
      // A point with a known real-world coordinate (typed in or CSV-imported) renders
      // THERE — never re-projected through the provisional plan-preview origin, which
      // may be a stale/unrelated anchor (rover position, a prior alignment, etc.) and
      // has nothing to do with this point's actual location.
      // planNorth/East always stored so ShapeSource onPress can toggle selection.
      const planProps = {
        id: `sp-${i}`,
        index: i + 1,
        planNorth: p.x,
        planEast: p.y,
      };

      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        // Matched by VALUE (not index) against activeSnapRefPointKey — `selectedPoints` (every
        // ref point) and the filtered, snap-eligible `snapRefPoints` can diverge in index when a
        // tapped point hasn't had its lat/lon filled in yet, so index correspondence isn't safe.
        const isSnapActive =
          activeSnapRefPointKey ===
          refPointKey({ lat: p.lat as number, lon: p.lon as number });
        // While the yellow dashed snap-guide is locked to this pin, omit the pin entirely
        // so the dashed line does not terminate in a yellow endpoint blob.
        if (isSnapActive) return;
        features.push(
          pointFeature(toMapboxCoord(p.lat as number, p.lon as number), {
            ...planProps,
            isSnapActive: 0,
          })
        );
        return;
      }
      // No coordinate yet (freshly tapped, not filled in) — show where it sits on the
      // currently-previewed plan so it lines up with what the user just tapped.
      if (!projectionOrigin) return;
      // In FieldsPage/App.tsx, p.x is Northing (dxf_y) and p.y is Easting (dxf_x)
      const gps = projectPlanNorthEastToGps(p.x, p.y, projectionOrigin);
      features.push(
        pointFeature(toMapboxCoord(gps.lat, gps.lon), {
          ...planProps,
          isSnapActive: false,
        })
      );
    });
    return featureCollection(features);
  }, [selectedPoints, originSig, activeSnapRefPointKey]);

  // Content-based signature so the log below fires only on real changes, not on every
  // FieldsPage render (selectedPoints is a fresh array reference each render there).
  const selectedPointsSig = (selectedPoints ?? [])
    .map((p) => `${p.x},${p.y},${p.lat ?? ""},${p.lon ?? ""}`)
    .join("|");
  useEffect(() => {
    if (!selectedPoints || selectedPoints.length === 0) return;
    console.log(
      `[AlignDXF][Map] Yellow ref-point dots (${selectedPoints.length}):`,
      JSON.stringify(
        selectedPoints.map((p) => ({
          dxf_north: p.x,
          dxf_east: p.y,
          usingOwnLatLon: Number.isFinite(p.lat) && Number.isFinite(p.lon),
          lat: p.lat,
          lon: p.lon,
        }))
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPointsSig]);

  // ── Virtual bounding box corners and dimension labels ──
  const { virtualBoxCornersFC, virtualBoxLabelsFC } = useMemo(() => {
    if (!projectionOrigin || lines.length === 0) {
      return { virtualBoxCornersFC: featureCollection([]), virtualBoxLabelsFC: featureCollection([]) };
    }
    const vbLines = lines.filter((l) => l.layer === "virtual_boundary");
    if (vbLines.length === 0) {
      return { virtualBoxCornersFC: featureCollection([]), virtualBoxLabelsFC: featureCollection([]) };
    }

    const seenCorners = new Set<string>();
    const cornerFeatures: GeoJSON.Feature[] = [];
    let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
    for (const line of vbLines) {
      minN = Math.min(minN, line.from.x, line.to.x);
      maxN = Math.max(maxN, line.from.x, line.to.x);
      minE = Math.min(minE, line.from.y, line.to.y);
      maxE = Math.max(maxE, line.from.y, line.to.y);
    }
    const centerN = (minN + maxN) / 2;
    const centerE = (minE + maxE) / 2;

    const labelFeatures: GeoJSON.Feature[] = [];
    for (const line of vbLines) {
      const segs = projectPlanLineToGpsSegments(line, projectionOrigin);
      if (segs.length >= 2) {
        const [lat1, lon1] = segs[0];
        const k1 = `${lat1.toFixed(6)},${lon1.toFixed(6)}`;
        if (!seenCorners.has(k1)) {
          seenCorners.add(k1);
          cornerFeatures.push(pointFeature(toMapboxCoord(lat1, lon1)));
        }
        const [lat2, lon2] = segs[segs.length - 1];
        const k2 = `${lat2.toFixed(6)},${lon2.toFixed(6)}`;
        if (!seenCorners.has(k2)) {
          seenCorners.add(k2);
          cornerFeatures.push(pointFeature(toMapboxCoord(lat2, lon2)));
        }

        const midLat = (lat1 + lat2) / 2;
        const midLon = (lon1 + lon2) / 2;
        const midN = (line.from.x + line.to.x) / 2;
        const midE = (line.from.y + line.to.y) / 2;
        const lenM = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
        const isHorizontal = Math.abs(line.to.y - line.from.y) > Math.abs(line.to.x - line.from.x);

        let label = "";
        let offset: [number, number] = [0, 0];
        if (isHorizontal) {
          label = `Width: ${lenM.toFixed(2)}m`;
          offset = midN > centerN ? [0, -1.2] : [0, 1.2];
        } else {
          label = midE > centerE ? `Height: ${lenM.toFixed(2)}m` : `Length: ${lenM.toFixed(2)}m`;
          offset = midE > centerE ? [2.5, 0] : [-2.5, 0];
        }
        labelFeatures.push(
          pointFeature(toMapboxCoord(midLat, midLon), {
            label,
            offset,
          })
        );
      }
    }
    return {
      virtualBoxCornersFC: featureCollection(cornerFeatures),
      virtualBoxLabelsFC: featureCollection(labelFeatures),
    };
  }, [lines, originSig, mode]);

  // ── Rover geometry (ISOLATED memo — telemetry hot path, see plan §9.1) ──
  // Only depends on rover fields + lines/origin so high-frequency updates never
  // re-render the plan/boundary/item sources.
  const roverGeo = useMemo(() => {
    const lat = telemetrySnapshot?.lat;
    const lon = telemetrySnapshot?.lon;
    const heading = telemetrySnapshot?.heading_ned_deg ?? null;

    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { center: null as Coord | null, heading, rangeCircle: null as GeoJSON.Feature<GeoJSON.Polygon> | null, targetLine: null as GeoJSON.FeatureCollection | null, targetPoint: null as Coord | null };
    }

    const center = toMapboxCoord(lat, lon);
    // 1.5 m real-world range circle via Turf (circleRadius px cannot do metres).
    // 48 steps stays smooth at editing zooms (19–22) without Mapbox overzoom faceting
    // once the ShapeSource uses PLAN_SOURCE_MAX_ZOOM / TOLERANCE below.
    const rangeCircle = circle(center, 1.5, { steps: 48, units: "meters" }) as GeoJSON.Feature<GeoJSON.Polygon>;

    // Next-target: active waypoint or plan start point ahead of the rover
    let targetPoint: Coord | null = null;
    let targetDist: number | null = null;
    if (lines.length > 0 && projectionOrigin) {
      const missionRunningOrPaused =
        telemetrySnapshot?.mission_state === "running" ||
        telemetrySnapshot?.mission_state === "paused";
      const idx = missionRunningOrPaused
        ? Math.min(
            Math.max(0, telemetrySnapshot?.projection_segment_index ?? 0),
            lines.length - 1
          )
        : 0;
      const targetSeg = lines[idx];
      if (targetSeg && targetSeg.from && targetSeg.to) {
        // When waiting/idle, destination is the very start of the path (from).
        // When running/paused, destination is the active segment end (to).
        const target = missionRunningOrPaused
          ? { x: targetSeg.to.x, y: targetSeg.to.y }
          : { x: targetSeg.from.x, y: targetSeg.from.y };
        const gps = projectPlanNorthEastToGps(target.x, target.y, projectionOrigin);
        // Calculate real physical distance on Earth (meters) between rover GPS and target GPS
        const dLatMeters = (gps.lat - lat) * 111320;
        const dLonMeters = (gps.lon - lon) * (111320 * Math.cos((lat * Math.PI) / 180));
        const dist = Math.hypot(dLatMeters, dLonMeters);
        if (dist < 10000) {
          targetDist = dist;
          targetPoint = toMapboxCoord(gps.lat, gps.lon);
        }
      }
    }

    const targetLine =
      targetPoint != null && targetDist != null
        ? featureCollection([
            lineFeature([center, targetPoint]),
            pointFeature(
              [(center[0] + targetPoint[0]) / 2, (center[1] + targetPoint[1]) / 2],
              { label: `${targetDist.toFixed(1)} m` }
            ),
          ])
        : null;

    return { center, heading, rangeCircle, targetLine, targetPoint };
  }, [
    telemetrySnapshot?.lat,
    telemetrySnapshot?.lon,
    telemetrySnapshot?.heading_ned_deg,
    telemetrySnapshot?.mission_state,
    telemetrySnapshot?.projection_segment_index,
    lines,
    originSig,
  ]);

  // ── Placed items (Templates): lines + bounding boxes ──
  // Circle/arc entities are intentionally NOT special-cased here — they flow through the same
  // getPlanLineRenderPoints() tessellation + per-point transformVisualDxfPoint() path as every
  // other shape (matches planLinesFC's static Fields preview). A native Mapbox CircleLayer
  // ("true circle", zoom-interpolated from a meterRadius property) was tried twice here — once
  // for all placed-item circles, once restricted to only the non-dragging steady state — and
  // both times reproduced the same visible shrink. Whatever the underlying cause turns out to
  // be, plain tessellated polyline points are what has actually been confirmed shrink-free, so
  // that's what both the steady state and the live drag preview use — do not reintroduce
  // CircleLayer for placed-item circles without a way to actually verify the fix on-device.
  const placedItemsGeo = useMemo(() => {
    if (mode !== "templates" || !placedItems || placedItems.length === 0 || !projectionOrigin) {
      return { lines: featureCollection([]), boxes: featureCollection([]) };
    }
    const lineFeatures: GeoJSON.Feature[] = [];
    const boxFeatures: GeoJSON.Feature[] = [];

    for (const item of placedItems) {
      const selected = selectedItemIds?.includes(item.id) ?? false;
      // Item lines via the shared visual transform (north/east → GPS).
      for (const l of item.lines) {
        const renderPoints = getPlanLineRenderPoints(l, true);
        if (renderPoints.length >= 2) {
          const coords: Coord[] = renderPoints.map((pt) => {
            const tp = transformVisualDxfPoint(pt.north, pt.east, item);
            const gps = projectPlanNorthEastToGps(tp.north, tp.east, projectionOrigin);
            return toMapboxCoord(gps.lat, gps.lon);
          });
          lineFeatures.push(lineFeature(coords, { itemId: item.id, selected }));
        } else {
          const fromP = transformVisualDxfPoint(l.from.x, l.from.y, item);
          const toP = transformVisualDxfPoint(l.to.x, l.to.y, item);
          const fromGps = projectPlanNorthEastToGps(fromP.north, fromP.east, projectionOrigin);
          const toGps = projectPlanNorthEastToGps(toP.north, toP.east, projectionOrigin);
          lineFeatures.push(
            lineFeature(
              [toMapboxCoord(fromGps.lat, fromGps.lon), toMapboxCoord(toGps.lat, toGps.lon)],
              { itemId: item.id, selected }
            )
          );
        }
      }
      // OBB from design-space line bbox (absolute DXF coords), then sticker transform.
      // Do not assume geometry is centred at design origin — that shifted the cyan
      // frame away from the plan on Move/Rotate enter for real DXF uploads.
      const obb = designObbFromLines(item.lines);
      const halfN = (obb.height > 0 ? obb.height : item.height) / 2;
      const halfE = (obb.width > 0 ? obb.width : item.width) / 2;
      const cN = obb.height > 0 || obb.width > 0 ? obb.designCenterNorth : 0;
      const cE = obb.height > 0 || obb.width > 0 ? obb.designCenterEast : 0;
      const cornersDesign = [
        { n: cN - halfN, e: cE - halfE },
        { n: cN - halfN, e: cE + halfE },
        { n: cN + halfN, e: cE + halfE },
        { n: cN + halfN, e: cE - halfE },
      ];
      // transformVisualDxfPoint already applies item.scaleNorth/scaleEast when set.
      const ring: Coord[] = cornersDesign.map((c) => {
        const tp = transformVisualDxfPoint(c.n, c.e, item);
        const gps = projectPlanNorthEastToGps(tp.north, tp.east, projectionOrigin);
        return toMapboxCoord(gps.lat, gps.lon);
      });
      ring.push(ring[0]); // close the polygon ring
      boxFeatures.push({
        type: "Feature",
        properties: { itemId: item.id, selected },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }

    return {
      lines: featureCollection(lineFeatures),
      boxes: featureCollection(boxFeatures),
    };
    // placedItemsSig (not placedItems) is the dependency — see its definition above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, placedItemsSig, selectedItemIds, originSig]);

  // ── Boundary box (Templates): outer + indent + control points ──
  const boundaryGeo = useMemo(() => {
    if (
      mode !== "templates" ||
      !projectionOrigin ||
      !boundaryWidth ||
      !boundaryHeight
    ) {
      return { outer: featureCollection([]), indent: featureCollection([]), controlPoints: featureCollection([]), labelCoord: null as Coord | null, rotDeg: 0 };
    }
    const bpX = (previewBoundary ? previewBoundary.x : boundaryPosition?.x) ?? 0;
    const bpY = (previewBoundary ? previewBoundary.y : boundaryPosition?.y) ?? 0;
    const rotDeg = (previewBoundary ? previewBoundary.rotation : boundaryRotation) ?? 0;
    const halfW = boundaryWidth / 2;
    const halfH = boundaryHeight / 2;

    const rad = ((rotDeg || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const projectRotated = (dn: number, de: number): Coord => {
      const n = (dn * cos - de * sin) + bpY;
      const e = (dn * sin + de * cos) + bpX;
      const gps = projectPlanNorthEastToGps(n, e, projectionOrigin);
      return toMapboxCoord(gps.lat, gps.lon);
    };

    const outerRing: Coord[] = [
      projectRotated(-halfH, -halfW),
      projectRotated(-halfH, halfW),
      projectRotated(halfH, halfW),
      projectRotated(halfH, -halfW),
      projectRotated(-halfH, -halfW),
    ];

    let indentFeatures: GeoJSON.Feature[] = [];
    if (indentSpacing && indentSpacing > 0) {
      const indW = halfW - indentSpacing;
      const indH = halfH - indentSpacing;
      if (indW > 0 && indH > 0) {
        const indentRing: Coord[] = [
          projectRotated(-indH, -indW),
          projectRotated(-indH, indW),
          projectRotated(indH, indW),
          projectRotated(indH, -indW),
          projectRotated(-indH, -indW),
        ];
        indentFeatures = [lineFeature(indentRing)];
      }
    }

    // 8 control points (4 corners + 4 midpoints), matching legacy ids.
    let controlPointFeatures: GeoJSON.Feature[] = [];
    if (showBoundaryPoints) {
      const c = outerRing;
      const mid = (a: Coord, b: Coord): Coord => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const pts: { id: string; coord: Coord }[] = [
        { id: "corner-tl", coord: c[0] },
        { id: "corner-tr", coord: c[1] },
        { id: "corner-br", coord: c[2] },
        { id: "corner-bl", coord: c[3] },
        { id: "midpoint-t", coord: mid(c[0], c[1]) },
        { id: "midpoint-r", coord: mid(c[1], c[2]) },
        { id: "midpoint-b", coord: mid(c[2], c[3]) },
        { id: "midpoint-l", coord: mid(c[3], c[0]) },
      ];
      controlPointFeatures = pts.map((p) =>
        pointFeature(p.coord, { id: p.id, active: p.id === activeSnapPointId })
      );
    }

    const labelCoord = projectRotated(halfH + 1.5, 0);

    const isSelected = selectedItemIds?.includes("boundary") ?? false;
    return {
      outer: featureCollection([lineFeature(outerRing, { selected: isSelected })]),
      indent: featureCollection(indentFeatures),
      controlPoints: featureCollection(controlPointFeatures),
      labelCoord: [labelCoord[0], labelCoord[1]] as Coord,
      rotDeg,
    };
  }, [
    mode,
    originSig,
    boundaryWidth,
    boundaryHeight,
    indentSpacing,
    boundaryPosition,
    boundaryRotation,
    previewBoundary,
    showBoundaryPoints,
    activeSnapPointId,
    selectedItemIds,
  ]);

  // ── Gesture editing flag ──
  // When true, the map's own pan/zoom must be suppressed to prevent fighting
  // the editing gestures. Updated on the JS thread at gesture start/end.
  const isGestureEditing = gestureEditType !== null;

  // ── Gesture: calibrate meters-per-pixel at gesture start ──
  // Async — called once per gesture-start to calibrate the synchronous
  // pixelDeltaToMetres path used for all subsequent move events.
  // Uses a Reanimated shared value (NOT useRef) so the worklet can read it
  // safely without triggering "tried to modify key `current`" warnings.
  const metersPerPixelSV = useSharedValue(0.05); // fallback ~zoom-17

  const calibrateMetersPerPixel = useCallback(
    async (touchX: number, touchY: number) => {
      if (!mapViewRef.current) return;
      const geo1 = await screenToGeo(mapViewRef.current, { x: touchX, y: touchY });
      const geo2 = await screenToGeo(mapViewRef.current, { x: touchX + 100, y: touchY });
      if (geo1 && geo2) {
        const mpp = deriveMetersPerPixel(
          { x: touchX, y: touchY },
          geo1,
          { x: touchX + 100, y: touchY },
          geo2
        );
        if (mpp !== null && mpp > 0) {
          // Assign on the JS thread — metersPerPixelSV is a shared value,
          // safe to assign from JS. Worklets read it via .value.
          metersPerPixelSV.value = mpp;
        }
      }
    },
    [metersPerPixelSV]
  );

  // Gestures only while something is selected — tap outside deselects so the map
  // can pan/zoom freely; tap the plan reselects and re-enables drag/rotate/resize.
  const hasEditableSelection =
    mode === "templates" &&
    (
      (selectedItemIds != null && selectedItemIds.length > 0) ||
      (selectedItemIds != null && selectedItemIds.includes("boundary"))
    );

  // ── Drag helpers (JS thread — called from worklet via runOnJS) ──

  /**
   * Build the indent BoundingRect for clampToIndent, matching the legacy
   * "leftIndent / rightIndent / topIndent / bottomIndent" calculation.
   */
  const buildIndentRect = useCallback((): BoundingRect | null => {
    if (!boundaryWidth || !boundaryHeight) return null;
    const bpX = boundaryPosition?.x ?? 0;
    const bpY = boundaryPosition?.y ?? 0;
    const indent = indentSpacing ?? 0;
    return {
      leftEast:    bpX - boundaryWidth / 2 + indent,
      rightEast:   bpX + boundaryWidth / 2 - indent,
      bottomNorth: bpY - boundaryHeight / 2 + indent,
      topNorth:    bpY + boundaryHeight / 2 - indent,
    };
  }, [boundaryWidth, boundaryHeight, indentSpacing, boundaryPosition]);

  /**
   * Decimate dense tessellation for live drag previews only — full quality returns on commit
   * via placedItemsGeo. Keeps snap math independent (uses shape candidates, not this geo).
   */
  const decimateRenderPoints = useCallback(
    (points: { north: number; east: number }[], maxVertices: number) => {
      if (points.length <= maxVertices) return points;
      const step = Math.ceil(points.length / maxVertices);
      const out: { north: number; east: number }[] = [];
      for (let i = 0; i < points.length; i += step) out.push(points[i]);
      const last = points[points.length - 1];
      const prev = out[out.length - 1];
      if (!prev || prev.north !== last.north || prev.east !== last.east) out.push(last);
      return out;
    },
    []
  );

  /**
   * Build a preview FeatureCollection for the given shifted items.
   * Reuses the same projection logic as placedItemsGeo — kept in sync manually.
   * `lod: "drag"` decimates vertices for plan-editing-group to avoid JS thread saturation.
   */
  const buildItemsGeoForItems = useCallback(
    (
      items: PlacedItem[],
      lod: "full" | "drag" = "full"
    ): {
      lines: GeoJSON.FeatureCollection;
      boxes: GeoJSON.FeatureCollection;
    } => {
      if (!projectionOrigin) {
        return { lines: featureCollection([]), boxes: featureCollection([]) };
      }
      const lineFeatures: GeoJSON.Feature[] = [];
      const boxFeatures: GeoJSON.Feature[] = [];

      for (const item of items) {
        const selected = selectedItemIds?.includes(item.id) ?? false;
        const useDragLod = lod === "drag" && item.id === "plan-editing-group";
        for (const l of item.lines) {
          let renderPoints = getPlanLineRenderPoints(l, true);
          if (useDragLod) {
            renderPoints = decimateRenderPoints(renderPoints, DRAG_PREVIEW_MAX_VERTICES);
          }
          if (renderPoints.length >= 2) {
            const coords: Coord[] = renderPoints.map((pt) => {
              const tp = transformVisualDxfPoint(pt.north, pt.east, item);
              const gps = projectPlanNorthEastToGps(tp.north, tp.east, projectionOrigin);
              return toMapboxCoord(gps.lat, gps.lon);
            });
            lineFeatures.push(lineFeature(coords, { itemId: item.id, selected }));
          } else {
            const fromP = transformVisualDxfPoint(l.from.x, l.from.y, item);
            const toP   = transformVisualDxfPoint(l.to.x,   l.to.y,   item);
            const fG = projectPlanNorthEastToGps(fromP.north, fromP.east, projectionOrigin);
            const tG = projectPlanNorthEastToGps(toP.north,   toP.east,   projectionOrigin);
            lineFeatures.push(
              lineFeature(
                [toMapboxCoord(fG.lat, fG.lon), toMapboxCoord(tG.lat, tG.lon)],
                { itemId: item.id, selected }
              )
            );
          }
        }
        const obb = designObbFromLines(item.lines);
        const halfN = (obb.height > 0 ? obb.height : item.height) / 2;
        const halfE = (obb.width > 0 ? obb.width : item.width) / 2;
        const cN = obb.height > 0 || obb.width > 0 ? obb.designCenterNorth : 0;
        const cE = obb.height > 0 || obb.width > 0 ? obb.designCenterEast : 0;
        const ring: Coord[] = [
          { n: cN - halfN, e: cE - halfE },
          { n: cN - halfN, e: cE + halfE },
          { n: cN + halfN, e: cE + halfE },
          { n: cN + halfN, e: cE - halfE },
        ].map((c) => {
          const tp = transformVisualDxfPoint(c.n, c.e, item);
          const g = projectPlanNorthEastToGps(tp.north, tp.east, projectionOrigin);
          return toMapboxCoord(g.lat, g.lon);
        });
        ring.push(ring[0]);
        boxFeatures.push({
          type: "Feature",
          properties: { itemId: item.id, selected },
          geometry: { type: "Polygon", coordinates: [ring] },
        });
      }
      return {
        lines: featureCollection(lineFeatures),
        boxes: featureCollection(boxFeatures),
      };
    },
    [projectionOrigin, selectedItemIds, decimateRenderPoints]
  );

  /**
   * Called via runOnJS from the worklet on every gesture move (RAF-coalesced).
   * Reads the current panDeltaN/E shared values, applies them to the snapshot
   * positions, rebuilds preview geometry, and sets previewItemsGeo state.
   */
  // Builds the Figma/Illustrator-style snap guide line from the reference point to the plan's
  // snap anchor. The point end uses its OWN lat/lon directly (no round-trip through local
  // metres) — highlighting that same point is handled separately by selectedPointsFC's
  // isSnapActive styling, driven off activeSnapRefPointKey. A `null` guide clears it (nothing
  // nearby, or the gesture just ended).
  const buildSnapGuideFC = useCallback(
    (guide: { point: SnapRefPoint; anchor: LocalMeters } | null): GeoJSON.FeatureCollection => {
      if (!guide || !projectionOrigin) return featureCollection([]);
      const anchorGps = projectLocalMetersToGps(guide.anchor.north, guide.anchor.east, projectionOrigin.originLat, projectionOrigin.originLon);
      const pointCoord = toMapboxCoord(guide.point.lat, guide.point.lon);
      const anchorCoord = toMapboxCoord(anchorGps.lat, anchorGps.lon);
      return featureCollection([lineFeature([pointCoord, anchorCoord], { id: "ref-point-snap-guide-line" })]);
    },
    [projectionOrigin?.originLat, projectionOrigin?.originLon]
  );

  const poseFromPlanItem = useCallback((item: PlacedItem): PlanStickerPose => {
    const obb = designObbFromLines(item.lines);
    return {
      x: item.x,
      y: item.y,
      rotation: item.rotation || 0,
      scale: item.scale || 1,
      scaleNorth: item.scaleNorth,
      scaleEast: item.scaleEast,
      width: obb.width > 0 ? obb.width : item.width,
      height: obb.height > 0 ? obb.height : item.height,
      designCenterNorth: obb.designCenterNorth,
      designCenterEast: obb.designCenterEast,
    };
  }, []);

  /**
   * Per-path length labels in world metres — always on when geometry is visible.
   * Real-time: called with live sticker poses during drag/resize previews.
   */
  const buildLengthLabelsFC = useCallback(
    (items: PlacedItem[]): GeoJSON.FeatureCollection => {
      if (!projectionOrigin) return featureCollection([]);
      const phase = planPlacementPhaseRef.current;
      const features: GeoJSON.Feature[] = [];
      for (const item of items) {
        if (item.id !== "plan-editing-group" && item.id !== "visual-alignment-group") {
          continue;
        }

        // Per-path length labels (including during resize) — only when the operator has
        // enabled Layers ▸ Lengths. The W × H resize pill below is deliberately NOT gated:
        // it is live feedback for an in-progress gesture, not a passive detail label.
        if (showLengths) {
          const labels = buildPlanLengthLabels(item.lines, {
            x: item.x,
            y: item.y,
            rotation: item.rotation || 0,
            scale: item.scale || 1,
            scaleNorth: item.scaleNorth,
            scaleEast: item.scaleEast,
          });
          for (const lbl of labels) {
            const gps = projectPlanNorthEastToGps(lbl.north, lbl.east, projectionOrigin);
            features.push(
              pointFeature(toMapboxCoord(gps.lat, gps.lon), {
                id: lbl.id,
                label: lbl.label,
              })
            );
          }
        }

        // Resize phase: also show live W × H m pill below the OBB.
        if (phase === "resizing" && item.id === "plan-editing-group") {
          const pose = poseFromPlanItem(item);
          const sE = effectiveScaleEast(pose);
          const sN = effectiveScaleNorth(pose);
          const widthM = pose.width * sE;
          const heightM = pose.height * sN;
          const cN = pose.designCenterNorth ?? 0;
          const cE = pose.designCenterEast ?? 0;
          const pillDesignN = cN - pose.height / 2 - Math.max(1.2, pose.height * 0.08);
          const pillWorld = transformVisualDxfPoint(pillDesignN, cE, item);
          const gps = projectPlanNorthEastToGps(pillWorld.north, pillWorld.east, projectionOrigin);
          features.push(
            pointFeature(toMapboxCoord(gps.lat, gps.lon), {
              id: "resize-wh-pill",
              label: `${widthM.toFixed(1)} × ${heightM.toFixed(1)} m`,
              isWhPill: true,
            })
          );
        }
      }
      return featureCollection(features);
    },
    [projectionOrigin, poseFromPlanItem, showLengths]
  );

  /** Fields mode (no sticker): path lengths on committed plan lines, identity pose. */
  const buildFieldsLengthLabelsFC = useCallback((): GeoJSON.FeatureCollection => {
    if (!projectionOrigin || lines.length === 0 || !showLengths) return featureCollection([]);
    const labels = buildPlanLengthLabels(lines, {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
    });
    const features: GeoJSON.Feature[] = [];
    for (const lbl of labels) {
      const gps = projectPlanNorthEastToGps(lbl.north, lbl.east, projectionOrigin);
      features.push(
        pointFeature(toMapboxCoord(gps.lat, gps.lon), {
          id: lbl.id,
          label: lbl.label,
        })
      );
    }
    return featureCollection(features);
  }, [projectionOrigin, lines, showLengths]);

  /**
   * Resize-mode affordances: four edge-midpoint arrows only (n/e/s/w).
   * No corners, no outer rotate rings — shape-based box editor UX.
   */
  const buildHandlesFC = useCallback(
    (items: PlacedItem[]): GeoJSON.FeatureCollection => {
      if (!projectionOrigin || planPlacementPhaseRef.current !== "resizing") {
        return featureCollection([]);
      }
      const features: GeoJSON.Feature[] = [];
      for (const item of items) {
        if (item.id !== "plan-editing-group") continue;
        const pose = poseFromPlanItem(item);
        for (const h of getEdgeHandleWorldPoints(pose)) {
          const gps = projectPlanNorthEastToGps(h.north, h.east, projectionOrigin);
          const bearing = edgeHandleArrowBearingDeg(h.id, pose.rotation);
          features.push(
            pointFeature(toMapboxCoord(gps.lat, gps.lon), {
              id: h.id,
              handleId: h.id,
              isEdge: 1,
              // Single upright glyph; SymbolLayer rotates by outward bearing.
              arrow: "▲",
              bearing,
            })
          );
        }
      }
      return featureCollection(features);
    },
    [projectionOrigin, poseFromPlanItem]
  );

  /** Rotate rings intentionally disabled — resize mode is edge-axis only. */
  const buildRotateHandlesFC = useCallback(
    (_items: PlacedItem[], _hideWhileDragging: boolean): GeoJSON.FeatureCollection =>
      featureCollection([]),
    []
  );

  // Steady-state path lengths — every state (idle fields, move, attach, resize).
  // Live drag/resize overrides via dragPreview.lengthLabelsFC.
  const steadyLengthLabelsFC = useMemo(() => {
    if (!projectionOrigin) return featureCollection([]);
    if (placedItems && placedItems.length > 0) {
      return buildLengthLabelsFC(placedItems);
    }
    // Fields preview / post-bake plan (no sticker).
    if (mode !== "templates" && lines.length > 0) {
      return buildFieldsLengthLabelsFC();
    }
    return featureCollection([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    placedItemsSig,
    projectionOrigin,
    planPlacementPhase,
    buildLengthLabelsFC,
    buildFieldsLengthLabelsFC,
    mode,
    lines,
  ]);

  const steadyHandlesFC = useMemo(() => {
    if (!placedItems || planPlacementPhase !== "resizing" || !projectionOrigin) {
      return featureCollection([]);
    }
    // Hide edge arrows when plan is deselected — reappear on tap-to-select.
    const planSelected =
      selectedItemIds?.includes("plan-editing-group") ||
      selectedItemIds?.includes("visual-alignment-group");
    if (!planSelected) {
      return featureCollection([]);
    }
    return buildHandlesFC(placedItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedItemsSig, planPlacementPhase, projectionOrigin, buildHandlesFC, selectedItemIds]);

  // Rotate affordances only while idle-selected (hidden during any active handle drag).
  const steadyRotateHandlesFC = useMemo(() => {
    if (!placedItems || planPlacementPhase !== "resizing" || !projectionOrigin || dragPreview) {
      return featureCollection([]);
    }
    return buildRotateHandlesFC(placedItems, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedItemsSig, planPlacementPhase, projectionOrigin, buildRotateHandlesFC, dragPreview]);

  /**
   * Multi-Point Fit ref-point magnet for drag / rotate. Pure math; MapView applies the result.
   *
   * RIGID by design: translate + rotate only, scale frozen at the gesture-start value.
   * Dragging the plan near reference points must never resize it — a similarity (scale-to-fit)
   * magnet here silently rescaled the plan the moment a corner came within ~0.75 m of a ref,
   * and baked that scale on finger-up. Scale changes belong to exactly two explicit user
   * actions: "Fit to Reference Points" (App.handleFitToReferencePoints, which runs the
   * similarity solver on demand) and the edge-handle resize phase.
   */
  const applyPointSnap = useCallback(
    (
      itemId: string,
      newX: number,
      newY: number,
      newRotation: number,
      newScale: number
    ): {
      x: number;
      y: number;
      rotation: number;
      scale: number;
      guide: { point: SnapRefPoint; anchor: LocalMeters } | null;
      attached: boolean;
    } => {
      if (!projectionOrigin) {
        snapLockRef.current = null;
        return { x: newX, y: newY, rotation: newRotation, scale: newScale, guide: null, attached: false };
      }
      const phase = planPlacementPhaseRef.current;
      // Magnet ONLY while free drag / rotate (placing or attached).
      // Never during resize — edge handles must not pin to a ref point.
      if (phase !== "placing" && phase !== "attached") {
        return { x: newX, y: newY, rotation: newRotation, scale: newScale, guide: null, attached: false };
      }
      const gestureStartScale =
        dragStartPositionsRef.current[itemId]?.scale ??
        (Number.isFinite(newScale) && newScale > 0 ? newScale : 1);

      const result = applyRigidPlanSnap({
        itemId,
        newX,
        newY,
        newRotation,
        newScale,
        candidates: planEditingSnapCandidates,
        refs: snapRefLocalPoints,
        originDxfNorth: projectionOrigin.originDxfNorth,
        originDxfEast: projectionOrigin.originDxfEast,
        // Re-acquired from the free pose every frame rather than held for the whole gesture,
        // so a near miss never glues the plan to a ref point (same free-drag feel as before,
        // minus the scale-to-fit). Guide line at 1.5 m, translation pin at 0.3 m.
        lock: null,
        gestureStartScale,
      });
      snapLockRef.current = result.lock;
      return {
        x: result.x,
        y: result.y,
        rotation: result.rotation,
        // Invariant, not a pass-through: the sticker's scale is fixed for the whole
        // drag/rotate gesture. Enforced here as well as in the snapper so swapping the
        // snapper again cannot reintroduce magnet-driven resizing.
        scale: itemId === "plan-editing-group" ? gestureStartScale : result.scale,
        guide: result.guide,
        // A plan feature is pinned onto a ref point. Drives the parent's placing → attached
        // transition (same move UX either way — see MultiPointPlacementPhase).
        attached: result.lock != null,
      };
    },
    [planEditingSnapCandidates, projectionOrigin, snapRefLocalPoints]
  );

  const applyDragMove = useCallback(
    (dN: number, dE: number, rotDeg: number, scaleF: number) => {
      const starts = dragStartPositionsRef.current;
      const phase = planPlacementPhaseRef.current;
      // Only manipulate explicitly selected items (tap-outside deselects).
      const ids = selectedItemIds ?? [];

      if (ids.includes("boundary") && starts["boundary"]) {
        const start = starts["boundary"];
        let newRot = (start.rotation + rotDeg) % 360;
        if (newRot < 0) newRot += 360;
        setPreviewBoundary({
          x: start.x + dE,
          y: start.y + dN,
          rotation: newRot,
        });
      }

      if (!placedItems) return;

      // Attached still allows free drag (the magnet re-acquires each frame, so pulling away
      // simply releases). Only resizing switches to handle mode; never freeze mid-gesture.
      let activeGuide: { point: SnapRefPoint; anchor: LocalMeters } | null = null;
      const shifted: PlacedItem[] = [];

      for (const item of placedItems) {
        const start = starts[item.id];
        if (!start || !ids.includes(item.id)) {
          shifted.push(item);
          continue;
        }

        // Resize phase: edge-midpoint axis resize only (drag/rotate/pinch disabled).
        if (phase === "resizing" && item.id === "plan-editing-group") {
          const session = resizeSessionRef.current;
          if (!session || !isEdgeHandleId(session.handle.id)) {
            // Hit-test in flight or miss — body frozen (no free drag in resize).
            shifted.push(item);
            continue;
          }
          // Ignore sub-threshold motion (tap / accidental jitter) — no live size jump.
          if (Math.hypot(dN, dE) < RESIZE_MIN_DRAG_M) {
            shifted.push(item);
            continue;
          }
          const cursor = {
            north: session.startCursor.north + dN,
            east: session.startCursor.east + dE,
          };
          const next = applyAxisResize({
            pose: session.startPose,
            activeHandle: session.handle,
            oppositeHandle: session.opposite,
            cursor,
          });
          shifted.push({
            ...item,
            x: next.x,
            y: next.y,
            scale: next.scale,
            scaleNorth: next.scaleNorth,
            scaleEast: next.scaleEast,
            rotation: next.rotation,
          });
          continue;
        }

        // placing + attached: free drag with a rigid ref-point magnet (translate + rotate;
        // scale is frozen for the gesture). Attach is reported only on commit.
        const newX = start.x + dE;
        const newY = start.y + dN;
        const newRotation = start.rotation + rotDeg;
        const newScale = start.scale * scaleF;
        const snapped = applyPointSnap(item.id, newX, newY, newRotation, newScale);
        if (snapped.guide) activeGuide = snapped.guide;
        shifted.push({
          ...item,
          x: snapped.x,
          y: snapped.y,
          rotation: snapped.rotation,
          scale: snapped.scale,
        });
      }

      setDragPreview({
        itemsGeo: buildItemsGeoForItems(shifted, "drag"),
        guideFC: buildSnapGuideFC(activeGuide),
        activeRefKey: activeGuide ? refPointKey(activeGuide.point) : null,
        lengthLabelsFC: buildLengthLabelsFC(shifted),
        handlesFC: buildHandlesFC(shifted),
      });
    },
    [
      placedItems,
      selectedItemIds,
      buildItemsGeoForItems,
      applyPointSnap,
      buildSnapGuideFC,
      buildLengthLabelsFC,
      buildHandlesFC,
      projectionOrigin,
    ]
  );

  // Raw pan/pinch/rotation callbacks fire on every native touch-move sample (often 60-120Hz,
  // not RAF-aligned) — applyDragMove rebuilds the WHOLE plan's GeoJSON (every line, every
  // tessellated circle point) and pushes it through a React state update + native ShapeSource
  // diff, so running it once per raw touch sample saturates the JS thread and is the main
  // source of visible lag while dragging/rotating. Coalesce to at most once per animation
  // frame: always remember the latest delta, but only do the expensive rebuild when a frame is
  // actually about to render, using whichever delta was most recent by then. (previewRafRef
  // already existed for onDragCommit to cancel — this is what was meant to schedule it.)
  const pendingDragDeltaRef = useRef<{ dN: number; dE: number; rotDeg: number; scaleF: number } | null>(null);
  const onDragMove = useCallback(
    (dN: number, dE: number, rotDeg: number, scaleF: number) => {
      pendingDragDeltaRef.current = { dN, dE, rotDeg, scaleF };
      if (previewRafRef.current !== null) return;
      previewRafRef.current = requestAnimationFrame(() => {
        previewRafRef.current = null;
        const pending = pendingDragDeltaRef.current;
        if (!pending) return;
        applyDragMove(pending.dN, pending.dE, pending.rotDeg, pending.scaleF);
      });
    },
    [applyDragMove]
  );

  /**
   * Called via runOnJS from the worklet on gesture finalize.
   * Reads final deltas, applies clamp, commits to parent once, clears preview.
   * Async: waits briefly for resize hit-test so a quick drag still commits after geo resolves.
   */
  const onDragCommit = useCallback(
    (finalDN: number, finalDE: number, finalRotDeg: number, finalScaleF: number) => {
      // Cancel any pending RAF preview update — the commit below applies the final,
      // authoritative delta, so a stale coalesced frame must not land after it.
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
      pendingDragDeltaRef.current = null;

      const starts = dragStartPositionsRef.current;
      const phase = planPlacementPhaseRef.current;
      const ids = selectedItemIds ?? [];
      const gestureGen = resizeGestureGenRef.current;

      const finishCommit = () => {
        // Ignore stale commits if a newer gesture already began.
        if (gestureGen !== resizeGestureGenRef.current) return;

        if (ids.includes("boundary") && starts["boundary"]) {
          const start = starts["boundary"];
          const finalX = start.x + finalDE;
          const finalY = start.y + finalDN;
          let finalRot = (start.rotation + finalRotDeg) % 360;
          if (finalRot < 0) finalRot += 360;
          if (onMoveBoundary) {
            onMoveBoundary(finalX, finalY);
          }
          if (onRotateBoundary) {
            onRotateBoundary(finalRot);
          }
          setPreviewBoundary(null);
        }

        if (!placedItems) {
          setDragPreview(null);
          resizeSessionRef.current = null;
          return;
        }

        let becameAttached: {
          x: number;
          y: number;
          rotation: number;
          scale: number;
        } | null = null;

        const updated = placedItems.map((item) => {
          const start = starts[item.id];
          if (!start || !ids.includes(item.id)) return item;

          if (phase === "resizing" && item.id === "plan-editing-group") {
            const session = resizeSessionRef.current;
            if (!session || !isEdgeHandleId(session.handle.id)) return item;
            // Tap / tiny motion: never bake a resize (deselect path must not grow the plan).
            if (Math.hypot(finalDN, finalDE) < RESIZE_MIN_DRAG_M) {
              return item;
            }
            const cursor = {
              north: session.startCursor.north + finalDN,
              east: session.startCursor.east + finalDE,
            };
            const next = applyAxisResize({
              pose: session.startPose,
              activeHandle: session.handle,
              oppositeHandle: session.opposite,
              cursor,
            });
            return {
              ...item,
              x: next.x,
              y: next.y,
              scale: next.scale,
              scaleNorth: next.scaleNorth,
              scaleEast: next.scaleEast,
              rotation: next.rotation,
            };
          }

          const newX = start.x + finalDE;
          const newY = start.y + finalDN;
          const newRotation = start.rotation + finalRotDeg;
          const newScale = start.scale * finalScaleF;
          const snapped = applyPointSnap(item.id, newX, newY, newRotation, newScale);
          // Attach UI only on finger-up while a feature is pinned — never a mid-drag freeze.
          if (snapped.attached && item.id === "plan-editing-group") {
            becameAttached = {
              x: snapped.x,
              y: snapped.y,
              rotation: snapped.rotation,
              scale: snapped.scale,
            };
          }
          return {
            ...item,
            x: snapped.x,
            y: snapped.y,
            rotation: snapped.rotation,
            scale: snapped.scale,
          };
        });

        // Single commit to parent — parity with legacy itemsMoved handler.
        if (onUpdatePlacedItems) {
          onUpdatePlacedItems(updated);
        } else if (onUpdatePlacedItem) {
          updated.forEach((item) => {
            const orig = placedItems.find((it) => it.id === item.id);
            if (
              orig &&
              (item.x !== orig.x ||
                item.y !== orig.y ||
                item.rotation !== orig.rotation ||
                item.scale !== orig.scale ||
                item.scaleNorth !== orig.scaleNorth ||
                item.scaleEast !== orig.scaleEast)
            ) {
              onUpdatePlacedItem(item.id, {
                x: item.x,
                y: item.y,
                rotation: item.rotation,
                scale: item.scale,
                scaleNorth: item.scaleNorth,
                scaleEast: item.scaleEast,
              });
            }
          });
        }

        if (becameAttached && onPlanAttachedRef.current) {
          onPlanAttachedRef.current(becameAttached);
        }

        // Clear atomic drag preview — parent state + placedItemsGeo are full quality now.
        setDragPreview(null);
        dragStartPositionsRef.current = {};
        snapLockRef.current = null;
        resizeSessionRef.current = null;
        // Keep notifiedAttachRef if parent phase is already attached; reset only on begin.
      };

      // Wait for resize hit-test (with timeout) so fast gestures still commit.
      const afterCommit = () => {
        finishCommit();
        // Near-zero pan while selected = tap. If outside the plan OBB, deselect so
        // map pan/zoom is free (RNGH otherwise swallows MapView onPress).
        const screen = gestureStartScreenRef.current;
        gestureStartScreenRef.current = null;
        const movedM = Math.hypot(finalDN, finalDE);
        const rotated = Math.abs(finalRotDeg) > 1.5;
        const scaled = Math.abs((finalScaleF || 1) - 1) > 0.02;
        if (
          !screen ||
          movedM > 0.35 ||
          rotated ||
          scaled ||
          !projectionOrigin ||
          !mapViewRef.current ||
          (selectedItemIds ?? []).length === 0
        ) {
          return;
        }
        void (async () => {
          const geo = await screenToGeo(mapViewRef.current!, screen);
          if (!geo || !projectionOrigin) return;
          const local = projectGpsToLocalMeters(
            geo.lat,
            geo.lon,
            projectionOrigin.originLat,
            projectionOrigin.originLon
          );
          const world = {
            north: local.north + projectionOrigin.originDxfNorth,
            east: local.east + projectionOrigin.originDxfEast,
          };
          const mpp = metersPerPixelSV.value > 0 ? metersPerPixelSV.value : 0.05;
          const padM = Math.max(0.75, Math.min(4, mpp * 28));
          let inside = false;
          for (const item of placedItems ?? []) {
            if (item.id !== "plan-editing-group" && item.id !== "visual-alignment-group") {
              continue;
            }
            if (isWorldPointInPlanObb(world, poseFromPlanItem(item), padM)) {
              inside = true;
              break;
            }
          }
          // Also treat resize edge-handle hits as "inside" (handles sit on the OBB edge).
          if (!inside && phase === "resizing") {
            for (const item of placedItems ?? []) {
              if (item.id !== "plan-editing-group") continue;
              const edges = getEdgeHandleWorldPoints(poseFromPlanItem(item));
              const grabR = handleGrabRadiusM(mpp, poseFromPlanItem(item));
              if (findNearestHandle(world, edges, grabR)) {
                inside = true;
                break;
              }
            }
          }
          if (!inside) {
            onSelectionChange?.([]);
          }
        })();
      };

      if (phase === "resizing") {
        const ready = resizeSessionReadyRef.current;
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 200));
        void Promise.race([ready, timeout]).then(afterCommit);
        return;
      }
      afterCommit();
    },
    [
      placedItems,
      selectedItemIds,
      onUpdatePlacedItems,
      onUpdatePlacedItem,
      onMoveBoundary,
      onRotateBoundary,
      applyPointSnap,
      projectionOrigin,
      poseFromPlanItem,
      onSelectionChange,
      metersPerPixelSV,
    ]
  );

  /**
   * Called via runOnJS from onBegin. Snapshots start positions and calibrates mpp.
   * In resizing phase, resolves which OBB handle is under the finger (async geo) with a
   * generation token + ready promise so fast gestures still commit correctly.
   */
  const onDragBegin = useCallback(
    (touchX: number, touchY: number) => {
      const ids = selectedItemIds ?? [];

      const snapshot: Record<string, { x: number; y: number; rotation: number; scale: number }> = {};
      for (const item of placedItems ?? []) {
        if (ids.includes(item.id)) {
          snapshot[item.id] = {
            x: item.x,
            y: item.y,
            rotation: item.rotation || 0,
            scale: item.scale || 1,
          };
        }
      }
      if (ids.includes("boundary")) {
        snapshot["boundary"] = {
          x: boundaryPosition?.x ?? 0,
          y: boundaryPosition?.y ?? 0,
          rotation: boundaryRotation ?? 0,
          scale: 1,
        };
      }
      dragStartPositionsRef.current = snapshot;
      gestureStartScreenRef.current = { x: touchX, y: touchY };
      snapLockRef.current = null; // each gesture starts with no held snap.
      resizeSessionRef.current = null;

      // Invalidate any in-flight hit-test from a previous gesture.
      const gestureGen = ++resizeGestureGenRef.current;
      if (resolveResizeSessionReadyRef.current) {
        resolveResizeSessionReadyRef.current();
        resolveResizeSessionReadyRef.current = null;
      }
      resizeSessionReadyRef.current = new Promise<void>((resolve) => {
        resolveResizeSessionReadyRef.current = resolve;
      });
      const markResizeReady = () => {
        if (gestureGen !== resizeGestureGenRef.current) return;
        resolveResizeSessionReadyRef.current?.();
        resolveResizeSessionReadyRef.current = null;
      };

      if (planPlacementPhaseRef.current === "placing") {
        notifiedAttachRef.current = false;
      }
      void calibrateMetersPerPixel(touchX, touchY);

      const phase = planPlacementPhaseRef.current;
      if (phase === "resizing" && projectionOrigin && mapViewRef.current) {
        const planItem = (placedItems ?? []).find((it) => it.id === "plan-editing-group");
        if (planItem) {
          const origin = projectionOrigin;
          const poseAtBegin = poseFromPlanItem(planItem);
          void (async () => {
            try {
              const map = mapViewRef.current;
              if (!map || gestureGen !== resizeGestureGenRef.current) return;

              // Calibrate mpp first so hit radius matches current zoom (best-effort).
              await calibrateMetersPerPixel(touchX, touchY);
              if (gestureGen !== resizeGestureGenRef.current) return;

              const geo = await screenToGeo(map, { x: touchX, y: touchY });
              if (!geo || gestureGen !== resizeGestureGenRef.current) return;

              const local = projectGpsToLocalMeters(
                geo.lat,
                geo.lon,
                origin.originLat,
                origin.originLon
              );
              // Sticker/world frame = local NE + originDxf (matches designOffsetToWorld).
              const cursorWorld = {
                north: local.north + origin.originDxfNorth,
                east: local.east + origin.originDxfEast,
              };
              const pose = poseAtBegin;
              const mpp = metersPerPixelSV.value > 0 ? metersPerPixelSV.value : 0.05;
              // Easy grab: generous finger target around each edge mid. Deltas still
              // anchor at the HANDLE world point so a soft grab never jumps scale.
              const grabR = handleGrabRadiusM(mpp, pose);

              const edgeWorlds = getEdgeHandleWorldPoints(pose);
              const hit = findNearestHandle(cursorWorld, edgeWorlds, grabR);
              if (hit && isEdgeHandleId(hit.id)) {
                const all = getObbResizeHandles(pose);
                const opposite = all.find((h) => h.id === hit.oppositeId);
                if (opposite) {
                  resizeSessionRef.current = {
                    handle: hit,
                    opposite,
                    startPose: pose,
                    startCursor: { north: hit.north, east: hit.east },
                  };
                }
              }
              // Miss → session null → body frozen; outside tap only deselects.

              // If the finger already moved while geo was resolving, paint a live preview now.
              const pending = pendingDragDeltaRef.current;
              if (pending && gestureGen === resizeGestureGenRef.current) {
                applyDragMove(pending.dN, pending.dE, pending.rotDeg, pending.scaleF);
              }
            } finally {
              markResizeReady();
            }
          })();
          return;
        }
      }
      // Non-resize (or missing plan item): ready immediately.
      markResizeReady();
    },
    [
      placedItems,
      selectedItemIds,
      boundaryPosition,
      boundaryRotation,
      calibrateMetersPerPixel,
      poseFromPlanItem,
      metersPerPixelSV,
      projectionOrigin,
      applyDragMove,
    ]
  );

  // ── Gesture surface: Pan + Pinch + Rotation (Simultaneous) ──
  //
  // CRITICAL DESIGN RULE: gestures ONLY activate when something is selected
  // (hasEditableSelection === true). When false, the GestureDetector is not
  // mounted at all, so the Mapbox map receives all touch events normally.
  //
  // Pan gesture drives single-item drag via RAF-coalesced JS callbacks.
  // Delta accumulation happens on the Reanimated UI thread (fast path).
  // Preview updates and commits happen on the JS thread (controlled rate).

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        // Low threshold so resize/drag feel immediate on touch devices.
        .minDistance(2)
        .onBegin((e) => {
          "worklet";
          panDeltaN.value = 0;
          panDeltaE.value = 0;
          runOnJS(onDragBegin)(e.x, e.y);
          runOnJS(setGestureEditType)("items");
        })
        .onChange((e) => {
          "worklet";
          const mpp = metersPerPixelSV.value;
          panDeltaE.value += e.changeX * mpp;
          panDeltaN.value -= e.changeY * mpp;
          // Pass all gesture values (pan + rotation + scale) for unified preview.
          runOnJS(onDragMove)(panDeltaN.value, panDeltaE.value, rotationDelta.value, pinchScale.value);
        })
        .onFinalize((e, success) => {
          "worklet";
          // Commit with the final accumulated delta (regardless of success/cancel).
          runOnJS(onDragCommit)(panDeltaN.value, panDeltaE.value, rotationDelta.value, pinchScale.value);
          panDeltaN.value = 0;
          panDeltaE.value = 0;
          pinchScale.value = 1;
          rotationDelta.value = 0;
          runOnJS(setGestureEditType)(null);
        }),
    [panDeltaN, panDeltaE, metersPerPixelSV, onDragBegin, onDragMove, onDragCommit, rotationDelta, pinchScale]
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          "worklet";
          pinchScale.value = 1;
          runOnJS(setGestureEditType)("items");
        })
        .onUpdate((e) => {
          "worklet";
          pinchScale.value = e.scale;
          // Live preview with current pan + rotation + scale deltas.
          runOnJS(onDragMove)(panDeltaN.value, panDeltaE.value, rotationDelta.value, pinchScale.value);
        })
        .onEnd(() => {
          "worklet";
          // Don't commit here — pan's onFinalize handles the unified commit.
        })
        .onFinalize(() => {
          "worklet";
        }),
    [pinchScale, panDeltaN, panDeltaE, rotationDelta, onDragMove]
  );

  const rotationGesture = useMemo(
    () =>
      Gesture.Rotation()
        .onBegin(() => {
          "worklet";
          rotationDelta.value = 0;
          runOnJS(setGestureEditType)("items");
        })
        .onUpdate((e) => {
          "worklet";
          rotationDelta.value = (e.rotation * 180) / Math.PI;
          // Live preview with current pan + rotation + scale deltas.
          runOnJS(onDragMove)(panDeltaN.value, panDeltaE.value, rotationDelta.value, pinchScale.value);
        })
        .onEnd(() => {
          "worklet";
          // Don't commit here — pan's onFinalize handles the unified commit.
        })
        .onFinalize(() => {
          "worklet";
        }),
    [rotationDelta, panDeltaN, panDeltaE, pinchScale, onDragMove]
  );

  // Gate gestures based on multiTouchMode + plan phase:
  // - resizing: pan only (edge-handle axis resize; no pinch/rotate)
  // - "both": pan + pinch + rotation
  // - "scale": pan + pinch only (no rotation)
  // - "rotate": pan + rotation only (no pinch/scale)
  const composedGesture = useMemo(
    () => {
      if (manualDrawingEnabled) {
        return Gesture.Pan().enabled(false);
      }
      const resizing = planPlacementPhase === "resizing";
      const gestures: any[] = [panGesture.enabled(!!hasEditableSelection)];
      if (!resizing && (multiTouchMode === "both" || multiTouchMode === "scale")) {
        gestures.push(pinchGesture.enabled(!!hasEditableSelection));
      }
      if (!resizing && (multiTouchMode === "both" || multiTouchMode === "rotate")) {
        gestures.push(rotationGesture.enabled(!!hasEditableSelection));
      }
      return Gesture.Simultaneous(...gestures);
    },
    [
      panGesture,
      pinchGesture,
      rotationGesture,
      multiTouchMode,
      hasEditableSelection,
      manualDrawingEnabled,
      planPlacementPhase,
    ]
  );

  // ── Camera helpers ──
  /** Collect all visible coordinates for fit-to-bounds. */
  const collectFitCoords = useCallback((): Coord[] => {
    const coords: Coord[] = [];
    const pushFeatureCoords = (f: GeoJSON.Feature) => {
      if (!f.geometry) return;
      if (f.geometry.type === "LineString") {
        for (const c of f.geometry.coordinates) coords.push(c as Coord);
      } else if (f.geometry.type === "Polygon") {
        for (const ring of f.geometry.coordinates) {
          for (const c of ring) coords.push(c as Coord);
        }
      } else if (f.geometry.type === "Point") {
        coords.push(f.geometry.coordinates as Coord);
      }
    };
    if (mode === "templates") {
      boundaryGeo.outer.features.forEach(pushFeatureCoords);
      boundaryGeo.indent.features.forEach(pushFeatureCoords);
      placedItemsGeo.lines.features.forEach(pushFeatureCoords);
      placedItemsGeo.boxes.features.forEach(pushFeatureCoords);
    } else {
      planLinesFC.features.forEach(pushFeatureCoords);
    }
    // Always include selected alignment ref points — CSV-imported or tapped points may sit
    // outside the plan's own line bounds, and they must never end up framed off-screen.
    selectedPointsFC.features.forEach(pushFeatureCoords);
    return coords;
  }, [mode, boundaryGeo, placedItemsGeo, planLinesFC, selectedPointsFC]);

  const fitToPlan = useCallback(() => {
    const coords = collectFitCoords();
    if (coords.length === 0) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    if (!Number.isFinite(minLon) || !Number.isFinite(minLat) ||
        !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return;
    // fitBounds(sw, ne, padding, duration) — sw = [minLon, minLat], ne = [maxLon, maxLat]
    safeFitBounds([minLon, minLat], [maxLon, maxLat], 40, 400);
  }, [collectFitCoords, safeFitBounds]);

  // Recenter on rover — STRICTLY one-shot per button press (parity with legacy).
  // `roverGeo.center` is intentionally NOT a dependency: if it were, this effect
  // would re-fire on every telemetry tick (roverGeo.center is a fresh array each
  // tick) and turn a one-shot recenter into continuous follow.
  useEffect(() => {
    if (!visible || !recenterRoverTrigger || recenterRoverTrigger <= 0) return;
    if (recenterRoverTrigger === lastRecenterRoverRef.current) return;
    lastRecenterRoverRef.current = recenterRoverTrigger;
    if (roverGeo.center) {
      safeSetCamera({ centerCoordinate: roverGeo.center, animationDuration: 300 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterRoverTrigger, visible]);

  // Fit to plan — STRICTLY one-shot per button press. `fitToPlan` is intentionally
  // not a dependency: its identity changes when geometry changes, which would
  // otherwise re-fit the camera on every plan/boundary/item update.
  useEffect(() => {
    if (!visible || !recenterPlanTrigger || recenterPlanTrigger <= 0) return;
    if (recenterPlanTrigger === lastRecenterPlanRef.current) return;
    lastRecenterPlanRef.current = recenterPlanTrigger;
    fitToPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterPlanTrigger, visible]);

  // Reset camera bearing to North (0 deg) — one-shot per button press.
  useEffect(() => {
    if (!visible || !resetNorthTrigger || resetNorthTrigger <= 0) return;
    if (resetNorthTrigger === lastResetNorthRef.current) return;
    lastResetNorthRef.current = resetNorthTrigger;
    safeSetCamera({
      heading: 0,
      animationDuration: 300,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNorthTrigger, visible]);

  // Initial autocenter: prefer rover, else fit plan (parity with legacy).
  // Wait until the native map reports style loaded — early setCamera is a common
  // release-only hard crash after websocket connect mounts the home map.
  useEffect(() => {
    if (!visible || hasAutoCenteredRef.current || !mapLoadedRef.current) return;
    if (roverGeo.center) {
      safeSetCamera({
        centerCoordinate: roverGeo.center,
        zoomLevel: 19,
        animationDuration: 0,
      });
      hasAutoCenteredRef.current = true;
    } else if (collectFitCoords().length > 0) {
      fitToPlan();
      hasAutoCenteredRef.current = true;
    }
  }, [visible, roverGeo.center, collectFitCoords, fitToPlan, safeSetCamera]);

  // Re-fit whenever the selected alignment ref points GROW (a tap-add or a bulk CSV
  // import) — CSV-imported points in particular may sit outside the plan's own line
  // bounds, so without this they can land off-screen with no way for the user to know.
  // Ignores shrinkage (point removal) so clearing/deselecting a point never yanks the
  // camera, and is baseline-seeded so it never fires spuriously on mount.
  useEffect(() => {
    const count = selectedPoints?.length ?? 0;
    if (visible && count > lastSelectedPointsCountRef.current) {
      fitToPlan();
    }
    lastSelectedPointsCountRef.current = count;
  }, [visible, selectedPoints, fitToPlan]);

  // Re-fit when a Fix Alignment just completed (alignedRefPoints going from empty to
  // non-empty). A completed alignment relocates the WHOLE plan to its real GPS position
  // (origin_gps), which can be far from wherever the camera was framed during the
  // pre-alignment preview (that used a provisional/fallback anchor, not the real one) —
  // without this, the newly-aligned plan can render entirely outside the current view.
  // Defer one frame so React has committed the atomic Fix handoff (transformed lines +
  // origin_gps + cleared visualAlignmentAnchor) before we measure/fit bounds.
  useEffect(() => {
    const count = alignedRefPoints?.length ?? 0;
    if (visible && count > lastAlignedRefPointsCountRef.current) {
      const id = requestAnimationFrame(() => {
        fitToPlan();
      });
      lastAlignedRefPointsCountRef.current = count;
      return () => cancelAnimationFrame(id);
    }
    lastAlignedRefPointsCountRef.current = count;
  }, [visible, alignedRefPoints, fitToPlan]);

  // ── Tap handling ──
  const handleMapPress = useCallback(
    (feature: GeoJSON.Feature<GeoJSON.Point>) => {
      const [lon, lat] = feature.geometry.coordinates as Coord;
      const { lat: pLat, lon: pLon } = fromMapboxCoord([lon, lat]);

      // Click-to-Mark: if drawing mode is active, emit the coordinate and return
      if (onMapClickToMark) {
        onMapClickToMark({ lat: pLat, lon: pLon });
        return;
      }

      if (mode === "templates") {
        // Tap on plan OBB → select; tap outside → deselect (map pan free when unselected).
        // ShapeSource onPress also selects; this path covers map presses and hit-tests the
        // live sticker bbox so hollow interiors / fill gaps still reselect reliably.
        if (projectionOrigin && placedItems && placedItems.length > 0) {
          const local = projectGpsToLocalMeters(
            pLat,
            pLon,
            projectionOrigin.originLat,
            projectionOrigin.originLon
          );
          const world = {
            north: local.north + projectionOrigin.originDxfNorth,
            east: local.east + projectionOrigin.originDxfEast,
          };
          const mpp = metersPerPixelSV.value > 0 ? metersPerPixelSV.value : 0.05;
          const padM = Math.max(0.75, Math.min(4, mpp * 28));
          for (const item of placedItems) {
            if (item.id !== "plan-editing-group" && item.id !== "visual-alignment-group") {
              continue;
            }
            const pose = poseFromPlanItem(item);
            if (isWorldPointInPlanObb(world, pose, padM)) {
              onSelectionChange?.([item.id]);
              return;
            }
          }
        }
        onSelectionChange?.([]);
        return;
      }
      if (!projectionOrigin) return;

      const local = projectGpsToLocalMeters(pLat, pLon, projectionOrigin.originLat, projectionOrigin.originLon);
      // Plan frame: north = x, east = y (same as PlanLine.from.x/y).
      const clickN = local.north + projectionOrigin.originDxfNorth;
      const clickE = local.east + projectionOrigin.originDxfEast;

      // Multi-Point hit: ~36px finger target in metres. Slightly generous so the
      // plan start vertex is easy to grab; still capped so hollow interior taps
      // never jump to a far corner.
      const mpp = metersPerPixelSV.value > 0 ? metersPerPixelSV.value : 0.05;
      const hitRadiusM = Math.max(1.0, Math.min(4.0, mpp * 36));
      // Snap onto true vertices (esp. plan start) when the finger is nearby.
      const vertexSnapM = Math.max(1.25, Math.min(4.5, mpp * 40));
      // Deselect only when the finger is on the yellow marker itself.
      const deselectRadiusM = Math.max(0.75, Math.min(2.5, mpp * 22));

      // ── Multi-Point guide pick (only when parent wired onSelectPoint) ──
      // Pick the closest point *on plan strokes* (vertex OR mid-segment). When a
      // true vertex is within vertexSnapM of the tap, snap onto that vertex so
      // the plan start / corners are easy to select with a finger.
      if (onSelectPoint) {
        // ShapeSource marker press already handled this tap — do not double-select.
        if (Date.now() - multiPointAnchorPressAtMsRef.current < 350) {
          return;
        }
        // Object wrapper so closest-hit updates are visible to TS (not narrowed via a closure).
        const geometryPick: { current: { x: number; y: number; dist: number } | null } = {
          current: null,
        };
        const vertexPick: { current: { x: number; y: number; dist: number } | null } = {
          current: null,
        };

        for (const line of lines) {
          // Skip synthetic overlay layers — alignment refs should land on real plan geometry.
          if (
            line.layer === "virtual_boundary" ||
            line.layer === "transit" ||
            line.layer === "extension"
          ) {
            continue;
          }

          const tryHit = (x: number, y: number, dist: number) => {
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dist)) return;
            if (dist > hitRadiusM) return;
            const prev = geometryPick.current;
            if (!prev || dist < prev.dist) {
              geometryPick.current = { x, y, dist };
            }
          };

          const tryVertex = (x: number, y: number) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            const dist = Math.hypot(x - clickN, y - clickE);
            if (dist > vertexSnapM) return;
            const prev = vertexPick.current;
            if (!prev || dist < prev.dist) {
              vertexPick.current = { x, y, dist };
            }
          };

          // Closest point on each stroke (includes endpoints and anywhere along the line).
          if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
            const pts = line.entity.preview_points;
            for (let i = 0; i < pts.length; i++) {
              tryVertex(pts[i].north, pts[i].east);
            }
            for (let i = 0; i < pts.length - 1; i++) {
              const hit = nearestOnSegment(
                clickN,
                clickE,
                pts[i].north,
                pts[i].east,
                pts[i + 1].north,
                pts[i + 1].east
              );
              tryHit(hit.x, hit.y, hit.dist);
            }
          } else if (line.from && line.to) {
            tryVertex(line.from.x, line.from.y);
            tryVertex(line.to.x, line.to.y);
            const hit = nearestOnSegment(
              clickN,
              clickE,
              line.from.x,
              line.from.y,
              line.to.x,
              line.to.y
            );
            tryHit(hit.x, hit.y, hit.dist);
          } else {
            if (line.from) {
              tryVertex(line.from.x, line.from.y);
              tryHit(
                line.from.x,
                line.from.y,
                Math.hypot(line.from.x - clickN, line.from.y - clickE)
              );
            }
            if (line.to) {
              tryVertex(line.to.x, line.to.y);
              tryHit(
                line.to.x,
                line.to.y,
                Math.hypot(line.to.x - clickN, line.to.y - clickE)
              );
            }
          }
        }

        // Prefer a nearby true vertex (start / corners) when the finger is closer
        // to it than to a pure mid-stroke hit (small slack for fat fingers).
        const strokeHit = geometryPick.current;
        const vertexHit = vertexPick.current;
        const fingerSlackM = Math.max(0.4, mpp * 10);
        const picked =
          vertexHit && (!strokeHit || vertexHit.dist <= strokeHit.dist + fingerSlackM)
            ? vertexHit
            : strokeHit;

        // Tight deselect: only when the finger is on a yellow marker.
        let bestSel: { x: number; y: number; dist: number } | null = null;
        if (selectedPoints && selectedPoints.length > 0) {
          for (const sp of selectedPoints) {
            if (!Number.isFinite(sp.x) || !Number.isFinite(sp.y)) continue;
            const d = Math.hypot(sp.x - clickN, sp.y - clickE);
            if (d <= deselectRadiusM && (!bestSel || d < bestSel.dist)) {
              bestSel = { x: sp.x, y: sp.y, dist: d };
            }
          }
        }

        // Prefer deselect only when the tap is clearly on the marker (closer than
        // a different geometry target, or no new geometry at all).
        if (bestSel) {
          const aimingAtSameMarker =
            !picked ||
            Math.hypot(picked.x - bestSel.x, picked.y - bestSel.y) < 0.35 ||
            bestSel.dist <= picked.dist;
          if (aimingAtSameMarker) {
            onSelectPoint({ x: bestSel.x, y: bestSel.y });
            return;
          }
        }

        if (picked) {
          onSelectPoint({ x: picked.x, y: picked.y });
          return;
        }
        // No geometry nearby — ignore completely (no free-place, no line select).
        return;
      }

      // ── Default: line selection (no guide-point mode) ──
      // Plan frame north/east consistently (previous path mixed east/north axes).
      let bestLineId: string | null = null;
      let bestLineDist = Infinity;
      const lineHitR = Math.max(8, Math.min(40, mpp * 32));
      for (const line of lines) {
        let dist = Infinity;
        if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
          for (let i = 0; i < line.entity.preview_points.length - 1; i++) {
            const p1 = line.entity.preview_points[i];
            const p2 = line.entity.preview_points[i + 1];
            const d = distToSegment(clickN, clickE, p1.north, p1.east, p2.north, p2.east);
            if (d < dist) dist = d;
          }
        } else if (line.from && line.to) {
          dist = distToSegment(clickN, clickE, line.from.x, line.from.y, line.to.x, line.to.y);
        }
        if (dist < bestLineDist) {
          bestLineDist = dist;
          bestLineId = line.id;
        }
      }
      if (bestLineId && bestLineDist < lineHitR && onSelectLine) {
        onSelectLine(bestLineId);
      } else if (onSelectLine) {
        onSelectLine(null);
      }
    },
    [
      mode,
      originSig,
      lines,
      onSelectPoint,
      onSelectLine,
      onSelectionChange,
      onMapClickToMark,
      selectedPoints,
      metersPerPixelSV,
      projectionOrigin,
      placedItems,
      poseFromPlanItem,
    ]
  );

  const handleItemsPress = useCallback(
    (event: ShapeSourcePressEvent) => {
      const f = event.features?.[0];
      const itemId = f?.properties?.itemId as string | undefined;
      if (itemId) onSelectionChange?.([itemId]);
    },
    [onSelectionChange]
  );

  // When a ShapeSource multi-point marker is pressed, MapView onPress often also fires
  // for the same finger-up. Ignore the map-press path briefly so we do not add twice.
  const multiPointAnchorPressAtMsRef = useRef(0);

  /**
   * Multi-Point: ShapeSource feature press.
   * - Gold numbered pins → focus that point's Lat/Lon fields (do not deselect).
   * - FROM start / invisible vertex hits → select that plan point for a new guide.
   */
  const handleMultiPointAnchorPress = useCallback(
    (event: ShapeSourcePressEvent) => {
      const features = event.features ?? [];
      for (const f of features) {
        const props = (f?.properties ?? {}) as Record<string, unknown>;
        // Existing guide pin (selectedPointsFC stores 1-based `index`)
        const index1 = Number(props.index);
        if (Number.isFinite(index1) && index1 >= 1) {
          multiPointAnchorPressAtMsRef.current = Date.now();
          onGuidePointFocus?.(index1 - 1);
          return;
        }
        const planNorth = Number(props.planNorth);
        const planEast = Number(props.planEast);
        if (Number.isFinite(planNorth) && Number.isFinite(planEast) && onSelectPoint) {
          multiPointAnchorPressAtMsRef.current = Date.now();
          onSelectPoint({ x: planNorth, y: planEast });
          return;
        }
      }
    },
    [onSelectPoint, onGuidePointFocus]
  );

  if (!visible) return null;

  const refLabelsVisible = !!showRefPointLabels;
  // Active preview overrides the committed sources during a live gesture.
  const activeItemsGeo = previewItemsGeo ?? placedItemsGeo;
  const activeLengthLabelsFC = previewLengthLabelsFC ?? steadyLengthLabelsFC;
  const activeHandlesFC = previewHandlesFC ?? steadyHandlesFC;
  // The inner map content (shared between editing and non-editing render).
  const mapContent = (
    <View style={styles.container}>
      <RNMapboxMapView
        ref={mapViewRef}
        style={styles.map}
        styleURL={props.styleURL ?? MAPBOX_STYLE_URL}
        onPress={handleMapPress as (f: GeoJSON.Feature) => void}
        onCameraChanged={handleCameraChanged}
        onDidFinishLoadingMap={() => {
          mapLoadedRef.current = true;
          // Retry one-shot autocenter now that native map is ready.
          if (!hasAutoCenteredRef.current) {
            if (roverGeo.center) {
              safeSetCamera({
                centerCoordinate: roverGeo.center,
                zoomLevel: 19,
                animationDuration: 0,
              });
              hasAutoCenteredRef.current = true;
            } else if (collectFitCoords().length > 0) {
              fitToPlan();
              hasAutoCenteredRef.current = true;
            }
          }
        }}
        scaleBarEnabled={false}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled={false}
        // During an active gesture or manual drawing, suppress map pan/zoom
        scrollEnabled={!manualDrawingEnabled && !lockPanDrag && !isGestureEditing}
        zoomEnabled={!manualDrawingEnabled && !lockZoom && !isGestureEditing}
        pitchEnabled={!manualDrawingEnabled}
        rotateEnabled={!manualDrawingEnabled}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={
            roverGeo.center &&
            Array.isArray(roverGeo.center) &&
            Number.isFinite(roverGeo.center[0]) &&
            Number.isFinite(roverGeo.center[1])
              ? { centerCoordinate: roverGeo.center, zoomLevel: 19 }
              : undefined
          }
        />

        {/* ── Plan lines (Fields) ── */}
        <ShapeSource
          id="plan-lines"
          shape={planLinesFC}
          maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
          tolerance={PLAN_SOURCE_TOLERANCE}
        >
          <LineLayer
            id="plan-lines-open-layer"
            filter={["all", ["!=", ["get", "closedRing"], true], ["!=", ["get", "layer"], "virtual_boundary"]]}
            style={{
              lineColor: ["get", "color"],
              lineWidth: 2,
              lineOpacity: 0.85,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          <LineLayer
            id="plan-lines-closed-layer"
            filter={["all", ["==", ["get", "closedRing"], true], ["!=", ["get", "layer"], "virtual_boundary"]]}
            style={{
              lineColor: ["get", "color"],
              lineWidth: 2,
              lineOpacity: 0.85,
              lineCap: "butt",
              lineJoin: "round",
            }}
          />
          <LineLayer
            id="plan-lines-virtual-boundary-layer"
            filter={["==", ["get", "layer"], "virtual_boundary"]}
            style={{
              lineColor: "#06b6d4",
              lineWidth: 2.5,
              lineDasharray: [2, 1],
              lineOpacity: 0.95,
            }}
          />
        </ShapeSource>

        {/* ── Offset ghost preview: live drag-only, gone on release, never committed ── */}
        <ShapeSource
          id="offset-ghost-lines"
          shape={ghostLinesFC}
          maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
          tolerance={PLAN_SOURCE_TOLERANCE}
        >
          <LineLayer
            id="offset-ghost-lines-layer"
            style={{
              lineColor: "#8b5cf6",
              lineWidth: 2,
              lineOpacity: 0.6,
              lineDasharray: [2, 2],
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        </ShapeSource>

        {/* ── Multi-Point pickable vertices: invisible hit targets only (no clutter dots) ── */}
        <ShapeSource
          id="multi-point-pick-anchors"
          shape={multiPointPickAnchorsFC}
          onPress={handleMultiPointAnchorPress}
          hitbox={{ width: 48, height: 48 }}
        >
          {/* Fully transparent but present so Mapbox still hit-tests the feature */}
          <CircleLayer
            id="multi-point-pick-hit"
            style={{
              circleRadius: 16,
              circleColor: "#0ea5e9",
              circleOpacity: 0.001,
            }}
          />
        </ShapeSource>

        {/* ── Anchor point selection: visible, tappable candidate dots on the isolated target ── */}
        <ShapeSource
          id="anchor-candidates"
          shape={anchorCandidatesFC}
          onPress={handleAnchorCandidatePress}
          hitbox={{ width: 40, height: 40 }}
        >
          <CircleLayer
            id="anchor-candidates-halo"
            style={{
              circleRadius: 10,
              circleColor: "#22c55e",
              circleOpacity: 0.22,
            }}
          />
          <CircleLayer
            id="anchor-candidates-core"
            style={{
              circleRadius: 5,
              circleColor: "#16a34a",
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 1.75,
              circleOpacity: 1,
            }}
          />
        </ShapeSource>

        {/* ── Rover start: red pin ON the true start vertex; FROM + ▲ label slightly below ── */}
        <ShapeSource
          id="plan-start-direction"
          shape={startDirectionFC}
          onPress={onSelectPoint ? handleMultiPointAnchorPress : undefined}
          hitbox={{ width: 72, height: 72 }}
        >
          {/* Hit + pin sit at the exact start coordinate (no translate offset) */}
          <CircleLayer
            id="plan-start-hit"
            filter={["==", ["get", "kind"], "start-origin"]}
            style={{
              circleRadius: 22,
              circleColor: "#f97316",
              circleOpacity: 0.001,
            }}
          />
          <CircleLayer
            id="plan-start-origin-halo"
            filter={["==", ["get", "kind"], "start-origin"]}
            style={{
              circleRadius: 11,
              circleColor: "#f97316",
              circleOpacity: 0.22,
            }}
          />
          <CircleLayer
            id="plan-start-origin-core"
            filter={["==", ["get", "kind"], "start-origin"]}
            style={{
              circleRadius: 5.5,
              circleColor: "#ea580c",
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 2.5,
              circleOpacity: 1,
            }}
          />
          {/* Labels offset below the pin so the red dot stays on the path start */}
          <SymbolLayer
            id="plan-start-origin-label"
            filter={["==", ["get", "kind"], "start-origin"]}
            style={{
              textField: ["get", "label"],
              textSize: 11,
              textColor: "#9a3412",
              textHaloColor: "#ffffff",
              textHaloWidth: 1.75,
              textFont: ["DIN Pro Bold"],
              textOffset: [-0.55, 1.35],
              textAnchor: "top",
              textAllowOverlap: true,
              textIgnorePlacement: true,
            }}
          />
          <SymbolLayer
            id="plan-start-arrow"
            filter={["==", ["get", "kind"], "start-origin"]}
            style={{
              textField: "▲",
              textSize: 16,
              textColor: "#ea580c",
              textHaloColor: "#ffffff",
              textHaloWidth: 1.5,
              textOffset: [1.55, 1.35],
              textAnchor: "top",
              textAllowOverlap: true,
              textIgnorePlacement: true,
              textRotate: ["get", "bearing"],
              textRotationAlignment: "map",
            }}
          />
        </ShapeSource>

        {/* ── Fields selection highlight + corner points ── */}
        <ShapeSource
          id="selected-line"
          shape={selectionFC.line}
          maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
          tolerance={PLAN_SOURCE_TOLERANCE}
        >
          <LineLayer
            id="selected-line-open-layer"
            filter={["!=", ["get", "closedRing"], true]}
            style={{ lineColor: "#3b82f6", lineWidth: 4, lineCap: "round", lineJoin: "round" }}
          />
          <LineLayer
            id="selected-line-closed-layer"
            filter={["==", ["get", "closedRing"], true]}
            style={{ lineColor: "#ef4444", lineWidth: 4, lineCap: "butt", lineJoin: "round" }}
          />
        </ShapeSource>
        <ShapeSource id="corner-points" shape={selectionFC.corners}>
          <CircleLayer
            id="corner-points-layer"
            style={{
              circleRadius: 4,
              circleColor: "#3b82f6",
              circleOpacity: 0.9,
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 1.5,
            }}
          />
        </ShapeSource>
        <ShapeSource id="selection-labels" shape={selectionFC.labels}>
          <SymbolLayer
            id="selection-labels-layer"
            style={{
              textField: ["get", "label"],
              textColor: "#ef4444",
              textHaloColor: "#ffffff",
              textHaloWidth: 2,
              textSize: 12,
              textOffset: ["get", "offset"],
              textAllowOverlap: true,
            }}
          />
        </ShapeSource>

        {/* ── Reference point labels only (green dots removed — cluttered Fields map) ── */}
        <ShapeSource id="ref-points" shape={refPointsFC}>
          {/* Invisible zero-radius layer keeps source valid without painting dots */}
          <CircleLayer
            id="ref-points-layer"
            style={{
              circleRadius: 0,
              circleOpacity: 0,
            }}
          />
          <SymbolLayer
            id="ref-points-labels"
            style={{
              textField: ["get", "label"],
              textColor: "#0f172a",
              textHaloColor: "#ffffff",
              textHaloWidth: 1.5,
              textSize: 11,
              textOffset: [0, -1.4],
              textAnchor: "bottom",
              textOpacity: refLabelsVisible ? 1 : 0,
            }}
          />
        </ShapeSource>

        {/* ── Multi-Point Fit snap guide: dashed line only (butt caps — no end dots) ── */}
        <ShapeSource id="ref-point-snap-guide" shape={snapGuideFC}>
          <LineLayer
            id="ref-point-snap-guide-line"
            style={{
              lineColor: "#f59e0b",
              lineWidth: 2,
              lineOpacity: 0.9,
              lineDasharray: [3, 2],
              lineCap: "butt",
              lineJoin: "miter",
            }}
          />
        </ShapeSource>

        {/* ── Live path lengths / resize W×H pill ── */}
        <ShapeSource id="plan-length-labels" shape={activeLengthLabelsFC}>
          {/* Per-path lengths: world-offset off stroke + strong halo for readability */}
          <SymbolLayer
            id="plan-length-labels-layer"
            filter={["!=", ["get", "isWhPill"], true]}
            style={{
              textField: ["get", "label"],
              textColor: "#0f172a",
              textHaloColor: "#ffffff",
              textHaloWidth: 2.25,
              textSize: 12,
              textOffset: [0, 0],
              textAnchor: "center",
              textJustify: "center",
              textAllowOverlap: true,
              textIgnorePlacement: true,
            }}
          />
          {/* Resize W×H pill (slightly below OBB) */}
          <SymbolLayer
            id="plan-length-wh-pill-layer"
            filter={["==", ["get", "isWhPill"], true]}
            style={{
              textField: ["get", "label"],
              textColor: "#ffffff",
              textHaloColor: "#2563eb",
              textHaloWidth: 8,
              textSize: 13,
              textOffset: [0, -0.8],
              textAnchor: "center",
              textAllowOverlap: true,
              textIgnorePlacement: true,
            }}
          />
        </ShapeSource>

        {/* ── Resize: four edge-midpoint arrows only (n/e/s/w) ── */}
        <ShapeSource id="plan-resize-handles" shape={activeHandlesFC}>
          <CircleLayer
            id="plan-resize-handles-hit"
            style={{
              // Large touch target so edge mids are easy to grab.
              circleRadius: 18,
              circleColor: "#0ea5e9",
              circleOpacity: 0.32,
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 2,
              circleStrokeOpacity: 0.95,
            }}
          />
          <SymbolLayer
            id="plan-resize-handles-arrows"
            style={{
              textField: ["get", "arrow"],
              textSize: 18,
              textColor: "#ffffff",
              textHaloColor: "#0369a1",
              textHaloWidth: 1.5,
              textAllowOverlap: true,
              textIgnorePlacement: true,
              textRotate: ["get", "bearing"],
              textRotationAlignment: "map",
            }}
          />
        </ShapeSource>

        {/* Rotate rings intentionally unmounted in Resize (edge-axis only). */}
        <ShapeSource id="plan-rotate-handles" shape={featureCollection([])}>
          <CircleLayer
            id="plan-rotate-handles-layer"
            style={{
              circleRadius: 0,
              circleOpacity: 0,
            }}
          />
        </ShapeSource>

        {/* ── Multi-Point guide anchors (gold pins). Snap-active endpoint is omitted
            from the FeatureCollection so the dashed snap line never ends on a yellow dot. ── */}
        <ShapeSource
          id="selected-points"
          shape={selectedPointsFC}
          onPress={
            onGuidePointFocus || onSelectPoint ? handleMultiPointAnchorPress : undefined
          }
          hitbox={{ width: 56, height: 56 }}
        >
          <CircleLayer
            id="selected-points-halo"
            style={{
              circleRadius: 14,
              circleColor: "#fbbf24",
              circleOpacity: 0.28,
            }}
          />
          <CircleLayer
            id="selected-points-body"
            style={{
              circleRadius: 10,
              circleColor: "#f59e0b",
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 2.5,
              circleOpacity: 1,
            }}
          />
          <CircleLayer
            id="selected-points-inner"
            style={{
              circleRadius: 6,
              circleColor: "#ffffff",
              circleOpacity: 1,
            }}
          />
          <SymbolLayer
            id="selected-points-index"
            style={{
              textField: ["to-string", ["get", "index"]],
              textSize: 12,
              textColor: "#b45309",
              textFont: ["DIN Pro Bold"],
              textAllowOverlap: true,
              textIgnorePlacement: true,
              textAnchor: "center",
            }}
          />
        </ShapeSource>

        {/* ── Virtual bounding box: labels only (corner dots removed) ── */}
        <ShapeSource id="virtual-box-corners" shape={virtualBoxCornersFC}>
          <CircleLayer
            id="virtual-box-corners-layer"
            style={{
              circleRadius: 0,
              circleOpacity: 0,
            }}
          />
        </ShapeSource>
        <ShapeSource id="virtual-box-labels" shape={virtualBoxLabelsFC}>
          <SymbolLayer
            id="virtual-box-labels-layer"
            style={{
              textField: ["get", "label"],
              textColor: "#0891b2",
              textHaloColor: "#ffffff",
              textHaloWidth: 2,
              textSize: 12,
              textOffset: ["get", "offset"],
              textAllowOverlap: true,
            }}
          />
        </ShapeSource>

        {/* ── Boundary box (Templates) ── */}
        <ShapeSource id="boundary-indent" shape={boundaryGeo.indent} onPress={() => onSelectionChange?.(["boundary"])}>
          <LineLayer
            id="boundary-indent-layer"
            style={{ lineColor: "#cbd5e1", lineWidth: 2, lineDasharray: [5, 5] }}
          />
        </ShapeSource>
        <ShapeSource id="boundary-outer" shape={boundaryGeo.outer} onPress={() => onSelectionChange?.(["boundary"])}>
          <FillLayer
            id="boundary-outer-fill"
            style={{
              fillColor: ["case", ["get", "selected"], "rgba(239, 68, 68, 0.15)", "rgba(15, 23, 42, 0.05)"],
              fillOpacity: 1,
            }}
          />
          <LineLayer
            id="boundary-outer-layer"
            style={{
              lineColor: ["case", ["get", "selected"], "#ef4444", "#0f172a"],
              lineWidth: ["case", ["get", "selected"], 4, 2],
              lineOpacity: 0.9,
            }}
          />
        </ShapeSource>
        <ShapeSource id="boundary-control-points" shape={boundaryGeo.controlPoints}>
          <CircleLayer
            id="boundary-control-points-layer"
            style={{
              circleRadius: ["case", ["get", "active"], 4.5, 3],
              circleColor: ["case", ["get", "active"], "#f59e0b", "#3b82f6"],
              circleOpacity: ["case", ["get", "active"], 0.9, 0.7],
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 1.5,
            }}
          />
        </ShapeSource>

        {/* ── Real-Time Boundary Rotation Degree Label ── */}
        {boundaryGeo.labelCoord && (
          <MarkerView coordinate={boundaryGeo.labelCoord} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <View
              style={{
                backgroundColor: "rgba(15, 23, 42, 0.9)",
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: "#38bdf8",
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Text style={{ color: "#38bdf8", fontSize: 12, fontWeight: "bold" }}>↻</Text>
              <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "bold", fontFamily: "monospace" }}>
                {Math.round(boundaryGeo.rotDeg || 0)}°
              </Text>
            </View>
          </MarkerView>
        )}

        {/* ── Placed template items (Templates) ── */}
        {/* Same tile fidelity as plan-lines/selected-line: default maxZoomLevel=18 +
            tolerance=0.375 simplifies dense circle rings into faceted polygons once the
            camera overzooms past generation zoom (alignment / Templates often sit at 19+). */}
        <ShapeSource
          id="placed-item-boxes"
          shape={activeItemsGeo.boxes}
          onPress={handleItemsPress}
          maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
          tolerance={PLAN_SOURCE_TOLERANCE}
        >
          <FillLayer
            id="placed-item-boxes-fill"
            style={{
              // Touch box is invisible but still catches taps via the ShapeSource onPress.
              fillColor: "transparent",
              fillOpacity: 0.01,
              fillOutlineColor: "transparent",
            }}
          />
        </ShapeSource>
        <ShapeSource
          id="placed-item-lines"
          shape={activeItemsGeo.lines}
          onPress={handleItemsPress}
          maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
          tolerance={PLAN_SOURCE_TOLERANCE}
        >
          <LineLayer
            id="placed-item-lines-layer"
            style={{
              // Selected items turn red to indicate selection.
              lineColor: ["case", ["get", "selected"], "#ef4444", "#16a34a"],
              lineWidth: ["case", ["get", "selected"], 3, 2],
              // sketchMode dims unselected items (parity with legacy renderPlacedItems).
              lineOpacity: ["case", ["get", "selected"], 1.0, sketchMode ? 0.2 : 0.8],
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        </ShapeSource>
        {/* ── Rover range circle + next-target line (isolated source) ── */}
        {roverGeo.rangeCircle && (
          <ShapeSource
            id="rover-range"
            shape={roverGeo.rangeCircle}
            maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
            tolerance={PLAN_SOURCE_TOLERANCE}
          >
            <FillLayer id="rover-range-fill" style={{ fillColor: "#3b82f6", fillOpacity: 0.12 }} />
            <LineLayer
              id="rover-range-outline"
              style={{ lineColor: "#3b82f6", lineWidth: 1.5, lineDasharray: [4, 4] }}
            />
          </ShapeSource>
        )}
        {roverGeo.targetLine && (
          <ShapeSource
            id="rover-target"
            shape={roverGeo.targetLine}
            maxZoomLevel={PLAN_SOURCE_MAX_ZOOM}
            tolerance={PLAN_SOURCE_TOLERANCE}
          >
            <LineLayer
              id="rover-target-layer"
              style={{ lineColor: "#f59e0b", lineWidth: 2, lineDasharray: [4, 4] }}
            />
            <SymbolLayer
              id="rover-target-label"
              style={{
                textField: ["get", "label"],
                textColor: "#f59e0b",
                textHaloColor: "#0f172a",
                textHaloWidth: 1.5,
                textSize: 12,
                textOffset: [0, -1],
                textAnchor: "bottom",
              }}
            />
          </ShapeSource>
        )}



        {/* ── Click-to-Mark drawn waypoints ── */}
        {drawnWaypoints && drawnWaypoints.length > 0 && (() => {
          const pointFeatures = drawnWaypoints.map((wp, i) => ({
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: toMapboxCoord(wp.lat, wp.lon) },
            properties: { index: i + 1 },
          }));
          const pointsGeo: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: pointFeatures,
          };
          const lineGeo: GeoJSON.FeatureCollection | null = drawnWaypoints.length >= 2
            ? {
                type: "FeatureCollection",
                features: [{
                  type: "Feature",
                  geometry: {
                    type: "LineString",
                    coordinates: drawnWaypoints.map((wp) => toMapboxCoord(wp.lat, wp.lon)),
                  },
                  properties: {},
                }],
              }
            : null;
          return (
            <>
              {lineGeo && (
                <ShapeSource id="drawn-waypoints-line" shape={lineGeo}>
                  <LineLayer
                    id="drawn-waypoints-line-layer"
                    style={{
                      lineColor: "#f4c10c",
                      lineWidth: 3,
                      lineDasharray: [2, 2],
                      lineOpacity: 0.8,
                    }}
                  />
                </ShapeSource>
              )}
              <ShapeSource id="drawn-waypoints-points" shape={pointsGeo}>
                <CircleLayer
                  id="drawn-waypoints-circle"
                  style={{
                    circleRadius: 8,
                    circleColor: "#f4c10c",
                    circleStrokeWidth: 2.5,
                    circleStrokeColor: "#ffffff",
                  }}
                />
                <SymbolLayer
                  id="drawn-waypoints-label"
                  style={{
                    textField: ["to-string", ["get", "index"]],
                    textColor: "#1c1c1c",
                    textSize: 10,
                    textFont: ["DIN Pro Bold"],
                    textAllowOverlap: true,
                  }}
                />
              </ShapeSource>
            </>
          );
        })()}

        {/* ── Rover vehicle marker + heading ── */}
        {showRover && roverGeo.center && (
          <MarkerView coordinate={roverGeo.center} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <RoverVehicle heading={roverGeo.heading} mapBearing={cameraBearing} />
          </MarkerView>
        )}

        {/* ── Next-target pulsing marker ── */}
        {roverGeo.targetPoint && (
          <MarkerView coordinate={roverGeo.targetPoint} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <PulsingDot color="#f59e0b" size={12} />
          </MarkerView>
        )}
      </RNMapboxMapView>
    </View>
  );

  // KEY ARBITRATION: The GestureDetector is always mounted, but the gestures
  // inside it are conditionally enabled via `.enabled(hasEditableSelection)`.
  // When disabled, RNGH passes all touch events to the Mapbox map directly 
  // (normal pan/zoom/tap). This avoids:
  //   - Map being blocked when not editing.
  //   - Map remounting (losing camera/zoom state) when selection changes.
  return (
    <GestureDetector gesture={composedGesture}>
      {mapContent}
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    elevation: 10,
    borderRadius: 20,
    overflow: "hidden",
  },
  map: { flex: 1 },
});

export default MapViewNative;
