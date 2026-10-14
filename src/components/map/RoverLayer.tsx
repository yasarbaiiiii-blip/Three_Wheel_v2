import React, { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Animated, Easing, View } from "react-native";
import {
  FillLayer,
  LineLayer,
  MarkerView,
  ShapeSource,
  SymbolLayer,
} from "@rnmapbox/maps";
import Svg, { Circle as SvgCircle, Polygon as SvgPolygon } from "react-native-svg";
import circle from "@turf/circle";

import type { PlanLine, TelemetrySnapshot } from "../../types/plan";
import { useTelemetrySelector } from "../../features/telemetry/telemetryStore";
import { groundDistanceMeters } from "../../utils/geoProjection";
import { projectPlanNorthEastToGps, type MapProjectionOrigin } from "../../utils/mapGeometryProjection";
import { toMapboxCoord } from "../../utils/mapboxCoords";
import { resolveRoverMarker, type RoverFix } from "../../utils/roverFixHold";
import type { CameraBearingStore } from "./cameraBearingStore";
import { useCameraBearing } from "./cameraBearingStore";
import {
  roverCenterFromSnapshot,
  roverTelemetryEqual,
  selectRoverTelemetry,
  type RoverTelemetryFields,
} from "./roverLayerModel";

type Coord = [number, number];
const PLAN_SOURCE_MAX_ZOOM = 22;
const PLAN_SOURCE_TOLERANCE = 0;

const RANGE_FILL_STYLE: React.ComponentProps<typeof FillLayer>["style"] = { fillColor: "#3b82f6", fillOpacity: 0.12 };
const RANGE_LINE_STYLE: React.ComponentProps<typeof LineLayer>["style"] = { lineColor: "#3b82f6", lineWidth: 1.5, lineDasharray: [4, 4] };
const TARGET_LINE_STYLE: React.ComponentProps<typeof LineLayer>["style"] = { lineColor: "#f59e0b", lineWidth: 2, lineDasharray: [4, 4] };
const TARGET_LABEL_STYLE: React.ComponentProps<typeof SymbolLayer>["style"] = {
  textField: ["get", "label"],
  textColor: "#f59e0b",
  textHaloColor: "#0f172a",
  textHaloWidth: 1.5,
  textSize: 12,
  textOffset: [0, -1],
  textAnchor: "bottom",
};

function featureCollection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

function lineFeature(coords: Coord[]): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
}

function pointFeature(coord: Coord, label: string): GeoJSON.Feature<GeoJSON.Point> {
  return { type: "Feature", properties: { label }, geometry: { type: "Point", coordinates: coord } };
}

