/**
 * End to end for "Set anchor": the same function the app runs on Confirm (reanchorTargetLines), then
 * the path order the Path Order step ends up with, then the trajectory that Send builds from it.
 * The contract: the painted mission starts at the anchor the operator tapped.
 */
import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { reanchorTargetLines } from "./anchorReorder";
import {
  buildOrderedTrajectory,
  defaultPathOrder,
  reseedPathOrder,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
  type CsvPathOrderEntry,
} from "./missionPathOrder";

const OPTS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

function csvLine(id: string, points: { north: number; east: number }[]): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: points[0].north, y: points[0].east },
    to: { id: 2, x: points[points.length - 1].north, y: points[points.length - 1].east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: { closed: false, road_marking: true, vertexCount: points.length, corners: [] },
      preview_points: points,
    },
  } as PlanLine;
}

function dxfLine(id: string, a: [number, number], b: [number, number]): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: a[0], y: a[1] },
    to: { id: 2, x: b[0], y: b[1] },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: {},
      preview_points: [
        { north: a[0], east: a[1] },
        { north: b[0], east: b[1] },
      ],
    },
  } as PlanLine;
}

const straight = (east: number) =>
  Array.from({ length: 11 }, (_, i) => ({ north: i, east }));

/** What the Path Order step did BEFORE the fix: keep old entries, append unknown ids at the end. */
function legacyStepSync(prev: CsvPathOrderEntry[], marks: PlanLine[]): CsvPathOrderEntry[] {
  const ids = new Set(marks.map((l) => l.id));
  const kept = prev.filter((e) => ids.has(e.lineId));
  const have = new Set(kept.map((e) => e.lineId));
  return [...kept, ...marks.filter((l) => !have.has(l.id)).map((l) => ({ lineId: l.id, label: l.label, paint: true }))];
}

/** First point of the first painted (spray-on) run — where the rover starts marking. */
function firstMarkPoint(lines: PlanLine[], order: CsvPathOrderEntry[]) {
  const { runs } = buildOrderedTrajectory(lines, order, OPTS);
  const run = runs.find((r) => r.kind === "mark");
  return run ? run.points[0] : null;
}

describe("anchor -> path order -> mission start", () => {
  it("CSV: a mid-path anchor becomes the first marked point; the old step order did not", () => {
    const a = csvLine("pathA", straight(0));
    const b = csvLine("pathB", straight(5));
    const lines = [a, b];
    const staleOrder = defaultPathOrder(selectMarkPlanLines(lines)); // what the step held

    const res = reanchorTargetLines(lines, { lineId: "pathA", north: 3, east: 0, kind: "csv" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const newLines = res.chained;
    const marks = selectMarkPlanLines(newLines);

    // Before the fix: pathB (not the anchored path) would be painted first.
    const legacy = legacyStepSync(staleOrder, marks);
    expect(resolveOrderedPaintedLines(marks, legacy)[0].id).toBe("pathB");

    // After the fix: reseeded order starts at the anchor.
    const order = reseedPathOrder(staleOrder, marks);
    expect(firstMarkPoint(newLines, order)).toEqual([3, 0]);
  });

  it("CSV: anchoring at the path's own end reverses it so the end is the start", () => {
    const lines = [csvLine("pathA", straight(0))];
    const res = reanchorTargetLines(lines, { lineId: "pathA", north: 10, east: 0, kind: "csv" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const marks = selectMarkPlanLines(res.chained);
    const order = reseedPathOrder(defaultPathOrder(selectMarkPlanLines(lines)), marks);
    expect(firstMarkPoint(res.chained, order)).toEqual([10, 0]);
  });

  it("DXF: tapping the far end of a line starts there; the near end starts at the other end", () => {
    const square = [
      dxfLine("bottom", [0, 0], [0, 2]),
      dxfLine("right", [0, 2], [2, 2]),
      dxfLine("top", [2, 2], [2, 0]),
      dxfLine("left", [2, 0], [0, 0]),
    ];
    const stale = defaultPathOrder(selectMarkPlanLines(square));
    const start = (north: number, east: number) => {
      const res = reanchorTargetLines(square, { lineId: "top", north, east, kind: "dxf" });
      expect(res.ok).toBe(true);
      if (!res.ok) return null;
      const marks = selectMarkPlanLines(res.chained);
      return firstMarkPoint(res.chained, reseedPathOrder(stale, marks));
    };
    expect(start(2, 2)).toEqual([2, 2]); // `from` end of "top"
    expect(start(2, 0)).toEqual([2, 0]); // `to` end of "top" (used to behave like the line above)
  });

  it("keeps a path the operator skipped skipped", () => {
    const lines = [csvLine("pathA", straight(0)), csvLine("pathB", straight(5))];
    const stale = defaultPathOrder(selectMarkPlanLines(lines)).map((e) =>
      e.lineId === "pathB" ? { ...e, paint: false } : e
    );
    const res = reanchorTargetLines(lines, { lineId: "pathA", north: 3, east: 0, kind: "csv" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const order = reseedPathOrder(stale, selectMarkPlanLines(res.chained));
    const painted = resolveOrderedPaintedLines(selectMarkPlanLines(res.chained), order).map((l) => l.id);
    expect(painted).not.toContain("pathB");
  });

  it("fails cleanly (no change) for a missing seed or a line with no geometry", () => {
    const lines = [csvLine("pathA", straight(0))];
    expect(reanchorTargetLines(lines, { lineId: "nope", north: 1, east: 0, kind: "csv" })).toEqual({
      ok: false,
      reason: "seed-missing",
    });
    const bare = [{ ...lines[0], entity: undefined } as PlanLine];
    expect(reanchorTargetLines(bare, { lineId: "pathA", north: 1, east: 0, kind: "csv" })).toEqual({
      ok: false,
      reason: "no-geometry",
    });
  });
});
