/**
 * Sparse surveyed-arc fitting.
 *
 * The operator-visible contract: a curve surveyed with a handful of widely spaced points is
 * drawn as a curve, while a chain of design vertices — a square, a zig-zag — is left exactly
 * as it was. Every assertion below is one of those two statements.
 *
 * The square case earns its own describe block. Its four corners lie EXACTLY on their
 * circumcircle, so the residual gate, the deviation gate and the monotonicity gate all wave it
 * through; only the turn-angle gate stops it becoming a circle. That is the single most
 * load-bearing line in this feature and the one most likely to be "simplified" away later.
 */

import { describe, expect, it } from "vitest";

import {
  buildRoadMarkingFittedPath,
  CORNER_TOLERANCE_M,
  fitCircleHyper,
  fitCircleThroughEndpoints,
  isMonotoneAngularProgression,
  maxTurningAngleDeg,
  SPARSE_ARC_MAX_RESIDUAL_M,
  SPARSE_ARC_RESIDUAL_FLOOR_M,
  SPARSE_ARC_RESIDUAL_RMS_MULTIPLE,
  sparseArcResidualGateM,
  trySparseArcFit,
  turningAngleDeg,
  type RoadMarkingNedPoint,
} from "./roadMarkingCsvPath";

/** Points on a circular arc. `sweepDeg` from the +east axis, centre offset so it is open. */
function arcPoints(n: number, radiusM: number, sweepDeg: number): RoadMarkingNedPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = ((i / (n - 1)) * sweepDeg * Math.PI) / 180;
    return { north: radiusM * (1 - Math.cos(t)), east: radiusM * Math.sin(t) };
  });
}

/** Alternating left/right turns — a deliberate zig-zag road path. */
function zigzag(n: number, legM: number, turnDeg: number): RoadMarkingNedPoint[] {
  const out: RoadMarkingNedPoint[] = [{ north: 0, east: 0 }];
  let heading = 0;
  for (let i = 1; i < n; i++) {
    const prev = out[out.length - 1];
    out.push({
      north: prev.north + legM * Math.sin(heading),
      east: prev.east + legM * Math.cos(heading),
    });
    heading += ((i % 2 === 1 ? 1 : -1) * turnDeg * Math.PI) / 180;
  }
  return out;
}

function square(sideM: number): RoadMarkingNedPoint[] {
  return [
    { north: 0, east: 0 },
    { north: 0, east: sideM },
    { north: sideM, east: sideM },
    { north: sideM, east: 0 },
  ];
}

function segLengths(pts: RoadMarkingNedPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    out.push(Math.hypot(pts[i].north - pts[i - 1].north, pts[i].east - pts[i - 1].east));
  }
  return out;
}

/** Longest straight run — what reads as a facet on the map. */
function longestChordM(pts: RoadMarkingNedPoint[]): number {
  return Math.max(...segLengths(pts));
}

/** Total absolute turning over a path, for asserting bends survive. */
function totalTurnDeg(pts: RoadMarkingNedPoint[]): number {
  let s = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const h1 = Math.atan2(b.east - a.east, b.north - a.north);
    const h2 = Math.atan2(c.east - b.east, c.north - b.north);
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    s += Math.abs((d * 180) / Math.PI);
  }
  return s;
}

describe("the reported case: 10 points, 4.67 m apart, radius 26.8 m", () => {
  const src = arcPoints(10, 26.8, 90);

  it("is fitted as one arc instead of eight elbows", () => {
    const fitted = buildRoadMarkingFittedPath(src);
    expect(fitted.mode).toBe("sparse-arc");
    expect(fitted.paintable).toBe(true);
  });

  it("has no facets left", () => {
    const fitted = buildRoadMarkingFittedPath(src);
    // Fillet mode leaves 3.27 m dead-straight chords between bends; an arc paced at 0.35 m
    // cannot have a segment longer than its spacing.
    expect(longestChordM(fitted.samples)).toBeLessThan(0.4);
    // Curvature spread over the path instead of concentrated: every joint turns the same
    // small amount, where fillet mode alternated 2.50° bends with dead-straight runs.
    expect(maxTurningAngleDeg(fitted.samples)).toBeLessThan(1.5);
  });

  it("is MORE accurate than the fillet path it replaces, not a trade", () => {
    const arc = buildRoadMarkingFittedPath(src);
    // Measured before this change: 0.031 m for waypoint fillets.
    expect(arc.quality.maxSourceDeviationM).toBeLessThan(0.01);
  });

  it("recovers the surveyed radius", () => {
    const fit = trySparseArcFit(src);
    expect(fit).not.toBeNull();
    expect(fit!.circle.r).toBeCloseTo(26.8, 3);
    expect(fit!.maxResidualM).toBeLessThan(1e-6);
  });

  it("anchors both termini to the operator's own points", () => {
    const s = buildRoadMarkingFittedPath(src).samples;
    expect(Math.hypot(s[0].north - src[0].north, s[0].east - src[0].east)).toBeLessThan(1e-9);
    const last = s[s.length - 1];
    const srcLast = src[src.length - 1];
    expect(Math.hypot(last.north - srcLast.north, last.east - srcLast.east)).toBeLessThan(1e-9);
  });
});

