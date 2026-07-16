/**
 * Native Mapbox implementation of the map, behind the USE_NATIVE_MAPBOX flag.
 *
 * Goal: full backward compatibility with the legacy Leaflet `MapView` — it
 * accepts the exact same `MapViewProps` so `App.tsx` / `TemplatesPage.tsx` need
 * zero changes. This file focuses on RENDERING PARITY (Phase 1, first milestone):
 * basemap, plan lines, rover + heading + range circle, next-target, reference
 * points, start arrow, boundary + control points, placed items, selection
 * highlight, camera recenter/fit, and tap selection. Gesture editing
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
  resolveMapGeometryFrame,
  resolveMapProjectionOrigin,
  type MapProjectionOrigin,
} from "../utils/mapGeometryProjection";
import {
  getCurveGeometry,
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
import { findNearestPointWithinRadius, type LocalMeters } from "../utils/refPointSnap";
import { computeShapeSnapPoints } from "../utils/planShapeSnapPoints";
import { toMapboxCoord, fromMapboxCoord } from "../utils/mapboxCoords";
import { MAPBOX_STYLE_URL } from "../config/mapbox";
import type { MapViewProps } from "./mapViewTypes";
import { pixelDeltaToMetres, clampToIndent, type BoundingRect } from "../utils/mapGestureUtils";
import { deriveMetersPerPixel, screenToGeo } from "../utils/mapScreenGeo";

/** Distance at which the Figma/Illustrator-style snap guide line appears, connecting a nearby
 * reference point to the plan (metres) — bigger than REF_POINT_SNAP_RADIUS_M so the guide gives
 * advance warning before the magnetic pull actually kicks in. */
const REF_POINT_GUIDE_RADIUS_M = 1.5;
/** Distance at which the plan's position actually snaps onto a reference point (metres). */
const REF_POINT_SNAP_RADIUS_M = 0.3;
/** Once locked onto a reference point, a candidate must be dragged out past THIS (larger)
 * radius to release — the hysteresis gap between this and REF_POINT_SNAP_RADIUS_M is what makes
 * a snap "hold" instead of flickering in and out right at the entry boundary. */
const REF_POINT_RELEASE_RADIUS_M = 0.6;

/** A reference point in local metres, carrying its ORIGINAL lat/lon alongside — needed to
 * identify (by value, not array index — `selectedPoints` and `snapRefPoints` can diverge when a
 * tapped point hasn't had its lat/lon filled in yet) which point to highlight as the active snap
 * target while the plan is being dragged near it. */
type SnapRefPoint = LocalMeters & { lat: number; lon: number };

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
const WEB_MERCATOR_WORLD_METERS = 40075016.68557849;
const MAPBOX_TILE_SIZE = 512;
const TRUE_CIRCLE_MAX_ZOOM = 22;
const TRUE_CIRCLE_RADIUS_EXPRESSION = [
  "interpolate",
  ["exponential", 2],
  ["zoom"],
  0,
  ["*", ["get", "meterRadius"], ["get", "pixelsPerMeterZoom0"]],
  TRUE_CIRCLE_MAX_ZOOM,
  ["*", ["get", "meterRadius"], ["get", "pixelsPerMeterMaxZoom"]],
] as const;

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
  const l2 = (x1 - x2) ** 2 + (y1 - y2) ** 2;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
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

/** A GeoJSON point's "true circle" sizing properties — used ONLY for the steady-state (not
 *  actively dragging) placed-item render. Mapbox's CircleLayer draws a real, GPU-rendered
 *  circle that stays perfectly smooth at any zoom level, unlike a polyline approximation which
 *  always has *some* zoom where its facets become visible. This is intentionally NOT used for
 *  the live drag preview (buildItemsGeoForItems) — during an active drag the GeoJSON source
 *  updates continuously, and a data-driven, zoom-interpolated circle-radius style property
 *  visibly desynced from position under that update rate (this is what looked like the circle
 *  "shrinking" while being moved). Restricting this to the steady state keeps the previously
 *  fixed drag behavior (plain tessellated polyline, immune to that desync) while restoring full
 *  native smoothness for the common case: looking at the plan before/after a drag, not mid-drag. */
