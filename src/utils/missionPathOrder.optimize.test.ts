/**
 * Ordering improvement passes (2-opt, or-opt, wet-paint awareness) layered on the greedy
 * chain, and curve reversal. Port of the rover's `optimize_segment_order`
 * (`path_engine/optimizers/segment_order.py`).
 */

import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { parseLocalDxf } from "./dxfLocalImport";
import {
  analyticCurveTangents,
  buildCsvExtensionLines,
  buildExtendedMarkChain,
  dxfArcTangent,
} from "./missionExtensions";
import {
  absHeadingChangeDeg,
  CHAIN_OPTIMIZE_MAX_MARKS,
  chainMarkLinesByGeometry,
  chainMarkLinesFromSeed,
  entryHeadingDeg,
  evaluateMarkOrder,
  exitHeadingDeg,
  reversePlanLineDirection,
  WET_PAINT_PENALTY_M,
} from "./missionPathOrder";
import { buildTrajectory, planLineToNedPolyline } from "./missionTrajectory";

type Pt = [number, number];

function seg(id: string, a: Pt, b: Pt): PlanLine {
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

function segs(coords: [Pt, Pt][], prefix = "m"): PlanLine[] {
  return coords.map(([a, b], i) => seg(`${prefix}${i}`, a, b));
}

/** Deterministic generator for the property checks (Numerical Recipes LCG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffled<T>(items: T[], rnd: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function ends(line: PlanLine): { start: Pt; end: Pt } {
  const p = planLineToNedPolyline(line)!;
  return { start: p[0], end: p[p.length - 1] };
}

function ids(lines: PlanLine[]): string[] {
  return lines.map((l) => l.id);
}

/**
 * The greedy this module used before the improvement passes: multi-start nearest-endpoint,
 * lines only, scored by transit distance. Kept here as the baseline the passes must beat.
 */
function baselineGreedy(placeable: PlanLine[]): PlanLine[] {
  const gap = (chain: PlanLine[]) => {
    let t = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = ends(chain[i]).end;
      const b = ends(chain[i + 1]).start;
      t += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return t;
  };
  const walk = (seedIdx: number, reversed: boolean): PlanLine[] => {
    const remaining = placeable.slice();
    const [seed] = remaining.splice(seedIdx, 1);
    const chain = [reversed ? reversePlanLineDirection(seed) : seed];
    let cursor = ends(chain[0]).end;
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      let bestRev = false;
      remaining.forEach((l, idx) => {
        const e = ends(l);
        const f = Math.hypot(e.start[0] - cursor[0], e.start[1] - cursor[1]);
        if (f < bestDist) {
          bestDist = f;
          bestIdx = idx;
          bestRev = false;
        }
        const b = Math.hypot(e.end[0] - cursor[0], e.end[1] - cursor[1]);
        if (b < bestDist) {
          bestDist = b;
          bestIdx = idx;
          bestRev = true;
        }
      });
      const [picked] = remaining.splice(bestIdx, 1);
      const next = bestRev ? reversePlanLineDirection(picked) : picked;
      chain.push(next);
      cursor = ends(next).end;
    }
    return chain;
  };
  let best = walk(0, false);
  let bestTotal = gap(best);
  for (let i = 0; i < placeable.length; i++) {
    for (const reversed of [false, true]) {
      if (i === 0 && !reversed) continue;
      const candidate = walk(i, reversed);
      const total = gap(candidate);
      if (total < bestTotal) {
        bestTotal = total;
        best = candidate;
      }
    }
  }
  return best;
}

function legsOf(chain: PlanLine[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    out.push([ends(chain[i]).end, ends(chain[i + 1]).start]);
  }
  return out;
}

function properlyCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/** Number of pairs of transit legs that cross each other. */
function crossingLegPairs(chain: PlanLine[]): number {
  const legs = legsOf(chain);
  let count = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (properlyCross(legs[i][0], legs[i][1], legs[j][0], legs[j][1])) count++;
    }
  }
  return count;
}

