/**
 * React glue for CSV point edit mode (docs/CSV_POINT_EDIT_EXECUTION_PLAN.md).
 *
 * All decisions live in the pure modules (`csvPointEdit`, `csvFileLines`); this hook only owns
 * the state (deleted ids + history, selection, mode, plan revision) and calls back into App to
 * swap a file's lines. The original per-file CSV parse is never mutated.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildCsvFileLines, type CsvFileLinesResult } from "../utils/csvFileLines";
import {
  EMPTY_CSV_EDIT_STATE,
  applyCsvDelete,
  applyCsvRedo,
  applyCsvRestoreAll,
  applyCsvReverse,
  applyCsvUndo,
  coincidentSelection,
  deletedIdsFor,
  isFileReversed,
  listEditablePoints,
  pruneCsvEditFile,
  pruneSelection,
  remainingPointsInDriveOrder,
  selectRange,
  selectionToParts,
  toggleSelection,
  totalDeletedCount,
  type CsvEditState,
  type CsvEditTransition,
  type CsvEditablePoint,
} from "../utils/csvPointEdit";
import { saveCsvFiles } from "../utils/csvExportSave";
import { buildEditedCsvText, defaultExportBaseName, exportFileNames } from "../utils/csvPointExport";
import type { LocalPointCsvResult, RoadMarkingFitCache } from "../utils/localPointCsv";
import { yieldToUi } from "../utils/runtimeGuards";
import type { UploadedFileEntry } from "../types/uploadedFiles";
import type { PlanLine } from "../types/plan";

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

export type CsvFileEditSummary = {
  fileId: string;
  fileName: string;
  totalPoints: number;
  remainingCount: number;
  deletedCount: number;
  pathCount: number;
  /** Groups left with too few points to make a path. */
  pointsOnlyGroups: number;
};

export type CsvPlanChange = {
  fileIds: string[];
  /** One-line operator summary, e.g. "Deleted 3 points". */
  summary: string;
  /** True when a file that had Anchor/Offset/Move baked in was redrawn from its CSV. */
  resetGeometry: boolean;
  /** True when a file's number of paths changed (line ids renumbered) — Path Order must reset. */
  pathCountChanged: boolean;
};

export type UseCsvPointEditParams = {
  /** Mission running or paused: edits are refused (and edit mode closes). */
  planLocked: boolean;
  getFiles: () => UploadedFileEntry[];
  /** `sharedOriginGps` — `[lat, lon]` or null. */
  getSharedOrigin: () => [number, number] | null;
  /** Replace one file's lines in the plan (App owns `lines`). */
  applyFileLines: (file: UploadedFileEntry, lines: PlanLine[], prefixed: boolean) => void;
  /** Called once per plan-changing action, after the lines were swapped. */
  onPlanChanged: (change: CsvPlanChange) => void;
  /** Leave Anchor mode etc. when edit mode opens. */
  onEnterEditMode: () => void;
  /** Resolve true to proceed. Used before redrawing a file that has Anchor/Offset baked in. */
  confirmResetGeometry: (fileNames: string[]) => Promise<boolean>;
  notify: (title: string, message: string, kind?: "info" | "success" | "warning" | "error") => void;
};

