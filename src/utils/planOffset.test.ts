import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  bearingUnitVector,
  computePlanOffsetDelta,
  normalizeBearingDeg,
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

describe("normalizeBearingDeg", () => {
  it("leaves an in-range bearing unchanged", () => {
    expect(normalizeBearingDeg(45)).toBeCloseTo(45, 9);
  });

  it("wraps 360 to 0", () => {
    expect(normalizeBearingDeg(360)).toBeCloseTo(0, 9);
  });

  it("wraps a large positive multiple of 360", () => {
    expect(normalizeBearingDeg(720 + 30)).toBeCloseTo(30, 9);
  });

  it("wraps negative bearings into [0,360)", () => {
    expect(normalizeBearingDeg(-10)).toBeCloseTo(350, 9);
    expect(normalizeBearingDeg(-370)).toBeCloseTo(350, 9);
  });
});

describe("bearingUnitVector", () => {
  it("0 deg = due north", () => {
    const v = bearingUnitVector(0);
    expect(v.north).toBeCloseTo(1, 9);
    expect(v.east).toBeCloseTo(0, 9);
  });

  it("90 deg = due east", () => {
    const v = bearingUnitVector(90);
    expect(v.north).toBeCloseTo(0, 9);
    expect(v.east).toBeCloseTo(1, 9);
  });

  it("180 deg = due south", () => {
    const v = bearingUnitVector(180);
    expect(v.north).toBeCloseTo(-1, 9);
    expect(v.east).toBeCloseTo(0, 9);
  });

  it("270 deg = due west", () => {
    const v = bearingUnitVector(270);
    expect(v.north).toBeCloseTo(0, 9);
    expect(v.east).toBeCloseTo(-1, 9);
  });

  it("45 deg = northeast, equal components", () => {
    const v = bearingUnitVector(45);
    expect(v.north).toBeCloseTo(Math.SQRT1_2, 9);
    expect(v.east).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it("is periodic: 360 deg behaves like 0 deg, -90 deg like 270 deg", () => {
    const a = bearingUnitVector(360);
    const b = bearingUnitVector(0);
    expect(a.north).toBeCloseTo(b.north, 9);
    expect(a.east).toBeCloseTo(b.east, 9);

    const c = bearingUnitVector(-90);
    const d = bearingUnitVector(270);
    expect(c.north).toBeCloseTo(d.north, 9);
    expect(c.east).toBeCloseTo(d.east, 9);
  });
});

describe("computePlanOffsetDelta", () => {
  it("zero offset returns the zero vector regardless of bearing, not null", () => {
    expect(computePlanOffsetDelta(0, 90)).toEqual({ north: 0, east: 0 });
    expect(computePlanOffsetDelta(0, NaN)).toEqual({ north: 0, east: 0 });
  });

  it("non-finite offset returns null", () => {
    expect(computePlanOffsetDelta(NaN, 90)).toBeNull();
    expect(computePlanOffsetDelta(Infinity, 90)).toBeNull();
  });

  it("non-finite bearing with a nonzero offset returns null", () => {
    expect(computePlanOffsetDelta(2, NaN)).toBeNull();
  });

  it("magnitude uses abs(offsetM); sign of the input distance does not flip direction", () => {
    const delta = computePlanOffsetDelta(-2, 90)!; // due east
    expect(delta.north).toBeCloseTo(0, 9);
    expect(delta.east).toBeCloseTo(2, 9);
  });
});

describe("offsetPlanLines", () => {
  it("offset toward 90 deg (east): every point shifts east by the offset", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    const next = offsetPlanLines(lines, 1, 90)!;
    expect(next).not.toBeNull();
    expect(next[0].from.x).toBeCloseTo(0, 9);
    expect(next[0].from.y).toBeCloseTo(1, 9);
    expect(next[0].to.x).toBeCloseTo(10, 9);
    expect(next[0].to.y).toBeCloseTo(1, 9);
  });

  it("offset toward 270 deg (west): every point shifts west by the offset", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    const next = offsetPlanLines(lines, 1, 270)!;
    expect(next[0].from.y).toBeCloseTo(-1, 9);
    expect(next[0].to.y).toBeCloseTo(-1, 9);
  });

  it("zero offset is a no-op: output deep-equals input", () => {
    const lines = [seg("a", [0, 0], [10, 0])];
    const next = offsetPlanLines(lines, 0, 90);
    expect(next).toEqual(lines);
  });

  it("robustness win: a closed-loop plan now offsets successfully (no heading lookup needed)", () => {
    const square = [
      seg("bottom", [0, 0], [0, 2]),
      seg("right", [0, 2], [2, 2]),
      seg("top", [2, 2], [2, 0]),
      seg("left", [2, 0], [0, 0]),
    ];
    const next = offsetPlanLines(square, 1, 90)!;
    expect(next).not.toBeNull();
    // Every point shifts 1m east — spot-check the first and last segment.
    expect(next[0].from.y).toBeCloseTo(1, 9);
    expect(next[3].to.y).toBeCloseTo(1, 9);
  });

  it("applies the same delta to every line, including layers not painted (e.g. transit)", () => {
    const mark = seg("mark-1", [0, 0], [10, 0]);
    const transit: PlanLine = {
      ...seg("transit-1", [10, 0], [20, 0]),
      layer: "transit",
      segmentRole: "none",
    };
    const next = offsetPlanLines([mark, transit], 1, 90)!;
    const nextTransit = next.find((l) => l.id === "transit-1")!;
    expect(nextTransit.from.y).toBeCloseTo(1, 9);
    expect(nextTransit.to.y).toBeCloseTo(1, 9);
  });

  it("preserves curve geometry (circle center) through the offset", () => {
    const circle = makeCircleLine(100, 50, 10);
    const next = offsetPlanLines([circle], 2, 0)!; // 2m due north
    const geom = next[0].entity!.geometry as Record<string, unknown>;
    expect(geom.centerNorth).toBeCloseTo(102, 6);
    expect(geom.centerEast).toBeCloseTo(50, 6);
    expect(geom.radius).toBeCloseTo(10, 6);
  });
});