/** Cheapest possible transit over every order and direction (small n only). */
function bruteForceDeadheadM(lines: PlanLine[]): number {
  const e = lines.map(ends);
  let best = Infinity;
  const rec = (used: number, cursor: Pt | null, cost: number) => {
    if (cost >= best) return;
    if (used === (1 << e.length) - 1) {
      best = cost;
      return;
    }
    for (let i = 0; i < e.length; i++) {
      if (used & (1 << i)) continue;
      for (const [s, t] of [
        [e[i].start, e[i].end],
        [e[i].end, e[i].start],
      ] as [Pt, Pt][]) {
        rec(used | (1 << i), t, cost + (cursor ? Math.hypot(s[0] - cursor[0], s[1] - cursor[1]) : 0));
      }
    }
  };
  rec(0, null, 0);
  return best;
}

const flip = reversePlanLineDirection;

function sliceReversals(route: PlanLine[]): PlanLine[][] {
  const out: PlanLine[][] = [];
  for (let i = 0; i < route.length; i++) {
    for (let k = i + 1; k < route.length; k++) {
      out.push([
        ...route.slice(0, i),
        ...route.slice(i, k + 1).reverse().map(flip),
        ...route.slice(k + 1),
      ]);
    }
  }
  return out;
}

function relocations(route: PlanLine[]): PlanLine[][] {
  const out: PlanLine[][] = [];
  for (let i = 0; i < route.length; i++) {
    const rest = [...route.slice(0, i), ...route.slice(i + 1)];
    for (let j = 0; j <= rest.length; j++) {
      if (j === i) continue;
      for (const mark of [route[i], flip(route[i])]) {
        out.push([...rest.slice(0, j), mark, ...rest.slice(j)]);
      }
    }
  }
  return out;
}

const minCost = (candidates: PlanLine[][]) =>
  Math.min(...candidates.map((c) => evaluateMarkOrder(c).totalM));

describe("2-opt", () => {
  // Greedy leaves two transit legs crossing. Reversing the slice between them fixes it; no
  // single relocation of a mark does.
  const crossed = segs([
    [[3.6, 3.4], [4, 3.7]],
    [[3.5, 6.9], [2.7, 6.8]],
    [[1, 4.3], [0.6, 4.2]],
    [[3, 7.6], [2.4, 8.5]],
    [[3.6, 5.1], [2.8, 4.5]],
    [[1.6, 4], [2.4, 3.8]],
  ]);

  it("the instance is one only a slice reversal improves", () => {
    const greedy = baselineGreedy(crossed);
    const cost = evaluateMarkOrder(greedy).totalM;
    expect(minCost(relocations(greedy))).toBeGreaterThanOrEqual(cost - 1e-9);
    expect(minCost(sliceReversals(greedy))).toBeLessThan(cost - 0.1);
  });

  it("removes a crossing the greedy walk leaves and reaches the optimum", () => {
    const greedy = baselineGreedy(crossed);
    expect(crossingLegPairs(greedy)).toBeGreaterThan(0);

    const chained = chainMarkLinesByGeometry(crossed);
    expect(crossingLegPairs(chained)).toBe(0);

    const before = evaluateMarkOrder(greedy);
    const after = evaluateMarkOrder(chained);
    expect(before.wetPaintPenaltyM).toBe(0);
    expect(after.wetPaintPenaltyM).toBe(0);
    expect(after.deadheadM).toBeLessThan(before.deadheadM - 0.1);
    expect(after.deadheadM).toBeCloseTo(bruteForceDeadheadM(crossed), 9);
  });

  it("keeps every mark exactly once", () => {
    const chained = chainMarkLinesByGeometry(crossed);
    expect(ids(chained).sort()).toEqual(ids(crossed).sort());
  });
});