export type CsvPointEditApi = {
  editMode: boolean;
  setEditMode: (on: boolean) => void;
  rangeMode: boolean;
  toggleRangeMode: () => void;
  /** All editable points (only populated while edit mode is on). */
  points: CsvEditablePoint[];
  selection: ReadonlySet<string>;
  selectedCount: number;
  onPointPress: (pointId: string) => void;
  clearSelection: () => void;
  deleteSelected: () => void;
  undo: () => void;
  redo: () => void;
  restoreAll: () => void;
  /** Reverse the whole CSV plan (every file, end → start). Undoable; a second tap flips back. */
  reversePlan: () => void;
  /** True when the CSV plan is currently reversed. */
  reversed: boolean;
  /** Suggested name for the export prompt (no extension). */
  defaultExportName: string;
  /** Write the edited CSV(s) — remaining points, in drive order — under `baseName`. */
  exportCsv: (baseName: string) => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  deletedCount: number;
  /** Per-file counts for the panel. */
  summaries: CsvFileEditSummary[];
  /** Total points left across all CSV files (0 ⇒ Send must be blocked). */
  remainingTotal: number;
  /** Bumped by every edit. A Send stamps it; a stale result is discarded. */
  planRevision: number;
  getPlanRevision: () => number;
  /** Bumped only when a file's path count changed — Path Order should reset, not just reseed. */
  pathOrderResetToken: number;
  /** Bumped when a reverse (or its undo / redo) flipped the plan — Path Order reverses its list. */
  pathOrderReverseToken: number;
  hasCsv: boolean;
  /** True while a rebuild is running (the UI painted a spinner first); further actions are ignored. */
  busy: boolean;
  /** Shared road-marking fit memo: pass to `buildCsvFileLines` at upload so the first edit is cheap too. */
  fitCache: RoadMarkingFitCache;

  /** Upload hooks (App). */
  registerParse: (fileId: string, parse: LocalPointCsvResult, built: CsvFileLinesResult) => void;
  removeFile: (fileId: string) => void;
  reset: () => void;
  /** Anchor / Offset / Move baked these files' geometry — a rebuild would discard it. */
  markFilesTouched: (fileIds: Iterable<string>) => void;
  markAllFilesTouched: () => void;
  /** Per-file parses with deleted points removed (drives pins / preview / readiness). */
  getEffectiveParses: () => LocalPointCsvResult[];
};

