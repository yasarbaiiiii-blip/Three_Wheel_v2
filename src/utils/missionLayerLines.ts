/**
 * Map line ids → files → mission layers; filter painted snapshots for Start.
 */

import type { PlanLine } from "../types/plan";
import type { UploadedFileEntry } from "../types/uploadedFiles";
import type { MissionLayer } from "../types/missionLayers";
import {
  clonePlanLinesForSnapshot,
  type AppPlannedStartSnapshot,
} from "./appPlannedStartSnapshot";
import { sortedMissionLayers } from "./missionLayerAssignment";

const PREFIX_SEP = "__";

/** Match line id to the longest known file prefix (handles nested-looking stems). */
export function fileForLineId(
  lineId: string,
  uploadedFiles: UploadedFileEntry[]
): UploadedFileEntry | null {
  let best: UploadedFileEntry | null = null;
  let bestLen = -1;
  for (const f of uploadedFiles) {
    const token = `${f.lineIdPrefix}${PREFIX_SEP}`;
    if (lineId.startsWith(token) && f.lineIdPrefix.length > bestLen) {
      best = f;
      bestLen = f.lineIdPrefix.length;
    }
  }
  return best;
}

export function layerForFileId(
  fileId: string,
  layers: MissionLayer[]
): MissionLayer | null {
  return layers.find((l) => l.fileEntryIds.includes(fileId)) ?? null;
}

export function layerForLineId(
  lineId: string,
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[]
): MissionLayer | null {
  const file = fileForLineId(lineId, uploadedFiles);
  if (!file) return null;
  return layerForFileId(file.id, layers);
}

/**
 * Order painted marks for multi-layer Start:
 * ascending layer.number, then relative order from the Send snapshot within each layer.
 * Lines with no layer membership are omitted when filtering by selectedLayerIds.
 */
export function filterPaintedLinesForLayers(
  paintedLines: PlanLine[],
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[],
  selectedLayerIds: ReadonlySet<string> | string[]
): PlanLine[] {
  const selected =
    selectedLayerIds instanceof Set
      ? selectedLayerIds
      : new Set(selectedLayerIds);
  if (selected.size === 0) return [];

  const layerById = new Map(layers.map((l) => [l.id, l]));
  const buckets = new Map<string, PlanLine[]>();
  for (const id of selected) buckets.set(id, []);

  for (const line of paintedLines) {
    const layer = layerForLineId(line.id, uploadedFiles, layers);
    if (!layer || !selected.has(layer.id)) continue;
    buckets.get(layer.id)!.push(line);
  }

  const orderedLayerIds = sortedMissionLayers(
    [...selected]
      .map((id) => layerById.get(id))
      .filter((l): l is MissionLayer => l != null)
  ).map((l) => l.id);

  const out: PlanLine[] = [];
  for (const id of orderedLayerIds) {
    const group = buckets.get(id);
    if (group) out.push(...group);
  }
  return out;
}

export type LayerScopedSnapshotResult =
  | { ok: true; snapshot: AppPlannedStartSnapshot }
  | { ok: false; error: string };

/**
 * Build a Start-time snapshot scoped to selected mission layers.
 * Preserves extensionConfig / originGps / missionName / groundTruth (filtered is marks only).
 */
export function buildLayerScopedStartSnapshot(
  snapshot: AppPlannedStartSnapshot,
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[],
  selectedLayerIds: ReadonlySet<string> | string[]
): LayerScopedSnapshotResult {
  const painted = filterPaintedLinesForLayers(
    snapshot.paintedLines,
    uploadedFiles,
    layers,
    selectedLayerIds
  );
  if (painted.length === 0) {
    return {
      ok: false,
      error:
        "No painted paths in the selected mission layers. Assign files, check Path Order paint flags, or re-Send.",
    };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      paintedLines: clonePlanLinesForSnapshot(painted),
    },
  };
}

/**
 * Canvas visibility for mission layers.
 * - Mark / prefix-owned lines: hidden when their mission layer has visible=false.
 * - Lines with no file prefix (synthetic transit after path-order, etc.): kept
 *   (CAD LayerVisibility still applies elsewhere).
 * - Unassigned files (no mission layer): always visible.
 * - When no mission layers exist: identity.
 */
export function filterCanvasLinesByMissionVisibility(
  lines: PlanLine[],
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[]
): PlanLine[] {
  if (layers.length === 0) return lines;

  const hiddenLayerIds = new Set(
    layers.filter((l) => !l.visible).map((l) => l.id)
  );
  if (hiddenLayerIds.size === 0) return lines;

  return lines.filter((line) => {
    const layer = layerForLineId(line.id, uploadedFiles, layers);
    if (!layer) return true;
    return !hiddenLayerIds.has(layer.id);
  });
}

/** Files in the batch that are not assigned to any mission layer. */
export function unassignedFileIds(
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[]
): string[] {
  const assigned = new Set(layers.flatMap((l) => l.fileEntryIds));
  return uploadedFiles.filter((f) => !assigned.has(f.id)).map((f) => f.id);
}

export function countUnassignedFiles(
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[]
): number {
  return unassignedFileIds(uploadedFiles, layers).length;
}