describe("or-opt", () => {
  // The greedy route is a 2-opt local optimum (no slice reversal helps) yet one mark sits in
  // the wrong place: only lifting it out and re-inserting it elsewhere improves it.
  const stranded = segs([
    [[4.3, 2.7], [4.4, 3.1]],
    [[6.9, 1.9], [7.5, 2.6]],
    [[1.7, 7.1], [1.3, 8]],
    [[4.1, 6.3], [3.7, 6.9]],
    [[3.7, 3.1], [3.1, 3]],
    [[4, 1.7], [4, 1.5]],
  ]);

  it("the instance is a 2-opt optimum that relocation can still improve", () => {
    const greedy = baselineGreedy(stranded);
    const cost = evaluateMarkOrder(greedy).totalM;
    expect(minCost(sliceReversals(greedy))).toBeGreaterThanOrEqual(cost - 1e-9);
    expect(minCost(relocations(greedy))).toBeLessThan(cost - 0.1);
  });

  it("relocates the stranded mark and reaches the optimum", () => {
    const greedy = baselineGreedy(stranded);
    const chained = chainMarkLinesByGeometry(stranded);
    const after = evaluateMarkOrder(chained);
    expect(after.totalM).toBeLessThan(evaluateMarkOrder(greedy).totalM - 0.1);
    expect(after.totalM).toBeLessThanOrEqual(minCost(relocations(greedy)) + 1e-9);
    expect(after.deadheadM).toBeCloseTo(bruteForceDeadheadM(stranded), 9);
  });
});

describe("wet-paint awareness", () => {
  /**
   * A 4 m square with a small cross inside it, between two outside marks. Walking the
   * square first is a hair cheaper, but then the way out of the cross drives over the
   * finished square.
   */
  const enclosed: PlanLine[] = [
    seg("e1", [-4, -9], [-4, -8]),
    seg("qb", [-2, -2], [-2, 2]),
    seg("qr", [-2, 2], [2, 2]),
    seg("qt", [2, 2], [2, -2]),
    seg("ql", [2, -2], [-2, -2]),
    seg("ph", [0, -0.5], [0, 0.5]),
    seg("pv", [-0.5, 0], [0.5, 0]),
    seg("e2", [-6, 2], [-6, 3]),
  ];

  it("the unpenalised greedy order paints the square before the cross and drives over it", () => {
    const greedy = baselineGreedy(enclosed);
    const order = ids(greedy);
    expect(order.indexOf("qb")).toBeLessThan(order.indexOf("ph"));
    expect(evaluateMarkOrder(greedy).wetPaintPenaltyM).toBeGreaterThanOrEqual(
      2 * WET_PAINT_PENALTY_M
    );
  });

  it("marks the inner cross before any side of the enclosing square", () => {
    const chained = chainMarkLinesByGeometry(enclosed);
    const order = ids(chained);
    const lastCross = Math.max(order.indexOf("ph"), order.indexOf("pv"));
    const firstSide = Math.min(...["qb", "qr", "qt", "ql"].map((s) => order.indexOf(s)));
    expect(lastCross).toBeLessThan(firstSide);
    expect(order).not.toEqual(ids(baselineGreedy(enclosed)));

    const cost = evaluateMarkOrder(chained);
    expect(cost.wetPaintPenaltyM).toBe(0);
    // The detour that buys this costs far less than the paint it saves.
    expect(cost.deadheadM).toBeLessThan(evaluateMarkOrder(baselineGreedy(enclosed)).deadheadM + 1);
  });

  it("run-up and run-out lengths decide what a connector drives over", () => {
    // Plain mark-end to mark-start, a -> b passes west of the short wall. With run-ups the
    // connector runs tip to tip, swings east, and drives over the wall that is already down.
    const wall = seg("wall", [3, 3], [3, 5]);
    const a = seg("a", [0, 0], [0, 4]);
    const b = seg("b", [6, 0], [6, 4]);
    const plain = evaluateMarkOrder([wall, a, b]);
    const extended = evaluateMarkOrder([wall, a, b], {
      extensionConfig: { enabled: true, preM: 0.5, aftM: 5 },
    });
    expect(plain.wetPaintPenaltyM).toBe(0);
    expect(extended.wetPaintPenaltyM).toBe(WET_PAINT_PENALTY_M);
    // Crossing it before it is painted is free.
    const wallLast = evaluateMarkOrder([a, b, wall], {
      extensionConfig: { enabled: true, preM: 0.5, aftM: 5 },
    });
    expect(wallLast.wetPaintPenaltyM).toBe(0);
  });
});

