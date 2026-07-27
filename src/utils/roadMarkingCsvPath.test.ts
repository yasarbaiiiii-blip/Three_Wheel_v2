import { describe, expect, it } from "vitest";
import {
  buildRoadMarkingPreviewPoints,
  ensureOpenPath,
  filletSharpCorners,
  fitCircleHyper,
  fitCircleKasa,
  geometricFilletFromTangents,
  dampenOppositeJogs,
  maxOppositeTurnPairDeg,
  maxTurningAngleDeg,
  rejectPathSpikes,
  segmentIntoPrimitives,
  turningAngleDeg,
  estimateAdaptiveTolerance,
  tryWholeLoopFit,
  mergeAdjacentPrimitives,
  dropNegligibleArcs,
  absorbSandwichedCornerArcs,
  splitIntoOpenPathGroups,
  tessellatePrimitivesWithJointFillets,
  type RoadMarkingNedPoint,
  type PathPrimitive,
} from "./roadMarkingCsvPath";

/** Deterministic pseudo-noise so fixtures are reproducible without Math.random. */
function detNoise(i: number, mag: number): number {
  return (Math.sin(i * 12.9898) * 43758.5453 % 1) * mag;
}

describe("ensureOpenPath", () => {
  it("drops last point when path would form a closed ring", () => {
    const pts = [
      { north: 0, east: 0 },
      { north: 1, east: 0 },
      { north: 1, east: 1 },
      { north: 0, east: 0 },
    ];
    const open = ensureOpenPath(pts);
    expect(open).toHaveLength(3);
    expect(open[0]).toEqual({ north: 0, east: 0 });
    expect(open[open.length - 1]).toEqual({ north: 1, east: 1 });
  });

  it("keeps open paths unchanged", () => {
    const pts = [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
      { north: 10, east: 1 },
    ];
    expect(ensureOpenPath(pts)).toEqual(pts);
  });
});

describe("fitCircleHyper (Chernov HyperLS)", () => {
  it("fits a long quarter-circle accurately", () => {
    const r = 10;
    const arc = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 23) * (Math.PI / 2);
      return { north: r * Math.sin(a), east: r * Math.cos(a) };
    });
    const hyper = fitCircleHyper(arc);
    expect(hyper).not.toBeNull();
    expect(hyper!.r).toBeCloseTo(10, 1);
    expect(hyper!.cn).toBeCloseTo(0, 1);
    expect(hyper!.ce).toBeCloseTo(0, 1);
  });

  it("matches Chernov A1 on short noisy arc (tighter than Kåsa and loose +0.5)", () => {
    // Failure mode that exposed the buggy A1 (wrong cubic → Newton clamp at x=0).
    // 9 pts, ~25° span, true R=15, deterministic noise.
    const trueR = 15;
    const span = (25 * Math.PI) / 180;
    const noise = [0.04, -0.05, 0.03, -0.02, 0.06, -0.03, 0.02, -0.04, 0.01];
    const arc = Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      const a = t * span;
      const n = noise[i];
      return {
        north: trueR * Math.sin(a) + n * 0.5,
        east: trueR * Math.cos(a) + n * 0.4,
      };
    });

    const hyper = fitCircleHyper(arc);
    const kasa = fitCircleKasa(arc);
    expect(hyper).not.toBeNull();
    expect(kasa).not.toBeNull();

    const errH = Math.abs(hyper!.r - trueR);
    const errK = Math.abs(kasa!.r - trueR);
    // Real Hyper must beat Kåsa and stay within a tight absolute band.
    expect(errH).toBeLessThan(errK);
    expect(errH).toBeLessThan(0.2);
    // Regression: buggy A1 typically landed ~0.26–0.31 error on this class.
    expect(errH).toBeLessThan(0.15);
  });

  it("stays in a tight absolute band on sparse short arc (variance ≠ bias)", () => {
    // On a single noisy draw, Kåsa can luckily beat Hyper (same leading variance).
    // Hyper's contract is low bias / correct cubic, not winning every sample.
    const trueR = 40;
    const span = (18 * Math.PI) / 180;
    const a0 = 0.2;
    const noise = [0.02, -0.03, 0.015, -0.01, 0.025, -0.02, 0.01];
    const arc = Array.from({ length: 7 }, (_, i) => {
      const t = i / 6;
      const a = a0 + t * span;
      const n = noise[i % noise.length];
      return {
        north: trueR * Math.sin(a) + n * 0.4,
        east: trueR * Math.cos(a) + n * 0.3,
      };
    });

    const hyper = fitCircleHyper(arc);
    expect(hyper).not.toBeNull();
    expect(Math.abs(hyper!.r - trueR)).toBeLessThan(trueR * 0.08);
    expect(hyper!.r).toBeGreaterThan(trueR * 0.85);
    expect(hyper!.r).toBeLessThan(trueR * 1.15);
  });

  it("beats Kåsa on clean sparse short arc (Kåsa underestimates R)", () => {
    const trueR = 25;
    const span = (12 * Math.PI) / 180;
    const arc = Array.from({ length: 5 }, (_, i) => {
      const a = (i / 4) * span;
      return { north: trueR * Math.sin(a), east: trueR * Math.cos(a) + 100 };
    });
    const kasa = fitCircleKasa(arc);
    const hyper = fitCircleHyper(arc);
    expect(kasa).not.toBeNull();
    expect(hyper).not.toBeNull();
    expect(Math.abs(hyper!.r - trueR)).toBeLessThanOrEqual(
      Math.abs(kasa!.r - trueR) + 1e-6
    );
  });

  it("disagrees with the old buggy A1 polynomial on noisy short arc", () => {
    // Inline the known-wrong A1 so a future formula regression fails loudly.
    const trueR = 15;
    const span = (25 * Math.PI) / 180;
    const noise = [0.04, -0.05, 0.03, -0.02, 0.06, -0.03, 0.02, -0.04, 0.01];
    const arc = Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      const a = t * span;
      const n = noise[i];
      return {
        north: trueR * Math.sin(a) + n * 0.5,
        east: trueR * Math.cos(a) + n * 0.4,
      };
    });

    const buggyR = fitCircleBuggyA1(arc);
    const hyper = fitCircleHyper(arc);
    expect(hyper).not.toBeNull();
    expect(buggyR).not.toBeNull();
    const errBuggy = Math.abs(buggyR! - trueR);
    const errHyper = Math.abs(hyper!.r - trueR);
    expect(errHyper).toBeLessThan(errBuggy);
  });
});

