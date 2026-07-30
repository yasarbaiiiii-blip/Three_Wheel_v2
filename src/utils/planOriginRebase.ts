/**
 * Rebase PlanLine geometry from one GPS-anchored local NED frame into another.
 *
 * Pure translation in the local frames (no rotation/scale). Uses the shared
 * PX4-sphere projection so CSV, geo-DXF, and Fix-Alignment origins all agree.
 */

import type { PlanLine } from "../types/plan";
import { projectGpsToLocalMeters, projectLocalMetersToGps } from "./geoProjection";
import { transformPlanLineGeometry } from "./planLineTransform";

export type GpsOrigin = { lat: number; lon: number };

function originsEqual(a: GpsOrigin, b: GpsOrigin): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

/**
 * Identity when origins match; otherwise GPS round-trip via PX4 sphere.
 */
export function rebasePlanLineToOrigin(
  line: PlanLine,
  fromOrigin: GpsOrigin,
  toOrigin: GpsOrigin
): PlanLine {
  if (originsEqual(fromOrigin, toOrigin)) {
    return line;
  }
  return transformPlanLineGeometry(line, (north, east) => {
    const gps = projectLocalMetersToGps(
      north,
      east,
      fromOrigin.lat,
      fromOrigin.lon
    );
    return projectGpsToLocalMeters(gps.lat, gps.lon, toOrigin.lat, toOrigin.lon);
  });
}

export function rebasePlanLinesToOrigin(
  lines: PlanLine[],
  fromOrigin: GpsOrigin,
  toOrigin: GpsOrigin
): PlanLine[] {
  if (originsEqual(fromOrigin, toOrigin)) {
    return lines;
  }
  return lines.map((line) => rebasePlanLineToOrigin(line, fromOrigin, toOrigin));
}