describe("mark cap", () => {
  /** The crossed-route instance plus a far, already-contiguous chain of filler marks. */
  function withFiller(total: number): PlanLine[] {
    const core = segs([
      [[2.7, 5], [3.7, 4.3]],
      [[4.9, 2.4], [4.7, 3.4]],
      [[5.8, 1], [4.9, 0.5]],
      [[6.6, 2.2], [7.3, 2.1]],
      [[3.1, 3.6], [3.3, 4.1]],
      [[4.2, 7], [4.2, 7.2]],
    ]);
    const filler: PlanLine[] = [];
    for (let i = 0; i < total - core.length; i++) {
      filler.push(seg(`f${i}`, [1000, i], [1000, i + 1]));
    }
    return [...core, ...filler];
  }

  const key = (chain: PlanLine[]) =>
    chain.map((l) => `${l.id}:${ends(l).start.join(",")}>${ends(l).end.join(",")}`);

  it("exposes the cap as 80", () => {
    expect(CHAIN_OPTIMIZE_MAX_MARKS).toBe(80);
  });

  it("improves at the cap", () => {
    const lines = withFiller(CHAIN_OPTIMIZE_MAX_MARKS);
    const greedy = evaluateMarkOrder(baselineGreedy(lines)).totalM;
    expect(evaluateMarkOrder(chainMarkLinesByGeometry(lines)).totalM).toBeLessThan(greedy - 0.1);
  });

  it("returns the plain greedy result one mark above the cap", () => {
    const lines = withFiller(CHAIN_OPTIMIZE_MAX_MARKS + 1);
    expect(key(chainMarkLinesByGeometry(lines))).toEqual(key(baselineGreedy(lines)));
  });
});

describe("determinism", () => {
  const instance = segs([
    [[2.7, 5], [3.7, 4.3]],
    [[4.9, 2.4], [4.7, 3.4]],
    [[5.8, 1], [4.9, 0.5]],
    [[6.6, 2.2], [7.3, 2.1]],
    [[3.1, 3.6], [3.3, 4.1]],
    [[4.2, 7], [4.2, 7.2]],
  ]);

  it("same input, same output", () => {
    expect(chainMarkLinesByGeometry(instance)).toEqual(chainMarkLinesByGeometry(instance));
    expect(
      chainMarkLinesFromSeed(instance, "m2", false)
    ).toEqual(chainMarkLinesFromSeed(instance, "m2", false));
  });

  it("does not depend on the order the marks arrive in", () => {
    const reference = evaluateMarkOrder(chainMarkLinesByGeometry(instance)).totalM;
    const rnd = lcg(2024);
    for (let i = 0; i < 12; i++) {
      const total = evaluateMarkOrder(chainMarkLinesByGeometry(shuffled(instance, rnd))).totalM;
      expect(total).toBeCloseTo(reference, 9);
    }
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(instance);
    chainMarkLinesByGeometry(instance);
    chainMarkLinesFromSeed(instance, "m1", true);
    expect(JSON.stringify(instance)).toBe(before);
  });
});

