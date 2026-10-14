import { describe, expect, it } from "vitest";
import { buildCsvFileLines } from "./csvFileLines";
import { csvPointId } from "./csvPointEdit";
import { prefixDxfLineIds } from "./dxfLocalImport";
import {
  buildCsvTransitLines,
  localCsvPointsToPlanLines,
  parseLocalPointCsv,
} from "./localPointCsv";
import { chainMarkLinesByGeometry } from "./missionPathOrder";
import { rebasePlanLinesToOrigin } from "./planOriginRebase";

const F = "survey-csv";
const STEP = 0.00002; // ~2.2 m of latitude

/** GPS survey with a `road` column: road A (12 pts), road B (10 pts), road C (2 pts). */
function gpsCsv(lat0 = 13.0, lon0 = 80.0, rows?: number[]): string {
  const all: { road: string; lat: number; lon: number; row: number }[] = [];
  let row = 2; // header is row 1
  const add = (road: string, n: number, dLat: number, dLon: number, startLat: number, startLon: number) => {
    for (let i = 0; i < n; i++) {
      all.push({ road, lat: startLat + i * dLat, lon: startLon + i * dLon, row: row++ });
    }
  };
  add("A", 12, STEP, 0, lat0, lon0);
  add("B", 10, 0, STEP, lat0 + 0.001, lon0);
  add("C", 2, STEP, STEP, lat0 + 0.002, lon0);
  const kept = rows ? all.filter((r) => rows.includes(r.row)) : all;
  return ["lat,lon,road", ...kept.map((r) => `${r.lat.toFixed(8)},${r.lon.toFixed(8)},${r.road}`)].join("\n");
}

const ALL_ROWS = Array.from({ length: 24 }, (_, i) => i + 2);
const rowIds = (...rows: number[]) => new Set(rows.map((r) => `${F}:${r}`));

/** The pre-refactor inline pipeline from App.handleLocalCsvParsed (GPS branch). */
function legacyUploadLines(
  parse: ReturnType<typeof parseLocalPointCsv>,
  prefix: string,
  shared: { lat: number; lon: number } | null
) {
  const preview = chainMarkLinesByGeometry(localCsvPointsToPlanLines(parse.points, parse.anchor));
  const raw = [...preview, ...buildCsvTransitLines(preview)];
  const rebased = shared ? rebasePlanLinesToOrigin(raw, parse.anchor!, shared) : raw;
  return prefixDxfLineIds(rebased, prefix);
}

describe("buildCsvFileLines — golden equivalence with the old upload path", () => {
  const parse = parseLocalPointCsv(gpsCsv(), "survey.csv");

  it("no deleted ids ⇒ identical to the legacy inline pipeline (establishing origin)", () => {
    const built = buildCsvFileLines({ parse, fileId: F, prefix: "survey", sharedOrigin: null });
    expect(built.lines).toEqual(legacyUploadLines(parse, "survey", null));
    expect(built.deletedCount).toBe(0);
    expect(built.remainingCount).toBe(24);
  });

  it("identical when rebasing onto an existing shared origin", () => {
    const shared = { lat: 13.01, lon: 80.01 };
    const built = buildCsvFileLines({ parse, fileId: F, prefix: "survey", sharedOrigin: shared });
    expect(built.lines).toEqual(legacyUploadLines(parse, "survey", shared));
  });

  it("shared origin equal to the file's own anchor skips the (float-lossy) rebase", () => {
    const built = buildCsvFileLines({ parse, fileId: F, prefix: "survey", sharedOrigin: { ...parse.anchor! } });
    expect(built.lines).toEqual(legacyUploadLines(parse, "survey", null));
  });

  it("standalone local-NED flow stays unprefixed", () => {
    const ned = parseLocalPointCsv(
      ["north,east,road", ...Array.from({ length: 6 }, (_, i) => `${i * 2},0,A`)].join("\n"),
      "n.csv"
    );
    const built = buildCsvFileLines({ parse: ned, fileId: "n-csv", prefix: null });
    expect(built.lines.length).toBeGreaterThan(0);
    expect(built.lines.every((l) => !l.id.includes("__"))).toBe(true);
  });
});