describe("geometricFilletFromTangents", () => {
  it("builds a true-radius fillet for a 90° joint", () => {
    const joint = { north: 0, east: 10 };
    const uIn = { north: 0, east: 1 };
    const uOut = { north: 1, east: 0 };
    const fillet = geometricFilletFromTangents(joint, uIn, uOut, 2, 0.25);
    expect(fillet).not.toBeNull();
    expect(fillet!.samples.length).toBeGreaterThan(2);
    expect(distApprox(fillet!.t1, { north: 0, east: 8 })).toBeLessThan(0.05);
    expect(distApprox(fillet!.t2, { north: 2, east: 10 })).toBeLessThan(0.05);
  });
});

describe("filletSharpCorners", () => {
  it("reduces max turning angle on a sharp right-angle path", () => {
    const sharp = [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
      { north: 10, east: 10 },
    ];
    expect(Math.abs(turningAngleDeg(sharp[0], sharp[1], sharp[2]))).toBeCloseTo(90, 0);

    const soft = filletSharpCorners(sharp, {
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.4,
      maxFilletRadiusM: 8,
      sampleSpacingM: 0.35,
    });
    expect(soft.length).toBeGreaterThan(3);
    expect(maxTurningAngleDeg(soft)).toBeLessThan(45);
  });
});

describe("rejectPathSpikes", () => {
  it("drops an extreme GPS spike without removing a 90° corner", () => {
    const withSpike = [
      { north: 0, east: 0 },
      { north: 0, east: 5 },
      { north: 8, east: 5.1 },
      { north: 0, east: 5.2 },
      { north: 0, east: 10 },
      { north: 10, east: 10 },
    ];
    const cleaned = rejectPathSpikes(withSpike, 0.08, 2.5, 8);
    expect(cleaned.some((p) => p.north > 5 && p.east < 6)).toBe(false);
    expect(cleaned.some((p) => Math.abs(p.north - 10) < 0.01 && Math.abs(p.east - 10) < 0.01)).toBe(
      true
    );
  });
});

describe("segmentIntoPrimitives", () => {
  it("classifies a long straight as a single line", () => {
    const straight = Array.from({ length: 15 }, (_, i) => ({
      north: i * 2,
      east: 0.01 * Math.sin(i),
    }));
    const prims = segmentIntoPrimitives(straight, {
      fitToleranceM: 0.08,
      minArcPoints: 4,
      maxArcRadiusM: 5000,
    });
    expect(prims.length).toBeGreaterThanOrEqual(1);
    expect(prims.every((p) => p.kind === "line")).toBe(true);
  });

  it("classifies a clean circular arc as an arc primitive", () => {
    const r = 12;
    const arc = Array.from({ length: 20 }, (_, i) => {
      const a = (i / 19) * (Math.PI / 2);
      return { north: r * Math.sin(a), east: r * Math.cos(a) };
    });
    const prims = segmentIntoPrimitives(arc, {
      fitToleranceM: 0.1,
      minArcPoints: 4,
      maxArcRadiusM: 5000,
    });
    expect(prims.some((p) => p.kind === "arc")).toBe(true);
  });
});