function PulsingDot({ color = "#f59e0b", size = 12 }: { color?: string; size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.2] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });
  return (
    <View style={{ width: size * 2, height: size * 2, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={{ position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: ringOpacity, transform: [{ scale: ringScale }] }} />
      <View style={{ width: size * 0.8, height: size * 0.8, borderRadius: size * 0.4, backgroundColor: color, opacity: 0.85 }} />
    </View>
  );
}

function RoverVehicle({ heading, mapBearing, stale }: { heading: number | null | undefined; mapBearing: number; stale: boolean }) {
  const rotationDeg = (heading ?? 0) - mapBearing;
  return (
    <View style={{ opacity: stale ? 0.4 : 1, transform: [{ rotate: `${rotationDeg}deg` }] }}>
      <Svg width={40} height={40} viewBox="-20 -20 40 40">
        <SvgCircle cx={0} cy={0} r={18.7} fill="rgba(14,165,233,0.12)" />
        <SvgPolygon points="-6.5,11 6.5,11 6.5,-4 0,-7.5 -6.5,-4" fill="#0ea5e9" stroke="#ffffff" strokeWidth={1.8} strokeLinejoin="round" />
        <SvgPolygon points="-9.5,5 -6.5,5 -6.5,11 -9.5,11" fill="#0f172a" />
        <SvgPolygon points="9.5,5 6.5,5 6.5,11 9.5,11" fill="#0f172a" />
        <SvgPolygon points="-2.5,3 2.5,3 2.5,-3 -2.5,-3" fill="#0f172a" />
        <SvgPolygon points="-4.5,-2 4.5,-2 3.5,2 -3.5,2" fill="rgba(186,230,253,0.85)" />
        <SvgCircle cx={0} cy={-7.5} r={2.5} fill="#fbbf24" stroke="#fff" strokeWidth={1} />
      </Svg>
    </View>
  );
}

export function RoverLayer({
  lines,
  projectionOrigin,
  showRover,
  fallbackSnapshot,
  bearingStore,
  lastFixRef,
}: {
  lines: PlanLine[];
  projectionOrigin: MapProjectionOrigin | null;
  showRover: boolean;
  fallbackSnapshot?: TelemetrySnapshot | null;
  bearingStore: CameraBearingStore;
  lastFixRef: MutableRefObject<RoverFix<Coord> | null>;
}) {
  const selected = useTelemetrySelector(selectRoverTelemetry, roverTelemetryEqual);
  const telemetry: RoverTelemetryFields = selected ?? selectRoverTelemetry(fallbackSnapshot ?? null);
  const mapBearing = useCameraBearing(bearingStore);

  const roverGeo = useMemo(() => {
    const resolved = roverCenterFromSnapshot(telemetry);
    const heading = telemetry?.heading_ned_deg ?? null;
    if (!resolved) {
      return { center: null as Coord | null, heading, rangeCircle: null as GeoJSON.Feature<GeoJSON.Polygon> | null, targetLine: null as GeoJSON.FeatureCollection | null, targetPoint: null as Coord | null };
    }
    const { lat, lon } = resolved;
    const center = toMapboxCoord(lat, lon);
    const rangeCircle = circle(center, 1.5, { steps: 48, units: "meters" }) as GeoJSON.Feature<GeoJSON.Polygon>;
    let targetPoint: Coord | null = null;
    let targetDist: number | null = null;
    if (lines.length > 0 && projectionOrigin) {
      const active = telemetry?.mission_state === "running" || telemetry?.mission_state === "paused";
      const idx = active ? Math.min(Math.max(0, telemetry?.projection_segment_index ?? 0), lines.length - 1) : 0;
      const segment = lines[idx];
      if (segment?.from && segment?.to) {
        const target = active ? segment.to : segment.from;
        const gps = projectPlanNorthEastToGps(target.x, target.y, projectionOrigin);
        const distance = groundDistanceMeters(lat, lon, gps.lat, gps.lon);
        if (distance < 10_000) {
          targetDist = distance;
          targetPoint = toMapboxCoord(gps.lat, gps.lon);
        }
      }
    }
    const targetLine = targetPoint && targetDist != null
      ? featureCollection([lineFeature([center, targetPoint]), pointFeature([(center[0] + targetPoint[0]) / 2, (center[1] + targetPoint[1]) / 2], `${targetDist.toFixed(1)} m`)])
      : null;
    return { center, heading, rangeCircle, targetLine, targetPoint };
  }, [telemetry, lines, projectionOrigin]);

  const resolvedRover = resolveRoverMarker(roverGeo, lastFixRef.current);
  lastFixRef.current = resolvedRover.last;

  return (
    <>
      {roverGeo.rangeCircle ? (
        <ShapeSource id="rover-range" shape={roverGeo.rangeCircle} maxZoomLevel={PLAN_SOURCE_MAX_ZOOM} tolerance={PLAN_SOURCE_TOLERANCE}>
          <FillLayer id="rover-range-fill" style={RANGE_FILL_STYLE} />
          <LineLayer id="rover-range-outline" style={RANGE_LINE_STYLE} />
        </ShapeSource>
      ) : null}
      {roverGeo.targetLine ? (
        <ShapeSource id="rover-target" shape={roverGeo.targetLine} maxZoomLevel={PLAN_SOURCE_MAX_ZOOM} tolerance={PLAN_SOURCE_TOLERANCE}>
          <LineLayer id="rover-target-layer" style={TARGET_LINE_STYLE} />
          <SymbolLayer id="rover-target-label" style={TARGET_LABEL_STYLE} />
        </ShapeSource>
      ) : null}
      {showRover && resolvedRover.marker ? (
        <MarkerView coordinate={resolvedRover.marker.center} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
          <RoverVehicle heading={resolvedRover.marker.heading} mapBearing={mapBearing} stale={resolvedRover.marker.stale} />
        </MarkerView>
      ) : null}
      {roverGeo.targetPoint ? (
        <MarkerView coordinate={roverGeo.targetPoint} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
          <PulsingDot />
        </MarkerView>
      ) : null}
    </>
  );
}
