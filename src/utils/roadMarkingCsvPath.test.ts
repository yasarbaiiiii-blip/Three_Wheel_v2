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
} from "./roadMarkingCsvPath";

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