describe("buildRoadMarkingPreviewPoints", () => {
  it("never closes into a polygon ring", () => {
    const loop = [
      { north: 0, east: 0 },
      { north: 0, east: 5 },
      { north: 5, east: 5 },
      { north: 5, east: 0 },
      { north: 0, east: 0 },
    ];
    const out = buildRoadMarkingPreviewPoints(loop);
    expect(out.length).toBeGreaterThanOrEqual(2);
    const first = out[0];
    const last = out[out.length - 1];
    const gap = Math.hypot(first.north - last.north, first.east - last.east);
    expect(gap).toBeGreaterThan(0.04);
  });

  it("keeps a straight run roughly collinear", () => {
    const straight = Array.from({ length: 11 }, (_, i) => ({
      north: i * 2,
      east: 0,
    }));
    const out = buildRoadMarkingPreviewPoints(straight, {
      fitToleranceM: 0.08,
      sampleSpacingM: 0.5,
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].north).toBeCloseTo(0, 1);
    expect(out[out.length - 1].north).toBeCloseTo(20, 1);
    const maxEast = Math.max(...out.map((p) => Math.abs(p.east)));
    expect(maxEast).toBeLessThan(0.15);
  });

  it("fits a circular arc sample without sharp corners", () => {
    const r = 10;
    const arc = Array.from({ length: 20 }, (_, i) => {
      const a = (i / 19) * (Math.PI / 2);
      return { north: r * Math.sin(a), east: r * Math.cos(a) };
    });
    const circle = fitCircleHyper(arc);
    expect(circle).not.toBeNull();
    expect(circle!.r).toBeCloseTo(10, 0);

    const out = buildRoadMarkingPreviewPoints(arc, {
      fitToleranceM: 0.1,
      sampleSpacingM: 0.4,
      sharpCornerDeg: 12,
    });
    expect(out.length).toBeGreaterThan(5);
    expect(maxTurningAngleDeg(out)).toBeLessThan(25);
  });

  it("softens L-shaped intersection without polygon close", () => {
    const pts: { north: number; east: number }[] = [];
    for (let i = 0; i <= 20; i++) pts.push({ north: 0, east: i * 0.5 });
    pts.push({ north: 0.05, east: 10.05 });
    pts.push({ north: 0.15, east: 10.1 });
    pts.push({ north: 0.35, east: 10.12 });
    for (let i = 1; i <= 20; i++) pts.push({ north: i * 0.5, east: 10.15 });

    const out = buildRoadMarkingPreviewPoints(pts, {
      fitToleranceM: 0.12,
      sampleSpacingM: 0.35,
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.35,
      maxFilletRadiusM: 4,
    });
    expect(out.length).toBeGreaterThan(5);
    expect(maxTurningAngleDeg(out)).toBeLessThan(55);
    const gap = Math.hypot(
      out[0].north - out[out.length - 1].north,
      out[0].east - out[out.length - 1].east
    );
    expect(gap).toBeGreaterThan(1);
  });

  it("does not re-introduce a 90° kink after full pipeline", () => {
    const sharp = [
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 0, east: 4 },
      { north: 0, east: 8 },
      { north: 0, east: 12 },
      { north: 2, east: 12 },
      { north: 4, east: 12 },
      { north: 8, east: 12 },
      { north: 12, east: 12 },
    ];
    const out = buildRoadMarkingPreviewPoints(sharp, {
      fitToleranceM: 0.08,
      sampleSpacingM: 0.3,
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.4,
      maxFilletRadiusM: 5,
    });
    expect(maxTurningAngleDeg(out)).toBeLessThan(50);
  });

  it("does not leave an S-shaped jog (opposite consecutive turns)", () => {
    // Screenshot-class defect: two moderate opposite kinks near a corner cluster.
    // maxTurningAngle alone can stay low while the path still snakes.
    const pts: { north: number; east: number }[] = [];
    for (let i = 0; i <= 16; i++) pts.push({ north: 0, east: i * 0.6 });
    // Deliberate S-jog before the main turn.
    pts.push({ north: 0.6, east: 9.7 });
    pts.push({ north: -0.5, east: 10.0 });
    pts.push({ north: 0.4, east: 10.3 });
    for (let i = 1; i <= 16; i++) pts.push({ north: i * 0.6, east: 10.4 });

    // Raw path has a strong opposite-turn pair.
    expect(maxOppositeTurnPairDeg(pts, 3)).toBeGreaterThan(20);

    const out = buildRoadMarkingPreviewPoints(pts, {
      fitToleranceM: 0.12,
      sampleSpacingM: 0.3,
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.35,
      maxFilletRadiusM: 4,
    });
    expect(out.length).toBeGreaterThan(5);
    // Refined path should not keep a large opposite-sign turn pair (S-jog).
    expect(maxOppositeTurnPairDeg(out, 4)).toBeLessThan(35);
    expect(maxTurningAngleDeg(out)).toBeLessThan(55);
  });
});

describe("maxOppositeTurnPairDeg", () => {
  it("returns 0 for a monotonic single-corner L", () => {
    const L = [
      { north: 0, east: 0 },
      { north: 0, east: 5 },
      { north: 0, east: 10 },
      { north: 5, east: 10 },
      { north: 10, east: 10 },
    ];
    // Only one significant turn direction → no opposite pair.
    expect(maxOppositeTurnPairDeg(L, 3)).toBe(0);
  });

  it("detects an S-jog polyline", () => {
    const s = [
      { north: 0, east: 0 },
      { north: 0, east: 5 },
      { north: 2, east: 6 },
      { north: -1, east: 7 },
      { north: 0, east: 12 },
    ];
    expect(maxOppositeTurnPairDeg(s, 3)).toBeGreaterThan(30);
  });
});

describe("dampenOppositeJogs", () => {
  it("collapses a short S-weave without removing a long L-corner", () => {
    const s = [
      { north: 0, east: 0 },
      { north: 0, east: 4 },
      { north: 1.2, east: 5 },
      { north: -1.0, east: 6 },
      { north: 0, east: 7 },
      { north: 0, east: 14 },
      { north: 8, east: 14 },
    ];
    const rawPair = maxOppositeTurnPairDeg(s, 3);
    expect(rawPair).toBeGreaterThan(30);
    const out = dampenOppositeJogs(s, 8, 3.5);
    expect(maxOppositeTurnPairDeg(out, 3)).toBeLessThan(rawPair * 0.85);
    // L corner near east=14 still present.
    expect(out.some((p) => Math.abs(p.east - 14) < 0.01)).toBe(true);
  });
});

