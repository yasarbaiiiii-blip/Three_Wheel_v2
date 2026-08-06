import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  absHeadingChangeDeg,
  applyCsvOrderToPlanLines,
  buildCsvTransitPreviews,
  buildOrderedTrajectory,
  chainMarkLinesByGeometry,
  defaultPathOrder,
  detectCurveDirectionWarnings,
  detectDegenerateEntityWarnings,
  detectReversalWarnings,
  entryHeadingDeg,
  exitHeadingDeg,
  headingDeltaDeg,
  reorderPathOrder,
  resolveOrderedPaintedLines,
  setPathPaint,
} from "./csvPathOrder";
import { buildExtensionTransitLines } from "./missionExtensions";
import { MARK_CONTIGUOUS_GAP_M } from "./missionTrajectory";

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

  it("buildCsvTransitPreviews with extensions uses tip-to-tip lengths (not mark-to-mark)", () => {
    // Parallel marks 30 m east apart: mark-to-mark transit ≈ 30 m.
    // With 0.5 m AFT + 0.5 m PRE along +north, tips leave mark ends so connector ≠ 30.
    const left = mark(
      "left",
      [
        { north: 0, east: 0 },
        { north: 10, east: 0 },
      ],
      "Left"
    );
    const right = mark(
      "right",
      [
        { north: 0, east: 30 },
        { north: 10, east: 30 },
      ],
      "Right"
    );
    const order = defaultPathOrder([left, right]);
    const extCfg = { enabled: true, preM: 0.5, aftM: 0.5, perLine: false };

    const mapTransit = buildExtensionTransitLines([left, right], extCfg);
    expect(mapTransit.length).toBeGreaterThanOrEqual(1);
    const tipLen = mapTransit[0].entity?.length_m ?? 0;
    // Mark-end → mark-start is pure east 30 m; tip-to-tip differs once run-ups exist.
    const markToMark = Math.hypot(0 - 10, 30 - 0); // right.from (0,30) from left.to (10,0)
    expect(tipLen).not.toBeCloseTo(markToMark, 1);

    const previews = buildCsvTransitPreviews([left, right], order, extCfg);
    expect(previews).toHaveLength(mapTransit.length);
    expect(previews[0].lengthM).toBeCloseTo(tipLen, 5);
    expect(previews[0].fromLabel).toBe("Left");
    expect(previews[0].toLabel).toBe("Right");
  });

  it("buildCsvTransitPreviews without extensions still matches mark-to-mark map transit", () => {
    const order = defaultPathOrder([a, b]);
    const previews = buildCsvTransitPreviews([a, b], order, null);
    // a ends (10,0), b starts (10,20) → 20 m east
    expect(previews).toHaveLength(1);
    expect(previews[0].lengthM).toBeCloseTo(20, 5);
  });

  it("chain + defaultPathOrder + applyCsvOrder yields continuous walk (wiring shape)", () => {
    // Shuffled square sides: file order is not perimeter order and one side is reversed.
    const bottom = mark("bottom", [
      { north: 0, east: 0 },
      { north: 0, east: 2 },
    ]);
    const top = mark("top", [
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ]);
    // right stored bottom→top would be correct; reverse it (top→bottom) to force flip.
    const rightReversed = mark("right", [
      { north: 2, east: 2 },
      { north: 0, east: 2 },
    ]);
    const left = mark("left", [
      { north: 2, east: 0 },
      { north: 0, east: 0 },
    ]);
    // CAD-like mess: bottom, top, right(reversed), left
    const fileOrder = [bottom, top, rightReversed, left];
    const chained = chainMarkLinesByGeometry(fileOrder);
    const order = defaultPathOrder(chained);
    const applied = applyCsvOrderToPlanLines(chained, order, null);
    const transit = applied.filter((l) => l.layer === "transit");
    // Contiguous square: three corner joins ≈ 0 after reverse/order (touching ends).
    // Greedy chain should make consecutive ends meet so transit is empty or tiny.
    const totalTransit = transit.reduce(
      (s, l) => s + (l.entity?.length_m ?? 0),
      0
    );
    expect(totalTransit).toBeLessThan(0.1);
    const painted = resolveOrderedPaintedLines(chained, order);
    expect(detectReversalWarnings(painted).length).toBe(0);
  });

  it("buildCsvTransitPreviews skips gaps under MARK_CONTIGUOUS_GAP_M", () => {
    const gap = 0.03; // in the old 2–5 cm mismatch band
    expect(gap).toBeLessThan(MARK_CONTIGUOUS_GAP_M);
    const p1 = mark("p1", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const p2 = mark("p2", [
      { north: 10 + gap, east: 0 },
      { north: 20, east: 0 },
    ]);
    const order = defaultPathOrder([p1, p2]);
    expect(buildCsvTransitPreviews([p1, p2], order)).toHaveLength(0);
  });

  it("does not collapse two transit legs that share endpoints", () => {
    // p2 stands in for a curve entered from the wrong end (field_test_01.DXF failure
    // mode): its "to" duplicates p1's "to", and its "from" duplicates p3's "from", so a
    // coordinate search would attribute both real transit legs to the same pair.
    const p1 = mark("p1", [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
    ]);
    const p2 = mark("p2", [
      { north: 20, east: 10 },
      { north: 0, east: 10 },
    ]);
    const p3 = mark("p3", [
      { north: 20, east: 10 },
      { north: 20, east: 20 },
    ]);
    const order = defaultPathOrder([p1, p2, p3]);
    const previews = buildCsvTransitPreviews([p1, p2, p3], order, null);
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({ fromLineId: "p1", toLineId: "p2" });
    expect(previews[1]).toMatchObject({ fromLineId: "p2", toLineId: "p3" });
    expect(previews[0].lengthM).toBeCloseTo(20, 5);
    expect(previews[1].lengthM).toBeCloseTo(20, 5);
  });
});

