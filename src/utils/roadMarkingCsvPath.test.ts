import { describe, expect, it } from "vitest";
import {
  anchorSharpJoints,
  buildRoadMarkingFittedPath,
  buildRoadMarkingPreviewPoints,
  buildWaypointFilletPath,
  pinFittedPathTermini,
  strongCornerIndices,
  ensureOpenPath,
  fitCircleHyper,
  fitCircleKasa,
  geometricFilletFromTangents,
  dampenOppositeJogs,
  maxOppositeTurnPairDeg,
  maxTurningAngleDeg,
  polylineLengthM,
  rejectPathSpikes,
  segmentIntoPrimitives,
  turningAngleDeg,
  estimateAdaptiveTolerance,
  tryWholeLoopFit,
  mergeAdjacentPrimitives,
  dropNegligibleArcs,
  splitIntoOpenPathGroups,
  splitFittedPathAtAnchor,
  splitRoadMarkingPathAtAnchor,
  tessellatePrimitivesWithJointFillets,
  type RoadMarkingNedPoint,
  type PathPrimitive,
} from "./roadMarkingCsvPath";
import type { PlanLine } from "../types/plan";

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

  it("keeps an L-shaped corner sharp (no fillet) without polygon close", () => {
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
    // The corner is not rounded: the path turns ~90 degrees at a single vertex.
    expect(maxTurningAngleDeg(out)).toBeGreaterThan(80);
    // And that vertex is a surveyed one (the apex of the corner cluster), not an invented one.
    const turnIdx = out.findIndex(
      (p, i) => i > 0 && i < out.length - 1 && Math.abs(turningAngleDeg(out[i - 1], p, out[i + 1])) > 80
    );
    expect(turnIdx).toBeGreaterThan(0);
    expect(pts.some((q) => q.north === out[turnIdx].north && q.east === out[turnIdx].east)).toBe(true);
    const gap = Math.hypot(
      out[0].north - out[out.length - 1].north,
      out[0].east - out[out.length - 1].east
    );
    expect(gap).toBeGreaterThan(1);
  });

  it("keeps the 90° corner of a dense polyline as the exact surveyed vertex", () => {
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
    expect(out.some((p) => p.north === 0 && p.east === 12)).toBe(true);
    expect(maxTurningAngleDeg(out)).toBeCloseTo(90, 5);
  });

  it("does not silently collapse a surveyed S-jog: its vertices stay and the fold is flagged", () => {
    // A ~1 m jog on the approach to a corner is surveyed geometry, not RTK weave. The old weave
    // collapse quietly deleted its vertices and painted a different path; now the jog apexes
    // reach the rover exactly and the fold (reversal-class vertices) blocks the path with a
    // clear warning instead.
    const pts: { north: number; east: number }[] = [];
    for (let i = 0; i <= 16; i++) pts.push({ north: 0, east: i * 0.6 });
    const jog = [
      { north: 0.6, east: 9.7 },
      { north: -0.5, east: 10.0 },
    ];
    pts.push(...jog, { north: 0.4, east: 10.3 });
    for (let i = 1; i <= 16; i++) pts.push({ north: i * 0.6, east: 10.4 });

    const fit = buildRoadMarkingFittedPath(pts, {
      fitToleranceM: 0.12,
      sampleSpacingM: 0.3,
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.35,
      maxFilletRadiusM: 4,
    });
    for (const j of jog) {
      expect(fit.samples.some((p) => p.north === j.north && p.east === j.east)).toBe(true);
    }
    expect(fit.paintable).toBe(false);
    expect(fit.warnings.some((w) => /reversal corner/i.test(w))).toBe(true);
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
  it("collapses a small S-weave without removing a long L-corner", () => {
    // Two opposite ~10 degree kinks 1 m apart (a ~9 cm lateral shift): weave, not geometry.
    const dn = Math.sin((10 * Math.PI) / 180);
    const de = Math.cos((10 * Math.PI) / 180);
    const s = [
      { north: 0, east: 0 },
      { north: 0, east: 4 },
      { north: 0, east: 5 },
      { north: dn, east: 5 + de },
      { north: dn, east: 6 + de },
      { north: dn, east: 14 },
      { north: 8, east: 14 },
    ];
    const rawPair = maxOppositeTurnPairDeg(s, 3);
    expect(rawPair).toBeGreaterThan(15);
    const out = dampenOppositeJogs(s, 8, 3.5, 12);
    expect(maxOppositeTurnPairDeg(out, 3)).toBeLessThan(rawPair * 0.85);
    // L corner near east=14 still present.
    expect(out.some((p) => Math.abs(p.east - 14) < 0.01 && Math.abs(p.north - dn) < 0.01)).toBe(true);
  });

  it("never drops a true corner: a noisy fix after a 90 degree corner is dropped instead", () => {
    const s = [
      { north: 0, east: 0 },
      { north: 0, east: 4 },
      { north: 0, east: 8 },
      { north: 1, east: 8 },
      { north: 2, east: 8.15 },
      { north: 6, east: 8.15 },
    ];
    // Without protection the 90 degree vertex at (0, 8) is the "kinkier" one and would go.
    const out = dampenOppositeJogs(s, 8, 3.5, 12);
    expect(out.some((p) => p.north === 0 && p.east === 8)).toBe(true);
    expect(out.length).toBe(s.length - 1);
  });

  it("keeps every apex of a short-legged zig-zag (large alternating turns are geometry)", () => {
    const zz = Array.from({ length: 12 }, (_, i) => ({ north: i, east: (i % 2) * 1.5 }));
    expect(dampenOppositeJogs(zz, 8, 3.5, 12)).toEqual(zz);
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

/** Open square (side `side`, last point distinct from the first) sampled every `step`, plus optional noise. */
function sampledSquare(side: number, step: number, noise = 0): RoadMarkingNedPoint[] {
  const corners = [
    [0, 0],
    [0, side],
    [side, side],
    [side, 0],
  ];
  const pts: RoadMarkingNedPoint[] = [];
  let k = 0;
  const n = Math.round(side / step);
  for (let c = 0; c < 3; c++) {
    const [a0, b0] = corners[c];
    const [a1, b1] = corners[c + 1];
    for (let i = 0; i < n; i++) {
      pts.push({
        north: a0 + ((a1 - a0) * i) / n + detNoise(k, noise),
        east: b0 + ((b1 - b0) * i) / n + detNoise(k + 5000, noise),
      });
      k++;
    }
  }
  pts.push({ north: side, east: 0 });
  return pts;
}

function hasVertex(samples: RoadMarkingNedPoint[], v: RoadMarkingNedPoint): boolean {
  return samples.some((p) => p.north === v.north && p.east === v.east);
}

describe("sharp corners are exact vertices (rover controller owns corner policy)", () => {
  it("keeps all four corners of a sparse square (waypoint path) as exact vertices, no cut", () => {
    const sq = [
      { north: 0, east: 0 },
      { north: 0, east: 8 },
      { north: 8, east: 8 },
      { north: 8, east: 0 },
    ];
    const fit = buildRoadMarkingFittedPath(sq);
    expect(fit.mode).toBe("waypoint-fillet");
    expect(hasVertex(fit.samples, sq[1])).toBe(true);
    expect(hasVertex(fit.samples, sq[2])).toBe(true);
    expect(fit.quality.maxSourceDeviationM).toBe(0);
    expect(maxTurningAngleDeg(fit.samples)).toBeCloseTo(90, 5);
  });

  it("keeps both corners of a dense square exact at every sampling density and noise level", () => {
    for (const step of [0.05, 0.1, 0.25, 0.5, 1]) {
      for (const noise of [0, 0.01, 0.02]) {
        const src = sampledSquare(10, step, noise);
        const fit = buildRoadMarkingFittedPath(src);
        expect(fit.mode).toBe("dense-fit");
        // The output vertex is a surveyed fix (bit-identical), within one noise radius of the
        // true corner - never a fillet tangent point 15 cm away.
        for (const trueCorner of [
          { north: 0, east: 10 },
          { north: 10, east: 10 },
        ]) {
          const nearSrc = src.reduce((best, p) =>
            distApprox(p, trueCorner) < distApprox(best, trueCorner) ? p : best
          );
          expect(hasVertex(fit.samples, nearSrc)).toBe(true);
        }
        expect(maxTurningAngleDeg(fit.samples)).toBeGreaterThan(80);
      }
    }
  });

  it("keeps every apex of a dense zig-zag exact, with short and long legs", () => {
    const cases: Array<[number, number, number, number]> = [
      [30, 1, 1.2, 1.5], // one fix per leg
      [30, 2, 0.5, 2],
      [12, 3, 0.5, 3],
      [25, 1, 0.5, 0.6], // two fixes per leg, tolerance estimate inflated by the zig-zag itself
    ];
    for (const [nLegs, leg, step, ampl] of cases) {
      const apex: RoadMarkingNedPoint[] = [];
      for (let k = 0; k <= nLegs; k++) apex.push({ north: k * leg, east: (k % 2) * ampl });
      const pts: RoadMarkingNedPoint[] = [];
      const m = Math.max(1, Math.round(Math.hypot(leg, ampl) / step));
      for (let k = 0; k < nLegs; k++) {
        for (let i = 0; i < m; i++) {
          pts.push({
            north: apex[k].north + ((apex[k + 1].north - apex[k].north) * i) / m,
            east: apex[k].east + ((apex[k + 1].east - apex[k].east) * i) / m,
          });
        }
      }
      pts.push(apex[nLegs]);
      const fit = buildRoadMarkingFittedPath(pts);
      expect(fit.mode).toBe("dense-fit");
      for (const a of apex.slice(1, -1)) {
        expect(hasVertex(fit.samples, a)).toBe(true);
      }
    }
  });

  it("keeps the apexes of a sparse zig-zag exact", () => {
    const zz = Array.from({ length: 9 }, (_, i) => ({ north: i * 3, east: (i % 2) * 3 }));
    const fit = buildRoadMarkingFittedPath(zz);
    for (const a of zz.slice(1, -1)) expect(hasVertex(fit.samples, a)).toBe(true);
    expect(fit.quality.maxSourceDeviationM).toBe(0);
  });

  it("does not fillet a sparse vertex turning more than sharpCornerDeg, but smooths one turning less", () => {
    const turn = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return [
        { north: 0, east: 0 },
        { north: 0, east: 20 },
        { north: 20 * Math.sin(r), east: 20 + 20 * Math.cos(r) },
      ];
    };
    const sharp = buildWaypointFilletPath(turn(12.5), { sharpCornerDeg: 12 });
    expect(hasVertex(sharp.samples, { north: 0, east: 20 })).toBe(true);
    const gentle = buildWaypointFilletPath(turn(11.5), { sharpCornerDeg: 12 });
    expect(hasVertex(gentle.samples, { north: 0, east: 20 })).toBe(false);
  });

  it("still smooths gentle joints below sharpCornerDeg (waypoint and dense tessellation)", () => {
    // Sparse: an 8 degree vertex is a bend of a curve and gets a small fillet.
    const r = (8 * Math.PI) / 180;
    const bend = [
      { north: 0, east: 0 },
      { north: 0, east: 20 },
      { north: 20 * Math.sin(r), east: 20 + 20 * Math.cos(r) },
    ];
    const wp = buildWaypointFilletPath(bend);
    expect(hasVertex(wp.samples, bend[1])).toBe(false);
    expect(maxTurningAngleDeg(wp.samples)).toBeLessThan(5);
    // The pre-existing 8 degree dense-tessellation case lives in "joint fillet floor" below.
  });

  it("strongCornerIndices reports one apex per corner, not every fix around it", () => {
    const dense = sampledSquare(5, 0.05);
    const idx = strongCornerIndices(dense);
    expect(idx).toHaveLength(2);
    for (const i of idx) {
      const p = dense[i];
      const atCorner =
        (p.north === 0 && p.east === 5) || (p.north === 5 && p.east === 5);
      expect(atCorner).toBe(true);
    }
  });

  it("anchorSharpJoints moves a joint that landed past the corner back onto the corner fix", () => {
    // 5 cm fixes: the first straight run absorbs one fix past the corner (still inside the
    // 8 cm band), so the joint sits at index 101 instead of the corner at index 100.
    const pts: RoadMarkingNedPoint[] = [];
    for (let i = 0; i <= 100; i++) pts.push({ north: 0, east: i * 0.05 });
    for (let i = 1; i <= 100; i++) pts.push({ north: i * 0.05, east: 5 });
    const prims: PathPrimitive[] = [
      { kind: "line", i0: 0, i1: 101 },
      { kind: "line", i0: 101, i1: 200 },
    ];
    const anchored = anchorSharpJoints(pts, prims, 12, 0.08);
    expect(anchored[0].i1).toBe(100);
    expect(anchored[1].i0).toBe(100);
    // A joint that is not a corner is left alone.
    const gentlePts: RoadMarkingNedPoint[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ north: 0, east: i })),
      ...Array.from({ length: 10 }, (_, i) => ({ north: (i + 1) * Math.sin(0.1), east: 10 + (i + 1) * Math.cos(0.1) })),
    ];
    const gp: PathPrimitive[] = [
      { kind: "line", i0: 0, i1: 10 },
      { kind: "line", i0: 10, i1: 20 },
    ];
    expect(anchorSharpJoints(gentlePts, gp, 12, 0.08)).toEqual(gp);
  });

  it("mergeAdjacentPrimitives never merges across a hard break", () => {
    const arc = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 11) * (Math.PI / 3);
      return { north: 10 * Math.sin(a), east: 10 * Math.cos(a) };
    });
    const c1 = fitCircleHyper(arc.slice(0, 7))!;
    const c2 = fitCircleHyper(arc.slice(6))!;
    const prims: PathPrimitive[] = [
      { kind: "arc", i0: 0, i1: 6, circle: c1 },
      { kind: "arc", i0: 6, i1: 11, circle: c2 },
    ];
    expect(mergeAdjacentPrimitives(arc, prims, 0.1, 4, 5000)).toHaveLength(1);
    expect(mergeAdjacentPrimitives(arc, prims, 0.1, 4, 5000, new Set([6]))).toHaveLength(2);
  });

  it("still reconstructs a dense surveyed curve as a smooth curve next to exact corners", () => {
    // Straight, 90 degree corner, then a r=12 m quarter circle: the corner stays sharp, the
    // curve stays smooth (turn per sample well under the bare-turn bar).
    const pts: RoadMarkingNedPoint[] = [];
    for (let i = 0; i < 20; i++) pts.push({ north: 0, east: i * 0.5 });
    // corner at (0, 10), then a quarter circle starting due north
    const r = 12;
    for (let i = 0; i <= 30; i++) {
      const a = (i / 30) * (Math.PI / 2);
      pts.push({ north: r * Math.sin(a), east: 10 + r * (1 - Math.cos(a)) });
    }
    const fit = buildRoadMarkingFittedPath(pts);
    expect(fit.mode).toBe("dense-fit");
    expect(hasVertex(fit.samples, { north: 0, east: 10 })).toBe(true);
    // Everything except the corner turns gently.
    const turns = fit.samples
      .slice(1, -1)
      .map((p, i) => ({ p, t: Math.abs(turningAngleDeg(fit.samples[i], p, fit.samples[i + 2])) }));
    const big = turns.filter((x) => x.t > 8);
    expect(big).toHaveLength(1);
    expect(big[0].p).toEqual({ north: 0, east: 10 });
  });
});

