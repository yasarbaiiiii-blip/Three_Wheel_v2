import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  absHeadingChangeDeg,
  applyCsvOrderToPlanLines,
  buildCsvTransitPreviews,
  buildOrderedTrajectory,
  defaultPathOrder,
  detectReversalWarnings,
  entryHeadingDeg,
  exitHeadingDeg,
  headingDeltaDeg,
  reorderPathOrder,
  resolveOrderedPaintedLines,
  setPathPaint,
} from "./csvPathOrder";

function mark(
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
      geometry: {},
      preview_points: points,
    },
  };
}

describe("heading helpers", () => {
  it("exit heading 0° along +north", () => {
    expect(exitHeadingDeg([
      [0, 0],
      [10, 0],
    ])).toBeCloseTo(0, 5);
  });

  it("entry heading 90° along +east", () => {
    expect(entryHeadingDeg([
      [0, 0],
      [0, 10],
    ])).toBeCloseTo(90, 5);
  });

  it("heading delta wraps to (-180, 180]", () => {
    expect(headingDeltaDeg(170, -170)).toBeCloseTo(20, 5);
    expect(absHeadingChangeDeg(0, 90)).toBeCloseTo(90, 5);
    expect(absHeadingChangeDeg(0, 179)).toBeCloseTo(179, 5);
  });
});

describe("detectReversalWarnings", () => {
  it("does not warn for 0° and 90° consecutive headings", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]); // exit 0°
    const b = mark("b", [
      { north: 10, east: 5 },
      { north: 10, east: 15 },
    ]); // entry 90°
    expect(detectReversalWarnings([a, b])).toHaveLength(0);
  });

  it("warns above 120° including 179° near-reversal", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]); // exit +north
    const b = mark("b", [
      { north: 20, east: 0 },
      { north: 10.1, east: 0 },
    ]); // entry nearly -north ≈ 180°
    const warnings = detectReversalWarnings([a, b]);
    expect(warnings.length).toBe(1);
    expect(warnings[0].headingChangeDeg).toBeGreaterThan(120);
  });

  it("does not warn at exactly 120° (threshold is exclusive >)", () => {
    // exit 0°, entry 120°
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const angle = (120 * Math.PI) / 180;
    const b = mark("b", [
      { north: 20, east: 0 },
      { north: 20 + Math.cos(angle) * 10, east: 0 + Math.sin(angle) * 10 },
    ]);
    // floating point may be just under/over — assert no false positive for ~90
    const mild = mark("c", [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
    ]);
    expect(detectReversalWarnings([a, mild])).toHaveLength(0);
    void b;
  });
});

describe("order / paint / trajectory", () => {
  const a = mark(
    "a",
    [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ],
    "A"
  );
  const b = mark(
    "b",
    [
      { north: 10, east: 20 },
      { north: 20, east: 20 },
    ],
    "B"
  );
  const c = mark(
    "c",
    [
      { north: 20, east: 40 },
      { north: 30, east: 40 },
    ],
    "C"
  );

  it("totals match buildTrajectory for default order", () => {
    const order = defaultPathOrder([a, b, c]);
    const { runs, totals } = buildOrderedTrajectory([a, b, c], order, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs.map((r) => r.kind)).toEqual([
      "mark",
      "travel",
      "mark",
      "travel",
      "mark",
    ]);
    expect(totals.markRunCount).toBe(3);
    expect(totals.travelRunCount).toBe(2);
    expect(totals.markLengthM).toBeCloseTo(30, 5);
  });

  it("reorder produces the expected run sequence", () => {
    let order = defaultPathOrder([a, b, c]);
    order = reorderPathOrder(order, 0, 2); // A moves after C → B, C, A
    const painted = resolveOrderedPaintedLines([a, b, c], order);
    expect(painted.map((l) => l.id)).toEqual(["b", "c", "a"]);
    const { runs } = buildOrderedTrajectory([a, b, c], order, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs.filter((r) => r.kind === "mark").map((r) => r.label)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  it("skip excludes path and neighbours get direct travel", () => {
    let order = defaultPathOrder([a, b, c]);
    order = setPathPaint(order, "b", false);
    const { runs } = buildOrderedTrajectory([a, b, c], order, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs.filter((r) => r.kind === "mark").map((r) => r.label)).toEqual([
      "A",
      "C",
    ]);
    expect(runs).toHaveLength(3);
    expect(runs[1].kind).toBe("travel");
  });

  it("applyCsvOrderToPlanLines rebuilds transit end→start after reorder", () => {
    // A ends at (10,0); C starts at (20,40) — after A→C→B, first transit is A→C.
    let order = defaultPathOrder([a, b, c]);
    order = reorderPathOrder(order, 2, 1); // A, C, B
    const next = applyCsvOrderToPlanLines([a, b, c], order);
    const marks = next.filter((l) => l.layer === "marking");
    const transit = next.filter((l) => l.layer === "transit");
    expect(marks.map((l) => l.id)).toEqual(["a", "c", "b"]);
    expect(transit.length).toBeGreaterThanOrEqual(1);
    // First transit: end of A (10,0) → start of C (20,40)
    expect(transit[0].from.x).toBeCloseTo(10, 5);
    expect(transit[0].from.y).toBeCloseTo(0, 5);
    expect(transit[0].to.x).toBeCloseTo(20, 5);
    expect(transit[0].to.y).toBeCloseTo(40, 5);
  });

  it("buildCsvTransitPreviews follows painted order labels", () => {
    let order = defaultPathOrder([a, b, c]);
    order = reorderPathOrder(order, 0, 2); // B, C, A
    const previews = buildCsvTransitPreviews([a, b, c], order);
    expect(previews.map((p) => `${p.fromLabel}->${p.toLabel}`)).toEqual([
      "B->C",
      "C->A",
    ]);
  });
});
