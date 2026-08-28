import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { getCurveGeometry } from "./curveGeometry";
import {
  bufferPlanLines,
  marksCentroid,
  offsetPolylineLeft,
} from "./planBufferOffset";

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
    is_mark: true,
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

/** Axis-aligned 10 m square, CCW, centroid at (5, 5) in (north, east). */
function squareLines(): PlanLine[] {
  return [
    seg("south", [0, 0], [0, 10]), // east along n=0
    seg("east", [0, 10], [10, 10]), // north along e=10
    seg("north", [10, 10], [10, 0]), // west along n=10
    seg("west", [10, 0], [0, 0]), // south along e=0
  ];
}

describe("offsetPolylineLeft", () => {
  it("offsets an eastbound segment north for a positive left distance", () => {
    const next = offsetPolylineLeft(
      [
        { north: 0, east: 0 },
        { north: 0, east: 10 },
      ],
      1
    );
    expect(next[0].north).toBeCloseTo(1, 9);
    expect(next[1].north).toBeCloseTo(1, 9);
    expect(next[0].east).toBeCloseTo(0, 9);
    expect(next[1].east).toBeCloseTo(10, 9);
  });
});

describe("bufferPlanLines", () => {
  it("zero distance is a no-op", () => {
    const lines = squareLines();
    expect(bufferPlanLines(lines, 0, "out")).toBe(lines);
  });

  it("non-finite distance returns null", () => {
    expect(bufferPlanLines(squareLines(), NaN, "out")).toBeNull();
  });

  it("expands a square outward: each side moves 1 m away from the centroid", () => {
    const next = bufferPlanLines(squareLines(), 1, "out")!;
    expect(next).not.toBeNull();
    const south = next.find((l) => l.id === "south")!;
    const north = next.find((l) => l.id === "north")!;
    const west = next.find((l) => l.id === "west")!;
    const east = next.find((l) => l.id === "east")!;
    expect(south.from.x).toBeCloseTo(-1, 6);
    expect(south.to.x).toBeCloseTo(-1, 6);
    expect(north.from.x).toBeCloseTo(11, 6);
    expect(north.to.x).toBeCloseTo(11, 6);
    expect(west.from.y).toBeCloseTo(-1, 6);
    expect(west.to.y).toBeCloseTo(-1, 6);
    expect(east.from.y).toBeCloseTo(11, 6);
    expect(east.to.y).toBeCloseTo(11, 6);
  });

  it("shrinks a square inward: each side moves 1 m toward the centroid", () => {
    const next = bufferPlanLines(squareLines(), 1, "in")!;
    const south = next.find((l) => l.id === "south")!;
    const north = next.find((l) => l.id === "north")!;
    expect(south.from.x).toBeCloseTo(1, 6);
    expect(north.from.x).toBeCloseTo(9, 6);
  });

  it("grows a circle radius on out and shrinks on in, center stays put", () => {
    const circle = makeCircleLine(100, 50, 10);
    const out = bufferPlanLines([circle], 2, "out")!;
    const inw = bufferPlanLines([circle], 2, "in")!;
    const outCurve = getCurveGeometry(out[0])!;
    const inCurve = getCurveGeometry(inw[0])!;
    expect(outCurve.radius).toBeCloseTo(12, 6);
    expect(inCurve.radius).toBeCloseTo(8, 6);
    expect(outCurve.centerNorth).toBeCloseTo(100, 6);
    expect(outCurve.centerEast).toBeCloseTo(50, 6);
  });

  it("refuses an inward offset that would collapse a circle", () => {
    const circle = makeCircleLine(0, 0, 0.5);
    expect(bufferPlanLines([circle], 1, "in")).toBeNull();
  });

  it("centroid of a square sits at its center", () => {
    const c = marksCentroid(squareLines())!;
    expect(c.north).toBeCloseTo(5, 6);
    expect(c.east).toBeCloseTo(5, 6);
  });
});
