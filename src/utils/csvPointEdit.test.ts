import { describe, expect, it } from "vitest";
import {
  CSV_EDIT_HISTORY_CAP,
  EMPTY_CSV_EDIT_STATE,
  applyCsvDelete,
  applyCsvRedo,
  applyCsvRestoreAll,
  applyCsvUndo,
  coincidentSelection,
  csvPointId,
  deletedIdsFor,
  listEditablePoints,
  pruneCsvEditFile,
  pruneSelection,
  selectRange,
  selectionToParts,
  toggleSelection,
  totalDeletedCount,
  type CsvEditState,
} from "./csvPointEdit";
import { parseLocalPointCsv } from "./localPointCsv";

function nedCsv(rows: number, opts: { skipRow?: number } = {}): string {
  const out = ["north,east"];
  for (let i = 0; i < rows; i++) {
    // "bad" row keeps its row number even though it is skipped by the parser.
    out.push(opts.skipRow === i + 2 ? "oops,east" : `${i * 2},${i % 3}`);
  }
  return out.join("\n");
}

const A = "a-csv";
const B = "b-csv";

const ids = (fileId: string, ...rows: number[]) => rows.map((r) => `${fileId}:${r}`);

function del(state: CsvEditState, fileId: string, rowIds: string[]): CsvEditState {
  return applyCsvDelete(state, [{ fileId, ids: rowIds }]).state;
}

describe("point ids", () => {
  it("use the CSV row number and count skipped rows", () => {
    const parse = parseLocalPointCsv(nedCsv(5, { skipRow: 3 }), "a.csv");
    // header is row 1, so data rows are 2..6; row 3 was skipped.
    expect(parse.points.map((p) => csvPointId(A, p))).toEqual(ids(A, 2, 4, 5, 6));
  });

  it("do not change when another file is added", () => {
    const a = parseLocalPointCsv(nedCsv(4), "a.csv");
    const before = listEditablePoints([{ fileId: A, parse: a }], EMPTY_CSV_EDIT_STATE).map((p) => p.id);
    const b = parseLocalPointCsv(nedCsv(4), "b.csv");
    const after = listEditablePoints(
      [
        { fileId: A, parse: a },
        { fileId: B, parse: b },
      ],
      EMPTY_CSV_EDIT_STATE
    )
      .filter((p) => p.fileId === A)
      .map((p) => p.id);
    expect(after).toEqual(before);
  });
});

describe("delete / undo / redo", () => {
  it("round-trips deleted ids", () => {
    let s = EMPTY_CSV_EDIT_STATE;
    s = del(s, A, ids(A, 2, 3));
    expect([...deletedIdsFor(s, A)].sort()).toEqual(ids(A, 2, 3));
    const undone = applyCsvUndo(s);
    expect(undone.change).toEqual({ effect: "restored", parts: [{ fileId: A, ids: ids(A, 2, 3) }] });
    expect(totalDeletedCount(undone.state)).toBe(0);
    const redone = applyCsvRedo(undone.state);
    expect(redone.change?.effect).toBe("deleted");
    expect([...deletedIdsFor(redone.state, A)].sort()).toEqual(ids(A, 2, 3));
  });

  it("ignores ids that are already deleted and reports no change", () => {
    const s = del(EMPTY_CSV_EDIT_STATE, A, ids(A, 2));
    const again = applyCsvDelete(s, [{ fileId: A, ids: ids(A, 2) }]);
    expect(again.change).toBeNull();
    expect(again.state).toBe(s);
    expect(again.state.undo).toHaveLength(1);
  });

  it("a new delete clears redo", () => {
    let s = del(EMPTY_CSV_EDIT_STATE, A, ids(A, 2));
    s = applyCsvUndo(s).state;
    expect(s.redo).toHaveLength(1);
    s = del(s, A, ids(A, 5));
    expect(s.redo).toHaveLength(0);
    expect(applyCsvRedo(s).change).toBeNull();
  });

  it("undo / redo on empty stacks are no-ops", () => {
    expect(applyCsvUndo(EMPTY_CSV_EDIT_STATE).change).toBeNull();
    expect(applyCsvRedo(EMPTY_CSV_EDIT_STATE).change).toBeNull();
  });

  it(`keeps only the last ${CSV_EDIT_HISTORY_CAP} actions (the 51st drops the oldest)`, () => {
    let s = EMPTY_CSV_EDIT_STATE;
    for (let i = 0; i < CSV_EDIT_HISTORY_CAP + 1; i++) s = del(s, A, ids(A, i + 2));
    expect(s.undo).toHaveLength(CSV_EDIT_HISTORY_CAP);
    // Undo everything we can: the very first deletion (row 2) is no longer undoable.
    for (let i = 0; i < CSV_EDIT_HISTORY_CAP; i++) s = applyCsvUndo(s).state;
    expect([...deletedIdsFor(s, A)]).toEqual(ids(A, 2));
    expect(applyCsvUndo(s).change).toBeNull();
  });

  it("restore all is one undoable action across files", () => {
    let s = EMPTY_CSV_EDIT_STATE;
    s = del(s, A, ids(A, 2, 3));
    s = del(s, B, ids(B, 4));
    const restored = applyCsvRestoreAll(s);
    expect(totalDeletedCount(restored.state)).toBe(0);
    expect(restored.change?.parts.map((p) => p.fileId).sort()).toEqual([A, B]);
    const undone = applyCsvUndo(restored.state);
    expect(totalDeletedCount(undone.state)).toBe(3);
    expect(applyCsvRestoreAll(EMPTY_CSV_EDIT_STATE).change).toBeNull();
  });

  it("restore all can be limited to one file", () => {
    let s = del(EMPTY_CSV_EDIT_STATE, A, ids(A, 2));
    s = del(s, B, ids(B, 2));
    const r = applyCsvRestoreAll(s, A);
    expect(deletedIdsFor(r.state, A).size).toBe(0);
    expect(deletedIdsFor(r.state, B).size).toBe(1);
  });

  it("one action spanning two files undoes together", () => {
    const s = applyCsvDelete(EMPTY_CSV_EDIT_STATE, [
      { fileId: A, ids: ids(A, 2) },
      { fileId: B, ids: ids(B, 3) },
    ]).state;
    expect(s.undo).toHaveLength(1);
    expect(totalDeletedCount(applyCsvUndo(s).state)).toBe(0);
  });
});

