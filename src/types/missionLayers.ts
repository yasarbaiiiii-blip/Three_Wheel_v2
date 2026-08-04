/**
 * Mission Layers — operator grouping of imported plan files.
 * Distinct from CAD LayerVisibility (boundary/marking/transit/…).
 */

export type MissionLayerOutcome = "completed" | "stopped" | "failed" | null;

export type MissionLayer = {
  /** Stable identity, independent of display number. */
  id: string;
  /** Operator-facing 1, 2, 3… — never renumbered silently in-session. */
  number: number;
  /** UploadedFileEntry.id members (order = within-layer merge order). */
  fileEntryIds: string[];
  /** Canvas gate; default true. */
  visible: boolean;
  /** True only after a run of this layer reached mission_state === "completed". */
  finished: boolean;
  /** Backend mission id of last successful start that included this layer. */
  lastMissionId: string | null;
  /** Epoch ms of that start. */
  lastRunAt: number | null;
  /** Last known terminal outcome (stopped ≠ finished). */
  lastOutcome: MissionLayerOutcome;
};

export function createEmptyMissionLayer(
  id: string,
  number: number,
  fileEntryIds: string[] = []
): MissionLayer {
  return {
    id,
    number,
    fileEntryIds: [...fileEntryIds],
    visible: true,
    finished: false,
    lastMissionId: null,
    lastRunAt: null,
    lastOutcome: null,
  };
}