describe("a square must stay square", () => {
  const sq = square(2);

  it("every other gate would let it through — this is why the turn gate exists", () => {
    // The four corners lie exactly on the circumcircle, so a naive "fit a circle, accept if
    // the points lie on it" test cannot tell a square from a curve.
    const circle = fitCircleHyper(sq)!;
    expect(circle.r).toBeCloseTo(Math.SQRT2, 6);
    for (const p of sq) {
      const d = Math.hypot(p.north - circle.cn, p.east - circle.ce);
      expect(Math.abs(d - circle.r)).toBeLessThan(SPARSE_ARC_MAX_RESIDUAL_M);
    }
    expect(isMonotoneAngularProgression(sq, circle)).toBe(true);
  });

  it("is rejected anyway, on the turn-angle gate", () => {
    expect(trySparseArcFit(sq)).toBeNull();
    expect(buildRoadMarkingFittedPath(sq).mode).toBe("waypoint-fillet");
  });

  it("keeps its corners in the rendered path", () => {
    const fitted = buildRoadMarkingFittedPath(sq);
    // An open 4-point square outline has two interior corners of 90°. Both survive as bends
    // (the fillets round them, but the total turning is preserved), and the sides stay straight.
    expect(totalTurnDeg(fitted.samples)).toBeCloseTo(180, 0);
    expect(longestChordM(fitted.samples)).toBeGreaterThan(1);
  });
});

describe("a zig-zag must stay a zig-zag", () => {
  it.each([
    ["90° turns", 90],
    ["60° turns", 60],
    ["45° turns", 45],
  ])("rejects on the turn-angle gate: %s", (_label, turn) => {
    const z = zigzag(9, 3, turn);
    expect(trySparseArcFit(z)).toBeNull();
    expect(buildRoadMarkingFittedPath(z).mode).toBe("waypoint-fillet");
  });

  it.each([
    ["30° turns", 30, 0.47],
    ["20° turns", 20, 0.31],
    ["15° turns", 15, 0.23],
    ["8° turns", 8, 0.12],
  ])("rejects on the residual gate: %s", (_label, turn, expectedResidual) => {
    const z = zigzag(9, 3, turn);
    // Below the corner threshold, so gate 1 lets these through and the residual gate does
    // the work. Monotonicity does NOT — a zig-zag sweeps monotonically about its own distant
    // best-fit centre, which is exactly why the residual gate has to exist.
    const circle = fitCircleHyper(z)!;
    expect(isMonotoneAngularProgression(z, circle)).toBe(true);

    let residual = 0;
    for (const p of z) {
      residual = Math.max(residual, Math.abs(Math.hypot(p.north - circle.cn, p.east - circle.ce) - circle.r));
    }
    expect(residual).toBeCloseTo(expectedResidual, 1);
    expect(residual).toBeGreaterThan(SPARSE_ARC_MAX_RESIDUAL_M);

    expect(trySparseArcFit(z)).toBeNull();
    expect(buildRoadMarkingFittedPath(z).mode).toBe("waypoint-fillet");
  });

  it("keeps every degree of bend it was given", () => {
    const z = zigzag(9, 3, 90);
    const fitted = buildRoadMarkingFittedPath(z);
    expect(totalTurnDeg(fitted.samples)).toBeCloseTo(totalTurnDeg(z), 0);
  });

  it("DOES smooth an alternation small enough to be noise — deliberately", () => {
    // 1 m legs, 5° turns: residual 0.031 m, i.e. an alternation of about 2 cm. RTK noise is
    // ~2 cm and the painted line is ~10 cm wide, so this is not a zig-zag anyone specified;
    // smoothing it is noise removal, bounded by the same 5 cm invariant as everything else.
    const tiny = zigzag(9, 1, 5);
    const fit = trySparseArcFit(tiny);
    expect(fit).not.toBeNull();
    expect(fit!.maxResidualM).toBeLessThanOrEqual(SPARSE_ARC_MAX_RESIDUAL_M);
    expect(buildRoadMarkingFittedPath(tiny).mode).toBe("sparse-arc");
  });

  it.each([
    ["1 m legs", 1],
    ["3 m legs", 3],
  ])("preserves an 8° alternation, the smallest that reads as deliberate: %s", (_l, leg) => {
    // Residual 0.050 m at 1 m legs and 0.150 m at 3 m — both outside the gate, so the
    // alternation survives. This is where the line now sits between noise and design.
    const real = zigzag(9, leg, 8);
    expect(trySparseArcFit(real)).toBeNull();
    expect(buildRoadMarkingFittedPath(real).mode).toBe("waypoint-fillet");
  });
});

