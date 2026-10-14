/**
 * CSV point edit mode — pure state + selection logic (no React, no map).
 *
 * The imported points are immutable. An edit is only a set of deleted point ids per file;
 * the working plan is always re-derived from (original parse − deleted ids) by
 * `buildCsvFileLines`, so undo / redo / "restore all" need no special geometry logic and the
 * file's GPS anchor (frozen at parse time) can never move.
 *
 * See docs/CSV_POINT_EDIT_EXECUTION_PLAN.md (D1–D9).
 */

import type { LocalPointCsvPoint, LocalPointCsvResult } from "./localPointCsv";

/** Undo / redo depth. The oldest action is dropped past this. */
export const CSV_EDIT_HISTORY_CAP = 50;

/** Points closer than this (metres) are treated as one stacked tap target. */
export const CSV_EDIT_COINCIDENT_TOL_M = 0.02;

/** `${fileId}:${csv row number}` — row numbers count skipped/invalid rows, so ids never shift. */
export function csvPointId(fileId: string, point: Pick<LocalPointCsvPoint, "source_index">): string {
  return `${fileId}:${point.source_index}`;
}

/** One undoable user action. May span several files (e.g. "Restore all"). */
export type CsvEditDelta = {
  /** What the action did when applied forward. `reverse` is its own inverse; its parts carry no ids. */
  kind: "delete" | "restore" | "reverse";
  parts: { fileId: string; ids: string[] }[];
};

export type CsvEditState = {
  /** fileId → deleted point ids. Files with nothing deleted are absent. */
  deleted: Record<string, ReadonlySet<string>>;
  /** Files whose plan is driven end → start. Absent ⇒ not reversed. */
  reversed?: Readonly<Record<string, true>>;
  undo: CsvEditDelta[];
  redo: CsvEditDelta[];
};

export const EMPTY_CSV_EDIT_STATE: CsvEditState = { deleted: {}, reversed: {}, undo: [], redo: [] };

/** What a state transition changed, so callers can rebuild + reselect precisely. */
export type CsvEditChange = {
  effect: "deleted" | "restored" | "reversed";
  parts: { fileId: string; ids: string[] }[];
};

export type CsvEditTransition = { state: CsvEditState; change: CsvEditChange | null };

const NO_CHANGE = (state: CsvEditState): CsvEditTransition => ({ state, change: null });

export function deletedIdsFor(state: CsvEditState, fileId: string): ReadonlySet<string> {
  return state.deleted[fileId] ?? EMPTY_SET;
}
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export function isFileReversed(state: CsvEditState, fileId: string): boolean {
  return state.reversed?.[fileId] === true;
}

function toggleReversed(
  reversed: CsvEditState["reversed"],
  fileIds: readonly string[]
): Readonly<Record<string, true>> {
  const out: Record<string, true> = { ...(reversed ?? {}) };
  for (const id of fileIds) {
    if (out[id]) delete out[id];
    else out[id] = true;
  }
  return out;
}

export function totalDeletedCount(state: CsvEditState): number {
  let n = 0;
  for (const set of Object.values(state.deleted)) n += set.size;
  return n;
}

export function fileIdsWithEdits(state: CsvEditState): string[] {
  return Object.keys(state.deleted).filter((id) => state.deleted[id].size > 0);
}

function capped(stack: CsvEditDelta[]): CsvEditDelta[] {
  return stack.length > CSV_EDIT_HISTORY_CAP ? stack.slice(stack.length - CSV_EDIT_HISTORY_CAP) : stack;
}

function withDeleted(
  deleted: CsvEditState["deleted"],
  fileId: string,
  mutate: (next: Set<string>) => void
): CsvEditState["deleted"] {
  const next = new Set(deleted[fileId] ?? []);
  mutate(next);
  const out = { ...deleted };
  if (next.size === 0) delete out[fileId];
  else out[fileId] = next;
  return out;
}

/** Apply a delta's forward or inverse effect. Returns the actually-changed parts. */
function applyEffect(
  deleted: CsvEditState["deleted"],
  parts: CsvEditDelta["parts"],
  effect: "deleted" | "restored"
): { deleted: CsvEditState["deleted"]; changed: CsvEditChange["parts"] } {
  let next = deleted;
  const changed: CsvEditChange["parts"] = [];
  for (const part of parts) {
    const current = next[part.fileId] ?? EMPTY_SET;
    const ids = part.ids.filter((id) => (effect === "deleted" ? !current.has(id) : current.has(id)));
    if (ids.length === 0) continue;
    next = withDeleted(next, part.fileId, (set) => {
      for (const id of ids) {
        if (effect === "deleted") set.add(id);
        else set.delete(id);
      }
    });
    changed.push({ fileId: part.fileId, ids });
  }
  return { deleted: next, changed };
}