function trueCircleProperties(
  coord: Coord,
  meterRadius: number,
  properties: GeoJSON.GeoJsonProperties = {}
): GeoJSON.GeoJsonProperties {
  const lat = coord[1];
  const latitudeScale = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const pixelsPerMeterZoom0 =
    MAPBOX_TILE_SIZE / (WEB_MERCATOR_WORLD_METERS * latitudeScale);
  return {
    ...properties,
    meterRadius,
    pixelsPerMeterZoom0,
    pixelsPerMeterMaxZoom: pixelsPerMeterZoom0 * Math.pow(2, TRUE_CIRCLE_MAX_ZOOM),
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

/** Rover vehicle icon — react-native-svg port of the legacy inline SVG. */
function RoverVehicle({ heading }: { heading: number | null | undefined }) {
  return (
    <View style={{ transform: [{ rotate: `${heading ?? 0}deg` }] }}>
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

/** Start-direction arrow — rotated red triangle pointing along the plan's
 *  initial travel direction (parity with the legacy rotated CSS triangle).
 *  At bearing 0 the arrow points up (North); rotation is clockwise from North. */
function StartArrow({ bearing }: { bearing: number }) {
  return (
    <View style={{ transform: [{ rotate: `${bearing}deg` }] }}>
      <Svg width={14} height={16} viewBox="0 0 14 16">
        <SvgPolygon
          points="7,0 13,15 1,15"
          fill="#ef4444"
          stroke="#ffffff"
          strokeWidth={1}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

export function MapViewNative(props: MapViewProps) {
  const {
    telemetrySnapshot,
    lines,
    alignedRefPoints,
    visible,
    recenterRoverTrigger,
    recenterPlanTrigger,
    resetNorthTrigger,
    onSelectPoint,
    onSelectLine,
    selectedLineId,
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
    visualAlignmentAnchor,
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
  } = props;

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

  // Multi-Point Fit snap hysteresis: once a candidate (corner/edge-midpoint/center/quadrant)
  // locks onto a reference point, it HOLDS there — the plan won't drift off the moment a tiny
  // hand-jitter nudges it past the (tight) entry radius. It only releases once dragged past the
  // larger REF_POINT_RELEASE_RADIUS_M. Scoped to a single gesture — reset at drag begin/end.
  const snapLockRef = useRef<{ candidateIndex: number; point: SnapRefPoint } | null>(null);

  // Preview FeatureCollection for live drag feedback (set via RAF-coalesced JS callback).
  // Null = use the normal committed sources (no active drag preview).
  const [previewItemsGeo, setPreviewItemsGeo] = useState<{
    lines: GeoJSON.FeatureCollection;
    boxes: GeoJSON.FeatureCollection;
  } | null>(null);
  const [previewBoundary, setPreviewBoundary] = useState<{
    x: number;
    y: number;
    rotation: number;
  } | null>(null);

  // Multi-Point Fit reference-point snap guide (Figma/Illustrator-style): a line from the
  // nearest reference point to the plan while it's being dragged close to one. Cleared once the
  // gesture ends — it's only ever shown live, mid-drag.
  const [snapGuideFC, setSnapGuideFC] = useState<GeoJSON.FeatureCollection>(featureCollection([]));
  // Which reference point (by value, via refPointKey) is the active snap target right now —
  // drives the highlighted/bigger styling on that point's own marker in selectedPointsFC below,
  // so the point itself visibly reacts as the plan comes closer, not just a separate overlay dot.
  const [activeSnapRefPointKey, setActiveSnapRefPointKey] = useState<string | null>(null);

  // rAF coalescing for preview updates — avoids calling setPreviewItemsGeo 60×/sec.
  const previewRafRef = useRef<number | null>(null);

  // Stable fallback origin so the plan doesn't jitter with every telemetry tick during preview
  const [stableFallbackOrigin, setStableFallbackOrigin] = useState<{lat: number, lon: number} | null>(null);

  // ── Templates floating origin (parity with legacy) ──
  const [templatesFloatingOrigin, setTemplatesFloatingOrigin] = useState<{
    lat: number;
    lon: number;
  } | null>(null);

  useEffect(() => {
    if (!stableFallbackOrigin && telemetrySnapshot?.lat != null && telemetrySnapshot?.lon != null) {
      setStableFallbackOrigin({ lat: telemetrySnapshot.lat, lon: telemetrySnapshot.lon });
    } else if (!stableFallbackOrigin && templatesFloatingOrigin) {
      setStableFallbackOrigin(templatesFloatingOrigin);
    }
  }, [telemetrySnapshot?.lat, telemetrySnapshot?.lon, templatesFloatingOrigin, stableFallbackOrigin]);

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

  // ── Projection frame + origin (reuse existing utilities verbatim) ──
  // Honor an explicit `mapGeometryFrame` prop when provided (contract parity
  // with the legacy MapView), else resolve from inputs.
  const geometryFrame = useMemo(
    () =>
      mapGeometryFrame ??
      resolveMapGeometryFrame({
        mode,
        previewAnchor,
        alignedRefPoints: alignedRefPoints ?? [],
        stagedVerified,
        autoOriginReference: autoOriginReference ?? null,
        autoOriginEnabled,
      }),
    [mapGeometryFrame, mode, previewAnchor, alignedRefPoints, stagedVerified, autoOriginReference, autoOriginEnabled]
  );

  const projectionOrigin = useMemo((): MapProjectionOrigin | null => {
    const isPlanManipulation = placedItems?.some(
      (it) => it.id === "visual-alignment-group" || it.id === "plan-editing-group"
    );

    // Not gated on isPlanManipulation: this anchor must keep being used for a while AFTER
    // plan editing ends too (App.tsx keeps it alive post-bake for exactly this reason) —
    // otherwise the map falls through to the generic fallback below, which re-derives its
    // origin from `lines[0]`'s CURRENT position on every render and so cancels out
    // whatever the just-baked drag/rotate/scale moved, making the plan appear to snap back.
    if (visualAlignmentAnchor) {
      return {
        frame: "RAW_DESIGN",
        originLat: visualAlignmentAnchor.originLat,
        originLon: visualAlignmentAnchor.originLon,
        originDxfNorth: visualAlignmentAnchor.originDxfNorth,
        originDxfEast: visualAlignmentAnchor.originDxfEast,
      };
    }

    const resolved = resolveMapProjectionOrigin(geometryFrame, {
      mode,
      previewAnchor,
      alignedRefPoints,
      stagedVerified,
      autoOriginReference: autoOriginReference ?? null,
      autoOriginEnabled,
    });
    if (resolved) return resolved;

    if (mode === "templates" && !isPlanManipulation && templatesFloatingOrigin) {
      return {
        frame: "RAW_DESIGN",
        originLat: templatesFloatingOrigin.lat,
        originLon: templatesFloatingOrigin.lon,
        originDxfNorth: 0,
        originDxfEast: 0,
      };
    }

    // Fallback: If no origin is available (e.g. previewing unaligned plans in fields mode or visual alignment),
    // place the plan at the first seen floating origin (rover's position) so it renders on map.
    // If there is no rover telemetry, fallback to 0,0 (Null Island) so we can at least see the plan.
    if ((mode === "fields" || isPlanManipulation) && (lines.length > 0 || isPlanManipulation)) {
      const fallback = stableFallbackOrigin || templatesFloatingOrigin || { lat: 0, lon: 0 };
      const planLines = lines.length > 0 ? lines : (placedItems?.[0]?.lines ?? []);
      const firstLine = planLines[0];
      const startN = firstLine?.from?.x ?? 0;
      const startE = firstLine?.from?.y ?? 0;

      // Offset the local origin by 2 meters so the plan is rendered
      // 2 meters North and 2 meters East of the rover icon, rather than exactly on top of it.
      return {
        frame: "RAW_DESIGN",
        originLat: fallback.lat,
        originLon: fallback.lon,
        originDxfNorth: startN - 2,
        originDxfEast: startE - 2,
      };
    }

    return null;
  }, [
    geometryFrame,
    mode,
    previewAnchor,
    alignedRefPoints,
    stagedVerified,
    autoOriginReference,
    autoOriginEnabled,
    templatesFloatingOrigin,
    stableFallbackOrigin,
    lines, // We use lines to find the center/start
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
  // Computed once per geometry change, NOT per drag frame.
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
        features.push(
          lineFeature(coords, {
            id: line.id,
            layer: line.layer,
            color: colorForLayer(line.layer),
            closedRing: isClosedCoordRing(coords),
          })
        );
      }
    }
    return featureCollection(features);
  }, [lines, originSig, mode]);

  // ── Start-direction arrow (Fields): start coord + bearing (deg CW from N) ──
  const startArrow = useMemo((): { coord: Coord; bearing: number } | null => {
    if (mode === "templates" || !projectionOrigin || lines.length === 0) return null;
    const first = planLinesFC.features[0];
    if (!first || first.geometry.type !== "LineString" || first.geometry.coordinates.length < 2) {
      return null;
    }
    const [lon1, lat1] = first.geometry.coordinates[0] as Coord;
    const [lon2, lat2] = first.geometry.coordinates[1] as Coord;
    const dy = lat2 - lat1;
    const dx = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI; // deg clockwise from North
    return { coord: [lon1, lat1], bearing };
  }, [planLinesFC, originSig, lines.length, mode]);

  // ── Fields selection: highlighted line + corner points ──
  const selectionFC = useMemo(() => {
    if (mode !== "fields" || !projectionOrigin || !selectedLineId) {
      return { line: featureCollection([]), corners: featureCollection([]) };
    }
    const selected = lines.find((l) => l.id === selectedLineId);
    if (!selected) {
      return { line: featureCollection([]), corners: featureCollection([]) };
    }
    const segs = projectPlanLineToGpsSegments(selected, projectionOrigin);
    if (segs.length < 2) {
      return { line: featureCollection([]), corners: featureCollection([]) };
    }
    const coords = segs.map(([lat, lon]) => toMapboxCoord(lat, lon));
    const closedRing = isClosedCoordRing(coords);
    const cornerAnchors = isCurveEntity(selected) || isCircleLikeLine(selected)
      ? getCurveSelectionAnchors(selected).map((pt) => {
          const gps = projectPlanNorthEastToGps(pt.north, pt.east, projectionOrigin);
          return pointFeature(toMapboxCoord(gps.lat, gps.lon));
        })
      : coords.map((c) => pointFeature(c));
    const corners = cornerAnchors;
    return {
      line: featureCollection([lineFeature(coords, { closedRing })]),
      corners: featureCollection(corners),
    };
  }, [mode, originSig, selectedLineId, lines]);

  // ── Reference points ──
  const refPointsFC = useMemo(() => {
    if (!alignedRefPoints || alignedRefPoints.length === 0) return featureCollection([]);
    console.log(
      `[AlignDXF][Map] Verified ref-point marker(s) (blue "Ref #" dots) at:`,
      JSON.stringify(alignedRefPoints.map((p) => ({ lat: p.lat, lon: p.lon })))
    );
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
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        // Matched by VALUE (not index) against activeSnapRefPointKey — `selectedPoints` (every
        // ref point) and the filtered, snap-eligible `snapRefPoints` can diverge in index when a
        // tapped point hasn't had its lat/lon filled in yet, so index correspondence isn't safe.
        const isSnapActive = activeSnapRefPointKey === refPointKey({ lat: p.lat as number, lon: p.lon as number });
        features.push(
          pointFeature(toMapboxCoord(p.lat as number, p.lon as number), { id: `sp-${i}`, isSnapActive })
        );
        return;
      }
      // No coordinate yet (freshly tapped, not filled in) — show where it sits on the
      // currently-previewed plan so it lines up with what the user just tapped.
      if (!projectionOrigin) return;
      // In FieldsPage/App.tsx, p.x is Northing (dxf_y) and p.y is Easting (dxf_x)
      const gps = projectPlanNorthEastToGps(p.x, p.y, projectionOrigin);
      features.push(pointFeature(toMapboxCoord(gps.lat, gps.lon), { id: `sp-${i}`, isSnapActive: false }));
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
    // 16 steps is visually smooth at field zoom and ~3x cheaper than 48 on the
    // per-tick rover path.
    const rangeCircle = circle(center, 1.5, { steps: 16, units: "meters" }) as GeoJSON.Feature<GeoJSON.Polygon>;

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
  // This is the STEADY-STATE render (the committed item, not an active drag) — circles use the
  // native "true circle" CircleLayer (see trueCircleProperties above) so they stay perfectly
  // smooth at any zoom instead of showing polyline facets. The live drag preview
  // (buildItemsGeoForItems below) deliberately does NOT do this — during an active drag the
  // source updates continuously and the data-driven circle-radius style visibly desynced from
  // position under that update rate (reported as the circle "shrinking" while being moved), so
  // it uses a plain tessellated polyline instead. Splitting the two keeps both fixed: smooth
  // circles when idle, no shrink/jitter while actively dragging.
  const placedItemsGeo = useMemo(() => {
    if (mode !== "templates" || !placedItems || placedItems.length === 0 || !projectionOrigin) {
      return { lines: featureCollection([]), circles: featureCollection([]), boxes: featureCollection([]) };
    }
    const lineFeatures: GeoJSON.Feature[] = [];
    const circleFeatures: GeoJSON.Feature[] = [];
    const boxFeatures: GeoJSON.Feature[] = [];

    for (const item of placedItems) {
      const selected = selectedItemIds?.includes(item.id) ?? false;
      // Item lines via the shared visual transform (north/east → GPS).
      for (const l of item.lines) {
        const circleGeometry = isCircleLikeLine(l) ? getCurveGeometry(l) : null;
        if (circleGeometry) {
          const center = transformVisualDxfPoint(
            circleGeometry.centerNorth,
            circleGeometry.centerEast,
            item
          );
          const centerGps = projectPlanNorthEastToGps(center.north, center.east, projectionOrigin);
          const centerCoord = toMapboxCoord(centerGps.lat, centerGps.lon);
          circleFeatures.push(
            pointFeature(
              centerCoord,
              trueCircleProperties(centerCoord, Math.abs(circleGeometry.radius * item.scale), {
                itemId: item.id,
                selected,
              })
            )
          );
          continue;
        }

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
      // Bounding box (centered at item.y North / item.x East), rotated + scaled.
      const cos = Math.cos(((item.rotation || 0) * Math.PI) / 180);
      const sin = Math.sin(((item.rotation || 0) * Math.PI) / 180);
      const halfN = item.height / 2;
      const halfE = item.width / 2;
      const cornersLocal = [
        { n: -halfN, e: -halfE },
        { n: -halfN, e: halfE },
        { n: halfN, e: halfE },
        { n: halfN, e: -halfE },
      ];
      const ring: Coord[] = cornersLocal.map((c) => {
        const n = (c.n * cos - c.e * sin) * item.scale + item.y;
        const e = (c.n * sin + c.e * cos) * item.scale + item.x;
        const gps = projectPlanNorthEastToGps(n, e, projectionOrigin);
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
      circles: featureCollection(circleFeatures),
      boxes: featureCollection(boxFeatures),
    };
  }, [mode, placedItems, selectedItemIds, originSig]);

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

  // Whether we have anything selected that can be edited.
  // Gesture engagement is gated on this: if nothing is selected, the
  // GestureDetector is not even mounted so map touch events pass through freely.
  const hasEditableSelection =
    mode === "templates" &&
    (
      (selectedItemIds && selectedItemIds.length > 0) ||
      (selectedItemIds && selectedItemIds.includes("boundary"))
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
   * Build a preview FeatureCollection for the given shifted items.
   * Reuses the same projection logic as placedItemsGeo — kept in sync manually.
   */
  const buildItemsGeoForItems = useCallback(
    (items: PlacedItem[]): {
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
        const cos = Math.cos(((item.rotation || 0) * Math.PI) / 180);
        const sin = Math.sin(((item.rotation || 0) * Math.PI) / 180);
        const halfN = item.height / 2;
        const halfE = item.width / 2;
        const ring: Coord[] = [
          { n: -halfN, e: -halfE }, { n: -halfN, e: halfE },
          { n: halfN,  e: halfE  }, { n: halfN,  e: -halfE },
        ].map((c) => {
          const n = (c.n * cos - c.e * sin) * item.scale + item.y;
          const e = (c.n * sin + c.e * cos) * item.scale + item.x;
          const g = projectPlanNorthEastToGps(n, e, projectionOrigin);
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
    [projectionOrigin, selectedItemIds]
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

  // Applies the Multi-Point Fit reference-point snap to a proposed transform: every shape-aware
  // candidate (corners, edge-midpoints, overall center — or quadrants+center for a circle/
  // ellipse; see planShapeSnapPoints.ts) is transformed and checked, and the SINGLE closest
  // candidate-to-reference-point pair wins — so a corner (or edge-midpoint, or center) can snap
  // onto a reference point individually, not just the plan's center. Within
  // REF_POINT_SNAP_RADIUS_M that pair magnetically snaps (a rigid translation of the whole
  // plan) AND holds a lock (snapLockRef); once locked, it keeps holding through small jitter and
  // only releases once dragged past the larger REF_POINT_RELEASE_RADIUS_M — otherwise the plan
  // would flicker in and out of the snap right at the entry boundary instead of feeling "held".
  // Within REF_POINT_GUIDE_RADIUS_M (but not yet locked), `guide` reports a Figma/Illustrator-
  // style guide line connecting the point to that candidate for the caller to render. A no-op
  // unless the item being moved is specifically the "plan-editing-group" sticker (never the
  // Visual method's own "visual-alignment-group" sticker, which this feature deliberately
  // leaves untouched). Runs on the JS thread (called from onDragMove/onDragCommit below, never
  // from inside a reanimated worklet), so it can freely do the GPS<->metres math without any
  // UI-thread/worklet constraints. Rotation is always passed through unchanged — this is a
  // position-only snap.
  const applyPointSnap = useCallback(
    (
      itemId: string,
      newX: number,
      newY: number,
      newRotation: number,
      newScale: number
    ): { x: number; y: number; rotation: number; scale: number; guide: { point: SnapRefPoint; anchor: LocalMeters } | null } => {
      if (
        itemId !== "plan-editing-group" ||
        planEditingSnapCandidates.length === 0 ||
        !projectionOrigin ||
        snapRefLocalPoints.length === 0
      ) {
        snapLockRef.current = null;
        return { x: newX, y: newY, rotation: newRotation, scale: newScale, guide: null };
      }

      const transformed = planEditingSnapCandidates.map((candidate) => {
        const placed = transformVisualDxfPoint(candidate.north, candidate.east, {
          x: newX,
          y: newY,
          rotation: newRotation,
          scale: newScale,
        });
        return {
          north: placed.north - projectionOrigin.originDxfNorth,
          east: placed.east - projectionOrigin.originDxfEast,
        };
      });

      // Already locked onto a point — keep holding as long as that SAME candidate hasn't been
      // dragged past the (larger) release radius from that SAME point, regardless of whether
      // it's still within the tighter entry radius. This is what makes the snap feel "held".
      const lock = snapLockRef.current;
      if (lock && lock.candidateIndex < transformed.length) {
        const current = transformed[lock.candidateIndex];
        const dist = Math.hypot(current.north - lock.point.north, current.east - lock.point.east);
        if (dist <= REF_POINT_RELEASE_RADIUS_M) {
          return {
            x: newX + (lock.point.east - current.east),
            y: newY + (lock.point.north - current.north),
            rotation: newRotation,
            scale: newScale,
            guide: { point: lock.point, anchor: lock.point },
          };
        }
        snapLockRef.current = null; // dragged far enough away — release the hold.
      }

      // No active lock — look for a new one using the tighter entry/guide radii.
      let best: { index: number; candidate: LocalMeters; point: SnapRefPoint; dist: number } | null = null;
      for (let index = 0; index < transformed.length; index++) {
        const current = transformed[index];
        const nearest = findNearestPointWithinRadius(current, snapRefLocalPoints, REF_POINT_GUIDE_RADIUS_M);
        if (!nearest) continue;
        const dist = Math.hypot(current.north - nearest.north, current.east - nearest.east);
        if (!best || dist < best.dist) {
          best = { index, candidate: current, point: nearest, dist };
        }
      }

      if (!best) {
        return { x: newX, y: newY, rotation: newRotation, scale: newScale, guide: null };
      }
      if (best.dist > REF_POINT_SNAP_RADIUS_M) {
        return {
          x: newX,
          y: newY,
          rotation: newRotation,
          scale: newScale,
          guide: { point: best.point, anchor: best.candidate },
        };
      }

      // Newly entering snap range — acquire the hold so small jitter doesn't immediately break it.
      snapLockRef.current = { candidateIndex: best.index, point: best.point };
      return {
        x: newX + (best.point.east - best.candidate.east),
        y: newY + (best.point.north - best.candidate.north),
        rotation: newRotation,
        scale: newScale,
        guide: { point: best.point, anchor: best.point },
      };
    },
    [planEditingSnapCandidates, projectionOrigin, snapRefLocalPoints]
  );

  const applyDragMove = useCallback(
    (dN: number, dE: number, rotDeg: number, scaleF: number) => {
      const starts = dragStartPositionsRef.current;
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
      const indentRect = buildIndentRect();

      // A plain for-of (not .map()) so TS can actually track activeGuide's reassignment below —
      // it can't follow mutations made from inside a separate callback function.
      let activeGuide: { point: SnapRefPoint; anchor: LocalMeters } | null = null;
      const shifted: PlacedItem[] = [];
      for (const item of placedItems) {
        const start = starts[item.id];
        if (!start || !ids.includes(item.id)) {
          shifted.push(item);
          continue;
        }
        const newX = start.x + dE;
        const newY = start.y + dN;
        const newRotation = start.rotation + rotDeg;
        const newScale = start.scale * scaleF;
        const snapped = applyPointSnap(item.id, newX, newY, newRotation, newScale);
        if (snapped.guide) activeGuide = snapped.guide;
        shifted.push({ ...item, x: snapped.x, y: snapped.y, rotation: snapped.rotation, scale: snapped.scale });
      }

      setPreviewItemsGeo(buildItemsGeoForItems(shifted));
      setSnapGuideFC(buildSnapGuideFC(activeGuide));
      setActiveSnapRefPointKey(activeGuide ? refPointKey(activeGuide.point) : null);
    },
    [placedItems, selectedItemIds, buildIndentRect, buildItemsGeoForItems, applyPointSnap, buildSnapGuideFC]
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
      const ids = selectedItemIds ?? [];

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

      // The snap guide/highlight only ever make sense mid-drag — always clear on finalize.
      setSnapGuideFC(featureCollection([]));
      setActiveSnapRefPointKey(null);

      if (!placedItems) {
        setPreviewItemsGeo(null);
        return;
      }
      const indentRect = buildIndentRect();

      const updated = placedItems.map((item) => {
        const start = starts[item.id];
        if (!start || !ids.includes(item.id)) return item;
        const newX = start.x + finalDE;
        const newY = start.y + finalDN;
        const newRotation = start.rotation + finalRotDeg;
        const newScale = start.scale * finalScaleF;
        const snapped = applyPointSnap(item.id, newX, newY, newRotation, newScale);
        return { ...item, x: snapped.x, y: snapped.y, rotation: snapped.rotation, scale: snapped.scale };
      });

      // Single commit to parent — parity with legacy itemsMoved handler.
      if (onUpdatePlacedItems) {
        onUpdatePlacedItems(updated);
      } else if (onUpdatePlacedItem) {
        updated.forEach((item) => {
          const orig = placedItems.find((it) => it.id === item.id);
          if (orig && (item.x !== orig.x || item.y !== orig.y || item.rotation !== orig.rotation || item.scale !== orig.scale)) {
            onUpdatePlacedItem(item.id, { x: item.x, y: item.y, rotation: item.rotation, scale: item.scale });
          }
        });
      }

      // Clear preview — parent state is now up to date.
      setPreviewItemsGeo(null);
      dragStartPositionsRef.current = {};
      snapLockRef.current = null; // the gesture is over — nothing left to hold.
    },
    [
      placedItems,
      selectedItemIds,
      buildIndentRect,
      onUpdatePlacedItems,
      onUpdatePlacedItem,
      onMoveBoundary,
      onRotateBoundary,
      applyPointSnap,
    ]
  );

  /**
   * Called via runOnJS from onBegin. Snapshots start positions and calibrates mpp.
   */
  const onDragBegin = useCallback(
    (touchX: number, touchY: number) => {
      const ids = selectedItemIds ?? [];
      const snapshot: Record<string, { x: number; y: number; rotation: number; scale: number }> = {};
      for (const item of placedItems ?? []) {
        if (ids.includes(item.id)) {
          snapshot[item.id] = { x: item.x, y: item.y, rotation: item.rotation || 0, scale: item.scale || 1 };
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
      snapLockRef.current = null; // each gesture starts with no held snap.
      calibrateMetersPerPixel(touchX, touchY);
    },
    [placedItems, selectedItemIds, boundaryPosition, boundaryRotation, calibrateMetersPerPixel]
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
        .minDistance(4)
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

  // Gate gestures based on multiTouchMode:
  // - "both": pan + pinch + rotation
  // - "scale": pan + pinch only (no rotation)
  // - "rotate": pan + rotation only (no pinch/scale)
  const composedGesture = useMemo(
    () => {
      if (manualDrawingEnabled) {
        return Gesture.Pan().enabled(false);
      }
      const gestures: any[] = [panGesture.enabled(!!hasEditableSelection)];
      if (multiTouchMode === "both" || multiTouchMode === "scale") {
        gestures.push(pinchGesture.enabled(!!hasEditableSelection));
      }
      if (multiTouchMode === "both" || multiTouchMode === "rotate") {
        gestures.push(rotationGesture.enabled(!!hasEditableSelection));
      }
      return Gesture.Simultaneous(...gestures);
    },
    [panGesture, pinchGesture, rotationGesture, multiTouchMode, hasEditableSelection, manualDrawingEnabled]
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
      placedItemsGeo.circles.features.forEach(pushFeatureCoords);
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
    cameraRef.current?.fitBounds([minLon, minLat], [maxLon, maxLat], 40, 400);
  }, [collectFitCoords]);

  // Recenter on rover — STRICTLY one-shot per button press (parity with legacy).
  // `roverGeo.center` is intentionally NOT a dependency: if it were, this effect
  // would re-fire on every telemetry tick (roverGeo.center is a fresh array each
  // tick) and turn a one-shot recenter into continuous follow.
  useEffect(() => {
    if (!visible || !recenterRoverTrigger || recenterRoverTrigger <= 0) return;
    if (recenterRoverTrigger === lastRecenterRoverRef.current) return;
    lastRecenterRoverRef.current = recenterRoverTrigger;
    if (roverGeo.center) {
      cameraRef.current?.setCamera({ centerCoordinate: roverGeo.center, animationDuration: 300 });
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
    cameraRef.current?.setCamera({
      heading: 0,
      animationDuration: 300,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNorthTrigger, visible]);

  // Initial autocenter: prefer rover, else fit plan (parity with legacy).
  useEffect(() => {
    if (!visible || hasAutoCenteredRef.current) return;
    if (roverGeo.center) {
      cameraRef.current?.setCamera({
        centerCoordinate: roverGeo.center,
        zoomLevel: 19,
        animationDuration: 0,
      });
      hasAutoCenteredRef.current = true;
    } else if (collectFitCoords().length > 0) {
      fitToPlan();
      hasAutoCenteredRef.current = true;
    }
  }, [visible, roverGeo.center, collectFitCoords, fitToPlan]);

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
  useEffect(() => {
    const count = alignedRefPoints?.length ?? 0;
    if (visible && count > lastAlignedRefPointsCountRef.current) {
      fitToPlan();
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
        onSelectionChange?.([]);
        return;
      }
      if (!projectionOrigin) return;

      const local = projectGpsToLocalMeters(pLat, pLon, projectionOrigin.originLat, projectionOrigin.originLon);
      const clickedDxfX = local.east + projectionOrigin.originDxfEast;
      const clickedDxfY = local.north + projectionOrigin.originDxfNorth;

      // 1) Nearest vertex/point (4.5 m tolerance)
      let bestPt: { x: number; y: number } | null = null;
      let bestPtDist = Infinity;
      for (const line of lines) {
        if (line.from) {
          const d = Math.hypot(line.from.x - clickedDxfY, line.from.y - clickedDxfX);
          if (d < bestPtDist) { bestPtDist = d; bestPt = { x: line.from.x, y: line.from.y }; }
        }
        if (line.to) {
          const d = Math.hypot(line.to.x - clickedDxfY, line.to.y - clickedDxfX);
          if (d < bestPtDist) { bestPtDist = d; bestPt = { x: line.to.x, y: line.to.y }; }
        }
        if (line.entity?.preview_points) {
          for (const pt of line.entity.preview_points) {
            const d = Math.hypot(pt.north - clickedDxfY, pt.east - clickedDxfX);
            if (d < bestPtDist) { bestPtDist = d; bestPt = { x: pt.north, y: pt.east }; }
          }
        }
      }
      if (bestPt && bestPtDist < 4.5 && onSelectPoint) {
        onSelectPoint({ x: bestPt.x, y: bestPt.y });
        return;
      }

      // 2) Nearest line (3.5 m tolerance)
      let bestLineId: string | null = null;
      let bestLineDist = Infinity;
      for (const line of lines) {
        let dist = Infinity;
        if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
          for (let i = 0; i < line.entity.preview_points.length - 1; i++) {
            const p1 = line.entity.preview_points[i];
            const p2 = line.entity.preview_points[i + 1];
            const d = distToSegment(clickedDxfX, clickedDxfY, p1.north, p1.east, p2.north, p2.east);
            if (d < dist) dist = d;
          }
        } else if (line.from && line.to) {
          dist = distToSegment(clickedDxfX, clickedDxfY, line.from.x, line.from.y, line.to.x, line.to.y);
        }
        if (dist < bestLineDist) { bestLineDist = dist; bestLineId = line.id; }
      }
      if (bestLineId && bestLineDist < 3.5 && onSelectLine) {
        onSelectLine(bestLineId);
      } else if (onSelectLine) {
        onSelectLine(null);
      }
    },
    [mode, originSig, lines, onSelectPoint, onSelectLine, onSelectionChange, onMapClickToMark]
  );

  const handleItemsPress = useCallback(
    (event: ShapeSourcePressEvent) => {
      const f = event.features?.[0];
      const itemId = f?.properties?.itemId as string | undefined;
      if (itemId) onSelectionChange?.([itemId]);
    },
    [onSelectionChange]
  );

  if (!visible) return null;

  const refLabelsVisible = !!showRefPointLabels;
  // Active preview overrides the committed sources during a live gesture.
  const activeItemsGeo = previewItemsGeo ?? placedItemsGeo;
  // The live drag preview has no `.circles` — during an active drag, circles are already
  // included (as a tessellated polyline) in activeItemsGeo.lines, so the native CircleLayer
  // source must go empty rather than double-drawing the circle via both layers.
  const activeCircles = previewItemsGeo ? featureCollection([]) : placedItemsGeo.circles;
  // The inner map content (shared between editing and non-editing render).
  const mapContent = (
    <View style={styles.container}>
      <RNMapboxMapView
        ref={mapViewRef}
        style={styles.map}
        styleURL={props.styleURL ?? MAPBOX_STYLE_URL}
        onPress={handleMapPress as (f: GeoJSON.Feature) => void}
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
          defaultSettings={roverGeo.center ? { centerCoordinate: roverGeo.center, zoomLevel: 19 } : undefined} 
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

        {/* ── Start-direction arrow rendered below as a rotated MarkerView ── */}

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

        {/* ── Reference points (+ optional labels) ── */}
        <ShapeSource id="ref-points" shape={refPointsFC}>
          <CircleLayer
            id="ref-points-layer"
            style={{
              circleRadius: 3.5,
              circleColor: "#10b981",
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 1.5,
            }}
          />
          {/* Labels always mounted; visibility toggled via opacity to keep
              ShapeSource children strongly typed and avoid remounts. */}
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

        {/* ── Multi-Point Fit snap guide — a Figma/Illustrator-style line + highlight dot
            from a nearby reference point to the plan while it's being dragged close to one ── */}
        <ShapeSource id="ref-point-snap-guide" shape={snapGuideFC}>
          <LineLayer
            id="ref-point-snap-guide-line"
            style={{
              lineColor: "#ff2d78",
              lineWidth: 2,
              lineOpacity: 0.9,
              lineDasharray: [3, 2],
            }}
          />
          <CircleLayer
            id="ref-point-snap-guide-dot"
            style={{
              circleRadius: 5,
              circleColor: "#ff2d78",
              circleStrokeWidth: 1.5,
              circleStrokeColor: "#ffffff",
            }}
          />
        </ShapeSource>

        {/* ── Selected alignment points (highlighted in yellow) ── */}
        <ShapeSource id="selected-points" shape={selectedPointsFC}>
          <CircleLayer
            id="selected-points-layer"
            style={{
              circleRadius: ["case", ["get", "isSnapActive"], 11, 6.5],
              circleColor: ["case", ["get", "isSnapActive"], "#ff2d78", "#eab308"],
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: ["case", ["get", "isSnapActive"], 3, 2],
              circleOpacity: 1,
            }}
          />
        </ShapeSource>

        {/* ── Virtual bounding box corners and dimension labels ── */}
        <ShapeSource id="virtual-box-corners" shape={virtualBoxCornersFC}>
          <CircleLayer
            id="virtual-box-corners-layer"
            style={{
              circleRadius: 5,
              circleColor: "#06b6d4",
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 1.5,
              circleOpacity: 0.95,
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
        <ShapeSource id="placed-item-boxes" shape={activeItemsGeo.boxes} onPress={handleItemsPress}>
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
        <ShapeSource id="placed-item-lines" shape={activeItemsGeo.lines} onPress={handleItemsPress}>
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
        <ShapeSource id="placed-item-circles" shape={activeCircles} onPress={handleItemsPress}>
          <CircleLayer
            id="placed-item-circles-layer"
            style={{
              circleRadius: TRUE_CIRCLE_RADIUS_EXPRESSION as any,
              circleColor: ["case", ["get", "selected"], "#ef4444", "#16a34a"],
              circleOpacity: 0.01,
              circleStrokeColor: ["case", ["get", "selected"], "#ef4444", "#16a34a"],
              circleStrokeWidth: ["case", ["get", "selected"], 3, 2],
              circleStrokeOpacity: ["case", ["get", "selected"], 1.0, sketchMode ? 0.2 : 0.8],
            }}
          />
        </ShapeSource>
        {/* ── Rover range circle + next-target line (isolated source) ── */}
        {roverGeo.rangeCircle && (
          <ShapeSource id="rover-range" shape={roverGeo.rangeCircle}>
            <FillLayer id="rover-range-fill" style={{ fillColor: "#3b82f6", fillOpacity: 0.12 }} />
            <LineLayer
              id="rover-range-outline"
              style={{ lineColor: "#3b82f6", lineWidth: 1.5, lineDasharray: [4, 4] }}
            />
          </ShapeSource>
        )}
        {roverGeo.targetLine && (
          <ShapeSource id="rover-target" shape={roverGeo.targetLine}>
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
        {roverGeo.center && (
          <MarkerView coordinate={roverGeo.center} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <RoverVehicle heading={roverGeo.heading} />
          </MarkerView>
        )}

        {/* ── Start-direction arrow (rotated to plan start bearing) ── */}
        {startArrow && (
          <MarkerView coordinate={startArrow.coord} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <StartArrow bearing={startArrow.bearing} />
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