describe("the path must arrive at its own endpoints on tangent", () => {
  /**
   * Reported from the field: the first half metre of the mission looked straight while the
   * rest curved, and the 0.5 m run-up left visibly off the curve.
   *
   * Cause: an unconstrained best-fit circle generally misses the termini, and the I1 rule then
   * drags them onto the operator's points. That skews the first and last CHORDS — a kink at
   * the first joint, and a run-up misaimed by the same angle because `terminalUnitVector`
   * follows that chord. Constraining the fit through both endpoints removes the conflict.
   */
  function withEndpointOffCircle(offsetM: number): RoadMarkingNedPoint[] {
    const src = arcPoints(10, 26.8, 90);
    const dn = src[0].north - 26.8;
    const de = src[0].east - 0;
    const len = Math.hypot(dn, de);
    src[0] = {
      north: src[0].north + (dn / len) * offsetM,
      east: src[0].east + (de / len) * offsetM,
    };
    return src;
  }

  function jointTurns(pts: RoadMarkingNedPoint[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < pts.length - 1; i++) {
      out.push(Math.abs(turningAngleDeg(pts[i - 1], pts[i], pts[i + 1])));
    }
    return out;
  }

  it.each([0, 0.01, 0.03, 0.045])(
    "interpolates an off-circle terminus exactly instead of dragging it onto the fit: %s m",
    (offsetM) => {
      // FRONTEND_NOTE_sparse_arc_fit_misses_survey_points.md: resampling one global circle
      // (the old behavior this replaced) silently drags any point not exactly on that circle
      // onto it — including a deliberately off-circle terminus, same as the reported interior-
      // point miss. Exact interpolation is the new, primary invariant; perfectly uniform
      // turning between every joint (the old assertion here) only holds when every point
      // truly lies on one circle, which an intentionally-perturbed terminus does not — see the
      // note's "decision needed before coding" for why both cannot hold at once.
      const src = withEndpointOffCircle(offsetM);
      const fitted = buildRoadMarkingFittedPath(src);
      expect(fitted.mode).toBe("sparse-arc");
      expect(fitted.quality.maxSourceDeviationM).toBeLessThan(1e-6);
      // Still must read as one smooth curve, not a hard kink: per-joint turning stays small
      // (typical per-tessellation-step turn on this 26.8 m arc is ~0.74°; even the joint
      // nearest a 4.5 cm-off terminus stays well under a degree).
      const turns = jointTurns(fitted.samples);
      expect(Math.max(...turns)).toBeLessThan(2);
    }
  );

  it("puts the arc exactly through both surveyed termini", () => {
    const src = withEndpointOffCircle(0.03);
    const circle = fitCircleThroughEndpoints(src, fitCircleHyper(src))!;
    for (const p of [src[0], src[src.length - 1]]) {
      const d = Math.hypot(p.north - circle.cn, p.east - circle.ce);
      expect(d).toBeCloseTo(circle.r, 9);
    }
  });

  it("refuses rather than falling back to a fit that cannot hold its endpoints", () => {
    // Endpoints coincident — no chord, so no bisector and no constrained fit. Must fall
    // through to fillets rather than silently using the unconstrained circle.
    const closed = [...arcPoints(8, 20, 300), { north: 20 * (1 - Math.cos(0)), east: 0 }];
    closed[closed.length - 1] = { ...closed[0] };
    expect(fitCircleThroughEndpoints(closed, fitCircleHyper(closed))).toBeNull();
  });
});

