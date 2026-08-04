/**
 * Pure Mission Layer assignment helpers (no React).
 * A file belongs to at most one mission layer.
 */

import {
  createEmptyMissionLayer,
  type MissionLayer,
  type MissionLayerOutcome,
} from "../types/missionLayers";

let layerIdSeq = 0;

/** Test helper — reset id counter between unit tests. */
export function resetMissionLayerIdSeqForTests(): void {
  layerIdSeq = 0;
}

export function newMissionLayerId(): string {
  layerIdSeq += 1;
  return `ml-${Date.now().toString(36)}-${layerIdSeq}`;
}

export function nextLayerNumber(layers: MissionLayer[]): number {
  if (layers.length === 0) return 1;
  return Math.max(...layers.map((l) => l.number)) + 1;
}

/** Non-empty layers eligible for the Start picker. */
export function nonEmptyMissionLayers(layers: MissionLayer[]): MissionLayer[] {
  return layers
    .filter((l) => l.fileEntryIds.length > 0)
    .slice()
    .sort((a, b) => a.number - b.number);
}

export function sortedMissionLayers(layers: MissionLayer[]): MissionLayer[] {
  return layers.slice().sort((a, b) => a.number - b.number);
}

export function layerForFile(
  layers: MissionLayer[],
  fileEntryId: string
): MissionLayer | null {
  return layers.find((l) => l.fileEntryIds.includes(fileEntryId)) ?? null;
}

export function createLayerForFile(
  layers: MissionLayer[],
  fileEntryId: string,
  idFactory: () => string = newMissionLayerId
): MissionLayer[] {
  // Move off any existing layer first.
  const cleaned = unassignFile(layers, fileEntryId);
  const layer = createEmptyMissionLayer(
    idFactory(),
    nextLayerNumber(cleaned),
    [fileEntryId]
  );
  return [...cleaned, layer];
}

export function assignFileToLayer(
  layers: MissionLayer[],
  fileEntryId: string,
  layerId: string
): MissionLayer[] {
  const target = layers.find((l) => l.id === layerId);
  if (!target) return layers;

  const without = unassignFile(layers, fileEntryId);
  return without.map((l) => {
    if (l.id !== layerId) return l;
    if (l.fileEntryIds.includes(fileEntryId)) return l;
    return { ...l, fileEntryIds: [...l.fileEntryIds, fileEntryId] };
  });
}

export function unassignFile(
  layers: MissionLayer[],
  fileEntryId: string
): MissionLayer[] {
  return layers.map((l) => {
    if (!l.fileEntryIds.includes(fileEntryId)) return l;
    return {
      ...l,
      fileEntryIds: l.fileEntryIds.filter((id) => id !== fileEntryId),
    };
  });
}

/** Drop file ids that no longer exist in the upload batch. Keeps empty layers. */
export function pruneMissingFiles(
  layers: MissionLayer[],
  uploadedFileIds: ReadonlySet<string> | string[]
): MissionLayer[] {
  const set =
    uploadedFileIds instanceof Set
      ? uploadedFileIds
      : new Set(uploadedFileIds);
  return layers.map((l) => ({
    ...l,
    fileEntryIds: l.fileEntryIds.filter((id) => set.has(id)),
  }));
}

export function markLayersStarted(
  layers: MissionLayer[],
  layerIds: string[],
  missionId: string | null,
  atMs: number = Date.now()
): MissionLayer[] {
  const set = new Set(layerIds);
  return layers.map((l) => {
    if (!set.has(l.id)) return l;
    return {
      ...l,
      lastMissionId: missionId,
      lastRunAt: atMs,
      lastOutcome: null,
    };
  });
}

export function applyMissionTerminalOutcome(
  layers: MissionLayer[],
  layerIds: string[],
  outcome: Exclude<MissionLayerOutcome, null>
): MissionLayer[] {
  const set = new Set(layerIds);
  return layers.map((l) => {
    if (!set.has(l.id)) return l;
    if (outcome === "completed") {
      return { ...l, finished: true, lastOutcome: "completed" };
    }
    return { ...l, lastOutcome: outcome };
  });
}

/**
 * Interpret mission_state transition for finished bookkeeping.
 * Only `completed` marks finished; `idle` after running is stop/abort.
 */
export function outcomeFromMissionStateTransition(
  prev: string | null | undefined,
  current: string | null | undefined
): "completed" | "stopped" | null {
  if (prev !== "running") return null;
  if (current === "completed") return "completed";
  if (current === "idle") return "stopped";
  return null;
}

export function toggleMissionLayerVisibility(
  layers: MissionLayer[],
  layerId: string
): MissionLayer[] {
  return layers.map((l) =>
    l.id === layerId ? { ...l, visible: !l.visible } : l
  );
}

export function setMissionLayerVisibility(
  layers: MissionLayer[],
  layerId: string,
  visible: boolean
): MissionLayer[] {
  return layers.map((l) => (l.id === layerId ? { ...l, visible } : l));
}