describe("estimateAdaptiveTolerance", () => {
  it("stays near the historical default for a clean, low-noise line", () => {
    const clean = Array.from({ length: 30 }, (_, i) => ({ north: i * 0.5, east: 0 }));
    const tol = estimateAdaptiveTolerance(clean);
    expect(tol).toBeGreaterThanOrEqual(0.05);
    expect(tol).toBeLessThan(0.1);
  });

  it("relaxes well above the historical default for heavily noisy data", () => {
    const noisy = Array.from({ length: 60 }, (_, i) => ({
      north: i * 0.5 + detNoise(i, 0.25),
      east: detNoise(i + 100, 0.25),
    }));
    const tol = estimateAdaptiveTolerance(noisy);
    expect(tol).toBeGreaterThan(0.15);
  });

  it("stays within the documented clamp range regardless of input", () => {
    const veryNoisy = Array.from({ length: 40 }, (_, i) => ({
      north: i * 0.3 + detNoise(i, 5),
      east: detNoise(i + 7, 5),
    }));
    const tol = estimateAdaptiveTolerance(veryNoisy);
    expect(tol).toBeGreaterThanOrEqual(0.05);
    expect(tol).toBeLessThanOrEqual(1.5);
  });
});

describe("tryWholeLoopFit", () => {
  function noisyCircle(r: number, n: number, noiseMag: number, closeGapM = 0.1): RoadMarkingNedPoint[] {
    const pts: RoadMarkingNedPoint[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      pts.push({
        north: r * Math.sin(a) + detNoise(i, noiseMag),
        east: r * Math.cos(a) + detNoise(i + 500, noiseMag),
      });
    }
    // Force a small, realistic near-closure gap instead of an exact mathematical close.
    pts.push({ north: pts[0].north + closeGapM, east: pts[0].east });
    return pts;
  }

  it("fits one circle to a near-closed noisy loop (roundabout-scale)", () => {
    const loop = noisyCircle(11.5, 140, 0.03);
    const fit = tryWholeLoopFit(loop, 0.1);
    expect(fit).not.toBeNull();
    expect(fit!.r).toBeCloseTo(11.5, 0);
  });

  it("returns null when the path does not actually close", () => {
    const open = Array.from({ length: 30 }, (_, i) => ({ north: i * 0.5, east: 0 }));
    expect(tryWholeLoopFit(open, 0.1)).toBeNull();
  });

  it("returns null for a closed but non-circular shape (square)", () => {
    const square: RoadMarkingNedPoint[] = [];
    for (let i = 0; i <= 8; i++) square.push({ north: 0, east: i * 1.25 });
    for (let i = 1; i <= 8; i++) square.push({ north: i * 1.25, east: 10 });
    for (let i = 1; i <= 8; i++) square.push({ north: 10, east: 10 - i * 1.25 });
    for (let i = 1; i < 8; i++) square.push({ north: 10 - i * 1.25, east: 0 });
    square.push({ north: 0.05, east: 0 });
    expect(tryWholeLoopFit(square, 0.1)).toBeNull();
  });
});

describe("mergeAdjacentPrimitives", () => {
  it("merges fragmented adjacent arcs of the same circle into one", () => {
    const r = 11.5;
    const pts: RoadMarkingNedPoint[] = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 39) * (Math.PI / 2);
      return { north: r * Math.sin(a), east: r * Math.cos(a) };
    });
    // Simulate the greedy segmenter having fragmented one true arc into three pieces.
    const fragmented = [
      { kind: "line" as const, i0: 0, i1: 10 },
      { kind: "arc" as const, i0: 10, i1: 25, circle: fitCircleHyper(pts.slice(10, 26))! },
      { kind: "arc" as const, i0: 25, i1: 39, circle: fitCircleHyper(pts.slice(25))! },
    ];
    const merged = mergeAdjacentPrimitives(pts, fragmented, 0.1, 4, 5000);
    const arcCount = merged.filter((p) => p.kind === "arc").length;
    expect(arcCount).toBeLessThanOrEqual(2);
  });

  it("never merges two lines straight across a real corner (regression)", () => {
    // A genuine 80-degree corner with zero curve data at the vertex — merging must not
    // bridge prims[0] and prims[1] into one line spanning the whole thing.
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
      { north: 20, east: 0 },
      { north: 30, east: 0 },
      { north: 35.21, east: 5.21 },
      { north: 40.42, east: 10.42 },
    ];
    const prims = [
      { kind: "line" as const, i0: 0, i1: 3 },
      { kind: "line" as const, i0: 3, i1: 5 },
    ];
    const merged = mergeAdjacentPrimitives(pts, prims, 0.12, 4, 5000);
    expect(merged.length).toBe(2);
  });
});

describe("dropNegligibleArcs", () => {
  it("reclassifies a huge-radius, negligible-sagitta arc as a line", () => {
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
      { north: 10, east: 0.15 },
    ];
    const fit = fitCircleHyper(pts)!;
    const prims = [{ kind: "arc" as const, i0: 0, i1: 2, circle: fit }];
    const result = dropNegligibleArcs(pts, prims, 0.12);
    expect(result[0].kind).toBe("line");
  });

  it("leaves a genuinely visible arc (large sagitta) classified as arc", () => {
    const r = 12;
    const pts: RoadMarkingNedPoint[] = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 9) * (Math.PI / 2);
      return { north: r * Math.sin(a), east: r * Math.cos(a) };
    });
    const fit = fitCircleHyper(pts)!;
    const prims = [{ kind: "arc" as const, i0: 0, i1: 9, circle: fit }];
    const result = dropNegligibleArcs(pts, prims, 0.1);
    expect(result[0].kind).toBe("arc");
  });
});

