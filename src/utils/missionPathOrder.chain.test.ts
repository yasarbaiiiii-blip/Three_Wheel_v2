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
import {
  chainMarkLinesByGeometry,
  chainMarkLinesFromSeed,
  reversePlanLineDirection,
} from "./missionPathOrder";

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

  it("tries alternate seeds when the file-order start is a bad one (confirmed on field_test_01.DXF)", () => {
    // Mirrors a real survey DXF: entity 0 ("lineA") is a line authored away from everything
    // else, an ARC can only be entered at P3=(3,4) and exits at P1=(0,0), and "lineB" departs
    // from that same P3. Seeding from lineA in its authored (file) direction strands the walk
    // 24+ m from the arc's entry; seeding from lineA REVERSED (or from another entity) does not.
    const p1: [number, number] = [0, 0];
    const p2: [number, number] = [0, -20];
    const p3: [number, number] = [3, 4];
    const p4: [number, number] = [13, 4];
    const lineA = seg("lineA", p1, p2); // file order: entity 0, authored P1→P2
    const arc: PlanLine = {
      ...seg("arc", p3, p1),
      entity: { ...seg("arc", p3, p1).entity!, entity_type: "ARC" },
    };
    const lineB = seg("lineB", p3, p4);

    const naiveTotal =
      Math.hypot(p2[0] - p3[0], p2[1] - p3[1]) + // lineA(fwd) end → arc start
      Math.hypot(p1[0] - p3[0], p1[1] - p3[1]); // arc end → lineB start
    expect(naiveTotal).toBeCloseTo(29.19, 2); // sanity-check the "before" baseline

    const chained = chainMarkLinesByGeometry([lineA, lineB, arc]);
    let total = 0;
    for (let i = 0; i < chained.length - 1; i++) {
      const a = chained[i].entity!.preview_points!;
      const b = chained[i + 1].entity!.preview_points!;
      total += Math.hypot(
        b[0].north - a[a.length - 1].north,
        b[0].east - a[a.length - 1].east
      );
    }
    expect(total).toBeLessThan(15); // well below the naive 29.19 m
    // The arc itself must never be reversed, regardless of which seed won.
    const placedArc = chained.find((l) => l.id === "arc")!;
    expect(placedArc.from).toMatchObject({ x: p3[0], y: p3[1] });
    expect(placedArc.to).toMatchObject({ x: p1[0], y: p1[1] });
  });
});

describe("chainMarkLinesFromSeed", () => {
  const square = [
    seg("bottom", BL, BR),
    seg("right", BR, TR),
    seg("top", TR, TL),
    seg("left", TL, BL),
  ];

  it("chains forward from an operator-picked seed, not the auto-optimized one", () => {
    // "top" seeded from its authored `from` (TR) — walk should still find the
    // nearest-endpoint perimeter order starting there, same algorithm as the
    // auto-chain, just pinned to a different start.
    const chained = chainMarkLinesFromSeed(square, "top", false);
    expect(chained[0].id).toBe("top");
    expect(chained[0].from).toMatchObject({ x: TR[0], y: TR[1] });
    expect(chained.map((l) => l.id)).toEqual(["top", "left", "bottom", "right"]);
  });

  it("seeds from the line's `to` end when seedFromEnd is true (line-like only)", () => {
    const chained = chainMarkLinesFromSeed(square, "top", true);
    expect(chained[0].id).toBe("top");
    // Reversed: authored TR→TL becomes TL→TR.
    expect(chained[0].from).toMatchObject({ x: TL[0], y: TL[1] });
    expect(chained[0].to).toMatchObject({ x: TR[0], y: TR[1] });
  });

  it("never reverses a curved seed even when seedFromEnd is requested", () => {
    const arc: PlanLine = {
      ...seg("arc", TR, TL),
      entity: {
        ...seg("arc", TR, TL).entity!,
        entity_type: "ARC",
        geometry: { startAngle: 0, endAngle: 90 },
      },
    };
    const lines = [seg("bottom", BL, BR), seg("right", BR, TR), arc, seg("left", TL, BL)];
    const chained = chainMarkLinesFromSeed(lines, "arc", true);
    expect(chained[0].id).toBe("arc");
    // Authored direction preserved — seedFromEnd is a no-op on curves.
    expect(chained[0].from).toMatchObject({ x: TR[0], y: TR[1] });
    expect(chained[0].to).toMatchObject({ x: TL[0], y: TL[1] });
  });

  it("keeps unplaceable marks and non-mark lines appended, not lost", () => {
    const boundary: PlanLine = { ...seg("vbox", BL, BR), id: "vbox", layer: "virtual_boundary" };
    const noGeometry: PlanLine = {
      ...seg("stray", BL, BR),
      id: "stray",
      entity: { ...seg("stray", BL, BR).entity!, preview_points: [] },
      from: undefined as any,
      to: undefined as any,
    };
    const chained = chainMarkLinesFromSeed([...square, noGeometry, boundary], "bottom", false);
    expect(chained.map((l) => l.id)).toEqual([
      "bottom",
      "right",
      "top",
      "left",
      "stray",
      "vbox",
    ]);
  });

  it("no-ops (returns marks/others unchanged) when the seed id is not a placeable mark", () => {
    const chained = chainMarkLinesFromSeed(square, "does-not-exist", false);
    expect(chained.map((l) => l.id)).toEqual(square.map((l) => l.id));
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
