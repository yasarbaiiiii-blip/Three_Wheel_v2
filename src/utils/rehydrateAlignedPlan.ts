/**
 * Re-apply a verified Fix Alignment transform to design-frame (raw DXF) geometry.
 *
 * After Fix Alignment the map holds `lines` in local NED relative to `origin_gps`,
 * with `alignedRefPoints` at {dxf_x:0, dxf_y:0, lat/lon: origin_gps}. Path refreshes
 * (extension toggle, re-select path, pre/aft change) re-fetch backend entities in the
 * original design frame. Writing those into `lines` without re-baking under the same
 * origin makes the plan jump on the map.
 *
 * Contract:
 * - `designFrameLines` MUST be design-frame (raw DXF / entities preview), never
 *   already-NED `lines` from a previous bake.
 * - When transform params are complete, returns a NEW array in NED (same math as
 *   AlignDxfPanel Fix Alignment). Calling twice on the same design input is
 *   idempotent (no double-bake of a prior output).
 * - Incomplete or missing alignment → pass-through (unaligned preview).
 */

import type { PlanLine } from "../types/plan";
import type { AlignmentResultState } from "../types/fieldsWorkflow";
import { enforceAlignmentScale } from "./designAlignmentPolicy";
import { coerceFiniteNumber } from "./pathWorkflow";
import {
  similarityTransform,
  transformPlanLinesGeometry,
} from "./planLineTransform";

/** Parsed affine params ready for `similarityTransform` (design → NED). */
export type VerifiedAlignmentTransform = {
  rotationDeg: number;
  scale: number;
  offsetN: number;
  offsetE: number;
};

/**
 * Extract a complete similarity transform from stored Fix Alignment result.
 * Returns null when any required field is missing/non-finite — never partial-apply.
 *
 * Note: `coerceFiniteNumber(null)` is 0 because `Number(null) === 0`. Required
 * fields must be explicitly non-null before coercion so a missing offset cannot
 * silently bake as 0 and shift the plan.
 */
export function parseVerifiedAlignmentTransform(
  alignment: AlignmentResultState | null | undefined
): VerifiedAlignmentTransform | null {
  if (!alignment) return null;

  if (
    alignment.rotation_deg == null ||
    alignment.offset_n == null ||
    alignment.offset_e == null
  ) {
    return null;
  }

  const rotationDeg = coerceFiniteNumber(alignment.rotation_deg);
  const offsetN = coerceFiniteNumber(alignment.offset_n);
  const offsetE = coerceFiniteNumber(alignment.offset_e);
  if (rotationDeg == null || offsetN == null || offsetE == null) return null;

  const rawScale =
    alignment.scale == null ? null : coerceFiniteNumber(alignment.scale);
  const scale = enforceAlignmentScale(rawScale ?? 1);

  return { rotationDeg, scale, offsetN, offsetE };
}

/**
 * If alignment is verified with a complete transform, bake design-frame lines into
 * the same NED frame Fix Alignment uses. Otherwise return `designFrameLines` unchanged
 * (same array reference when no bake runs).
 */
export function rehydrateAlignedPlanLines(
  designFrameLines: PlanLine[],
  alignment: AlignmentResultState | null | undefined
): PlanLine[] {
  const transform = parseVerifiedAlignmentTransform(alignment);
  if (!transform) return designFrameLines;

  return transformPlanLinesGeometry(
    designFrameLines,
    similarityTransform({
      rotationDeg: transform.rotationDeg,
      scale: transform.scale,
      offsetN: transform.offsetN,
      offsetE: transform.offsetE,
    })
  );
}