describe("the invariant worth remembering", () => {
  it("an accepted arc never moves the paint more than the residual gate allows", () => {
    const shapes: RoadMarkingNedPoint[][] = [
      arcPoints(10, 26.8, 90),
      arcPoints(6, 12, 45),
      arcPoints(20, 80, 200),
      zigzag(9, 1, 8),
      zigzag(9, 1, 5),
    ];
    for (const src of shapes) {
      const fit = trySparseArcFit(src);
      if (!fit) continue;
      const fitted = buildRoadMarkingFittedPath(src);
      expect(fitted.mode).toBe("sparse-arc");
      expect(fitted.quality.maxSourceDeviationM).toBeLessThanOrEqual(SPARSE_ARC_MAX_RESIDUAL_M);
    }
  });
});

describe("gates reject what they cannot establish", () => {
  it("needs more than three points — three always define a circle exactly", () => {
    const three = arcPoints(3, 26.8, 90);
    expect(trySparseArcFit(three)).toBeNull();
  });

  it("rejects points that do not lie on their own best-fit circle", () => {
    const wobbly = arcPoints(10, 26.8, 90).map((p, i) => ({
      north: p.north + (i % 2 === 0 ? 0.4 : -0.4),
      east: p.east,
    }));
    expect(trySparseArcFit(wobbly)).toBeNull();
    expect(buildRoadMarkingFittedPath(wobbly).mode).toBe("waypoint-fillet");
  });

  it("rejects a radius below the rover's turning floor", () => {
    const tight = arcPoints(10, 0.3, 90);
    expect(trySparseArcFit(tight)).toBeNull();
  });

  it("rejects a radius so large the points are a straight line", () => {
    const straight = Array.from({ length: 10 }, (_, i) => ({ north: 0, east: i * 4 }));
    expect(trySparseArcFit(straight)).toBeNull();
  });

  it("survives duplicate and collinear points without throwing", () => {
    const degenerate: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 0, east: 0 },
      { north: 0, east: 1 },
      { north: 0, east: 2 },
      { north: 0, east: 2 },
    ];
    expect(() => buildRoadMarkingFittedPath(degenerate)).not.toThrow();
    expect(trySparseArcFit(degenerate)).toBeNull();
  });
});

describe("sparseArcResidualGateM — scaling the gate to the survey's own reported precision", () => {
  it("falls back to the fixed default when no RMS is reported", () => {
    expect(sparseArcResidualGateM(undefined)).toBe(SPARSE_ARC_MAX_RESIDUAL_M);
    expect(sparseArcResidualGateM(null)).toBe(SPARSE_ARC_MAX_RESIDUAL_M);
  });

  it("treats non-finite or non-positive RMS as unreported", () => {
    expect(sparseArcResidualGateM(0)).toBe(SPARSE_ARC_MAX_RESIDUAL_M);
    expect(sparseArcResidualGateM(-0.02)).toBe(SPARSE_ARC_MAX_RESIDUAL_M);
    expect(sparseArcResidualGateM(NaN)).toBe(SPARSE_ARC_MAX_RESIDUAL_M);
    expect(sparseArcResidualGateM(Infinity)).toBe(SPARSE_ARC_MAX_RESIDUAL_M);
  });

  it("scales linearly by the documented multiplier in the middle of its range", () => {
    // 0.017 m is this file's own reported Lateral RMS — the case this feature exists for.
    expect(sparseArcResidualGateM(0.017)).toBeCloseTo(
      SPARSE_ARC_RESIDUAL_RMS_MULTIPLE * 0.017,
      9
    );
  });

  it("never drops below the sanity floor, even for an implausibly precise RMS", () => {
    expect(sparseArcResidualGateM(0.0001)).toBe(SPARSE_ARC_RESIDUAL_FLOOR_M);
  });

  it("never exceeds the paint budget, even for a very noisy survey", () => {
    // The same budget the dense pipeline is judged against — RMS confidence may loosen the
    // gate, never past what is already an acceptable paint error elsewhere in this file.
    expect(sparseArcResidualGateM(1)).toBe(CORNER_TOLERANCE_M);
  });

  it("is what trySparseArcFit actually judges the fit against", () => {
    const src = arcPoints(10, 26.8, 90);
    const fit = trySparseArcFit(src, { surveyRmsM: 0.02 });
    expect(fit).not.toBeNull();
    expect(fit!.gateM).toBe(sparseArcResidualGateM(0.02));
  });
});

