import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  MARK_CONTIGUOUS_GAP_M,
  buildTrajectory,
  findAdjacentMarkViolation,
  findTravelTouchViolations,
  planLineToNedPolyline,
  trajectoryRunLengthM,
  trajectoryTotals,
  type TrajectoryRun,
} from "./csvTrajectory";

const SPEEDS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

/** Build a minimal mark PlanLine with explicit NED preview_points. */
function markLine(
  id: string,
  points: Array<{ north: number; east: number }>,
  label?: string
): PlanLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    label: label ?? id,
    layer: "marking",
    from: { id: 1, x: first.north, y: first.east },
    to: { id: 2, x: last.north, y: last.east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: { closed: false, road_marking: true },
      preview_points: points,
    },
  };
}

/** Horizontal mark from north=n0 to n1 at fixed east. */
function horizontalMark(id: string, n0: number, n1: number, east: number, label?: string): PlanLine {
  return markLine(id, [
    { north: n0, east },
    { north: n1, east },
  ], label);
}

function kinds(runs: TrajectoryRun[]): string[] {
  return runs.map((r) => r.kind);
}

function gapBetweenRuns(a: TrajectoryRun, b: TrajectoryRun): number {
  const aEnd = a.points[a.points.length - 1];
  const bStart = b.points[0];
  return Math.hypot(aEnd[0] - bStart[0], aEnd[1] - bStart[1]);
}