describe("buildCsvFileLines — edited ≡ CSV physically lacking those rows", () => {
  const parse = parseLocalPointCsv(gpsCsv(), "survey.csv");
  const removed = [5, 6, 17];

  it("same anchor, same geometry (rows removed from the middle)", () => {
    const edited = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(...removed), prefix: "survey" });
    const physical = parseLocalPointCsv(
      gpsCsv(13.0, 80.0, ALL_ROWS.filter((r) => !removed.includes(r))),
      "survey.csv"
    );
    expect(physical.anchor).toEqual(parse.anchor);
    const reference = buildCsvFileLines({ parse: physical, fileId: F, prefix: "survey" });
    expect(edited.lines).toEqual(reference.lines);
    expect(edited.remainingCount).toBe(21);
    expect(edited.deletedCount).toBe(3);
  });

  it("delete → undo (empty set) → delete again is deterministic", () => {
    const a = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5), prefix: "survey" });
    const restored = buildCsvFileLines({ parse, fileId: F, deletedIds: new Set(), prefix: "survey" });
    const b = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5), prefix: "survey" });
    expect(b.lines).toEqual(a.lines);
    expect(restored.lines).toEqual(legacyUploadLines(parse, "survey", null));
  });
});

describe("buildCsvFileLines — anchor is frozen", () => {
  const parse = parseLocalPointCsv(gpsCsv(), "survey.csv");

  it("deleting row 1 does not move the anchor or the surviving geometry", () => {
    const firstRow = parse.points[0];
    expect(csvPointId(F, firstRow)).toBe(`${F}:2`);
    const full = buildCsvFileLines({ parse, fileId: F, prefix: "survey" });
    const cut = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(2), prefix: "survey" });

    // The parse (and its anchor) is the very same object — nothing re-derived.
    expect(parse.anchor).toEqual({ lat: 13.0, lon: 80.0 });

    // Road A's second row is now the first vertex, still at its ORIGINAL position (≈ +2.2 m N),
    // not re-zeroed to (0,0) as a re-parsed shorter file would be.
    const fullA = full.lines.find((l) => l.layer === "marking")!;
    const cutA = cut.lines.find((l) => l.layer === "marking")!;
    const fullPts = fullA.entity!.preview_points!;
    const cutPts = cutA.entity!.preview_points!;
    expect(Math.abs(fullPts[0].north)).toBeLessThan(1e-6);
    expect(cutPts[0].north).toBeGreaterThan(1.5);
    expect(cutPts[0].north).toBeCloseTo(fullPts[1].north, 1);
  });
});

describe("buildCsvFileLines — group and connector rules", () => {
  const parse = parseLocalPointCsv(gpsCsv(), "survey.csv");

  it("reports a group left with < 2 points as points-only (not silently dropped)", () => {
    const base = buildCsvFileLines({ parse, fileId: F, prefix: "survey" });
    expect(base.pathCount).toBe(3);
    expect(base.pointsOnlyGroups).toBe(0);
    // Road C = rows 24, 25. Delete one ⇒ a single point cannot form a path.
    const edited = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(25), prefix: "survey" });
    expect(edited.pathCount).toBe(2);
    expect(edited.pointsOnlyGroups).toBe(1);
  });

  it("deleting a whole group removes its path and its transit connectors", () => {
    const base = buildCsvFileLines({ parse, fileId: F, prefix: "survey" });
    const roadB = Array.from({ length: 10 }, (_, i) => 14 + i);
    const edited = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(...roadB), prefix: "survey" });
    expect(edited.pathCount).toBe(2);
    expect(edited.pointsOnlyGroups).toBe(0);
    const marks = edited.lines.filter((l) => l.layer === "marking");
    const transit = edited.lines.filter((l) => l.layer === "transit");
    expect(marks).toHaveLength(2);
    expect(transit.length).toBeLessThanOrEqual(1);
    expect(base.lines.filter((l) => l.layer === "transit").length).toBeGreaterThan(transit.length);
    // Every connector still joins two surviving paths.
    for (const t of transit) {
      const ends = marks.flatMap((m) => [m.from, m.to]);
      expect(ends.some((e) => e && e.x === t.from!.x && e.y === t.from!.y)).toBe(true);
      expect(ends.some((e) => e && e.x === t.to!.x && e.y === t.to!.y)).toBe(true);
    }
  });

  it("deleting every point yields no lines and says so", () => {
    const edited = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(...ALL_ROWS), prefix: "survey" });
    expect(edited.lines).toEqual([]);
    expect(edited.remainingCount).toBe(0);
    expect(edited.deletedCount).toBe(24);
    expect(edited.pathCount).toBe(0);
    expect(edited.pointsOnlyGroups).toBe(0);
  });

  it("a path whose closing duplicate is deleted stays open", () => {
    const loop = parseLocalPointCsv(
      ["north,east", "0,0", "0,10", "10,10", "10,0", "0,0"].join("\n"),
      "loop.csv"
    );
    const full = buildCsvFileLines({ parse: loop, fileId: "loop-csv", prefix: null });
    const cut = buildCsvFileLines({ parse: loop, fileId: "loop-csv", deletedIds: new Set(["loop-csv:6"]), prefix: null });
    for (const r of [full, cut]) {
      const line = r.lines.find((l) => l.layer === "marking");
      expect(line?.entity?.geometry?.closed).toBe(false);
    }
    // First point deleted instead.
    const cutFirst = buildCsvFileLines({ parse: loop, fileId: "loop-csv", deletedIds: new Set(["loop-csv:2"]), prefix: null });
    expect(cutFirst.lines.find((l) => l.layer === "marking")?.entity?.geometry?.closed).toBe(false);
  });
});