describe("sampling stays bounded", () => {
  it("paces a huge surveyed ring by the budget, not by arc length", () => {
    // 1 km radius shot with 40 points: 6.3 km of arc, which at the default 0.35 m spacing
    // would be 17.5k vertices. This is the case the existing suite caught.
    const ring = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      return { north: 1000 * Math.sin(a), east: 1000 * Math.cos(a) };
    });
    const fitted = buildRoadMarkingFittedPath(ring);
    expect(fitted.samples.length).toBeLessThanOrEqual(8100);
  });

  it("leaves an ordinary curve at the default spacing", () => {
    const fitted = buildRoadMarkingFittedPath(arcPoints(10, 26.8, 90));
    const segs = segLengths(fitted.samples).filter((s) => s > 1e-6);
    for (const s of segs) expect(s).toBeLessThanOrEqual(0.36);
  });
});

describe("the operator-reported case: curve_6_points.csv", () => {
  /**
   * NED metres transcribed from the real survey (8 usable points after this pipeline's own
   * 2 cm dedupe; a trailing 3-sample cluster 2 mm apart collapses into the 8th). Its own
   * Lateral RMS is 1.6-1.8 cm; worst point 0.018 m is what {@link groupSurveyRmsM} in
   * localPointCsv.ts would compute for this file.
   */
  const points: RoadMarkingNedPoint[] = [
    { north: 0.0, east: 0.0 },
    { north: -0.051, east: 0.546 },
    { north: -0.043, east: 1.178 },
    { north: 0.244, east: 2.015 },
    { north: 0.801, east: 2.58 },
    { north: 1.184, east: 2.879 },
    { north: 1.834, east: 3.059 },
    { north: 2.512, east: 3.102 },
  ];
  const REPORTED_RMS_M = 0.018;

  it("is rejected under the fixed default gate — the 1.8 mm near miss", () => {
    const fit = trySparseArcFit(points);
    expect(fit).toBeNull();
    expect(buildRoadMarkingFittedPath(points).mode).toBe("waypoint-fillet");
  });

  it("is accepted once the survey's own RMS scales the gate", () => {
    const fit = trySparseArcFit(points, { surveyRmsM: REPORTED_RMS_M });
    expect(fit).not.toBeNull();
    expect(fit!.maxResidualM).toBeLessThanOrEqual(fit!.gateM);
    expect(buildRoadMarkingFittedPath(points, { surveyRmsM: REPORTED_RMS_M }).mode).toBe(
      "sparse-arc"
    );
  });

  it("no more 1.48 m/4.90 m radius oscillation — every joint stays a driveable curve, not a corner", () => {
    // The original per-vertex fillet bug this feature exists to replace: fillet radius derived
    // from local turn angle swung 1.48 m → 4.90 m → 1.48 m against a true ~2.4 m curve. This
    // checks the actual driveability property, not perfectly uniform turning (which the fix
    // below intentionally trades away in favor of hitting every point — see the next test).
    const fitted = buildRoadMarkingFittedPath(points, { surveyRmsM: REPORTED_RMS_M });
    const turns: number[] = [];
    for (let i = 1; i < fitted.samples.length - 1; i++) {
      turns.push(
        Math.abs(
          turningAngleDeg(fitted.samples[i - 1], fitted.samples[i], fitted.samples[i + 1])
        )
      );
    }
    // A hard corner reads as tens of degrees between tessellation steps; a smooth curve at
    // this radius/spacing does not, even allowing for the real survey's own point-to-point
    // noise (unlike the fixed 0.1° bar this replaces, which assumed every point sits exactly
    // on one circle).
    expect(Math.max(...turns)).toBeLessThan(15);
  });

  it("hits every one of the 8 surveyed points exactly — FRONTEND_NOTE_sparse_arc_fit_misses_survey_points.md's acceptance test", () => {
    // The actual reported bug: interior points measured up to 7.09 cm off the emitted path on
    // a ±2 cm spec, because the old fit resampled one global circle and let interior points
    // land wherever it happened to pass. This is the property that matters.
    const fitted = buildRoadMarkingFittedPath(points, { surveyRmsM: REPORTED_RMS_M });
    expect(fitted.mode).toBe("sparse-arc");
    for (const p of points) {
      const nearest = Math.min(
        ...fitted.samples.map((s) => Math.hypot(s.north - p.north, s.east - p.east))
      );
      expect(nearest).toBeLessThan(0.01); // note's acceptance test: ≤ 1 cm per surveyed point
    }
    expect(fitted.quality.maxSourceDeviationM).toBeLessThan(1e-6);
  });
});

describe("determinism", () => {
  it("gives byte-identical output for the same input", () => {
    const src = arcPoints(12, 40, 120);
    const a = buildRoadMarkingFittedPath(src);
    const b = buildRoadMarkingFittedPath(src);
    expect(JSON.stringify(a.samples)).toBe(JSON.stringify(b.samples));
  });
});