describe("open paths are never closed into a ring", () => {
  it("keeps the last vertex of a square survey that returns to its start distinct from the first", () => {
    const loop = [
      { north: 0, east: 0 },
      { north: 0, east: 6 },
      { north: 6, east: 6 },
      { north: 6, east: 0 },
      { north: 0, east: 0 },
    ];
    const fit = buildRoadMarkingFittedPath(loop);
    const first = fit.samples[0];
    const last = fit.samples[fit.samples.length - 1];
    expect(Math.hypot(first.north - last.north, first.east - last.east)).toBeGreaterThan(4);
    expect(last).toEqual({ north: 6, east: 0 });
  });

  it("pins termini to the open source, never to the closing duplicate", () => {
    const samples = [
      { north: 0.01, east: 0 },
      { north: 3, east: 0 },
      { north: 6, east: 0.02 },
    ];
    const open = [
      { north: 0, east: 0 },
      { north: 6, east: 0 },
    ];
    const pinned = pinFittedPathTermini(samples, open);
    expect(pinned[0]).toEqual({ north: 0, east: 0 });
    expect(pinned[pinned.length - 1]).toEqual({ north: 6, east: 0 });
  });

  it("does not close a nearly-closed survey whose end is within a few cm of the start, either direction", () => {
    const base = [
      { north: 0, east: 0 },
      { north: 0, east: 6 },
      { north: 6, east: 6 },
      { north: 6, east: 0 },
      { north: 0.03, east: 0.01 },
    ];
    for (const pts of [base, [...base].reverse()]) {
      const fit = buildRoadMarkingFittedPath(pts);
      const first = fit.samples[0];
      const last = fit.samples[fit.samples.length - 1];
      expect(Math.hypot(first.north - last.north, first.east - last.east)).toBeGreaterThan(4);
    }
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

describe("splitFittedPathAtAnchor", () => {
  // 10 m straight line, one sample per metre: (0,0) .. (10,0).
  const straight: RoadMarkingNedPoint[] = Array.from({ length: 11 }, (_, i) => ({
    north: i,
    east: 0,
  }));

  it("splits mid-path into a near arm and a far arm, both anchor-first", () => {
    // Anchor at (3,0): near = start side (3 m, shorter), far = end side (7 m, longer).
    const split = splitFittedPathAtAnchor(straight, 3, 0);
    expect(split).not.toBeNull();
    expect(split!.near).not.toBeNull();
    const near = split!.near!;
    expect(near[0]).toEqual({ north: 3, east: 0 });
    expect(near[near.length - 1]).toEqual({ north: 0, east: 0 });
    expect(split!.far[0]).toEqual({ north: 3, east: 0 });
    expect(split!.far[split!.far.length - 1]).toEqual({ north: 10, east: 0 });
    expect(polylineLengthM(near)).toBeCloseTo(3, 6);
    expect(polylineLengthM(split!.far)).toBeCloseTo(7, 6);
  });

  it("picks the shorter side as near regardless of which end it is", () => {
    // Anchor at (8,0): near = end side (2 m, shorter), far = start side (8 m, longer).
    const split = splitFittedPathAtAnchor(straight, 8, 0);
    expect(split).not.toBeNull();
    expect(split!.near).not.toBeNull();
    const near = split!.near!;
    expect(polylineLengthM(near)).toBeCloseTo(2, 6);
    expect(near[near.length - 1]).toEqual({ north: 10, east: 0 });
    expect(polylineLengthM(split!.far)).toBeCloseTo(8, 6);
    expect(split!.far[split!.far.length - 1]).toEqual({ north: 0, east: 0 });
  });

  it("anchor at the current start leaves the path unchanged (near: null)", () => {
    const split = splitFittedPathAtAnchor(straight, 0, 0);
    expect(split).not.toBeNull();
    expect(split!.near).toBeNull();
    expect(split!.far).toEqual(straight);
  });

  it("anchor at the current end reverses the whole path (near: null)", () => {
    const split = splitFittedPathAtAnchor(straight, 10, 0);
    expect(split).not.toBeNull();
    expect(split!.near).toBeNull();
    expect(split!.far).toEqual(straight.slice().reverse());
    expect(split!.far[0]).toEqual({ north: 10, east: 0 });
    expect(split!.far[split!.far.length - 1]).toEqual({ north: 0, east: 0 });
  });

  it("allows an anchor very close to (but not exactly at) an end", () => {
    // Fine-grained line, one sample every 5 cm: (0,0) .. (1,0).
    const fine: RoadMarkingNedPoint[] = Array.from({ length: 21 }, (_, i) => ({
      north: i * 0.05,
      east: 0,
    }));
    // Anchor 5 cm from the start — used to be rejected under the old 0.5 m
    // minimum-arm policy; any non-endpoint sample must now be selectable.
    const split = splitFittedPathAtAnchor(fine, 0.05, 0);
    expect(split).not.toBeNull();
    expect(split!.near).not.toBeNull();
    expect(polylineLengthM(split!.near!)).toBeCloseTo(0.05, 6);
    expect(polylineLengthM(split!.far)).toBeCloseTo(0.95, 6);
  });

  it("returns null for a degenerate (under 2 point) path", () => {
    expect(splitFittedPathAtAnchor([{ north: 0, east: 0 }], 0, 0)).toBeNull();
    expect(splitFittedPathAtAnchor([], 0, 0)).toBeNull();
  });

  it("splits evenly down the middle without favoring either arm", () => {
    // Anchor exactly at the midpoint (5,0): both arms are 5 m — near/far order is
    // deterministic (far wins ties via <=) but neither arm may be dropped.
    const split = splitFittedPathAtAnchor(straight, 5, 0);
    expect(split).not.toBeNull();
    expect(split!.near).not.toBeNull();
    expect(polylineLengthM(split!.near!)).toBeCloseTo(5, 6);
    expect(polylineLengthM(split!.far)).toBeCloseTo(5, 6);
  });
});

describe("splitRoadMarkingPathAtAnchor", () => {
  function makeLine(points: RoadMarkingNedPoint[]): PlanLine {
    return {
      id: "local-csv-path",
      label: "CSV path (11 pts)",
      layer: "marking",
      from: { id: 1, x: points[0].north, y: points[0].east },
      to: { id: 2, x: points[points.length - 1].north, y: points[points.length - 1].east },
      width: 0.1,
      is_mark: true,
      entity: {
        entity_id: "local-csv-path",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: polylineLengthM(points),
        geometry: {
          closed: false,
          road_marking: true,
          vertexCount: points.length,
          corners: [{ atIndex: 3, turnDeg: 45, class: "clean" }],
        },
        preview_points: points,
      },
    } as PlanLine;
  }

  const straight: RoadMarkingNedPoint[] = Array.from({ length: 11 }, (_, i) => ({
    north: i,
    east: 0,
  }));

  it("produces two distinct, non-colliding PlanLine ids", () => {
    const result = splitRoadMarkingPathAtAnchor(makeLine(straight), 3, 0);
    expect(result).not.toBeNull();
    expect(result!.near).not.toBeNull();
    const near = result!.near!;
    expect(near.id).not.toBe(result!.far.id);
    expect(near.id).not.toMatch(/^local-csv-transit-/);
    expect(result!.far.id).not.toMatch(/^local-csv-transit-/);
  });

  it("both arms start at the anchor and stay marked as mark geometry", () => {
    const result = splitRoadMarkingPathAtAnchor(makeLine(straight), 3, 0);
    expect(result).not.toBeNull();
    expect(result!.near).not.toBeNull();
    const near = result!.near!;
    expect(near.from).toEqual({ id: 1, x: 3, y: 0 });
    expect(result!.far.from).toEqual({ id: 1, x: 3, y: 0 });
    expect(near.is_mark).toBe(true);
    expect(result!.far.is_mark).toBe(true);
    expect(near.layer).toBe("marking");
    expect(result!.far.layer).toBe("marking");
  });

  it("drops stale corner metadata rather than mislabeling it", () => {
    const result = splitRoadMarkingPathAtAnchor(makeLine(straight), 3, 0);
    expect(result).not.toBeNull();
    expect(result!.near).not.toBeNull();
    expect(result!.near!.entity?.geometry.corners).toEqual([]);
    expect(result!.far.entity?.geometry.corners).toEqual([]);
  });

  it("returns null when the line has no preview geometry", () => {
    const bare = { ...makeLine(straight), entity: undefined };
    expect(splitRoadMarkingPathAtAnchor(bare, 3, 0)).toBeNull();
  });

  it("anchor at the current start returns near: null and an unchanged far line", () => {
    const result = splitRoadMarkingPathAtAnchor(makeLine(straight), 0, 0);
    expect(result).not.toBeNull();
    expect(result!.near).toBeNull();
    expect(result!.far.from).toEqual({ id: 1, x: 0, y: 0 });
    expect(result!.far.to).toEqual({ id: 2, x: 10, y: 0 });
  });

  it("anchor at the current end returns near: null and a reversed far line", () => {
    const result = splitRoadMarkingPathAtAnchor(makeLine(straight), 10, 0);
    expect(result).not.toBeNull();
    expect(result!.near).toBeNull();
    expect(result!.far.from).toEqual({ id: 1, x: 10, y: 0 });
    expect(result!.far.to).toEqual({ id: 2, x: 0, y: 0 });
  });

  it("allows an anchor close to an end, producing a short but valid arm", () => {
    const result = splitRoadMarkingPathAtAnchor(makeLine(straight), 1, 0);
    expect(result).not.toBeNull();
    expect(result!.near).not.toBeNull();
    expect(result!.near!.from).toEqual({ id: 1, x: 1, y: 0 });
  });
});
