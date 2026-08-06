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
import { nonEmptyMissionLayers, sortedMissionLayers } from "./missionLayerAssignment";
import { buildCsvExtensionLines, type CsvExtensionConfig } from "./missionExtensions";

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
 *
 * A line's layer resolves in two ways: via its file-prefixed id (fresh, not-yet-staged
 * import lines), or via `line.missionLayerId` (staged/hydrated lines — see
 * tagLinesWithMissionLayer — whose ids like `rover-path-3` no longer carry a prefix).
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
    const layerId = line.missionLayerId ?? layerForLineId(line.id, uploadedFiles, layers)?.id ?? null;
    if (!layerId) return true;
    return !hiddenLayerIds.has(layerId);
  });
}

// ── Anchor point selection: file/layer picker + target isolation ──────────────

export type AnchorTarget =
  | { kind: "file"; fileId: string }
  | { kind: "layer"; layerId: string };

export type AnchorTargetOption = { target: AnchorTarget; label: string };

/**
 * Population rule for the Anchor file/layer picker — "full layer or null": list
 * mission layers only once EVERY uploaded file is assigned to one; otherwise list
 * individual files. Local to the Anchor picker's own rendering — does not change
 * the Start-flow "N files unassigned" warning or block imports.
 */
export function buildAnchorTargetOptions(
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[]
): AnchorTargetOption[] {
  const useLayers =
    countUnassignedFiles(uploadedFiles, layers) === 0 && nonEmptyMissionLayers(layers).length > 0;

  if (useLayers) {
    return sortedMissionLayers(layers)
      .filter((l) => l.fileEntryIds.length > 0)
      .map((l) => ({
        target: { kind: "layer" as const, layerId: l.id },
        label: `Layer ${l.number} (${l.fileEntryIds.length} file${l.fileEntryIds.length === 1 ? "" : "s"})`,
      }));
  }

  return uploadedFiles.map((f) => ({
    target: { kind: "file" as const, fileId: f.id },
    label: f.fileName,
  }));
}

/**
 * Isolate `lines` down to exactly one Anchor target's lines — a raw uploaded file
 * (via `fileForLineId`) or a whole mission layer (via `layerForLineId`). Unlike
 * `filterCanvasLinesByMissionVisibility` (whole-layer show/hide, unassigned files
 * always visible), this solos exactly one target and nothing else. Drives only the
 * temporary Anchor-selection map view — never a persisted `visible` flag.
 */
export function isolateLinesForAnchorTarget(
  lines: PlanLine[],
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[],
  target: AnchorTarget
): PlanLine[] {
  if (target.kind === "file") {
    return lines.filter((line) => fileForLineId(line.id, uploadedFiles)?.id === target.fileId);
  }
  return lines.filter(
    (line) => layerForLineId(line.id, uploadedFiles, layers)?.id === target.layerId
  );
}

/** Geometry sample used to recover mission-layer identity after hydration strips ids. */
export type MissionLayerLeg = {
  layerId: string;
  fromNorth: number;
  fromEast: number;
  toNorth: number;
  toEast: number;
};

/**
 * Tolerance for matching a hydrated (possibly merged) run to its source layer's line.
 * Generous vs EXTENSION_ENDPOINT_MATCH_EPS_M (0.05 m) because hydration merges
 * several contiguous same-layer source lines into one continuous polyline, so we
 * match by nearest source segment rather than requiring exact endpoint equality.
 */
const LAYER_MATCH_MAX_DIST_M = 1.0;

/** `ext-pre-<parentId>` / `ext-aft-<parentId>` → `<parentId>` (see makeExtensionPlanLine). */
function parentLineIdFromExtensionId(extensionId: string): string | null {
  if (extensionId.startsWith("ext-pre-")) return extensionId.slice("ext-pre-".length);
  if (extensionId.startsWith("ext-aft-")) return extensionId.slice("ext-aft-".length);
  return null;
}

/**
 * Catalog of source-line geometry keyed by mission layer, built while ids still
 * carry their file prefix (i.e. from the frozen Send-time snapshot).
 *
 * Also folds in PRE/AFT extension legs when `extensionConfig` is supplied — an
 * extension's own id carries no file prefix (`ext-pre-<parentId>`), so it's
 * attributed to whichever mark line it extends instead. Without this, hidden
 * mission layers left their extension run-ups/run-outs stuck always-visible on
 * the map after Send/Start, since nothing in the catalog could ever match them.
 */
export function buildMissionLayerLegCatalog(
  paintedLines: PlanLine[],
  uploadedFiles: UploadedFileEntry[],
  layers: MissionLayer[],
  extensionConfig?: Partial<CsvExtensionConfig> | null
): MissionLayerLeg[] {
  const out: MissionLayerLeg[] = [];
  for (const line of paintedLines) {
    const layer = layerForLineId(line.id, uploadedFiles, layers);
    if (!layer) continue;
    out.push({
      layerId: layer.id,
      fromNorth: line.from.x,
      fromEast: line.from.y,
      toNorth: line.to.x,
      toEast: line.to.y,
    });
  }

  if (extensionConfig) {
    for (const ext of buildCsvExtensionLines(paintedLines, extensionConfig)) {
      const parentId = parentLineIdFromExtensionId(String(ext.id));
      const layer = parentId ? layerForLineId(parentId, uploadedFiles, layers) : null;
      if (!layer) continue;
      out.push({
        layerId: layer.id,
        fromNorth: ext.from.x,
        fromEast: ext.from.y,
        toNorth: ext.to.x,
        toEast: ext.to.y,
      });
    }
  }
  return out;
}

function pointToSegmentDistanceM(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Recover mission-layer identity on hydrated map lines (ids like `rover-path-3`,
 * `staged-line-9`) that lost their file-prefix through the stage/hydrate round trip —
 * without this, M-Layers visibility toggles silently stop affecting the map the
 * moment a mission is Sent or Started. Matches each line's midpoint to the nearest
 * catalogued source leg; lines with no nearby match (e.g. runtime entry, synthetic
 * transit) are left untagged and stay always-visible, same as before this pass.
 */
export function tagLinesWithMissionLayer(
  lines: PlanLine[],
  catalog: MissionLayerLeg[]
): PlanLine[] {
  if (catalog.length === 0) return lines;
  return lines.map((line) => {
    const fn = line.from?.x;
    const fe = line.from?.y;
    const tn = line.to?.x;
    const te = line.to?.y;
    if (fn == null || fe == null || tn == null || te == null) return line;
    const midN = (fn + tn) / 2;
    const midE = (fe + te) / 2;

    let bestLayerId: string | null = null;
    let bestD = Infinity;
    for (const leg of catalog) {
      const d = pointToSegmentDistanceM(midN, midE, leg.fromNorth, leg.fromEast, leg.toNorth, leg.toEast);
      if (d < bestD) {
        bestD = d;
        bestLayerId = leg.layerId;
      }
    }
    if (bestLayerId == null || bestD > LAYER_MATCH_MAX_DIST_M) return line;
    return { ...line, missionLayerId: bestLayerId };
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