/** Delete points (new action: clears redo). Already-deleted ids are ignored. */
export function applyCsvDelete(
  state: CsvEditState,
  parts: { fileId: string; ids: readonly string[] }[]
): CsvEditTransition {
  const { deleted, changed } = applyEffect(
    state.deleted,
    parts.map((p) => ({ fileId: p.fileId, ids: [...p.ids] })),
    "deleted"
  );
  if (changed.length === 0) return NO_CHANGE(state);
  return {
    state: {
      ...state,
      deleted,
      undo: capped([...state.undo, { kind: "delete", parts: changed }]),
      redo: [],
    },
    change: { effect: "deleted", parts: changed },
  };
}

/** Restore every deleted point (all files, or just `fileId`) as ONE undoable action. */
export function applyCsvRestoreAll(state: CsvEditState, fileId?: string): CsvEditTransition {
  const parts: CsvEditDelta["parts"] = [];
  for (const [id, set] of Object.entries(state.deleted)) {
    if (fileId != null && id !== fileId) continue;
    if (set.size > 0) parts.push({ fileId: id, ids: [...set] });
  }
  if (parts.length === 0) return NO_CHANGE(state);
  const { deleted, changed } = applyEffect(state.deleted, parts, "restored");
  return {
    state: {
      ...state,
      deleted,
      undo: capped([...state.undo, { kind: "restore", parts: changed }]),
      redo: [],
    },
    change: { effect: "restored", parts: changed },
  };
}

/**
 * Reverse the drive direction of every file in `fileIds` (new action: clears redo). Points and
 * deletions are untouched; a second reverse flips back.
 */
export function applyCsvReverse(state: CsvEditState, fileIds: readonly string[]): CsvEditTransition {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return NO_CHANGE(state);
  const parts = unique.map((fileId) => ({ fileId, ids: [] as string[] }));
  return {
    state: {
      ...state,
      reversed: toggleReversed(state.reversed, unique),
      undo: capped([...state.undo, { kind: "reverse", parts }]),
      redo: [],
    },
    change: { effect: "reversed", parts },
  };
}

/** Undo / redo of a reverse: flip the same files again (reverse is its own inverse). */
function replayReverse(
  state: CsvEditState,
  delta: CsvEditDelta,
  stacks: Pick<CsvEditState, "undo" | "redo">
): CsvEditTransition {
  const parts = delta.parts.map((p) => ({ fileId: p.fileId, ids: [] as string[] }));
  return {
    state: {
      ...state,
      ...stacks,
      reversed: toggleReversed(state.reversed, parts.map((p) => p.fileId)),
    },
    change: { effect: "reversed", parts },
  };
}

export function applyCsvUndo(state: CsvEditState): CsvEditTransition {
  const delta = state.undo[state.undo.length - 1];
  if (!delta) return NO_CHANGE(state);
  if (delta.kind === "reverse") {
    return replayReverse(state, delta, {
      undo: state.undo.slice(0, -1),
      redo: capped([...state.redo, delta]),
    });
  }
  const inverse = delta.kind === "delete" ? "restored" : "deleted";
  const { deleted, changed } = applyEffect(state.deleted, delta.parts, inverse);
  return {
    state: {
      ...state,
      deleted,
      undo: state.undo.slice(0, -1),
      redo: capped([...state.redo, delta]),
    },
    change: changed.length > 0 ? { effect: inverse, parts: changed } : null,
  };
}

export function applyCsvRedo(state: CsvEditState): CsvEditTransition {
  const delta = state.redo[state.redo.length - 1];
  if (!delta) return NO_CHANGE(state);
  if (delta.kind === "reverse") {
    return replayReverse(state, delta, {
      undo: capped([...state.undo, delta]),
      redo: state.redo.slice(0, -1),
    });
  }
  const forward = delta.kind === "delete" ? "deleted" : "restored";
  const { deleted, changed } = applyEffect(state.deleted, delta.parts, forward);
  return {
    state: {
      ...state,
      deleted,
      undo: capped([...state.undo, delta]),
      redo: state.redo.slice(0, -1),
    },
    change: changed.length > 0 ? { effect: forward, parts: changed } : null,
  };
}

/**
 * Forget one file (it was removed from the batch): drop its deleted set and strip its parts
 * out of the history. Other files' history is untouched, so removing/adding a CSV never wipes
 * unrelated undo steps.
 */
export function pruneCsvEditFile(state: CsvEditState, fileId: string): CsvEditState {
  if (!(fileId in state.deleted) && !isFileReversed(state, fileId) && !state.undo.concat(state.redo).some((d) => d.parts.some((p) => p.fileId === fileId))) {
    return state;
  }
  const strip = (stack: CsvEditDelta[]) =>
    stack
      .map((d) => ({ ...d, parts: d.parts.filter((p) => p.fileId !== fileId) }))
      .filter((d) => d.parts.length > 0);
  const deleted = { ...state.deleted };
  delete deleted[fileId];
  const reversed = { ...(state.reversed ?? {}) };
  delete reversed[fileId];
  return { deleted, reversed, undo: strip(state.undo), redo: strip(state.redo) };
}

