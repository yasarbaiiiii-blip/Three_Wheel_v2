/**
 * Geometric chaining of imported CAD paths.
 *
 * The observable contract is the corner triangle: with per-line extensions on, every join in
 * a closed shape should be the short hypotenuse between one side's AFT tip and the next
 * side's PRE tip (0.5 m + 0.5 m at a right angle = 0.707 m). A file whose entities are stored
 * out of perimeter order, or with a side drawn backwards, produces connectors that jump
 * across the plan instead — 2.5 m and 3.5 m on a 2 m square.
 */

import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { buildCsvExtensionLines, buildExtensionTransitLines } from "./missionExtensions";
import { chainMarkLinesByGeometry, reversePlanLineDirection } from "./missionPathOrder";

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

const CFG = { enabled: true, preM: 0.5, aftM: 0.5, perLine: true };

/** 2 m square, corners in (north, east). */
const BL: [number, number] = [0, 0];
const BR: [number, number] = [0, 2];
const TR: [number, number] = [2, 2];
const TL: [number, number] = [2, 0];

/** Right-angle corner join: 0.5 m run-out then 0.5 m run-in, perpendicular. */
const CORNER_JOIN_M = Math.hypot(0.5, 0.5);

function connectorLengths(lines: PlanLine[]): number[] {
  return buildExtensionTransitLines(lines, CFG).map((t) => t.entity?.length_m ?? 0);
}

function expectAllCornerJoins(lines: PlanLine[]) {
  const lengths = connectorLengths(lines);
  expect(lengths).toHaveLength(3);
  for (const len of lengths) expect(len).toBeCloseTo(CORNER_JOIN_M, 6);
}

describe("chainMarkLinesByGeometry", () => {
  it("leaves a file already in perimeter order untouched", () => {
    const lines = [
      seg("bottom", BL, BR),
      seg("right", BR, TR),
      seg("top", TR, TL),
      seg("left", TL, BL),
    ];
    const chained = chainMarkLinesByGeometry(lines);
    expect(chained.map((l) => l.id)).toEqual(["bottom", "right", "top", "left"]);
    expectAllCornerJoins(chained);
  });

  it("flips a side that was drawn backwards", () => {
    const lines = [
      seg("bottom", BL, BR),
      seg("right", TR, BR), // drawn against the walk
      seg("top", TR, TL),
      seg("left", TL, BL),
    ];
    // Before: two connectors jump the plan instead of clipping the corner.
    const before = connectorLengths(lines);
    expect(before.filter((l) => l > 1)).toHaveLength(2);

    const chained = chainMarkLinesByGeometry(lines);
    expect(chained.map((l) => l.id)).toEqual(["bottom", "right", "top", "left"]);
    expect(chained[1].from).toMatchObject({ x: BR[0], y: BR[1] });
    expect(chained[1].to).toMatchObject({ x: TR[0], y: TR[1] });
    expectAllCornerJoins(chained);
  });

  it("reorders entities stored out of perimeter order", () => {
    const lines = [
      seg("bottom", BL, BR),
      seg("top", TR, TL),
      seg("right", BR, TR),
      seg("left", TL, BL),
    ];
    const before = connectorLengths(lines);
    expect(before.filter((l) => l > 1)).toHaveLength(3);

    const chained = chainMarkLinesByGeometry(lines);
    expect(chained.map((l) => l.id)).toEqual(["bottom", "right", "top", "left"]);
    expectAllCornerJoins(chained);
  });

  it("keeps every path and its run-up count", () => {
    const lines = [
      seg("bottom", BL, BR),
      seg("top", TR, TL),
      seg("right", BR, TR),
      seg("left", TL, BL),
    ];
    const chained = chainMarkLinesByGeometry(lines);
    expect(chained).toHaveLength(4);
    expect(new Set(chained.map((l) => l.id))).toEqual(
      new Set(["bottom", "right", "top", "left"])
    );
    // 4 sides × PRE + AFT — the count the Upload card reports.
    expect(buildCsvExtensionLines(chained, CFG)).toHaveLength(8);
  });

  it("starts the mission where file order started it", () => {
    const lines = [
      seg("top", TR, TL),
      seg("bottom", BL, BR),
      seg("right", BR, TR),
      seg("left", TL, BL),
    ];
    const chained = chainMarkLinesByGeometry(lines);
    expect(chained[0].id).toBe("top");
    expect(chained[0].from).toMatchObject({ x: TR[0], y: TR[1] });
  });

  it("preserves non-mark lines and passes short lists through", () => {
    const boundary: PlanLine = {
      ...seg("vbox", BL, BR),
      id: "vbox",
      layer: "virtual_boundary",
    };
    const chained = chainMarkLinesByGeometry([
      seg("bottom", BL, BR),
      seg("right", BR, TR),
      boundary,
    ]);
    expect(chained.map((l) => l.id)).toEqual(["bottom", "right", "vbox"]);
    expect(chainMarkLinesByGeometry([seg("only", BL, BR)]).map((l) => l.id)).toEqual([
      "only",
    ]);
  });

  it("does not reverse curved geometry", () => {
    const arc: PlanLine = {
      ...seg("arc", TR, TL),
      entity: {
        ...seg("arc", TR, TL).entity!,
        entity_type: "ARC",
        geometry: { startAngle: 0, endAngle: 90 },
      },
    };
    // The walk out of `bottom` ends at BR, nearer the arc's END (TL is far) — a line-like
    // path would flip here; the arc must keep its authored direction.
    const chained = chainMarkLinesByGeometry([seg("bottom", BL, TL), arc]);
    const placed = chained.find((l) => l.id === "arc")!;
    expect(placed.from).toMatchObject({ x: TR[0], y: TR[1] });
    expect(placed.to).toMatchObject({ x: TL[0], y: TL[1] });
  });
});

describe("reversePlanLineDirection", () => {
  it("swaps endpoints and vertex order", () => {
    const line = seg("a", BL, TR);
    const flipped = reversePlanLineDirection(line);
    expect(flipped.from).toMatchObject({ x: TR[0], y: TR[1] });
    expect(flipped.to).toMatchObject({ x: BL[0], y: BL[1] });
    expect(flipped.entity?.preview_points?.[0]).toMatchObject({ north: TR[0], east: TR[1] });
    // Source line untouched.
    expect(line.from).toMatchObject({ x: BL[0], y: BL[1] });
  });
});