describe("property: never worse than the greedy walk", () => {
  it("holds on seeded random instances, with and without extensions", () => {
    const rnd = lcg(99);
    let improved = 0;
    for (let trial = 0; trial < 60; trial++) {
      const n = 4 + Math.floor(rnd() * 12);
      const lines: PlanLine[] = [];
      for (let i = 0; i < n; i++) {
        const a: Pt = [Math.round(rnd() * 100) / 10, Math.round(rnd() * 100) / 10];
        const b: Pt = [
          a[0] + Math.round((rnd() * 2 - 1) * 40) / 10,
          a[1] + Math.round((rnd() * 2 - 1) * 40) / 10,
        ];
        if (a[0] === b[0] && a[1] === b[1]) b[0] += 0.5;
        lines.push(seg(`r${i}`, a, b));
      }
      const options =
        trial % 2 === 0
          ? undefined
          : { extensionConfig: { enabled: true, preM: 0.5, aftM: 0.5 } };
      const greedyCost = evaluateMarkOrder(baselineGreedy(lines), options).totalM;
      const chained = chainMarkLinesByGeometry(lines, options);
      const cost = evaluateMarkOrder(chained, options).totalM;
      expect(cost).toBeLessThanOrEqual(greedyCost + 1e-9);
      expect(ids(chained).sort()).toEqual(ids(lines).sort());
      if (cost < greedyCost - 1e-6) improved++;
    }
    // Not vacuous: the passes found something on a good share of instances.
    expect(improved).toBeGreaterThan(5);
  });
});

describe("pinned seed", () => {
  const lines = segs([
    [[2.7, 5], [3.7, 4.3]],
    [[4.9, 2.4], [4.7, 3.4]],
    [[5.8, 1], [4.9, 0.5]],
    [[6.6, 2.2], [7.3, 2.1]],
    [[3.1, 3.6], [3.3, 4.1]],
    [[4.2, 7], [4.2, 7.2]],
  ]);

  it("keeps the operator seed first and in the requested direction", () => {
    for (const seedFromEnd of [false, true]) {
      for (const seedId of ids(lines)) {
        const chained = chainMarkLinesFromSeed(lines, seedId, seedFromEnd);
        const original = ends(lines.find((l) => l.id === seedId)!);
        expect(chained[0].id).toBe(seedId);
        expect(ends(chained[0]).start).toEqual(seedFromEnd ? original.end : original.start);
        expect(ids(chained).sort()).toEqual(ids(lines).sort());
      }
    }
  });

  it("optimises the rest and is never worse than the plain seeded walk", () => {
    let improved = 0;
    for (const seedId of ids(lines)) {
      const chained = chainMarkLinesFromSeed(lines, seedId, false);
      // Plain seeded greedy = the same call on a list too long to optimise is not
      // comparable, so rebuild it: seed first, then nearest endpoint each step.
      const seed = lines.find((l) => l.id === seedId)!;
      const remaining = lines.filter((l) => l.id !== seedId);
      const walk: PlanLine[] = [seed];
      let cursor = ends(seed).end;
      while (remaining.length > 0) {
        let bi = 0;
        let bd = Infinity;
        let br = false;
        remaining.forEach((l, idx) => {
          const e = ends(l);
          const f = Math.hypot(e.start[0] - cursor[0], e.start[1] - cursor[1]);
          if (f < bd) {
            bd = f;
            bi = idx;
            br = false;
          }
          const b = Math.hypot(e.end[0] - cursor[0], e.end[1] - cursor[1]);
          if (b < bd) {
            bd = b;
            bi = idx;
            br = true;
          }
        });
        const [p] = remaining.splice(bi, 1);
        const next = br ? flip(p) : p;
        walk.push(next);
        cursor = ends(next).end;
      }
      const base = evaluateMarkOrder(walk).totalM;
      const got = evaluateMarkOrder(chained).totalM;
      expect(got).toBeLessThanOrEqual(base + 1e-9);
      if (got < base - 1e-6) improved++;
    }
    expect(improved).toBeGreaterThan(0);
  });
});