describe("absorbSandwichedCornerArcs", () => {
  it("reclassifies a short arc flanked by two sharp turns (regression: S-jog remnant)", () => {
    // Exact point sequence that reproduces the original bug: after dampenOppositeJogs
    // collapses an S-weave down to one transition point, segmentIntoPrimitives correctly
    // fits a genuine small-radius (r≈1.81) arc across indices 16-21 — but that arc is
    // sandwiched between two real corners and only 2.5m long, so its two joint fillets
    // (each independently budgeted against its full length) conflicted and produced a
    // backtracking tessellated sample.
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 }, { north: 0, east: 0.6 }, { north: 0, east: 1.2 }, { north: 0, east: 1.8 },
      { north: 0, east: 2.4 }, { north: 0, east: 3 }, { north: 0, east: 3.6 }, { north: 0, east: 4.2 },
      { north: 0, east: 4.8 }, { north: 0, east: 5.4 }, { north: 0, east: 6 }, { north: 0, east: 6.6 },
      { north: 0, east: 7.2 }, { north: 0, east: 7.8 }, { north: 0, east: 8.4 }, { north: 0, east: 9 },
      { north: 0, east: 9.6 },
      { north: 0.4, east: 10.3 },
      { north: 0.6, east: 10.4 }, { north: 1.2, east: 10.4 }, { north: 1.8, east: 10.4 },
      { north: 2.4, east: 10.4 }, { north: 3, east: 10.4 }, { north: 3.6, east: 10.4 },
      { north: 4.2, east: 10.4 }, { north: 4.8, east: 10.4 }, { north: 5.4, east: 10.4 },
      { north: 6, east: 10.4 }, { north: 6.6, east: 10.4 }, { north: 7.2, east: 10.4 },
      { north: 7.8, east: 10.4 }, { north: 8.4, east: 10.4 }, { north: 9, east: 10.4 },
      { north: 9.6, east: 10.4 },
    ];
    const smallArcFit = fitCircleHyper(pts.slice(16, 22))!;
    const prims = [
      { kind: "line" as const, i0: 0, i1: 16 },
      { kind: "arc" as const, i0: 16, i1: 21, circle: smallArcFit },
      { kind: "line" as const, i0: 21, i1: 33 },
    ];
    const result = absorbSandwichedCornerArcs(pts, prims, 12);
    expect(result[1].kind).toBe("line");
  });

  it("does not touch a genuine road curve with smooth tangent continuity at its boundaries", () => {
    const r = 20;
    const before: RoadMarkingNedPoint[] = Array.from({ length: 6 }, (_, i) => ({ north: -6 + i, east: 0 }));
    const arcPts: RoadMarkingNedPoint[] = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 11) * (Math.PI / 4);
      return { north: r * Math.sin(a), east: r - r * Math.cos(a) };
    });
    const afterStart = arcPts[arcPts.length - 1];
    const afterHeading = Math.atan2(afterStart.east - arcPts[arcPts.length - 2].east, afterStart.north - arcPts[arcPts.length - 2].north);
    const after: RoadMarkingNedPoint[] = Array.from({ length: 6 }, (_, i) => ({
      north: afterStart.north + (i + 1) * Math.cos(afterHeading),
      east: afterStart.east + (i + 1) * Math.sin(afterHeading),
    }));
    const pts = [...before, ...arcPts, ...after];
    const fit = fitCircleHyper(arcPts)!;
    const prims = [
      { kind: "line" as const, i0: 0, i1: 5 },
      { kind: "arc" as const, i0: 5, i1: 16, circle: fit },
      { kind: "line" as const, i0: 16, i1: 21 },
    ];
    const result = absorbSandwichedCornerArcs(pts, prims, 12);
    expect(result[1].kind).toBe("arc");
  });
});

describe("splitIntoOpenPathGroups", () => {
  it("splits on an explicit group-key change even when points are close together", () => {
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 1, east: 0 },
      { north: 2, east: 0 },
      { north: 2.5, east: 0 },
      { north: 3, east: 0 },
    ];
    const keys = ["A", "A", "A", "B", "B"];
    const groups = splitIntoOpenPathGroups(pts, keys);
    expect(groups.length).toBe(2);
    expect(groups[0].length).toBe(3);
    expect(groups[1].length).toBe(2);
  });

  it("splits on an abnormal jump when no group keys are given (real bug regression)", () => {
    const westCircle = Array.from({ length: 50 }, (_, i) => ({
      north: 11.5 * Math.sin((i / 50) * 2 * Math.PI),
      east: 11.5 * Math.cos((i / 50) * 2 * Math.PI),
    }));
    const eastCircle = Array.from({ length: 50 }, (_, i) => ({
      north: 30 + 9 * Math.sin((i / 50) * 2 * Math.PI),
      east: 30 + 9 * Math.cos((i / 50) * 2 * Math.PI),
    }));
    const groups = splitIntoOpenPathGroups([...westCircle, ...eastCircle]);
    expect(groups.length).toBe(2);
  });

  it("does not split within one group when spacing is uniform", () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ north: i * 0.5, east: 0 }));
    const groups = splitIntoOpenPathGroups(pts);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(40);
  });

  it("documents a known limitation: two unrelated paths whose ends are close together get bridged", () => {
    const pathA = Array.from({ length: 20 }, (_, i) => ({ north: i * 0.5, east: 0 }));
    const pathB = Array.from({ length: 20 }, (_, i) => ({ north: 10 + i * 0.5, east: 1.5 }));
    const groups = splitIntoOpenPathGroups([...pathA, ...pathB]);
    // Not the ideal outcome — a real feature/road column is what actually resolves this.
    // This test exists so a future change to the jump-distance heuristic notices the effect.
    expect(groups.length).toBe(1);
  });
});