describe("buildCsvFileLines — multi-file isolation", () => {
  it("deleting in file A leaves file B's lines byte-identical", () => {
    const a = parseLocalPointCsv(gpsCsv(13.0, 80.0), "a.csv");
    const b = parseLocalPointCsv(gpsCsv(13.01, 80.01), "b.csv");
    const shared = a.anchor!;
    const bBefore = buildCsvFileLines({ parse: b, fileId: "b-csv", prefix: "b", sharedOrigin: shared });
    buildCsvFileLines({ parse: a, fileId: "a-csv", deletedIds: new Set(["a-csv:5", "a-csv:6"]), prefix: "a", sharedOrigin: shared });
    const bAfter = buildCsvFileLines({ parse: b, fileId: "b-csv", prefix: "b", sharedOrigin: shared });
    expect(bAfter.lines).toEqual(bBefore.lines);
  });
});

describe("buildCsvFileLines — fit memo", () => {
  const parse = parseLocalPointCsv(gpsCsv(), "survey.csv");

  it("gives byte-identical lines with or without the memo", () => {
    const plain = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5, 17), prefix: "survey" });
    const cache = new Map();
    const memo1 = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5, 17), prefix: "survey", fitCache: cache });
    const memo2 = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5, 17), prefix: "survey", fitCache: cache });
    expect(memo1.lines).toEqual(plain.lines);
    expect(memo2.lines).toEqual(plain.lines);
  });

  it("an edit only adds entries for the groups it changed", () => {
    const cache = new Map();
    buildCsvFileLines({ parse, fileId: F, prefix: "survey", fitCache: cache });
    const afterUpload = cache.size; // roads A, B, C
    expect(afterUpload).toBe(3);
    // Delete a point of road A only: B and C are hits, A is one new entry.
    buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5), prefix: "survey", fitCache: cache });
    expect(cache.size).toBe(afterUpload + 1);
    // Undo (nothing deleted) reuses the original entries — no refit at all.
    buildCsvFileLines({ parse, fileId: F, prefix: "survey", fitCache: cache });
    expect(cache.size).toBe(afterUpload + 1);
  });

  it("never reuses a fit across different geometry", () => {
    const cache = new Map();
    const a = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(5), prefix: "survey", fitCache: cache });
    const b = buildCsvFileLines({ parse, fileId: F, deletedIds: rowIds(6), prefix: "survey", fitCache: cache });
    expect(a.lines).not.toEqual(b.lines);
  });
});

describe("buildCsvFileLines — performance gate", () => {
  it("rebuilds a 5,000-point file well inside a UI-friendly budget", () => {
    const rows = ["north,east,road"];
    for (let i = 0; i < 5000; i++) rows.push(`${i * 0.5},${Math.sin(i / 40) * 3},R${Math.floor(i / 500)}`);
    const parse = parseLocalPointCsv(rows.join("\n"), "big.csv");
    const deleted = new Set<string>();
    for (let i = 100; i < 130; i++) deleted.add(`big-csv:${i}`);
    const t0 = Date.now();
    const r = buildCsvFileLines({ parse, fileId: "big-csv", deletedIds: deleted, prefix: null });
    const ms = Date.now() - t0;
    expect(r.remainingCount).toBe(5000 - 30);
    // Generous CI bound; the real number is logged for the plan's perf gate (Phase 6).
    console.log(`[csvFileLines perf] 5k pts rebuild: ${ms} ms`);
    expect(ms).toBeLessThan(15_000);
  });
});
