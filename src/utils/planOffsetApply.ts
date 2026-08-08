/**
 * Scope-aware composition on top of planOffset.ts's pure geometry: isolate the
 * chosen target (a file, a mission layer, or the whole plan), shift just that
 * subset, then merge the result back into the full line list, order-preserving.
 *
 * planOffset.ts itself stays scope/UI-unaware by design. This module is the one
 * place that logic lives, so both the real Apply commit (App.tsx's
 * handleApplyOffset) and the live drag-time ghost preview share identical
 * behavior and can never drift apart.
 */

import type { PlanLine } from "../types/plan";
import type { UploadedFileEntry } from "../types/uploadedFiles";
import type { MissionLayer } from "../types/missionLayers";
import { isolateLinesForAnchorTarget, type AnchorTarget } from "./missionLayerLines";
import { selectMarkPlanLines } from "./missionPathOrder";
import { offsetPlanLines } from "./planOffset";
import { sanitizePlanLines } from "./pathWorkflow";

export type OffsetApplyResult =
  | { ok: true; lines: PlanLine[] }
  | { ok: false; reason: "no-marks" | "invalid-offset" | "zero-distance" };

/**
 * Isolate `target`'s lines from `baseLines`, shift them, and merge the shifted
 * subset back into `baseLines` (order-preserving substitution by id — never a
 * target-first reorder, since offsetting one file/layer must not reshuffle
 * Path Order or mission-layer numbering for the rest of the plan).
 */
export function computeOffsetResultLines(
  baseLines: PlanLine[],
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[],
  target: AnchorTarget,
  offsetM: number,
  bearingDeg: number
): OffsetApplyResult {
  const targetLines = isolateLinesForAnchorTarget(baseLines, uploadedFiles, layers, target);

  const marks = selectMarkPlanLines(targetLines);
  if (marks.length === 0) return { ok: false, reason: "no-marks" };

  const shifted = offsetPlanLines(targetLines, offsetM, bearingDeg);
  if (!shifted) return { ok: false, reason: "invalid-offset" };
  if (offsetM === 0) return { ok: false, reason: "zero-distance" };

  const shiftedById = new Map(shifted.map((l) => [l.id, l]));
  return {
    ok: true,
    lines: sanitizePlanLines(baseLines.map((l) => shiftedById.get(l.id) ?? l)),
  };
}