// ─── Points the map can show / tap ────────────────────────────────────────────────

/** One tappable point (all rows of all files, original order). */
export type CsvEditablePoint = {
  id: string;
  fileId: string;
  /** Row order within its file (0-based index into the parse's `points`). */
  order: number;
  deleted: boolean;
  north: number;
  east: number;
  lat?: number;
  lon?: number;
};

export type CsvFileParse = { fileId: string; parse: LocalPointCsvResult };

/** Flatten every file's parse into editable points, tagging deleted ones. */
export function listEditablePoints(
  files: readonly CsvFileParse[],
  state: CsvEditState
): CsvEditablePoint[] {
  const out: CsvEditablePoint[] = [];
  for (const { fileId, parse } of files) {
    const deleted = deletedIdsFor(state, fileId);
    parse.points.forEach((p, order) => {
      const id = csvPointId(fileId, p);
      out.push({
        id,
        fileId,
        order,
        deleted: deleted.has(id),
        north: p.north_m,
        east: p.east_m,
        lat: p.lat,
        lon: p.lon,
      });
    });
  }
  return out;
}

/** Remaining (non-deleted) points of one file, original order. */
export function remainingPoints(
  parse: LocalPointCsvResult,
  fileId: string,
  deleted: ReadonlySet<string>
): LocalPointCsvPoint[] {
  if (deleted.size === 0) return parse.points;
  return parse.points.filter((p) => !deleted.has(csvPointId(fileId, p)));
}

/** Remaining points in drive order: original row order, or last row first when the file is reversed. */
export function remainingPointsInDriveOrder(
  parse: LocalPointCsvResult,
  fileId: string,
  state: CsvEditState
): LocalPointCsvPoint[] {
  const kept = remainingPoints(parse, fileId, deletedIdsFor(state, fileId));
  return isFileReversed(state, fileId) ? kept.slice().reverse() : kept;
}

// ─── Selection ────────────────────────────────────────────────────────────────────

function distanceM(a: CsvEditablePoint, b: CsvEditablePoint): number {
  if (a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
    const dN = (a.lat - b.lat) * 111_320;
    const dE = (a.lon - b.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    return Math.hypot(dN, dE);
  }
  // Same-file NED rows share a frame; across frames fall back to "never coincident".
  if (a.fileId !== b.fileId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.north - b.north, a.east - b.east);
}

/**
 * A tap on a point selects every remaining point stacked on it (within
 * CSV_EDIT_COINCIDENT_TOL_M) — duplicates are indistinguishable on the map, and deleting just
 * one of them would look like nothing happened.
 */
export function coincidentSelection(
  points: readonly CsvEditablePoint[],
  tappedId: string,
  tolM = CSV_EDIT_COINCIDENT_TOL_M
): string[] {
  const tapped = points.find((p) => p.id === tappedId);
  if (!tapped || tapped.deleted) return [];
  const ids: string[] = [];
  for (const p of points) {
    if (p.deleted) continue;
    if (p.id === tappedId || distanceM(tapped, p) <= tolM) ids.push(p.id);
  }
  return ids;
}

/** Toggle: if every id is already selected, deselect them; otherwise add them. */
export function toggleSelection(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(selected);
  if (ids.length === 0) return next;
  const allSelected = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * "From this point to that point along the path": every remaining point of the same file
 * between the two (inclusive, by row order). Null when the points are in different files or
 * either is unknown/deleted.
 */
export function selectRange(
  points: readonly CsvEditablePoint[],
  fromId: string,
  toId: string
): string[] | null {
  const a = points.find((p) => p.id === fromId);
  const b = points.find((p) => p.id === toId);
  if (!a || !b || a.deleted || b.deleted || a.fileId !== b.fileId) return null;
  const lo = Math.min(a.order, b.order);
  const hi = Math.max(a.order, b.order);
  return points
    .filter((p) => p.fileId === a.fileId && !p.deleted && p.order >= lo && p.order <= hi)
    .map((p) => p.id);
}

/** Drop ids that no longer exist or were deleted. Returns the same set when nothing changed. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  points: readonly CsvEditablePoint[]
): Set<string> | ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const live = new Set<string>();
  for (const p of points) if (!p.deleted) live.add(p.id);
  const next = new Set<string>();
  for (const id of selected) if (live.has(id)) next.add(id);
  return next.size === selected.size ? selected : next;
}

/** Group a flat id selection by file, ready for `applyCsvDelete`. */
export function selectionToParts(
  selected: ReadonlySet<string>,
  points: readonly CsvEditablePoint[]
): { fileId: string; ids: string[] }[] {
  const byFile = new Map<string, string[]>();
  for (const p of points) {
    if (p.deleted || !selected.has(p.id)) continue;
    const list = byFile.get(p.fileId);
    if (list) list.push(p.id);
    else byFile.set(p.fileId, [p.id]);
  }
  return [...byFile.entries()].map(([fileId, ids]) => ({ fileId, ids }));
}
