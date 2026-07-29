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

// PX4 sphere metres-per-degree — shared with geoProjection / rover georef (G2).
// Do not reintroduce WGS84 ellipsoid here; the EKF navigates the PX4 sphere.
import {
  projectLocalMetersToGps,
  metresPerDegreeShared as _metresPerDegreeShared,
  metresPerDegreePx4 as _metresPerDegreePx4,
  projectGpsToLocalMeters as _projectGpsToLocalMeters,
  PX4_EARTH_RADIUS_M as _PX4_EARTH_RADIUS_M,
} from "./geoProjection";

export const metresPerDegreeShared = _metresPerDegreeShared;
export const metresPerDegreePx4 = _metresPerDegreePx4;
export const projectGpsToLocalMeters = _projectGpsToLocalMeters;
export const PX4_EARTH_RADIUS_M = _PX4_EARTH_RADIUS_M;
export { projectLocalMetersToGps };

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