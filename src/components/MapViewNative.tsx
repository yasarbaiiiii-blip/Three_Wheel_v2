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
import { Animated, Easing, StyleSheet, View } from "react-native";
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
import {
  projectPlanLineToGpsSegments,
  projectPlanNorthEastToGps,
  resolveMapGeometryFrame,
  resolveMapProjectionOrigin,
  type MapProjectionOrigin,
} from "../utils/mapGeometryProjection";
import {
  transformVisualDxfPoint,
  projectGpsToLocalMeters,
} from "../utils/visualAlignment";
import { toMapboxCoord, fromMapboxCoord } from "../utils/mapboxCoords";
import { MAPBOX_STYLE_URL } from "../config/mapbox";
import type { MapViewProps } from "./mapViewTypes";

// ── Layer colours (parity with legacy LAYER_COLORS in MapView.tsx) ──
const LAYER_COLORS: Record<string, string> = {
  boundary: "#0f172a",
  marking: "#16a34a",
  marking_false: "#86efac",
  center: "#f59e0b",
  transit: "#94a3b8",
  extension: "#8b5cf6",
};
const DEFAULT_LINE_COLOR = "#0f172a";

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
    onSelectPoint,
    onSelectLine,
    selectedLineId,
    mode = "fields",
    placedItems,
    selectedItemIds,
    boundaryWidth,
    boundaryHeight,
    indentSpacing,
    showRefPointLabels,
    boundaryPosition,
    showBoundaryPoints,
    activeSnapPointId,
    onSelectionChange,
    previewAnchor,
    autoOriginReference,
    mapGeometryFrame,
    stagedVerified = false,
    autoOriginEnabled = false,
    lockPanDrag,
    lockZoom,
    sketchMode,
  } = props;

  const cameraRef = useRef<Camera>(null);
  const hasAutoCenteredRef = useRef(false);
  // Track the last trigger value we acted on, so recenter/fit fire exactly once
  // per button press and never on telemetry/geometry changes.
  const lastRecenterRoverRef = useRef(0);
  const lastRecenterPlanRef = useRef(0);

  // ── Templates floating origin (parity with legacy) ──
  const [templatesFloatingOrigin, setTemplatesFloatingOrigin] = useState<{
    lat: number;
    lon: number;
  } | null>(null);

  useEffect(() => {
    if (!visible || mode !== "templates") {
      setTemplatesFloatingOrigin(null);
      return;
    }
    if (previewAnchor || (alignedRefPoints && alignedRefPoints.length > 0) || templatesFloatingOrigin) {
      return;
    }
    if (telemetrySnapshot?.lat != null && telemetrySnapshot?.lon != null) {
      setTemplatesFloatingOrigin({ lat: telemetrySnapshot.lat, lon: telemetrySnapshot.lon });
    }
  }, [
    visible,
    mode,
    previewAnchor,
    alignedRefPoints,
    telemetrySnapshot?.lat,
    telemetrySnapshot?.lon,
    templatesFloatingOrigin,
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
        alignedRefPoints,
        stagedVerified,
        autoOriginReference: autoOriginReference ?? null,
        autoOriginEnabled,
      }),
    [mapGeometryFrame, mode, previewAnchor, alignedRefPoints, stagedVerified, autoOriginReference, autoOriginEnabled]
  );

  const projectionOrigin = useMemo((): MapProjectionOrigin | null => {
    const resolved = resolveMapProjectionOrigin(geometryFrame, {
      mode,
      previewAnchor,
      alignedRefPoints,
      stagedVerified,
      autoOriginReference: autoOriginReference ?? null,
      autoOriginEnabled,
    });
    if (resolved) return resolved;
    if (mode === "templates" && templatesFloatingOrigin) {
      return {
        frame: "RAW_DESIGN",
        originLat: templatesFloatingOrigin.lat,
        originLon: templatesFloatingOrigin.lon,
        originDxfNorth: 0,
        originDxfEast: 0,
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
    const corners = coords.map((c) => pointFeature(c));
    return {
      line: featureCollection([lineFeature(coords)]),
      corners: featureCollection(corners),
    };
  }, [mode, originSig, selectedLineId, lines]);

  // ── Reference points ──
  const refPointsFC = useMemo(() => {
    if (!alignedRefPoints || alignedRefPoints.length === 0) return featureCollection([]);
    const features = alignedRefPoints.map((p, i) =>
      pointFeature(toMapboxCoord(p.lat, p.lon), {
        label: `Ref #${i + 1}`,
      })
    );
    return featureCollection(features);
  }, [refPointsSig]);

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

    // Next-target: nearest plan segment ahead of the rover (parity with legacy).
    let targetPoint: Coord | null = null;
    if (
      telemetrySnapshot?.pos_n != null &&
      telemetrySnapshot?.pos_e != null &&
      lines.length > 0 &&
      projectionOrigin
    ) {
      const realN = telemetrySnapshot.pos_n;
      const realE = telemetrySnapshot.pos_e;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.from || !line.to) continue;
        const segDx = line.to.x - line.from.x;
        const segDy = line.to.y - line.from.y;
        const segLen2 = segDx * segDx + segDy * segDy;
        if (segLen2 === 0) continue;
        const t = ((realN - line.from.x) * segDx + (realE - line.from.y) * segDy) / segLen2;
        const target =
          t <= 0.5
            ? { x: line.to.x, y: line.to.y }
            : i < lines.length - 1
              ? { x: lines[i + 1].from.x, y: lines[i + 1].from.y }
              : { x: line.to.x, y: line.to.y };
        const dist = Math.hypot(target.x - realN, target.y - realE);
        if (dist < 100) {
          const gps = projectPlanNorthEastToGps(target.x, target.y, projectionOrigin);
          targetPoint = toMapboxCoord(gps.lat, gps.lon);
        }
        break;
      }
    }

    const targetLine =
      targetPoint != null
        ? featureCollection([lineFeature([center, targetPoint])])
        : null;

    return { center, heading, rangeCircle, targetLine, targetPoint };
  }, [
    telemetrySnapshot?.lat,
    telemetrySnapshot?.lon,
    telemetrySnapshot?.heading_ned_deg,
    telemetrySnapshot?.pos_n,
    telemetrySnapshot?.pos_e,
    lines,
    originSig,
  ]);

  // ── Placed items (Templates): lines + bounding boxes ──
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

    return { lines: featureCollection(lineFeatures), boxes: featureCollection(boxFeatures) };
  }, [mode, placedItems, selectedItemIds, originSig]);

  // ── Boundary box (Templates): outer + indent + control points ──
  const boundaryGeo = useMemo(() => {
    if (
      mode !== "templates" ||
      !projectionOrigin ||
      !boundaryWidth ||
      !boundaryHeight
    ) {
      return { outer: featureCollection([]), indent: featureCollection([]), controlPoints: featureCollection([]) };
    }
    const bpX = boundaryPosition?.x ?? 0;
    const bpY = boundaryPosition?.y ?? 0;
    const halfW = boundaryWidth / 2;
    const halfH = boundaryHeight / 2;

    const project = (north: number, east: number): Coord => {
      const gps = projectPlanNorthEastToGps(north, east, projectionOrigin);
      return toMapboxCoord(gps.lat, gps.lon);
    };

    const outerRing: Coord[] = [
      project(bpY - halfH, bpX - halfW),
      project(bpY - halfH, bpX + halfW),
      project(bpY + halfH, bpX + halfW),
      project(bpY + halfH, bpX - halfW),
      project(bpY - halfH, bpX - halfW),
    ];

    let indentFeatures: GeoJSON.Feature[] = [];
    if (indentSpacing && indentSpacing > 0) {
      const indW = halfW - indentSpacing;
      const indH = halfH - indentSpacing;
      if (indW > 0 && indH > 0) {
        const indentRing: Coord[] = [
          project(bpY - indH, bpX - indW),
          project(bpY - indH, bpX + indW),
          project(bpY + indH, bpX + indW),
          project(bpY + indH, bpX - indW),
          project(bpY - indH, bpX - indW),
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

    const isSelected = selectedItemIds?.includes("boundary") ?? false;
    return {
      outer: featureCollection([lineFeature(outerRing, { selected: isSelected })]),
      indent: featureCollection(indentFeatures),
      controlPoints: featureCollection(controlPointFeatures),
    };
  }, [
    mode,
    originSig,
    boundaryWidth,
    boundaryHeight,
    indentSpacing,
    boundaryPosition,
    showBoundaryPoints,
    activeSnapPointId,
    selectedItemIds,
  ]);

  // ── Camera helpers ──
  /** Collect all visible coordinates for fit-to-bounds. */
  const collectFitCoords = useCallback((): Coord[] => {
    const coords: Coord[] = [];
    const pushLineString = (f: GeoJSON.Feature) => {
      if (f.geometry.type === "LineString") {
        for (const c of f.geometry.coordinates) coords.push(c as Coord);
      }
    };
    if (mode === "templates") {
      boundaryGeo.outer.features.forEach(pushLineString);
      placedItemsGeo.lines.features.forEach(pushLineString);
    } else {
      planLinesFC.features.forEach(pushLineString);
    }
    return coords;
  }, [mode, boundaryGeo, placedItemsGeo, planLinesFC]);

  const fitToPlan = useCallback(() => {
    const coords = collectFitCoords();
    if (coords.length === 0) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    // fitBounds(ne, sw, padding, duration) — ne = [maxLon, maxLat], sw = [minLon, minLat]
    cameraRef.current?.fitBounds([maxLon, maxLat], [minLon, minLat], 40, 400);
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

  // ── Tap handling ──
  const handleMapPress = useCallback(
    (feature: GeoJSON.Feature<GeoJSON.Point>) => {
      const [lon, lat] = feature.geometry.coordinates as Coord;
      const { lat: pLat, lon: pLon } = fromMapboxCoord([lon, lat]);

      if (mode === "templates") {
        onSelectionChange?.([]);
        return;
      }
      if (!projectionOrigin) return;

      const local = projectGpsToLocalMeters(pLat, pLon, projectionOrigin.originLat, projectionOrigin.originLon);
      const clickedDxfX = local.east + projectionOrigin.originDxfEast;
      const clickedDxfY = local.north + projectionOrigin.originDxfNorth;

      // 1) Nearest vertex/point (2.0 m tolerance)
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
      if (bestPt && bestPtDist < 2.0 && onSelectPoint) {
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
    [mode, originSig, lines, onSelectPoint, onSelectLine, onSelectionChange]
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

  return (
    <View style={styles.container}>
      <RNMapboxMapView
        style={styles.map}
        styleURL={MAPBOX_STYLE_URL}
        onPress={handleMapPress as (f: GeoJSON.Feature) => void}
        scaleBarEnabled={false}
        logoEnabled={false}
        attributionEnabled
        compassEnabled
        scrollEnabled={!lockPanDrag}
        zoomEnabled={!lockZoom}
      >
        <Camera ref={cameraRef} />

        {/* ── Plan lines (Fields) ── */}
        <ShapeSource id="plan-lines" shape={planLinesFC}>
          <LineLayer
            id="plan-lines-layer"
            style={{
              lineColor: ["get", "color"],
              lineWidth: 2,
              lineOpacity: 0.85,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        </ShapeSource>

        {/* ── Start-direction arrow rendered below as a rotated MarkerView ── */}

        {/* ── Fields selection highlight + corner points ── */}
        <ShapeSource id="selected-line" shape={selectionFC.line}>
          <LineLayer
            id="selected-line-layer"
            style={{ lineColor: "#ef4444", lineWidth: 4, lineCap: "round", lineJoin: "round" }}
          />
        </ShapeSource>
        <ShapeSource id="corner-points" shape={selectionFC.corners}>
          <CircleLayer
            id="corner-points-layer"
            style={{
              circleRadius: 5,
              circleColor: "#3b82f6",
              circleOpacity: 0.9,
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 2,
            }}
          />
        </ShapeSource>

        {/* ── Reference points (+ optional labels) ── */}
        <ShapeSource id="ref-points" shape={refPointsFC}>
          <CircleLayer
            id="ref-points-layer"
            style={{
              circleRadius: 7,
              circleColor: "#10b981",
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 2.5,
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

        {/* ── Boundary box (Templates) ── */}
        <ShapeSource id="boundary-indent" shape={boundaryGeo.indent}>
          <LineLayer
            id="boundary-indent-layer"
            style={{ lineColor: "#cbd5e1", lineWidth: 2, lineDasharray: [5, 5] }}
          />
        </ShapeSource>
        <ShapeSource id="boundary-outer" shape={boundaryGeo.outer}>
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
              circleRadius: ["case", ["get", "active"], 7, 5],
              circleColor: ["case", ["get", "active"], "#f59e0b", "#3b82f6"],
              circleOpacity: ["case", ["get", "active"], 0.9, 0.6],
              circleStrokeColor: "#ffffff",
              circleStrokeWidth: 2,
            }}
          />
        </ShapeSource>

        {/* ── Placed template items (Templates) ── */}
        <ShapeSource id="placed-item-boxes" shape={placedItemsGeo.boxes} onPress={handleItemsPress}>
          <FillLayer
            id="placed-item-boxes-fill"
            style={{
              fillColor: ["case", ["get", "selected"], "#ef4444", "#16a34a"],
              fillOpacity: ["case", ["get", "selected"], 0.1, sketchMode ? 0.02 : 0.05],
              fillOutlineColor: ["case", ["get", "selected"], "#ef4444", "#94a3b8"],
            }}
          />
        </ShapeSource>
        <ShapeSource id="placed-item-lines" shape={placedItemsGeo.lines} onPress={handleItemsPress}>
          <LineLayer
            id="placed-item-lines-layer"
            style={{
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
          </ShapeSource>
        )}

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
