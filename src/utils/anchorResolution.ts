/**
 * Compose independently-set per-file, per-layer, and universal anchor points into one
 * final plan order. See the Anchor Redesign plan (file/layer/universal anchors, all
 * coexisting) for the full design — this module is Design §3, `resolvePlanOrder`.
 *
 * Always resolves from `pristineLinesByFileId` (clean, never-anchored-yet geometry per
 * file), never from the live, possibly-already-anchored `lines` — so re-anchoring any
 * scope, in any order, never compounds a prior split's loss of corner/source-point detail.
 */

import type { PlanLine } from "../types/plan";
import type { AnchorPoint, UploadedFileEntry } from "../types/uploadedFiles";
import type { MissionLayer } from "../types/missionLayers";
import { sortedMissionLayers } from "./missionLayerAssignment";
import {
  chainBlocksFromSeed,
  chainMarkLinesFromSeed,
  selectMarkPlanLines,
  type ChainableBlock,
} from "./missionPathOrder";
import { splitRoadMarkingPathAtAnchor } from "./roadMarkingCsvPath";

/** Candidate anchor points a mark line offers — CSV raw survey rows, or a DXF entity's two endpoints. */
export function anchorCandidatePointsForLine(line: PlanLine): AnchorPoint[] {
  const isCsv = line.entity?.geometry?.road_marking === true;
  if (isCsv) {
    const sourcePts = line.entity?.geometry?.source_points as AnchorPoint[] | undefined;
    const pts = sourcePts && sourcePts.length > 0 ? sourcePts : (line.entity?.preview_points ?? []);
    return pts.map((p) => ({ north: p.north, east: p.east }));
  }
  const out: AnchorPoint[] = [];
  if (line.from) out.push({ north: line.from.x, east: line.from.y });
  if (line.to) out.push({ north: line.to.x, east: line.to.y });
  return out;
}

/** Whether a mark line's own candidate points identify it as CSV (road-marking) or DXF. */
function markLineKind(line: PlanLine): "csv" | "dxf" {
  return line.entity?.geometry?.road_marking === true ? "csv" : "dxf";
}

/**
 * Find whichever mark line among `lines` offers a candidate point nearest `anchor` — used to
 * re-locate a stored `{north,east}` anchor point against a (possibly already re-split) line
 * set. Anchor points are always originally captured from an exact candidate point, so this is
 * an exact-or-near-exact match in practice, never a coarse nearest-neighbor guess.
 *
 * `seedFromEnd` reports whether the match was a DXF line's `to` end (candidate index 1 —
 * `anchorCandidatePointsForLine` pushes `[from, to]`) rather than its `from` — the caller must
 * enter that line reversed so painting actually starts at the tapped point, same "any point,
 * including an end, is a valid anchor" rule the CSV split already follows.
 */
function findNearestMarkLine(
  lines: PlanLine[],
  anchor: AnchorPoint
): { line: PlanLine; kind: "csv" | "dxf"; seedFromEnd: boolean } | null {
  type Best = { line: PlanLine; kind: "csv" | "dxf"; seedFromEnd: boolean; dist: number };
  let best: Best | null = null;
  for (const line of selectMarkPlanLines(lines)) {
    const kind = markLineKind(line);
    const candidates = anchorCandidatePointsForLine(line);
    for (let idx = 0; idx < candidates.length; idx++) {
      const p = candidates[idx];
      const dist = Math.hypot(p.north - anchor.north, p.east - anchor.east);
      if (best === null || dist < best.dist) {
        best = { line, kind, seedFromEnd: kind === "dxf" && idx === 1, dist };
      }
    }
  }
  return best === null ? null : { line: best.line, kind: best.kind, seedFromEnd: best.seedFromEnd };
}

type FileBlockMeta = { level: "file"; fileId: string };
type TopBlockMeta = { level: "layer"; layerId: string } | { level: "unassigned_file"; fileId: string };

/**
 * Step A (per file): split/reseed this file's own pristine mark lines at its stored
 * `anchorPoint`, or keep them in their existing (import-time-chained) order when unset.
 */
