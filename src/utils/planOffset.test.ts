import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  MIN_PLAN_HEADING_LENGTH_M,
  computePlanHeadingFromPaintedLines,
  computePlanOffsetDelta,
  lateralUnitVector,
  offsetPlanLines,
} from "./planOffset";

function seg(id: string, a: [number, number], b: [number, number]): PlanLine {
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
  };
}

function makeCircleLine(centerNorth: number, centerEast: number, radius: number): PlanLine {
  return {
    id: "circle-1",
    label: "circle",
    layer: "marking",
    from: { id: 1, x: centerNorth, y: centerEast - radius },
    to: { id: 2, x: centerNorth, y: centerEast + radius },
    width: 0.1,
    entity: {
      entity_id: "c1",
      entity_type: "CIRCLE",
      layer: "marking",
      color: 1,
      is_mark: true,
      length_m: 2 * Math.PI * radius,
      geometry: {
        center: [centerNorth, centerEast],
        centerNorth,
        centerEast,
        radius,
        startAngle: 0,
        endAngle: 360,
      },
      preview_points: [
        { north: centerNorth, east: centerEast - radius },
        { north: centerNorth, east: centerEast + radius },
      ],
    },
  };
}

describe("lateralUnitVector", () => {
  it("heading due north: right = east, left = west", () => {
    const heading = { north: 1, east: 0 };
    const right = lateralUnitVector(heading, "right")!;
    expect(right.north).toBeCloseTo(0, 9);
    expect(right.east).toBeCloseTo(1, 9);
    const left = lateralUnitVector(heading, "left")!;
    expect(left.north).toBeCloseTo(0, 9);
    expect(left.east).toBeCloseTo(-1, 9);
  });

  it("heading due east: right = south, left = north", () => {
    const heading = { north: 0, east: 1 };
    const right = lateralUnitVector(heading, "right")!;
    expect(right.north).toBeCloseTo(-1, 9);
    expect(right.east).toBeCloseTo(0, 9);
    const left = lateralUnitVector(heading, "left")!;
    expect(left.north).toBeCloseTo(1, 9);
    expect(left.east).toBeCloseTo(0, 9);
  });

  it("normalizes non-unit headings", () => {
    const heading = { north: 5, east: 0 };
    const right = lateralUnitVector(heading, "right")!;
    expect(right.north).toBeCloseTo(0, 9);
    expect(right.east).toBeCloseTo(1, 9);
  });

  it("returns null for a zero-length heading", () => {
    expect(lateralUnitVector({ north: 0, east: 0 }, "right")).toBeNull();
  });
});

describe("computePlanHeadingFromPaintedLines", () => {
  it("single straight line: heading is start->end", () => {
    const heading = computePlanHeadingFromPaintedLines([seg("a", [0, 0], [10, 0])]);
    expect(heading).toEqual({ north: 10, east: 0 });
  });

  it("multi-shape plan: heading is first mark's start to last mark's end, not a local tangent", () => {
    // L-shape: north 10m, then east 5m. Overall A->B is the straight diagonal, not either leg's own direction.
    const lines = [seg("a", [0, 0], [10, 0]), seg("b", [10, 0], [10, 5])];
    const heading = computePlanHeadingFromPaintedLines(lines);
    expect(heading).toEqual({ north: 10, east: 5 });
  });

  it("returns null for a single degenerate (zero-length) line", () => {
    const heading = computePlanHeadingFromPaintedLines([seg("a", [0, 0], [0, 0])]);
    expect(heading).toBeNull();
  });

  it("returns null for a closed loop (first point ~= last point)", () => {
    const square = [
      seg("bottom", [0, 0], [0, 2]),
      seg("right", [0, 2], [2, 2]),
      seg("top", [2, 2], [2, 0]),
      seg("left", [2, 0], [0, 0]),
    ];
    expect(computePlanHeadingFromPaintedLines(square)).toBeNull();
  });

  it("returns null when no painted lines are given", () => {
    expect(computePlanHeadingFromPaintedLines([])).toBeNull();
  });

  it("epsilon boundary: just under MIN_PLAN_HEADING_LENGTH_M is null, just over is not", () => {
    const tooShort = [seg("a", [0, 0], [MIN_PLAN_HEADING_LENGTH_M * 0.5, 0])];
    expect(computePlanHeadingFromPaintedLines(tooShort)).toBeNull();

    const longEnough = [seg("a", [0, 0], [MIN_PLAN_HEADING_LENGTH_M * 2, 0])];
    expect(computePlanHeadingFromPaintedLines(longEnough)).not.toBeNull();
  });
});

