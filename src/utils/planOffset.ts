/**
 * Whole-plan rigid offset — shift an already-imported plan left/right of its own
 * start→end travel direction (AB-line / CNC-cutter-compensation convention: right
 * = clockwise from travel direction, left = counter-clockwise). Pure geometry;
 * no network/UI. Bakes into PlanLine[] via the existing translate primitive in
 * planLineTransform.ts, so every geometry channel (curve center/radius,
 * preview_points, extension_preview, source_points, corners) moves consistently.
 */

import type { PlanLine } from "../types/plan";
import { planLineToNedPolyline } from "./missionTrajectory";
import { transformPlanLinesGeometry, translationTransform } from "./planLineTransform";

export type LateralDirection = "left" | "right";
export type NedVector = { north: number; east: number };

/** Below this, start≈end (closed loop / single degenerate point) — no reliable travel direction. */
export const MIN_PLAN_HEADING_LENGTH_M = 0.01;

/**
 * Whole-plan travel direction: first usable point of the first painted line to
 * the last usable point of the last painted line (the "AB line" of the plan).
 * `orderedPaintedLines` must already be in operator order with skipped paths
 * excluded (e.g. via resolveOrderedPaintedLines) — this walks forward/backward
 * over it as given, tolerating stray degenerate lines mixed in.
 */
export function computePlanHeadingFromPaintedLines(
  orderedPaintedLines: PlanLine[]
): NedVector | null {
  let start: NedVector | null = null;
  for (const line of orderedPaintedLines) {
    const pts = planLineToNedPolyline(line);
    if (pts) {
      start = { north: pts[0][0], east: pts[0][1] };
      break;
    }
  }
  if (!start) return null;

  let end: NedVector | null = null;
  for (let i = orderedPaintedLines.length - 1; i >= 0; i--) {
    const pts = planLineToNedPolyline(orderedPaintedLines[i]);
    if (pts) {
      end = { north: pts[pts.length - 1][0], east: pts[pts.length - 1][1] };
      break;
    }
  }
  if (!end) return null;

  const dNorth = end.north - start.north;
  const dEast = end.east - start.east;
  if (Math.hypot(dNorth, dEast) < MIN_PLAN_HEADING_LENGTH_M) return null;
  return { north: dNorth, east: dEast };
}

/**
 * Unit lateral vector for `direction`, relative to `heading` (need not be unit length).
 *
 * Convention (matches CNC G41/G42 and AB-line guidance offset): right = clockwise
 * from the direction of travel, left = counter-clockwise. Concretely, heading due
 * north → right = due east, left = due west; heading due east → right = due south,
 * left = due north — ordinary compass "which hand does this point" intuition.
 *
 * Deliberately NOT reusing planLengthLabels.ts's "left-hand perpendicular" formula
 * (`-tangent.east, tangent.north`) — for a north-pointing tangent that evaluates to
 * due east, which is actually the RIGHT side of a northbound traveler. That helper's
 * label is stale; this function is independently derived and tested against
 * cardinal directions so the sign can't silently invert again.
 */
export function lateralUnitVector(
  heading: NedVector,
  direction: LateralDirection
): NedVector | null {
  const len = Math.hypot(heading.north, heading.east);
  if (!(len > 1e-9)) return null;
  const uNorth = heading.north / len;
  const uEast = heading.east / len;
  if (direction === "right") {
    return { north: -uEast, east: uNorth };
  }
  return { north: uEast, east: -uNorth };
}

/**
 * (north,east) delta for shifting the whole plan `offsetM` metres to `direction`.
 * `offsetM === 0` returns the zero vector (a legitimate no-op), not null.
 * Returns null when the offset can't be determined (non-finite distance, or no
 * reliable plan heading — see computePlanHeadingFromPaintedLines).
 */
export function computePlanOffsetDelta(
  orderedPaintedLines: PlanLine[],
  offsetM: number,
  direction: LateralDirection
): NedVector | null {
  if (!Number.isFinite(offsetM)) return null;
  if (offsetM === 0) return { north: 0, east: 0 };

  const heading = computePlanHeadingFromPaintedLines(orderedPaintedLines);
  if (!heading) return null;
  const lateral = lateralUnitVector(heading, direction);
  if (!lateral) return null;

  const mag = Math.abs(offsetM);
  return { north: lateral.north * mag, east: lateral.east * mag };
}

/**
 * Shift every line in `lines` (marks, transit, extension, virtual_boundary alike)
 * by the same rigid delta, so derived geometry stays attached to the marks it was
 * built from. Direction/magnitude are resolved from `orderedPaintedLines` (the
 * plan's own travel direction), not from `lines` itself. Returns null when the
 * delta can't be determined — caller should surface that as a blocking error, not
 * a silent no-op.
 */
export function offsetPlanLines(
  lines: PlanLine[],
  orderedPaintedLines: PlanLine[],
  offsetM: number,
  direction: LateralDirection
): PlanLine[] | null {
  const delta = computePlanOffsetDelta(orderedPaintedLines, offsetM, direction);
  if (!delta) return null;
  if (delta.north === 0 && delta.east === 0) return lines;
  return transformPlanLinesGeometry(lines, translationTransform(delta.north, delta.east));
}
