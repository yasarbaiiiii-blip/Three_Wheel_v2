/**
 * Visual alignment coordinate helpers.
 *
 * Contract (matches MapView projectedPlacedItems):
 * - line.from.x / corner.x = DXF north
 * - line.from.y / corner.y = DXF east
 * - item.x = east translation (metres, local NED)
 * - item.y = north translation (metres, local NED)
 * - item.rotation = degrees, positive = standard math CCW in north/east plane
 */

import type { PlanLine } from "../types/plan";
import { computePlanBoundingBoxLegacy } from "./curveGeometry";

export type VisualAlignmentTransform = {
  x: number;
  y: number;
  rotation: number;
  scale?: number;
  /** Independent north-axis scale (falls back to `scale`). */
  scaleNorth?: number;
  /** Independent east-axis scale (falls back to `scale`). */
  scaleEast?: number;
};

// WGS84 ellipsoid — must match the backend `georef.metres_per_degree`
// (path_engine/parsers/georef.py). North uses the meridional radius of
// curvature M, east the prime-vertical radius N times cos(lat). Using a single
// spherical radius for north is a +0.62 % scale error at 13° latitude (62 cm per
// 100 m), which is exactly the north-scale bug that was fixed on the backend.
const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = WGS84_F * (2.0 - WGS84_F);

/** Meridional (M) and prime-vertical (N) radii of curvature at a latitude. */
function radiiOfCurvature(latRad: number): { M: number; N: number } {
  const s = Math.sin(latRad);
  const w2 = 1.0 - WGS84_E2 * s * s;
  const w = Math.sqrt(w2);
  return {
    M: (WGS84_A * (1.0 - WGS84_E2)) / (w2 * w),
    N: WGS84_A / w,
  };
}

/** Rotate + translate a DXF point into local north/east metres (latchedOrigin frame). */
export function transformVisualDxfPoint(
  north: number,
  east: number,
  item: VisualAlignmentTransform
): { north: number; east: number } {
  const sN = item.scaleNorth ?? item.scale ?? 1;
  const sE = item.scaleEast ?? item.scale ?? 1;
  const sn = north * sN;
  const se = east * sE;
  const theta = (item.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    north: sn * cos - se * sin + item.y,
    east: sn * sin + se * cos + item.x,
  };
}

export function projectLocalMetersToGps(
  north: number,
  east: number,
  originLat: number,
  originLon: number
): { lat: number; lon: number } {
  const originLatRad = (originLat * Math.PI) / 180;
  const { M, N } = radiiOfCurvature(originLatRad);
  const lat = originLat + (north / M) * (180 / Math.PI);
  const lon =
    originLon + (east / (N * Math.cos(originLatRad))) * (180 / Math.PI);
  return { lat, lon };
}

export function projectGpsToLocalMeters(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { north: number; east: number } {
  const originLatRad = (originLat * Math.PI) / 180;
  const { M, N } = radiiOfCurvature(originLatRad);
  const north = ((lat - originLat) * (M * Math.PI)) / 180;
  const east = ((lon - originLon) * (N * Math.cos(originLatRad) * Math.PI)) / 180;
  return { north, east };
}

export type VisualAlignmentRefPoint = {
  dxf_x: number;
  dxf_y: number;
  lat: number;
  lon: number;
};

/** Bbox corners in DXF north/east, then preview transform → GPS ref pairs. */
export function buildVisualAlignmentRefPoints(
  corners: Array<{ x: number; y: number }>,
  item: VisualAlignmentTransform,
  originLat: number,
  originLon: number,
  originDxfNorth: number = 0,
  originDxfEast: number = 0
): VisualAlignmentRefPoint[] {
  return corners.map((corner) => {
    const placed = transformVisualDxfPoint(corner.x, corner.y, item);
    const gps = projectLocalMetersToGps(placed.north - originDxfNorth, placed.east - originDxfEast, originLat, originLon);
    return {
      // RefPoint API: dxf_y = north, dxf_x = east (see handleSelectPoint / backend swap).
      dxf_x: corner.y,
      dxf_y: corner.x,
      lat: gps.lat,
      lon: gps.lon,
    };
  });
}

export function computeLineBoundingBox(lines: PlanLine[]) {
  return computePlanBoundingBoxLegacy(lines);
}