describe("buildRoadMarkingPreviewPoints — noisy roundabout regression", () => {
  it("represents a realistically-noisy closed loop as smooth arcs, not a jagged raw polyline", () => {
    // Mirrors the real-world bug: ~11.5m radius, ~0.5m point spacing, a few cm of noise —
    // this is the exact shape that used to degenerate into 44 primitives / 0 arcs before
    // the fix (simplifyCollinear pre-pass + fixed 8cm tolerance).
    const r = 11.5;
    const n = 145;
    const loop: RoadMarkingNedPoint[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      loop.push({
        north: r * Math.sin(a) + detNoise(i, 0.035),
        east: r * Math.cos(a) + detNoise(i + 900, 0.035),
      });
    }
    loop.push({ north: loop[0].north + 0.1, east: loop[0].east });

    const out = buildRoadMarkingPreviewPoints(loop);
    expect(out.length).toBeGreaterThan(10);
    expect(maxTurningAngleDeg(out)).toBeLessThan(20);

    let sharpJoints = 0;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const v1 = { north: b.north - a.north, east: b.east - a.east };
      const v2 = { north: c.north - b.north, east: c.east - b.east };
      const cross = v1.north * v2.east - v1.east * v2.north;
      const dot = v1.north * v2.north + v1.east * v2.east;
      const ang = Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
      if (ang > 5) sharpJoints++;
    }
    expect(sharpJoints).toBe(0);
  });
});

describe("sampleArc angular resolution (real bug regression: curve_6_points.csv)", () => {
  it("keeps per-step turning angle small for a tight-radius arc, not just a large one", () => {
    // Mirrors curve_6_points.csv: a single r≈2.37m open arc. Fixed arc-length-only sampling
    // (0.35m spacing) put ~8.5° between consecutive samples on this radius — visible facets
    // — even though the same spacing gives a large-radius arc (e.g. an ~11.5m roundabout)
    // under 2°/step "for free". The angle cap must kick in regardless of radius.
    const circle = { cn: 0, ce: 0, r: 2.5 };
    const angles = [0, 50, 100].map((d) => (d * Math.PI) / 180);
    const points: RoadMarkingNedPoint[] = angles.map((a) => ({
      north: circle.r * Math.sin(a),
      east: circle.ce + circle.r * Math.cos(a),
    }));
    const prims: PathPrimitive[] = [{ kind: "arc", i0: 0, i1: 2, circle }];
    const out = tessellatePrimitivesWithJointFillets(points, prims, {
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.4,
      maxFilletRadiusM: 8,
      sampleSpacingM: 0.35,
    });
    // ~100° sweep at r=2.5 is only ~4.4m of arc length — fixed 0.35m spacing alone would
    // give ~13 points (~8°/step); the angle cap should push this well past 30.
    expect(out.length).toBeGreaterThan(30);
    let maxStep = 0;
    for (let i = 1; i < out.length - 1; i++) {
      maxStep = Math.max(maxStep, Math.abs(turningAngleDeg(out[i - 1], out[i], out[i + 1])));
    }
    expect(maxStep).toBeLessThan(4);
  });
});

describe("joint fillet floor (real bug regression: roads_coordinates.csv sub-sharpCornerDeg kinks)", () => {
  it("rounds a modest ~8° joint that sharpCornerDeg=12 alone would leave as a bare vertex", () => {
    // A real, gentle road bend routinely segments into several short line primitives each
    // turning less than sharpCornerDeg (12°) — fitLineOrCircle deliberately prefers "line"
    // over a fragile short/shallow-sweep arc. Every one of those joints used to be a
    // completely unrounded vertex; a chain of them reads as a series of small "minor edges."
    const points: RoadMarkingNedPoint[] = [];
    for (let i = 0; i <= 10; i++) points.push({ north: i * 2, east: 0 });
    const turnRad = (8 * Math.PI) / 180;
    const dir = { north: Math.cos(turnRad), east: Math.sin(turnRad) };
    for (let i = 1; i <= 10; i++) {
      points.push({ north: 20 + i * 2 * dir.north, east: i * 2 * dir.east });
    }
    const prims: PathPrimitive[] = [
      { kind: "line", i0: 0, i1: 10 },
      { kind: "line", i0: 10, i1: 20 },
    ];
    const out = tessellatePrimitivesWithJointFillets(points, prims, {
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.4,
      maxFilletRadiusM: 8,
      sampleSpacingM: 0.35,
      minArcPoints: 4,
      fitToleranceM: 0.05,
    });
    let maxStep = 0;
    for (let i = 1; i < out.length - 1; i++) {
      maxStep = Math.max(maxStep, Math.abs(turningAngleDeg(out[i - 1], out[i], out[i + 1])));
    }
    // Before the fix this joint was a single bare ~8° vertex (maxStep ≈ 8). After, the ~8°
    // turn is rounded into several smaller steps.
    expect(maxStep).toBeLessThan(5);
  });
});

