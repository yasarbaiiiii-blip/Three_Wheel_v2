/**
 * Extension connectors — where travel joins the chain, and where it must not.
 *
 * The rover has one rule once extensions exist: travel spans **exit tip → next entry tip**,
 * never mark-end → next mark-start. Two passes implement it and agree —
 * `_entity_transit_previews` (preview) and `_insert_transit_connectors_between_segments`
 * (the only routing pass once extensions are on). Connecting mark-to-mark instead makes the
 * rover drive out along AFT, back over it, across, then out along PRE again: two reversals
 * per junction with the run-ups exactly cancelled.
 */

import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildExtendedMarkChain,
  buildExtensionTransitLines,
  edgeEntryPoint,
  edgeExitPoint,
  EXT_SEGMENT_JOIN_TOL_M,
} from "./missionExtensions";
import { buildTrajectory } from "./missionTrajectory";

function poly(
  id: string,
  pts: Array<[number, number]>,
  opts: { closed?: boolean; type?: string } = {}
): PlanLine {
  const points = opts.closed && pts.length >= 2 ? [...pts, pts[0]] : pts;
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: points[0][0], y: points[0][1] },
    to: { id: 2, x: points[points.length - 1][0], y: points[points.length - 1][1] },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: opts.type ?? "LWPOLYLINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: { closed: Boolean(opts.closed) },
      preview_points: points.map(([n, e]) => ({ north: n, east: e })),
    },
  };
}

const PER_LINE = { enabled: true, preM: 0.5, aftM: 0.5, perLine: true };
const CHAIN_ENDS = { enabled: true, preM: 0.5, aftM: 0.5, perLine: false };

describe("connector geometry", () => {
  it("joins AFT tip to the next PRE tip, not mark end to mark start", () => {
    // Two separate north-running lines, 10 m apart in east.
    const a = poly("a", [
      [0, 0],
      [5, 0],
    ]);
    const b = poly("b", [
      [0, 10],
      [5, 10],
    ]);

    const chain = buildExtendedMarkChain([a, b], CHAIN_ENDS);
    expect(chain).toHaveLength(2);

    const transits = buildExtensionTransitLines([a, b], CHAIN_ENDS);
    expect(transits).toHaveLength(1);

    const pts = transits[0].entity!.preview_points;
    const exit = edgeExitPoint(chain[0]);
    const entry = edgeEntryPoint(chain[1]);

    // Starts at a's AFT tip (5 m end + 0.5 m run-out = north 5.5), not at the mark end.
    expect(pts[0].north).toBeCloseTo(5.5, 6);
    expect(pts[0].north).toBeCloseTo(exit[0], 9);
    // Ends at b's PRE tip (0 m start − 0.5 m run-up = north −0.5), not at the mark start.
    expect(pts[1].north).toBeCloseTo(-0.5, 6);
    expect(pts[1].north).toBeCloseTo(entry[0], 9);
  });

  it("emits no connector where consecutive edges already touch", () => {
    // Straight 10 m line split into two collinear halves that meet at (5, 0).
    // Collinear junction → freeness blocks the run-ups there, so the ends coincide.
    const a = poly("a", [
      [0, 0],
      [5, 0],
    ]);
    const b = poly("b", [
      [5, 0],
      [10, 0],
    ]);

    const chain = buildExtendedMarkChain([a, b], PER_LINE);
    expect(chain[0].aft).toBeNull();
    expect(chain[1].pre).toBeNull();

    const gap = Math.hypot(
      edgeExitPoint(chain[0])[0] - edgeEntryPoint(chain[1])[0],
      edgeExitPoint(chain[0])[1] - edgeEntryPoint(chain[1])[1]
    );
    expect(gap).toBeLessThanOrEqual(EXT_SEGMENT_JOIN_TOL_M);
    expect(buildExtensionTransitLines([a, b], PER_LINE)).toHaveLength(0);
  });

  it("closed square per-line: 4 sides, each with its own corner connectors", () => {
    const square = poly(
      "sq",
      [
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ],
      { closed: true }
    );

    const chain = buildExtendedMarkChain([square], PER_LINE);
    expect(chain).toHaveLength(4);
    for (const item of chain) {
      expect(item.pre).not.toBeNull();
      expect(item.aft).not.toBeNull();
    }
    // Three internal junctions between four sides (the chain is not re-closed).
    expect(buildExtensionTransitLines([square], PER_LINE)).toHaveLength(3);
  });

  it("does not split a curve at its tessellation vertices", () => {
    // An ARC arrives as many vertices; per-line must still treat it as ONE edge.
    const arcPts: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * (Math.PI / 2);
      arcPts.push([5 * Math.sin(t), 5 - 5 * Math.cos(t)]);
    }
    const arc = poly("arc", arcPts, { type: "ARC" });

    const chain = buildExtendedMarkChain([arc], PER_LINE);
    expect(chain).toHaveLength(1);
    expect(buildExtensionTransitLines([arc], PER_LINE)).toHaveLength(0);
  });
});

describe("trajectory follows the same chain the map draws", () => {
  it("closed square per-line → 4 mark runs separated by travel", () => {
    const square = poly(
      "sq",
      [
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ],
      { closed: true }
    );

    const { runs, warnings } = buildTrajectory([square], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      extensions: PER_LINE,
    });

    const marks = runs.filter((r) => r.kind === "mark");
    expect(marks).toHaveLength(4);

    // Backend rule 1: never two adjacent mark runs.
    for (let i = 0; i < runs.length - 1; i++) {
      expect(runs[i].kind === "mark" && runs[i + 1].kind === "mark").toBe(false);
    }
    // Backend rules 2/3: every boundary must touch within the join tolerance.
    for (let i = 0; i < runs.length - 1; i++) {
      const end = runs[i].points[runs[i].points.length - 1];
      const next = runs[i + 1].points[0];
      expect(Math.hypot(end[0] - next[0], end[1] - next[1])).toBeLessThanOrEqual(0.05);
    }
    expect(warnings.filter((w) => w.startsWith("INTERNAL"))).toHaveLength(0);
  });

  it("chain-ends on a closed path still yields one continuous mark run", () => {
    const square = poly(
      "sq",
      [
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ],
      { closed: true }
    );

    const { runs } = buildTrajectory([square], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      extensions: CHAIN_ENDS,
    });

    expect(runs.filter((r) => r.kind === "mark")).toHaveLength(1);
    expect(runs.filter((r) => r.kind === "travel")).toHaveLength(0);
  });

  it("travel out and back in is one run, not two adjacent travel legs", () => {
    const a = poly("a", [
      [0, 0],
      [5, 0],
    ]);
    const b = poly("b", [
      [0, 10],
      [5, 10],
    ]);

    const { runs } = buildTrajectory([a, b], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      extensions: CHAIN_ENDS,
    });

    for (let i = 0; i < runs.length - 1; i++) {
      expect(runs[i].kind === "travel" && runs[i + 1].kind === "travel").toBe(false);
    }
    // pre-ext, mark a, [aft a + connector + pre b], mark b, aft-ext
    expect(runs.map((r) => r.kind)).toEqual([
      "travel",
      "mark",
      "travel",
      "mark",
      "travel",
    ]);
    // The middle travel carries AFT, the crossing, and PRE as one continuous leg.
    const middle = runs[2];
    expect(middle.points.length).toBeGreaterThanOrEqual(4);
    expect(middle.points[0][0]).toBeCloseTo(5, 6);
    expect(middle.points[middle.points.length - 1][0]).toBeCloseTo(0, 6);
  });
});
