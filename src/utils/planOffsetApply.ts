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
import { offsetPlanLines, type PlanBufferDirection, type PlanOffsetMode } from "./planOffset";
import { bufferPlanLines } from "./planBufferOffset";
import { sanitizePlanLines } from "./pathWorkflow";

export type OffsetApplyResult =
  | { ok: true; lines: PlanLine[] }
  | { ok: false; reason: "no-marks" | "invalid-offset" | "zero-distance" | "collapsed" };

export type OffsetApplyOptions = {
  mode?: PlanOffsetMode;
  bufferDirection?: PlanBufferDirection;
};

/**
 * Isolate `target`'s lines from `baseLines`, shift or buffer them, and merge
 * the result back into `baseLines` (order-preserving substitution by id — never
 * a target-first reorder, since offsetting one file/layer must not reshuffle
 * Path Order or mission-layer numbering for the rest of the plan).
 *
 * Default `mode` is `"shift"` so existing compass-bearing callers stay unchanged.
 */
export function computeOffsetResultLines(
  baseLines: PlanLine[],
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[],
  target: AnchorTarget,
  offsetM: number,
  bearingDeg: number,
  options?: OffsetApplyOptions
): OffsetApplyResult {
  const targetLines = isolateLinesForAnchorTarget(baseLines, uploadedFiles, layers, target);

  const marks = selectMarkPlanLines(targetLines);
  if (marks.length === 0) return { ok: false, reason: "no-marks" };
  if (offsetM === 0) return { ok: false, reason: "zero-distance" };

  const mode: PlanOffsetMode = options?.mode === "buffer" ? "buffer" : "shift";
  const nextLines =
    mode === "buffer"
      ? bufferPlanLines(targetLines, offsetM, options?.bufferDirection === "in" ? "in" : "out")
      : offsetPlanLines(targetLines, offsetM, bearingDeg);

  if (!nextLines) {
    return {
      ok: false,
      reason: mode === "buffer" && Number.isFinite(offsetM) ? "collapsed" : "invalid-offset",
    };
  }

  const nextById = new Map(nextLines.map((l) => [l.id, l]));
  return {
    ok: true,
    lines: sanitizePlanLines(baseLines.map((l) => nextById.get(l.id) ?? l)),
  };
}