describe("small and mixed inputs", () => {
  it("leaves a single mark untouched", () => {
    const only = seg("only", [0, 0], [0, 5]);
    const out = chainMarkLinesByGeometry([only]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(only);
  });

  it("leaves two marks that already join untouched", () => {
    const a = seg("a", [0, 0], [0, 5]);
    const b = seg("b", [0, 5], [0, 9]);
    const out = chainMarkLinesByGeometry([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("still appends unplaceable marks and non-mark lines after the optimised chain", () => {
    const stray: PlanLine = {
      ...seg("stray", [0, 0], [0, 1]),
      entity: { ...seg("stray", [0, 0], [0, 1]).entity!, preview_points: [] },
      from: undefined as never,
      to: undefined as never,
    };
    const boundary: PlanLine = { ...seg("vbox", [0, 0], [0, 1]), layer: "virtual_boundary" };
    const marks = segs([
      [[2.7, 5], [3.7, 4.3]],
      [[4.9, 2.4], [4.7, 3.4]],
      [[5.8, 1], [4.9, 0.5]],
      [[6.6, 2.2], [7.3, 2.1]],
      [[3.1, 3.6], [3.3, 4.1]],
    ]);
    const out = chainMarkLinesByGeometry([stray, ...marks, boundary]);
    expect(ids(out).slice(0, 5).sort()).toEqual(ids(marks).sort());
    expect(ids(out).slice(5)).toEqual(["stray", "vbox"]);
  });
});

describe("start position", () => {
  const a = seg("a", [0, 0], [0, 10]);
  const b = seg("b", [0, 20], [0, 30]);

  it("without one, behaves as before", () => {
    const base = chainMarkLinesByGeometry([a, b]);
    expect(chainMarkLinesByGeometry([a, b], undefined)).toEqual(base);
    expect(chainMarkLinesByGeometry([a, b], {})).toEqual(base);
    expect(chainMarkLinesByGeometry([a, b], { startPosition: null })).toEqual(base);
    expect(ids(base)).toEqual(["a", "b"]);
  });

  it("begins at the mark nearest the rover, entered from its nearer end", () => {
    const chained = chainMarkLinesByGeometry([a, b], { startPosition: [0, 33] });
    expect(ids(chained)).toEqual(["b", "a"]);
    expect(ends(chained[0]).start).toEqual([0, 30]);
    expect(ends(chained[1]).start).toEqual([0, 10]);
  });

  it("counts the entry leg from the rover in the cost", () => {
    const start: [number, number] = [0, -4];
    const without = evaluateMarkOrder([a, b]);
    const withStart = evaluateMarkOrder([a, b], { startPosition: start });
    expect(withStart.deadheadM).toBeCloseTo(without.deadheadM + 4, 9);
  });

  it("lets the entry leg decide between otherwise equal walks", () => {
    const x = seg("x", [0, 0], [0, 10]);
    const y = seg("y", [0, 10], [0, 20]);
    const fromEast = chainMarkLinesByGeometry([x, y], { startPosition: [0, 25] });
    expect(ids(fromEast)).toEqual(["y", "x"]);
    expect(ends(fromEast[0]).start).toEqual([0, 20]);
    const fromWest = chainMarkLinesByGeometry([x, y], { startPosition: [0, -5] });
    expect(ids(fromWest)).toEqual(["x", "y"]);
  });

  it("turns a lone mark to enter it from the nearer end", () => {
    const only = seg("only", [0, 0], [0, 10]);
    const out = chainMarkLinesByGeometry([only], { startPosition: [0, 12] });
    expect(ends(out[0]).start).toEqual([0, 10]);
    expect(chainMarkLinesByGeometry([only])[0]).toBe(only);
  });

  it("is never worse than ignoring the rover (seeded random)", () => {
    const rnd = lcg(5);
    for (let trial = 0; trial < 30; trial++) {
      const n = 3 + Math.floor(rnd() * 8);
      const lines: PlanLine[] = [];
      for (let i = 0; i < n; i++) {
        const p: Pt = [Math.round(rnd() * 100) / 10, Math.round(rnd() * 100) / 10];
        lines.push(seg(`s${i}`, p, [p[0] + 1 + rnd(), p[1] + rnd()]));
      }
      const options = { startPosition: [rnd() * 10, rnd() * 10] as [number, number] };
      const aware = evaluateMarkOrder(chainMarkLinesByGeometry(lines, options), options).totalM;
      const blind = evaluateMarkOrder(chainMarkLinesByGeometry(lines), options).totalM;
      expect(aware).toBeLessThanOrEqual(blind + 1e-9);
    }
  });
});

describe("curves are driven either way", () => {
  function parsedArc(): PlanLine {
    const dxf = [
      "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n",
      "0\nSECTION\n2\nENTITIES\n",
      "0\nARC\n8\n0\n10\n0\n20\n0\n40\n2\n50\n0\n51\n90\n",
      "0\nENDSEC\n0\nEOF\n",
    ].join("");
    return parseLocalDxf(dxf, "quarter_arc.dxf").lines[0];
  }

  function parsedCircle(): PlanLine {
    const dxf = [
      "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n",
      "0\nSECTION\n2\nENTITIES\n",
      "0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n1.5\n",
      "0\nENDSEC\n0\nEOF\n",
    ].join("");
    return parseLocalDxf(dxf, "circle.dxf").lines[0];
  }

  const CFG = { enabled: true, preM: 0.5, aftM: 0.5, perLine: true };
  const near = (p: Pt, q: Pt, tol = 1e-6) =>
    Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;

  // The arc runs (0,2) -> (2,0). A line arrives at its END and another leaves from its START,
  // so the zero-transit walk drives the arc backwards.
  it("reverses an arc when entering it from its far end removes the transit", () => {
    const arc = parsedArc();
    const lead = seg("lead", [6, 0], [2, 0]);
    const tail = seg("tail", [0, 2], [0, 6]);
    const chained = chainMarkLinesByGeometry([lead, arc, tail]);

    expect(ids(chained)).toEqual(["lead", arc.id, "tail"]);
    const placed = ends(chained[1]);
    expect(near(placed.start, [2, 0])).toBe(true);
    expect(near(placed.end, [0, 2])).toBe(true);
    expect(evaluateMarkOrder(chained).deadheadM).toBeLessThan(1e-9);
    // The arc's own line is untouched.
    expect(near(ends(arc).start, [0, 2])).toBe(true);
  });

  it("flips the extension tangents of a reversed arc", () => {
    const arc = parsedArc();
    const [fwdStart, fwdEnd] = analyticCurveTangents(arc)!;
    const rev = flip(arc);
    const [revStart, revEnd] = analyticCurveTangents(rev)!;

    expect(revStart[0]).toBeCloseTo(-fwdEnd[0], 9);
    expect(revStart[1]).toBeCloseTo(-fwdEnd[1], 9);
    expect(revEnd[0]).toBeCloseTo(-fwdStart[0], 9);
    expect(revEnd[1]).toBeCloseTo(-fwdStart[1], 9);
    // Forward arc: start tangent is +north at 0 deg, end tangent -east at 90 deg.
    expect(fwdStart).toEqual(dxfArcTangent(0));
    expect(fwdEnd[1]).toBeCloseTo(-1, 9);
    // Reversing twice is the original again.
    const [againStart, againEnd] = analyticCurveTangents(flip(rev))!;
    expect(againStart[0]).toBeCloseTo(fwdStart[0], 9);
    expect(againEnd[1]).toBeCloseTo(fwdEnd[1], 9);
  });

  it("points the run-up of a reversed arc away from the arc along the tangent", () => {
    const rev = flip(parsedArc());
    const pts = planLineToNedPolyline(rev)!;
    const chain = buildExtendedMarkChain([rev], CFG);
    expect(chain).toHaveLength(1);
    const { pre, aft } = chain[0];

    // Driven (2,0) -> (0,2), clockwise: arrives heading +east at the start, leaves heading
    // -north at the end.
    const start = pts[0];
    const end = pts[pts.length - 1];
    expect(pre).not.toBeNull();
    expect(pre![0][0]).toBeCloseTo(start[0], 6);
    expect(pre![0][1]).toBeCloseTo(start[1] - 0.5, 6);
    expect(aft).not.toBeNull();
    expect(aft![1][0]).toBeCloseTo(end[0] - 0.5, 6);
    expect(aft![1][1]).toBeCloseTo(end[1], 6);

    // Behind the start (against the first chord), ahead of the end (along the last chord).
    const firstChord: Pt = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
    const lastChord: Pt = [
      pts[pts.length - 1][0] - pts[pts.length - 2][0],
      pts[pts.length - 1][1] - pts[pts.length - 2][1],
    ];
    const preVec: Pt = [pre![0][0] - start[0], pre![0][1] - start[1]];
    const aftVec: Pt = [aft![1][0] - end[0], aft![1][1] - end[1]];
    expect(preVec[0] * firstChord[0] + preVec[1] * firstChord[1]).toBeLessThan(0);
    expect(aftVec[0] * lastChord[0] + aftVec[1] * lastChord[1]).toBeGreaterThan(0);
  });

  it("builds a reversed arc into a travel, mark, travel trajectory that touches end to end", () => {
    const rev = flip(parsedArc());
    const { runs } = buildTrajectory([rev], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      extensions: CFG,
    });
    expect(runs.map((r) => r.kind)).toEqual(["travel", "mark", "travel"]);
    const mark = runs[1].points;
    expect(near(mark[0], [2, 0])).toBe(true);
    expect(near(mark[mark.length - 1], [0, 2])).toBe(true);
    for (let i = 0; i < runs.length - 1; i++) {
      const tail = runs[i].points[runs[i].points.length - 1];
      expect(near(tail, runs[i + 1].points[0], 0.05)).toBe(true);
    }
    // Run-up tip sits behind the reversed start: west of it.
    expect(runs[0].points[0][1]).toBeCloseTo(-0.5, 6);
  });

  it("keeps heading helpers consistent with the reversed polyline", () => {
    const arc = parsedArc();
    const rev = flip(arc);
    const fwdPts = planLineToNedPolyline(arc)!;
    const revPts = planLineToNedPolyline(rev)!;
    expect(revPts).toEqual([...fwdPts].reverse());
    expect(absHeadingChangeDeg(exitHeadingDeg(revPts)!, entryHeadingDeg(fwdPts)!)).toBeCloseTo(
      180,
      6
    );
  });

  it("keeps a reversed CIRCLE closed, with run-up and run-out flipped", () => {
    const circle = parsedCircle();
    const rev = flip(circle);
    const pts = planLineToNedPolyline(rev)!;
    expect(near(pts[0], pts[pts.length - 1], 1e-6)).toBe(true);
    expect(near(pts[0], planLineToNedPolyline(circle)![0], 1e-6)).toBe(true);

    const [s, e] = analyticCurveTangents(rev)!;
    expect(s[0]).toBeCloseTo(-1, 9);
    expect(e[0]).toBeCloseTo(-1, 9);

    // Forward: tangent +north at the start, so PRE comes from the south. Reversed it is
    // driven the other way round, so PRE comes from the north.
    const fwdPre = buildCsvExtensionLines([circle], CFG).find((l) => l.segmentRole === "pre")!;
    const revPre = buildCsvExtensionLines([rev], CFG).find((l) => l.segmentRole === "pre")!;
    const start = pts[0];
    expect(fwdPre.entity!.preview_points![0].north).toBeCloseTo(start[0] - 0.5, 6);
    expect(revPre.entity!.preview_points![0].north).toBeCloseTo(start[0] + 0.5, 6);
  });
});