describe("tessellatePrimitivesWithJointFillets — arc/line joint continuity (real bug regression)", () => {
  it("does not show a spurious sharp turn when the arc's fitted circle doesn't pass exactly through the shared raw joint point", () => {
    // Mirrors roads_coordinates.csv (Haddows Road): a long, gently-curving, large-radius
    // ("nearly straight") arc primitive is immediately followed by a line primitive, joined
    // without a fillet because the real turn is well under sharpCornerDeg. A Hyper fit only
    // approximates its window (residual up to fitToleranceM), so the raw point AT the joint
    // is not exactly ON the fitted circle — here by 3cm, a typical real-world residual. The
    // line primitive starts at that exact raw point. Before the fix, the arc side
    // reconstructed its own endpoint from angle+radius on the fitted circle instead of
    // reusing the raw point, so the two sides disagreed by ~3cm sideways — read as a sharp
    // corner (verified against the real file: max turning angle dropped from 90° to 11°, and
    // every >=12° turn vanished, after this fix).
    const circle = { cn: 0, ce: -100, r: 100 };
    const points: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 }, // exactly on the circle
      { north: 4.998, east: -0.125 }, // exactly on the circle
      { north: 9.983, east: -0.47 }, // raw joint: ~3cm off the circle (fit residual)
      { north: 10.978, east: -0.57 },
      { north: 11.973, east: -0.669 },
    ];
    const prims: PathPrimitive[] = [
      { kind: "arc", i0: 0, i1: 2, circle },
      { kind: "line", i0: 2, i1: 4 },
    ];

    const out = tessellatePrimitivesWithJointFillets(points, prims, {
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.4,
      maxFilletRadiusM: 8,
      sampleSpacingM: 0.35,
    });

    expect(maxTurningAngleDeg(out)).toBeLessThan(15);

    // The arc's last emitted sample and the line's first emitted sample must be the same
    // point (the raw joint), not two ~3cm-apart reconstructions.
    const jointIdx = out.findIndex((p) => distApprox(p, points[2]) < 0.001);
    expect(jointIdx).toBeGreaterThanOrEqual(0);
  });
});

function distApprox(
  a: { north: number; east: number },
  b: { north: number; east: number }
): number {
  return Math.hypot(a.north - b.north, a.east - b.east);
}

/**
 * Historical buggy Hyper A1 (pre-fix):
 *   A1 = Var_z*Mz + 4*Cov_xy*Zmean - Mzz*Mz + Mxz² + Myz²
 * Used only to prove production fitCircleHyper diverges from this on noisy short arcs.
 */
function fitCircleBuggyA1(
  points: { north: number; east: number }[]
): number | null {
  if (points.length < 3) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.east;
    my += p.north;
  }
  mx /= points.length;
  my /= points.length;
  let Mxx = 0;
  let Myy = 0;
  let Mxy = 0;
  let Mxz = 0;
  let Myz = 0;
  let Mzz = 0;
  let Zmean = 0;
  const n = points.length;
  for (const p of points) {
    const x = p.east - mx;
    const y = p.north - my;
    const z = x * x + y * y;
    Mxx += x * x;
    Myy += y * y;
    Mxy += x * y;
    Mxz += x * z;
    Myz += y * z;
    Mzz += z * z;
    Zmean += z;
  }
  Mxx /= n;
  Myy /= n;
  Mxy /= n;
  Mxz /= n;
  Myz /= n;
  Mzz /= n;
  Zmean /= n;
  const Mz = Mxx + Myy;
  const Cov_xy = Mxx * Myy - Mxy * Mxy;
  const Var_z = Mzz - Zmean * Zmean;
  const A2 = 4 * Cov_xy - 3 * Mz * Mz - Mzz;
  const A1 = Var_z * Mz + 4 * Cov_xy * Zmean - Mzz * Mz + Mxz * Mxz + Myz * Myz;
  const A0 =
    Mxz * (Mxz * Myy - Myz * Mxy) + Myz * (Myz * Mxx - Mxz * Mxy) - Var_z * Cov_xy;
  const A22 = A2 + A2;
  let xnew = 0;
  let ynew = 1e20;
  for (let iter = 0; iter < 20; iter++) {
    const yold = ynew;
    ynew = A0 + xnew * (A1 + xnew * (A2 + 4 * xnew * xnew));
    if (Math.abs(ynew) > Math.abs(yold)) {
      xnew = 0;
      break;
    }
    const Dy = A1 + xnew * (A22 + 16 * xnew * xnew);
    if (Math.abs(Dy) < 1e-18) break;
    const xold = xnew;
    xnew = xold - ynew / Dy;
    if (Math.abs(xnew) > 1e-15 && Math.abs((xnew - xold) / xnew) < 1e-12) break;
    if (xnew < 0) {
      xnew = 0;
      break;
    }
  }
  const DET = xnew * xnew - xnew * Mz + Cov_xy;
  if (Math.abs(DET) < 1e-18) return null;
  const centerX = (Mxz * (Myy - xnew) - Myz * Mxy) / DET / 2;
  const centerY = (Myz * (Mxx - xnew) - Mxz * Mxy) / DET / 2;
  const r = Math.sqrt(
    Math.abs(centerX * centerX + centerY * centerY + Zmean - 2 * xnew)
  );
  return Number.isFinite(r) && r > 0.05 ? r : null;
}

// ── Robustness: the preview must survive ANY file, not just dense road surveys ──────────
//
// Every case below was measured failing before the fixes these lock in. The failure mode
// was silent: no error, no warning, just a preview that no longer described the survey.

/** Ring of `n` points, radius `r`, with deterministic noise. Not closed (last ≠ first). */
function ringPoints(r: number, n: number, noiseM = 0): RoadMarkingNedPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return {
      north: r * Math.sin(a) + detNoise(i, noiseM),
      east: r * Math.cos(a) + detNoise(i + 500, noiseM),
    };
  });
}

function extentOf(points: RoadMarkingNedPoint[]): { n: number; e: number } {
  const n = points.map((p) => p.north);
  const e = points.map((p) => p.east);
  return { n: Math.max(...n) - Math.min(...n), e: Math.max(...e) - Math.min(...e) };
}