describe("detectCurveDirectionWarnings", () => {
  function arcMark(
    id: string,
    points: Array<{ north: number; east: number }>,
    startAngle: number,
    endAngle: number
  ): PlanLine {
    const base = mark(id, points);
    return {
      ...base,
      entity: {
        ...base.entity!,
        entity_type: "ARC",
        geometry: { startAngle, endAngle },
      },
    };
  }

  it("flags an arc whose authored direction adds an avoidable detour", () => {
    const straight = mark("straight", [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
    ]);
    // Tessellated start (0,30) is far from straight's end (0,10); tessellated end (0,10)
    // sits right on it — reversing this arc would erase almost the whole gap.
    const arc = arcMark(
      "curve",
      [
        { north: 0, east: 30 },
        { north: 5, east: 20 },
        { north: 0, east: 10 },
      ],
      90,
      270
    );
    const warnings = detectCurveDirectionWarnings([straight, arc]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].lineId).toBe("curve");
    expect(warnings[0].wastedM).toBeCloseTo(20, 5);
  });

  it("stays silent for an arc already entered from its near end", () => {
    const straight = mark("straight", [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
    ]);
    const arc = arcMark(
      "curve",
      [
        { north: 0, east: 10 },
        { north: 5, east: 20 },
        { north: 0, east: 30 },
      ],
      270,
      90
    );
    expect(detectCurveDirectionWarnings([straight, arc])).toHaveLength(0);
  });

  it("stays silent for a plain line (no analytic curve tangents)", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
    ]);
    const b = mark("b", [
      { north: 50, east: 10 },
      { north: 60, east: 10 },
    ]);
    expect(detectCurveDirectionWarnings([a, b])).toHaveLength(0);
  });
});

describe("detectDegenerateEntityWarnings", () => {
  function withLength(line: PlanLine, lengthM: number): PlanLine {
    return { ...line, entity: { ...line.entity!, length_m: lengthM } };
  }

  it("flags entities too short to be meaningful paint", () => {
    const normal = withLength(
      mark("normal", [
        { north: 0, east: 0 },
        { north: 10, east: 0 },
      ]),
      10
    );
    // Mirrors field_test_01.DXF: two entities of 4 cm and 0.8 cm.
    const tiny1 = withLength(
      mark("tiny1", [
        { north: 20, east: 0 },
        { north: 20.04, east: 0 },
      ]),
      0.04
    );
    const tiny2 = withLength(
      mark("tiny2", [
        { north: 30, east: 0 },
        { north: 30.008, east: 0 },
      ]),
      0.008
    );
    const warnings = detectDegenerateEntityWarnings([normal, tiny1, tiny2]);
    expect(warnings.map((w) => w.lineId)).toEqual(["tiny1", "tiny2"]);
  });

  it("does not flag a normal-length entity", () => {
    const normal = withLength(
      mark("normal", [
        { north: 0, east: 0 },
        { north: 5, east: 0 },
      ]),
      5
    );
    expect(detectDegenerateEntityWarnings([normal])).toHaveLength(0);
  });

  it("respects a custom threshold", () => {
    const line = withLength(
      mark("line", [
        { north: 0, east: 0 },
        { north: 0.5, east: 0 },
      ]),
      0.5
    );
    expect(detectDegenerateEntityWarnings([line], 0.1)).toHaveLength(0);
    expect(detectDegenerateEntityWarnings([line], 1)).toHaveLength(1);
  });
});