function resolveFileBlock(
  file: UploadedFileEntry,
  pristineLines: PlanLine[]
): ChainableBlock<FileBlockMeta> {
  const marks = selectMarkPlanLines(pristineLines);
  const markIds = new Set(marks.map((m) => m.id));
  const others = pristineLines.filter((l) => !markIds.has(l.id));

  let orderedMarks = marks;
  if (file.anchorPoint) {
    const found = findNearestMarkLine(pristineLines, file.anchorPoint);
    if (found) {
      if (found.kind === "csv") {
        const split = splitRoadMarkingPathAtAnchor(found.line, file.anchorPoint.north, file.anchorPoint.east);
        if (split) {
          const seedArm = split.near ?? split.far;
          const spliced = marks.flatMap((l) =>
            l.id === found.line.id ? (split.near ? [split.near, split.far] : [split.far]) : [l]
          );
          orderedMarks = chainMarkLinesFromSeed(spliced, seedArm.id, false);
        }
      } else {
        orderedMarks = chainMarkLinesFromSeed(marks, found.line.id, found.seedFromEnd);
      }
    }
  }

  return { id: file.id, lines: [...orderedMarks, ...others], meta: { level: "file", fileId: file.id } };
}

/**
 * Step B (per layer): chain member files' already-resolved blocks around this layer's
 * stored `anchorPoint` at file-block granularity — a file's own internal order/anchor
 * (Step A) is never split or reversed by this step, only re-positioned as a whole.
 */
function resolveLayerBlock(
  layer: MissionLayer,
  memberFileBlocks: ChainableBlock<FileBlockMeta>[]
): ChainableBlock<TopBlockMeta> {
  let ordered = memberFileBlocks;
  if (layer.anchorPoint && memberFileBlocks.length > 1) {
    const allLines = memberFileBlocks.flatMap((b) => b.lines);
    const found = findNearestMarkLine(allLines, layer.anchorPoint);
    const owningBlock = found
      ? memberFileBlocks.find((b) => b.lines.some((l) => l.id === found.line.id))
      : null;
    if (owningBlock) {
      ordered = chainBlocksFromSeed(memberFileBlocks, owningBlock.id);
    }
  }
  return {
    id: layer.id,
    lines: ordered.flatMap((b) => b.lines),
    meta: { level: "layer", layerId: layer.id },
  };
}

/**
 * Resolve the final plan line order from independently-set per-file, per-layer, and
 * universal anchor points. Unset scopes fall back to their existing default order —
 * unaffected files/layers are unaffected by this call.
 */
export function resolvePlanOrder(
  pristineLinesByFileId: Record<string, PlanLine[]>,
  uploadedFiles: UploadedFileEntry[],
  missionLayers: MissionLayer[],
  universalAnchorPoint: AnchorPoint | null
): PlanLine[] {
  // Step A — one resolved block per file that has pristine geometry.
  const fileBlockById = new Map<string, ChainableBlock<FileBlockMeta>>();
  for (const file of uploadedFiles) {
    const pristine = pristineLinesByFileId[file.id];
    if (!pristine || pristine.length === 0) continue;
    fileBlockById.set(file.id, resolveFileBlock(file, pristine));
  }

  // Step B — one resolved block per non-empty mission layer, from its member files.
  const layers = sortedMissionLayers(missionLayers).filter((l) => l.fileEntryIds.length > 0);
  const topBlocks: ChainableBlock<TopBlockMeta>[] = [];
  const assignedFileIds = new Set<string>();
  for (const layer of layers) {
    const memberBlocks: ChainableBlock<FileBlockMeta>[] = [];
    for (const fileId of layer.fileEntryIds) {
      assignedFileIds.add(fileId);
      const block = fileBlockById.get(fileId);
      if (block) memberBlocks.push(block);
    }
    if (memberBlocks.length === 0) continue;
    topBlocks.push(resolveLayerBlock(layer, memberBlocks));
  }

  // Unassigned files are each their own top-level unit.
  for (const file of uploadedFiles) {
    if (assignedFileIds.has(file.id)) continue;
    const block = fileBlockById.get(file.id);
    if (!block) continue;
    topBlocks.push({ id: block.id, lines: block.lines, meta: { level: "unassigned_file", fileId: file.id } });
  }

  // Step C — universal anchor composes the top-level units (layers + unassigned files).
  let orderedTopBlocks = topBlocks;
  if (universalAnchorPoint && topBlocks.length > 1) {
    const allLines = topBlocks.flatMap((b) => b.lines);
    const found = findNearestMarkLine(allLines, universalAnchorPoint);
    const owningBlock = found ? topBlocks.find((b) => b.lines.some((l) => l.id === found.line.id)) : null;
    if (owningBlock) {
      orderedTopBlocks = chainBlocksFromSeed(topBlocks, owningBlock.id);
    }
  }

  return orderedTopBlocks.flatMap((b) => b.lines);
}