/** Fraction of the source bounding box the refined path still covers, worst axis. */
function extentRetained(src: RoadMarkingNedPoint[], out: RoadMarkingNedPoint[]): number {
  const a = extentOf(src);
  const b = extentOf(out);
  return Math.min(a.n > 0 ? b.n / a.n : 1, a.e > 0 ? b.e / a.e : 1);
}

describe("estimateAdaptiveTolerance — noise vs curvature", () => {
  it("does not mistake sparse sampling of a curve for measurement noise", () => {
    // Same 11.5 m ring, same (zero) noise, only the sampling density differs. A residual
    // measured at one window size scales with spacing², so the sparse ring used to report
    // ~8x the tolerance of the dense one and its geometry was then discarded as noise.
    const dense = estimateAdaptiveTolerance(ringPoints(11.5, 146));
    const sparse = estimateAdaptiveTolerance(ringPoints(11.5, 40));
    expect(sparse).toBeLessThan(dense * 2);
  });

  it("still reports a genuinely noisy survey as noisy", () => {
    const clean = estimateAdaptiveTolerance(ringPoints(11.5, 146, 0.005));
    const noisy = estimateAdaptiveTolerance(ringPoints(11.5, 146, 0.4));
    expect(noisy).toBeGreaterThan(clean);
  });

  it("stays within the documented clamp for any input", () => {
    for (const pts of [ringPoints(0.5, 40), ringPoints(500, 40, 2), ringPoints(11.5, 9, 0.01)]) {
      const tol = estimateAdaptiveTolerance(pts);
      expect(tol).toBeGreaterThanOrEqual(0.05);
      expect(tol).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("tryWholeLoopFit — judged against the fit budget, not the noise floor", () => {
  it("accepts a real ring that deviates more than survey noise but within paint tolerance", () => {
    // A surveyed roundabout is never a perfect circle; the real Egmore rings sit ~11-13 cm
    // off their best-fit circle. Judged against the noise floor they were rejected and the
    // ring shattered into faceted arcs.
    const ring = ringPoints(11.5, 146).map((p, i) => ({
      north: p.north * (i % 2 === 0 ? 1.009 : 1),
      east: p.east,
    }));
    expect(tryWholeLoopFit(ring, 0.02)).not.toBeNull();
  });

  it("still refuses a shape that is genuinely not a circle", () => {
    const oval = ringPoints(11.5, 146).map((p) => ({ north: p.north * 1.6, east: p.east }));
    expect(tryWholeLoopFit(oval, 0.05)).toBeNull();
  });

  it("does not reject a loop for being coarsely surveyed", () => {
    // Ends of a ring shot every ~1.8 m are ~1.8 m apart however perfectly closed it is.
    expect(tryWholeLoopFit(ringPoints(11.5, 40), 0.06)).not.toBeNull();
  });

  it("still refuses an open path whose ends are genuinely far apart", () => {
    const arc = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 39) * Math.PI; // half circle — ends 23 m apart
      return { north: 11.5 * Math.sin(a), east: 11.5 * Math.cos(a) };
    });
    expect(tryWholeLoopFit(arc, 0.06)).toBeNull();
  });
});

describe("preview integrity — geometry is never silently lost", () => {
  const cases: [string, RoadMarkingNedPoint[]][] = [
    ["ring r=2 n=40", ringPoints(2, 40, 0.02)],
    ["ring r=11.5 n=20", ringPoints(11.5, 20, 0.02)],
    ["ring r=11.5 n=40", ringPoints(11.5, 40, 0.02)],
    ["ring r=11.5 n=60", ringPoints(11.5, 60, 0.02)],
    ["ring r=11.5 n=146", ringPoints(11.5, 146, 0.02)],
    ["ring r=50 n=40", ringPoints(50, 40, 0.02)],
    ["ring r=0.5 n=40", ringPoints(0.5, 40, 0.005)],
    ["ring r=200 n=40", ringPoints(200, 40, 0.05)],
  ];

  it.each(cases)("keeps the surveyed extent: %s", (_label, pts) => {
    // Before the fix, a 23 m ring shot with 40 points rendered as a 1.8 m stub (8 %).
    expect(extentRetained(pts, buildRoadMarkingPreviewPoints(pts))).toBeGreaterThan(0.9);
  });

  it.each(cases)("renders without visible facets: %s", (_label, pts) => {
    expect(maxTurningAngleDeg(buildRoadMarkingPreviewPoints(pts))).toBeLessThanOrEqual(4);
  });

  it("keeps the extent of an open path too", () => {
    const sCurve = Array.from({ length: 120 }, (_, i) => {
      const t = (i / 119) * 2 * Math.PI;
      return { north: 5 * t, east: 10 * Math.sin(t) + detNoise(i, 0.02) };
    });
    expect(extentRetained(sCurve, buildRoadMarkingPreviewPoints(sCurve))).toBeGreaterThan(0.9);
  });
});

describe("preview sampling stays bounded", () => {
  it("does not explode on a very large survey", () => {
    // Arc-length pacing alone would ask for ~18k vertices on a 1 km-radius ring. The
    // 8000 target is derived from the chord polygon, so allow the documented small
    // overshoot rather than asserting a bound the implementation does not claim.
    const huge = ringPoints(1000, 40);
    expect(buildRoadMarkingPreviewPoints(huge).length).toBeLessThan(8400);
  });

  it("leaves road-scale files at the default spacing", () => {
    // A 23 m ring is nowhere near the cap, so its sampling must be untouched.
    const ring = ringPoints(11.5, 146, 0.02);
    const out = buildRoadMarkingPreviewPoints(ring);
    expect(out.length).toBeGreaterThan(150);
    expect(out.length).toBeLessThan(400);
  });
});