export function useCsvPointEdit(params: UseCsvPointEditParams): CsvPointEditApi {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const parsesRef = useRef(new Map<string, LocalPointCsvResult>());
  const statsRef = useRef(new Map<string, CsvFileLinesResult>());
  const touchedRef = useRef(new Set<string>());
  const fitCacheRef = useRef<RoadMarkingFitCache>(new Map());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [parseVersion, setParseVersion] = useState(0);
  const [edit, setEditInner] = useState<CsvEditState>(EMPTY_CSV_EDIT_STATE);
  const editRef = useRef(edit);
  const setEdit = useCallback((next: CsvEditState) => {
    editRef.current = next;
    setEditInner(next);
  }, []);

  const [selection, setSelectionInner] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  const setSelection = useCallback((next: ReadonlySet<string>) => {
    selectionRef.current = next;
    setSelectionInner(next);
  }, []);

  const [editMode, setEditModeInner] = useState(false);
  const editModeRef = useRef(false);
  const [rangeMode, setRangeModeInner] = useState(false);
  const rangeStartRef = useRef<string | null>(null);

  const [planRevision, setPlanRevision] = useState(0);
  const revisionRef = useRef(0);
  const [pathOrderResetToken, setPathOrderResetToken] = useState(0);
  const [pathOrderReverseToken, setPathOrderReverseToken] = useState(0);
  const [statsVersion, setStatsVersion] = useState(0);

  // ── derived ────────────────────────────────────────────────────────────────────

  const orderedFiles = useCallback(() => {
    const out: { fileId: string; parse: LocalPointCsvResult }[] = [];
    for (const f of paramsRef.current.getFiles()) {
      if (f.kind !== "csv") continue;
      const parse = parsesRef.current.get(f.id);
      if (parse) out.push({ fileId: f.id, parse });
    }
    return out;
  }, []);

  // Only materialise the (possibly 100k-long) point list while the operator is editing.
  const points = useMemo(
    () => (editMode ? listEditablePoints(orderedFiles(), edit) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parseVersion tracks the parse map
    [editMode, edit, parseVersion, orderedFiles]
  );

  const summaries = useMemo<CsvFileEditSummary[]>(() => {
    const out: CsvFileEditSummary[] = [];
    for (const f of paramsRef.current.getFiles()) {
      if (f.kind !== "csv") continue;
      const parse = parsesRef.current.get(f.id);
      const stats = statsRef.current.get(f.id);
      if (!parse || !stats) continue;
      out.push({
        fileId: f.id,
        fileName: f.fileName,
        totalPoints: stats.totalPoints,
        remainingCount: stats.remainingCount,
        deletedCount: stats.deletedCount,
        pathCount: stats.pathCount,
        pointsOnlyGroups: stats.pointsOnlyGroups,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statsVersion tracks the stats map
  }, [statsVersion, parseVersion]);

  const remainingTotal = useMemo(
    () => summaries.reduce((n, s) => n + s.remainingCount, 0),
    [summaries]
  );

  // ── core: swap lines for changed files ───────────────────────────────────────

  const rebuildFiles = useCallback((fileIds: string[]) => {
    let pathCountChanged = false;
    let resetGeometry = false;
    const sharedRaw = paramsRef.current.getSharedOrigin();
    const sharedOrigin = sharedRaw ? { lat: sharedRaw[0], lon: sharedRaw[1] } : null;
    for (const fileId of fileIds) {
      const file = paramsRef.current.getFiles().find((f) => f.id === fileId && f.kind === "csv");
      const parse = parsesRef.current.get(fileId);
      if (!file || !parse) continue;
      const prefixed = parse.kind === "gps";
      const built = buildCsvFileLines({
        parse,
        fileId,
        deletedIds: deletedIdsFor(editRef.current, fileId),
        reversed: isFileReversed(editRef.current, fileId),
        prefix: prefixed ? file.lineIdPrefix : null,
        sharedOrigin,
        fitCache: fitCacheRef.current,
      });
      const before = statsRef.current.get(fileId);
      if (!before || before.pathCount !== built.pathCount) pathCountChanged = true;
      if (touchedRef.current.delete(fileId)) resetGeometry = true;
      statsRef.current.set(fileId, built);
      paramsRef.current.applyFileLines(file, built.lines, prefixed);
    }
    setStatsVersion((v) => v + 1);
    return { pathCountChanged, resetGeometry };
  }, []);

  const afterTransition = useCallback(
    (t: CsvEditTransition, verb: string) => {
      if (!t.change) return;
      setEdit(t.state);
      const fileIds = [...new Set(t.change.parts.map((p) => p.fileId))];
      const { pathCountChanged, resetGeometry } = rebuildFiles(fileIds);

      const count = t.change.parts.reduce((n, p) => n + p.ids.length, 0);
      const noun = count === 1 ? "point" : "points";
      const reversedEffect = t.change.effect === "reversed";

      // Selection: after a delete nothing is selected; after undo/redo/restore the points that
      // came back are selected (only while editing); a reverse keeps it (no point changed).
      if (!reversedEffect) {
        const next =
          editModeRef.current && t.change.effect === "restored"
            ? new Set(t.change.parts.flatMap((p) => p.ids))
            : EMPTY_SELECTION;
        setSelection(next);
      }
      rangeStartRef.current = null;
      setRangeModeInner(false);

      revisionRef.current += 1;
      setPlanRevision(revisionRef.current);
      if (pathCountChanged) setPathOrderResetToken((n) => n + 1);
      // A reset already rebuilt Path Order from the (reversed) lines; reversing it too would undo that.
      else if (reversedEffect) setPathOrderReverseToken((n) => n + 1);

      paramsRef.current.onPlanChanged({
        fileIds,
        summary: reversedEffect
          ? verb === "Reversed"
            ? "Reversed the plan"
            : `${verb} reverse`
          : `${verb} ${count} ${noun}`,
        resetGeometry,
        pathCountChanged,
      });
    },
    [rebuildFiles, setEdit, setSelection]
  );

  /** Guard + optional "this resets Anchor/Offset" confirm, then run `compute` on the latest state. */
  const runAction = useCallback(
    async (fileIdsHint: string[], compute: () => CsvEditTransition, verb: string) => {
      if (paramsRef.current.planLocked) {
        paramsRef.current.notify(
          "Mission active",
          "Point edits are blocked while a mission is active. Stop the mission first.",
          "warning"
        );
        return;
      }
      // One rebuild at a time: a second tap while the first is fitting would act on stale state.
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const touched = fileIdsHint.filter((id) => touchedRef.current.has(id));
        if (touched.length > 0) {
          const names = touched.map(
            (id) => paramsRef.current.getFiles().find((f) => f.id === id)?.fileName ?? id
          );
          const ok = await paramsRef.current.confirmResetGeometry(names);
          if (!ok) return;
        }
        // The path fit is CPU-heavy on big groups: paint the "Updating path…" state first.
        setBusy(true);
        await yieldToUi();
        // Recompute from the state as of NOW (it may have changed while the dialog was open).
        afterTransition(compute(), verb);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [afterTransition]
  );

  // ── operator actions ─────────────────────────────────────────────────────────

  const deleteSelected = useCallback(() => {
    if (!editModeRef.current) return;
    const parts = selectionToParts(selectionRef.current, listEditablePoints(orderedFiles(), editRef.current));
    if (parts.length === 0) return;
    void runAction(
      parts.map((p) => p.fileId),
      () => applyCsvDelete(editRef.current, parts),
      "Deleted"
    );
  }, [orderedFiles, runAction]);

  const undo = useCallback(() => {
    const top = editRef.current.undo[editRef.current.undo.length - 1];
    if (!top) return;
    void runAction(top.parts.map((p) => p.fileId), () => applyCsvUndo(editRef.current), "Undid");
  }, [runAction]);

  const redo = useCallback(() => {
    const top = editRef.current.redo[editRef.current.redo.length - 1];
    if (!top) return;
    void runAction(top.parts.map((p) => p.fileId), () => applyCsvRedo(editRef.current), "Redid");
  }, [runAction]);

  const restoreAll = useCallback(() => {
    const fileIds = Object.keys(editRef.current.deleted);
    if (fileIds.length === 0) return;
    void runAction(fileIds, () => applyCsvRestoreAll(editRef.current), "Restored");
  }, [runAction]);

  const reversePlan = useCallback(() => {
    const fileIds = orderedFiles().map((f) => f.fileId);
    if (fileIds.length === 0) return;
    void runAction(fileIds, () => applyCsvReverse(editRef.current, fileIds), "Reversed");
  }, [orderedFiles, runAction]);

  const exportCsv = useCallback(
    async (baseName: string) => {
      const files = orderedFiles();
      const withPoints = files
        .map((f) => ({ ...f, points: remainingPointsInDriveOrder(f.parse, f.fileId, editRef.current) }))
        .filter((f) => f.points.length > 0);
      if (withPoints.length === 0) {
        paramsRef.current.notify("Nothing to export", "Every CSV point was deleted.", "warning");
        return;
      }
      const names = exportFileNames(baseName, withPoints.length);
      try {
        const result = await saveCsvFiles(
          withPoints.map((f, i) => ({ fileName: names[i], text: buildEditedCsvText(f.parse, f.points) }))
        );
        if (result.status === "cancelled") return;
        const total = withPoints.reduce((n, f) => n + f.points.length, 0);
        paramsRef.current.notify(
          "CSV exported",
          `${result.files.map((f) => f.fileName).join(", ")} (${total} points) saved to ${result.location}.`,
          "success"
        );
      } catch (e) {
        paramsRef.current.notify(
          "Export failed",
          e instanceof Error ? e.message : "Could not write the CSV file.",
          "error"
        );
      }
    },
    [orderedFiles]
  );

  const clearSelection = useCallback(() => {
    rangeStartRef.current = null;
    setRangeModeInner(false);
    setSelection(EMPTY_SELECTION);
  }, [setSelection]);

  const setEditMode = useCallback(
    (on: boolean) => {
      if (on === editModeRef.current) return;
      if (on && paramsRef.current.planLocked) {
        paramsRef.current.notify(
          "Mission active",
          "Point edits are blocked while a mission is active. Stop the mission first.",
          "warning"
        );
        return;
      }
      editModeRef.current = on;
      setEditModeInner(on);
      // Entering or leaving always drops a pending selection / range (one mode at a time).
      rangeStartRef.current = null;
      setRangeModeInner(false);
      setSelection(EMPTY_SELECTION);
      if (on) paramsRef.current.onEnterEditMode();
    },
    [setSelection]
  );

  const toggleRangeMode = useCallback(() => {
    setRangeModeInner((prev) => {
      rangeStartRef.current = null;
      return !prev;
    });
  }, []);

  const onPointPress = useCallback(
    (pointId: string) => {
      if (!editModeRef.current) return;
      const all = listEditablePoints(orderedFiles(), editRef.current);
      if (rangeMode) {
        const start = rangeStartRef.current;
        if (start == null) {
          rangeStartRef.current = pointId;
          setSelection(new Set([...selectionRef.current, pointId]));
          return;
        }
        const ids = selectRange(all, start, pointId);
        rangeStartRef.current = null;
        setRangeModeInner(false);
        if (!ids) {
          paramsRef.current.notify("Range", "Pick two points from the same CSV file.", "warning");
          return;
        }
        setSelection(new Set([...selectionRef.current, ...ids]));
        return;
      }
      const ids = coincidentSelection(all, pointId);
      if (ids.length === 0) return;
      setSelection(toggleSelection(selectionRef.current, ids));
    },
    [orderedFiles, rangeMode, setSelection]
  );

  // ── upload / lifecycle (called by App) ─────────────────────────────────────────

  const registerParse = useCallback(
    (fileId: string, parse: LocalPointCsvResult, built: CsvFileLinesResult) => {
      parsesRef.current.set(fileId, parse);
      statsRef.current.set(fileId, built);
      touchedRef.current.delete(fileId);
      setParseVersion((v) => v + 1);
      setStatsVersion((v) => v + 1);
    },
    []
  );

  const removeFile = useCallback(
    (fileId: string) => {
      parsesRef.current.delete(fileId);
      statsRef.current.delete(fileId);
      touchedRef.current.delete(fileId);
      setEdit(pruneCsvEditFile(editRef.current, fileId));
      // Prune selection against what remains.
      const remaining = listEditablePoints(orderedFiles(), editRef.current);
      setSelection(pruneSelection(selectionRef.current, remaining));
      revisionRef.current += 1;
      setPlanRevision(revisionRef.current);
      setParseVersion((v) => v + 1);
      setStatsVersion((v) => v + 1);
    },
    [orderedFiles, setEdit, setSelection]
  );

  const reset = useCallback(() => {
    parsesRef.current.clear();
    statsRef.current.clear();
    touchedRef.current.clear();
    fitCacheRef.current.clear();
    setEdit(EMPTY_CSV_EDIT_STATE);
    setSelection(EMPTY_SELECTION);
    editModeRef.current = false;
    setEditModeInner(false);
    rangeStartRef.current = null;
    setRangeModeInner(false);
    revisionRef.current += 1;
    setPlanRevision(revisionRef.current);
    setParseVersion((v) => v + 1);
    setStatsVersion((v) => v + 1);
  }, [setEdit, setSelection]);

  const markFilesTouched = useCallback((fileIds: Iterable<string>) => {
    for (const id of fileIds) if (parsesRef.current.has(id)) touchedRef.current.add(id);
  }, []);

  const markAllFilesTouched = useCallback(() => {
    for (const id of parsesRef.current.keys()) touchedRef.current.add(id);
  }, []);

  const getPlanRevision = useCallback(() => revisionRef.current, []);

  /** Every CSV parse in upload order, minus deleted points (the original parses are not copied unless edited). */
  const getEffectiveParses = useCallback((): LocalPointCsvResult[] => {
    const out: LocalPointCsvResult[] = [];
    for (const [fileId, parse] of parsesRef.current) {
      if (deletedIdsFor(editRef.current, fileId).size === 0 && !isFileReversed(editRef.current, fileId)) {
        out.push(parse);
        continue;
      }
      const kept = remainingPointsInDriveOrder(parse, fileId, editRef.current);
      out.push({ ...parse, points: kept, num_points: kept.length });
    }
    return out;
  }, []);

  // A mission started elsewhere closes edit mode so the map can't be edited mid-run.
  useEffect(() => {
    if (!params.planLocked || !editModeRef.current) return;
    editModeRef.current = false;
    rangeStartRef.current = null;
    setEditModeInner(false);
    setRangeModeInner(false);
    setSelection(EMPTY_SELECTION);
  }, [params.planLocked, setSelection]);

  return {
    editMode,
    setEditMode,
    rangeMode,
    toggleRangeMode,
    points,
    selection,
    selectedCount: selection.size,
    onPointPress,
    clearSelection,
    deleteSelected,
    undo,
    redo,
    restoreAll,
    reversePlan,
    reversed: summaries.some((s) => isFileReversed(edit, s.fileId)),
    defaultExportName: defaultExportBaseName(summaries.map((s) => s.fileName)),
    exportCsv,
    canUndo: edit.undo.length > 0 && !params.planLocked && !busy,
    canRedo: edit.redo.length > 0 && !params.planLocked && !busy,
    deletedCount: totalDeletedCount(edit),
    summaries,
    remainingTotal,
    planRevision,
    getPlanRevision,
    pathOrderResetToken,
    pathOrderReverseToken,
    hasCsv: summaries.length > 0,
    busy,
    fitCache: fitCacheRef.current,
    registerParse,
    removeFile,
    reset,
    markFilesTouched,
    markAllFilesTouched,
    getEffectiveParses,
  };
}
