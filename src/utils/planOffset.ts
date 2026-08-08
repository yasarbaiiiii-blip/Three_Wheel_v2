/**
 * Whole-plan rigid offset — shift an already-imported plan toward an absolute
 * compass bearing (0=north, 90=east, clockwise-positive), by a fixed distance.
 * Pure geometry; no network/UI. Bakes into PlanLine[] via the existing translate
 * primitive in planLineTransform.ts, so every geometry channel (curve center/
 * radius, preview_points, extension_preview, source_points, corners) moves
 * consistently.
 *
 * Bearing is absolute — unlike an earlier left/right-of-travel-direction design,
 * it needs no knowledge of the plan's own heading, so there is no "can't
 * determine direction" failure mode (a closed-loop plan offsets just fine).
 */

import type { PlanLine } from "../types/plan";
import { transformPlanLinesGeometry, translationTransform } from "./planLineTransform";

export type NedVector = { north: number; east: number };

/** Wrap any bearing (including negative or >360) into [0, 360). */
export function normalizeBearingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Unit NED vector for an absolute compass bearing: 0=N, 90=E, 180=S, 270=W,
 * clockwise-positive. Matches atan2(east, north) convention used throughout
 * this codebase (planResizeHandles.ts's angleFromDesignCenterDeg,
 * similarityRefPointSnap.ts, missionPathOrder.ts's entry/exitHeadingDeg).
 */
export function bearingUnitVector(bearingDeg: number): NedVector {
  const rad = (bearingDeg * Math.PI) / 180;
  return { north: Math.cos(rad), east: Math.sin(rad) };
}

/**
 * (north,east) delta for shifting the whole plan `offsetM` metres toward
 * `bearingDeg`. `offsetM === 0` returns the zero vector (a legitimate no-op)
 * regardless of bearingDeg. Returns null when the offset can't be computed
 * (non-finite offsetM, or non-finite bearingDeg with a nonzero offsetM).
 */
export function computePlanOffsetDelta(offsetM: number, bearingDeg: number): NedVector | null {
  if (!Number.isFinite(offsetM)) return null;
  if (offsetM === 0) return { north: 0, east: 0 };
  if (!Number.isFinite(bearingDeg)) return null;

  const mag = Math.abs(offsetM);
  const unit = bearingUnitVector(bearingDeg);
  return { north: unit.north * mag, east: unit.east * mag };
}

/**
 * Shift every line in `lines` (marks, transit, extension, virtual_boundary
 * alike) by the same rigid delta, so derived geometry stays attached to the
 * marks it was built from. Returns null when the delta can't be computed —
 * caller should surface that as a blocking error, not a silent no-op.
 */
export function offsetPlanLines(
  lines: PlanLine[],
  offsetM: number,
  bearingDeg: number
): PlanLine[] | null {
  const delta = computePlanOffsetDelta(offsetM, bearingDeg);
  if (!delta) return null;
  if (delta.north === 0 && delta.east === 0) return lines;
  return transformPlanLinesGeometry(lines, translationTransform(delta.north, delta.east));
}