describe("computePlanOffsetDelta", () => {
  it("zero offset returns the zero vector, not null", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    expect(computePlanOffsetDelta(lines, 0, "right")).toEqual({ north: 0, east: 0 });
  });

  it("non-finite offset returns null", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    expect(computePlanOffsetDelta(lines, NaN, "right")).toBeNull();
  });

  it("undeterminable heading returns null regardless of offset value", () => {
    expect(computePlanOffsetDelta([], 1, "right")).toBeNull();
  });

  it("magnitude uses abs(offsetM); sign of the input distance does not flip direction", () => {
    const lines = [seg("a", [0, 0], [10, 0])]; // heading due north
    const delta = computePlanOffsetDelta(lines, -2, "right")!;
    expect(delta.north).toBeCloseTo(0, 9);
    expect(delta.east).toBeCloseTo(2, 9);
  });
});

describe("offsetPlanLines", () => {
  it("straight single-line plan, offset right: every point shifts east by the offset", () => {
    const lines = [seg("a", [0, 0], [10, 0])]; // heading due north
    const next = offsetPlanLines(lines, lines, 1, "right")!;
    expect(next).not.toBeNull();
    expect(next[0].from).toEqual({ id: 1, x: 0, y: 1 });
    expect(next[0].to).toEqual({ id: 2, x: 10, y: 1 });
  });

  it("straight single-line plan, offset left: every point shifts west by the offset", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    const next = offsetPlanLines(lines, lines, 1, "left")!;
    expect(next[0].from.y).toBeCloseTo(-1, 9);
    expect(next[0].to.y).toBeCloseTo(-1, 9);
  });

  it("zero offset is a no-op: output deep-equals input", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    const next = offsetPlanLines(lines, lines, 0, "right");
    expect(next).toEqual(lines);
  });

  it("returns null when the plan's heading can't be determined (e.g. closed loop)", () => {
    const square = [
      seg("bottom", [0, 0], [0, 2]),
      seg("right", [0, 2], [2, 2]),
      seg("top", [2, 2], [2, 0]),
      seg("left", [2, 0], [0, 0]),
    ];
    expect(offsetPlanLines(square, square, 1, "right")).toBeNull();
  });

  it("applies the same delta to every line, including ones not in orderedPaintedLines (e.g. transit)", () => {
    const mark = seg("mark-1", [0, 0], [10, 0]);
    const transit: PlanLine = {
      ...seg("transit-1", [10, 0], [20, 0]),
      layer: "transit",
      segmentRole: "none",
    };
    const next = offsetPlanLines([mark, transit], [mark], 1, "right")!;
    const nextTransit = next.find((l) => l.id === "transit-1")!;
    expect(nextTransit.from.y).toBeCloseTo(1, 9);
    expect(nextTransit.to.y).toBeCloseTo(1, 9);
  });

  it("preserves curve geometry (circle center) through the offset", () => {
    const circle = makeCircleLine(100, 50, 10);
    // preview_points run from=(north:100,east:40) to=(north:100,east:60) -> heading due
    // east -> right = due "south" (north decreases). 2m right shifts center north by -2.
    const next = offsetPlanLines([circle], [circle], 2, "right")!;
    const geom = next[0].entity!.geometry as Record<string, unknown>;
    expect(geom.centerEast).toBeCloseTo(50, 6);
    expect(geom.centerNorth).toBeCloseTo(98, 6);
    expect(geom.radius).toBeCloseTo(10, 6);
  });
});
