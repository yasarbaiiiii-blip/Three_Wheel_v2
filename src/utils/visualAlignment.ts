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
import { projectLocalMetersToGps } from "./geoProjection";

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