describe("pruneCsvEditFile", () => {
  it("drops one file's edits and history but keeps the other's undo", () => {
    let s = del(EMPTY_CSV_EDIT_STATE, A, ids(A, 2));
    s = del(s, B, ids(B, 3));
    const pruned = pruneCsvEditFile(s, A);
    expect(deletedIdsFor(pruned, A).size).toBe(0);
    expect(deletedIdsFor(pruned, B).size).toBe(1);
    expect(pruned.undo).toHaveLength(1);
    const undone = applyCsvUndo(pruned);
    expect(undone.change?.parts[0].fileId).toBe(B);
  });

  it("returns the same state for an unknown file", () => {
    const s = del(EMPTY_CSV_EDIT_STATE, A, ids(A, 2));
    expect(pruneCsvEditFile(s, "nope")).toBe(s);
  });
});

describe("selection", () => {
  const a = parseLocalPointCsv(["north,east", "0,0", "0,0", "5,0", "10,0", "15,0"].join("\n"), "a.csv");
  const points = listEditablePoints([{ fileId: A, parse: a }], EMPTY_CSV_EDIT_STATE);

  it("a tap on stacked duplicates selects all of them", () => {
    expect(coincidentSelection(points, `${A}:2`).sort()).toEqual(ids(A, 2, 3));
    expect(coincidentSelection(points, `${A}:4`)).toEqual(ids(A, 4));
  });

  it("ignores deleted points and unknown ids", () => {
    const withDeleted = listEditablePoints([{ fileId: A, parse: a }], del(EMPTY_CSV_EDIT_STATE, A, ids(A, 3)));
    expect(coincidentSelection(withDeleted, `${A}:2`)).toEqual(ids(A, 2));
    expect(coincidentSelection(withDeleted, `${A}:3`)).toEqual([]);
    expect(coincidentSelection(withDeleted, "zzz")).toEqual([]);
  });

  it("toggle adds then removes", () => {
    const one = toggleSelection(new Set(), ids(A, 4));
    expect([...one]).toEqual(ids(A, 4));
    expect(toggleSelection(one, ids(A, 4)).size).toBe(0);
    expect(toggleSelection(one, ids(A, 4, 5)).size).toBe(2);
  });

  it("range selects the remaining points between two taps, either direction", () => {
    expect(selectRange(points, `${A}:4`, `${A}:6`)).toEqual(ids(A, 4, 5, 6));
    expect(selectRange(points, `${A}:6`, `${A}:4`)).toEqual(ids(A, 4, 5, 6));
    const withDeleted = listEditablePoints([{ fileId: A, parse: a }], del(EMPTY_CSV_EDIT_STATE, A, ids(A, 5)));
    expect(selectRange(withDeleted, `${A}:4`, `${A}:6`)).toEqual(ids(A, 4, 6));
  });

  it("range across two files is refused", () => {
    const b = parseLocalPointCsv(["north,east", "1,1", "2,2"].join("\n"), "b.csv");
    const both = listEditablePoints(
      [
        { fileId: A, parse: a },
        { fileId: B, parse: b },
      ],
      EMPTY_CSV_EDIT_STATE
    );
    expect(selectRange(both, `${A}:2`, `${B}:2`)).toBeNull();
  });

  it("prunes ids that were deleted or no longer exist", () => {
    const sel = new Set([...ids(A, 2, 3), `${A}:99`]);
    const after = listEditablePoints([{ fileId: A, parse: a }], del(EMPTY_CSV_EDIT_STATE, A, ids(A, 2)));
    expect([...pruneSelection(sel, after)]).toEqual(ids(A, 3));
    expect(pruneSelection(new Set(ids(A, 3)), after)).toEqual(new Set(ids(A, 3)));
  });

  it("groups a selection across two files into one delete action", () => {
    const b = parseLocalPointCsv(["north,east", "1,1", "2,2"].join("\n"), "b.csv");
    const both = listEditablePoints(
      [
        { fileId: A, parse: a },
        { fileId: B, parse: b },
      ],
      EMPTY_CSV_EDIT_STATE
    );
    const parts = selectionToParts(new Set([...ids(A, 2), ...ids(B, 3)]), both);
    expect(parts).toEqual([
      { fileId: A, ids: ids(A, 2) },
      { fileId: B, ids: ids(B, 3) },
    ]);
    const s = applyCsvDelete(EMPTY_CSV_EDIT_STATE, parts).state;
    expect(s.undo).toHaveLength(1);
    expect(totalDeletedCount(s)).toBe(2);
  });
});