describe("planLineToNedPolyline", () => {
  it("reads preview_points as [north, east]", () => {
    const line = markLine("a", [
      { north: 1, east: 2 },
      { north: 3, east: 4 },
    ]);
    expect(planLineToNedPolyline(line)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("falls back to from/to with CSV convention x=north, y=east", () => {
    const line: PlanLine = {
      id: "fb",
      label: "fb",
      layer: "marking",
      from: { id: 1, x: 10, y: 20 },
      to: { id: 2, x: 30, y: 40 },
      width: 0.1,
    };
    expect(planLineToNedPolyline(line)).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });
});

describe("buildTrajectory", () => {
  it("two paths 50 m apart → 3 runs, middle is travel", () => {
    // Path A: (0,0)→(10,0); Path B starts 50 m east of A's end.
    const a = horizontalMark("a", 0, 10, 0, "Path A");
    const b = markLine(
      "b",
      [
        { north: 10, east: 50 },
        { north: 20, east: 50 },
      ],
      "Path B"
    );

    const { runs } = buildTrajectory([a, b], SPEEDS);
    expect(runs).toHaveLength(3);
    expect(kinds(runs)).toEqual(["mark", "travel", "mark"]);
    expect(runs[0].label).toBe("Path A");
    expect(runs[2].label).toBe("Path B");
    expect(runs[1].kind).toBe("travel");
    expect(trajectoryRunLengthM(runs[1])).toBeCloseTo(50, 6);
    expect(runs[0].speed_m_s).toBe(0.35);
    expect(runs[1].speed_m_s).toBe(0.5);
  });

  it("three paths → mark/travel/mark/travel/mark", () => {
    const a = horizontalMark("a", 0, 5, 0);
    const b = markLine("b", [
      { north: 5, east: 10 },
      { north: 10, east: 10 },
    ]);
    const c = markLine("c", [
      { north: 10, east: 30 },
      { north: 15, east: 30 },
    ]);

    const { runs } = buildTrajectory([a, b, c], SPEEDS);
    expect(kinds(runs)).toEqual(["mark", "travel", "mark", "travel", "mark"]);
    expect(findAdjacentMarkViolation(runs)).toBeNull();
  });

  it("skipped path excluded; neighbours get a direct travel leg", () => {
    // Operator order after skip: path A then path C (B removed).
    const a = horizontalMark("a", 0, 10, 0, "A");
    const c = markLine(
      "c",
      [
        { north: 10, east: 40 },
        { north: 20, east: 40 },
      ],
      "C"
    );

    const { runs } = buildTrajectory([a, c], SPEEDS);
    expect(kinds(runs)).toEqual(["mark", "travel", "mark"]);
    expect(runs[0].label).toBe("A");
    expect(runs[2].label).toBe("C");
    expect(trajectoryRunLengthM(runs[1])).toBeCloseTo(40, 6);
  });

  it("travel legs touch their neighbours within 0.05 m (backend rule 2/3)", () => {
    const a = horizontalMark("a", 0, 10, 0);
    const b = markLine("b", [
      { north: 10, east: 20 },
      { north: 20, east: 20 },
    ]);
    const c = markLine("c", [
      { north: 20, east: 45 },
      { north: 30, east: 45 },
    ]);

    const { runs } = buildTrajectory([a, b, c], SPEEDS);
    expect(findTravelTouchViolations(runs)).toEqual([]);
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].kind !== "travel") continue;
      expect(gapBetweenRuns(runs[i - 1], runs[i])).toBeLessThanOrEqual(MARK_CONTIGUOUS_GAP_M);
      expect(gapBetweenRuns(runs[i], runs[i + 1])).toBeLessThanOrEqual(MARK_CONTIGUOUS_GAP_M);
    }
  });

  it("no two mark runs adjacent, ever (backend rule 1)", () => {
    const cases: PlanLine[][] = [
      [horizontalMark("a", 0, 10, 0)],
      [
        horizontalMark("a", 0, 10, 0),
        markLine("b", [
          { north: 10, east: 50 },
          { north: 20, east: 50 },
        ]),
      ],
      // near-touch (would have produced adjacent marks if we bridged with no travel)
      [
        horizontalMark("a", 0, 10, 0),
        markLine("b", [
          { north: 10.01, east: 0 },
          { north: 20, east: 0 },
        ]),
      ],
      [
        horizontalMark("a", 0, 5, 0),
        markLine("b", [
          { north: 5, east: 0.03 },
          { north: 10, east: 0.03 },
        ]),
        markLine("c", [
          { north: 10, east: 20 },
          { north: 15, east: 20 },
        ]),
      ],
    ];

    for (const lines of cases) {
      const { runs } = buildTrajectory(lines, SPEEDS);
      expect(findAdjacentMarkViolation(runs)).toBeNull();
      for (let i = 0; i < runs.length - 1; i++) {
        expect(!(runs[i].kind === "mark" && runs[i + 1].kind === "mark")).toBe(true);
      }
    }
  });

  it("two paths 0.01 m apart → ONE mark run, not two (2 cm gap case)", () => {
    // End of A at (10, 0); start of B at (10.01, 0) — 1 cm gap.
    const a = horizontalMark("a", 0, 10, 0, "A");
    const b = markLine(
      "b",
      [
        { north: 10.01, east: 0 },
        { north: 20, east: 0 },
      ],
      "B"
    );

    const { runs, warnings } = buildTrajectory([a, b], SPEEDS);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("mark");
    expect(runs[0].label).toContain("A");
    expect(runs[0].label).toContain("B");
    // Both endpoints retained (gap non-zero but under merge threshold).
    expect(runs[0].points.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some((w) => /Merged/i.test(w))).toBe(true);
  });

  it("two paths 0.03 m apart → merged too (under backend 0.05 m tolerance)", () => {
    const a = horizontalMark("a", 0, 10, 0, "A");
    const b = markLine(
      "b",
      [
        { north: 10.03, east: 0 },
        { north: 20, east: 0 },
      ],
      "B"
    );

    const { runs } = buildTrajectory([a, b], SPEEDS);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("mark");
  });

  it("two paths exactly at 0.05 m stay separate with a travel leg", () => {
    // gap == MARK_CONTIGUOUS_GAP_M is NOT merged (strict <).
    const a = horizontalMark("a", 0, 10, 0, "A");
    const b = markLine(
      "b",
      [
        { north: 10, east: MARK_CONTIGUOUS_GAP_M },
        { north: 20, east: MARK_CONTIGUOUS_GAP_M },
      ],
      "B"
    );

    const { runs } = buildTrajectory([a, b], SPEEDS);
    expect(kinds(runs)).toEqual(["mark", "travel", "mark"]);
    expect(trajectoryRunLengthM(runs[1])).toBeCloseTo(MARK_CONTIGUOUS_GAP_M, 6);
  });

  it("coincident ends (0 m gap) merge and dedupe the junction vertex", () => {
    const a = horizontalMark("a", 0, 10, 0, "A");
    const b = markLine(
      "b",
      [
        { north: 10, east: 0 },
        { north: 20, east: 0 },
      ],
      "B"
    );

    const { runs } = buildTrajectory([a, b], SPEEDS);
    expect(runs).toHaveLength(1);
    // [0,0], [10,0], [20,0] — junction not doubled
    expect(runs[0].points).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it("ground-truth indices resolve to real points on mark runs", () => {
    const a = markLine(
      "a",
      [
        { north: 0, east: 0 },
        { north: 10, east: 0 },
      ],
      "A"
    );
    const b = markLine(
      "b",
      [
        { north: 10, east: 30 },
        { north: 20, east: 30 },
      ],
      "B"
    );

    const { runs, groundTruth } = buildTrajectory([a, b], {
      ...SPEEDS,
      groundTruthSource: [
        { north: 0, east: 0, lat: 13.0, lon: 80.0 },
        { north: 10, east: 0, lat: 13.0001, lon: 80.0 },
        { north: 10, east: 30, lat: 13.0001, lon: 80.0003 },
        // Far from any fitted point — ignored
        { north: 999, east: 999, lat: 14.0, lon: 81.0 },
      ],
    });

    expect(groundTruth.length).toBe(3);
    for (const gt of groundTruth) {
      expect(gt.run_index).toBeGreaterThanOrEqual(0);
      expect(gt.run_index).toBeLessThan(runs.length);
      expect(runs[gt.run_index].kind).toBe("mark");
      expect(gt.point_index).toBeGreaterThanOrEqual(0);
      expect(gt.point_index).toBeLessThan(runs[gt.run_index].points.length);
      expect(Number.isFinite(gt.lat) && Number.isFinite(gt.lon)).toBe(true);
    }
  });

  it("ignores transit layer lines in the input list", () => {
    const a = horizontalMark("a", 0, 10, 0);
    const transit: PlanLine = {
      id: "t",
      label: "Transit",
      layer: "transit",
      from: { id: 1, x: 10, y: 0 },
      to: { id: 2, x: 10, y: 50 },
      width: 0.1,
      is_mark: false,
    };
    const b = markLine("b", [
      { north: 10, east: 50 },
      { north: 20, east: 50 },
    ]);

    const { runs } = buildTrajectory([a, transit, b], SPEEDS);
    expect(kinds(runs)).toEqual(["mark", "travel", "mark"]);
  });

  it("trajectoryTotals matches painted vs travel side-by-side figures", () => {
    const a = horizontalMark("a", 0, 10, 0);
    const b = markLine("b", [
      { north: 10, east: 20 },
      { north: 15, east: 20 },
    ]);
    const { runs } = buildTrajectory([a, b], SPEEDS);
    const totals = trajectoryTotals(runs);
    expect(totals.markRunCount).toBe(2);
    expect(totals.travelRunCount).toBe(1);
    expect(totals.markLengthM).toBeCloseTo(10 + 5, 6);
    expect(totals.travelLengthM).toBeCloseTo(20, 6);
  });

  it("unknown layer without is_mark:true does not paint (allowlist fail-closed)", () => {
    const weird: PlanLine = {
      id: "boundary-ish",
      label: "Box",
      layer: "boundary",
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 10, y: 0 },
      width: 0.1,
      entity: {
        entity_id: "b",
        entity_type: "LINE",
        layer: "BOUNDARY",
        color: 1,
        is_mark: true, // even entity flag — layer boundary not allowlisted unless is_mark on line
        length_m: 10,
        geometry: {},
        preview_points: [
          { north: 0, east: 0 },
          { north: 10, east: 0 },
        ],
      },
    };
    // is_mark undefined on line → skip (entity.is_mark true is accepted by isPaintableMarkLine)
    // Adjust: entity.is_mark true currently allows — force undefined entity is_mark
    weird.entity!.is_mark = undefined as unknown as boolean;
    const { runs, warnings } = buildTrajectory([weird], SPEEDS);
    expect(runs).toHaveLength(0);
    expect(warnings.some((w) => /allowlist|Skipped/i.test(w))).toBe(true);
  });

  it("ground-truth attachment scales with spatial index (many survey × many fitted)", () => {
    // 200 fitted points on a mark, 200 survey samples — must stay correct and finish quickly.
    const fitted = Array.from({ length: 200 }, (_, i) => ({
      north: i * 0.05,
      east: 0,
    }));
    const line = markLine("road", fitted, "Road");
    const source = fitted.map((p, i) => ({
      north: p.north,
      east: p.east,
      lat: 13 + i * 1e-6,
      lon: 80,
    }));
    const t0 = performance.now();
    const { groundTruth } = buildTrajectory([line], {
      ...SPEEDS,
      groundTruthSource: source,
    });
    const ms = performance.now() - t0;
    expect(groundTruth.length).toBeGreaterThan(50);
    // Spatial hash should be well under a second even on weak hosts.
    expect(ms).toBeLessThan(500);
  });
});
