import { describe, expect, it } from "vitest";

import {
  buildRoadMarkingFittedPath,
  buildRoadMarkingPreviewPoints,
  classifyPointSequence,
  maxSourceDeviationM,
  maxTurningAngleDeg,
  pathExtentM,
  polylineLengthM,
  tryWholeLoopFit,
  validateFittedPath,
  R_MIN_ROVER_M,
  CORNER_TOLERANCE_M,
  MAX_BARE_TURN_DEG,
} from "./roadMarkingCsvPath";

function ringPoints(r: number, n: number, noise = 0): { north: number; east: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const j = noise === 0 ? 0 : ((i * 17) % 7) * 0.001 * noise;
    return { north: r * Math.sin(a) + j, east: r * Math.cos(a) - j };
  });
}

describe("CSV geometry robustness", () => {
  it("classifies sparse waypoint files as sparse", () => {
    const square = [
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ];
    expect(classifyPointSequence(square).class).toBe("sparse-waypoints");
  });

  it("classifies dense rings as dense-survey", () => {
    const ring = ringPoints(11.5, 146, 0.02);
    expect(classifyPointSequence(ring).class).toBe("dense-survey");
  });

  it("softens sparse 90° corners instead of returning raw polyline", () => {
    // mission.csv class: 3-point L
    const mission = [
      { north: 0, east: 0 },
      { north: 0, east: 1 },
      { north: 1, east: 1 },
    ];
    const fitted = buildRoadMarkingFittedPath(mission);
    expect(fitted.mode).toBe("waypoint-fillet");
    expect(fitted.samples.length).toBeGreaterThan(3);
    expect(maxTurningAngleDeg(fitted.samples)).toBeLessThan(45);
    // I1 endpoints
    expect(fitted.samples[0].north).toBeCloseTo(0, 3);
    expect(fitted.samples[0].east).toBeCloseTo(0, 3);
    expect(fitted.samples[fitted.samples.length - 1].north).toBeCloseTo(1, 3);
    expect(fitted.samples[fitted.samples.length - 1].east).toBeCloseTo(1, 3);
  });

  it("preserves 2x2 square extent and fillets corners", () => {
    const square = [
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ];
    const out = buildRoadMarkingPreviewPoints(square);
    expect(maxTurningAngleDeg(out)).toBeLessThan(50);
    const srcLen = polylineLengthM(square);
    const outLen = polylineLengthM(out);
    expect(outLen / srcLen).toBeGreaterThan(0.75);
    expect(outLen / srcLen).toBeLessThan(1.25);
    expect(pathExtentM(out)).toBeGreaterThan(pathExtentM(square) * 0.85);
  });

  it("does not invent a huge circle from zig-zag / non-spatial order", () => {
    // Synthetic stand-in for utm_to_latlon_44N failure class: points span ~40 m
    // but file order zig-zags; previously tryWholeLoopFit accepted r hundreds of m.
    const zig: { north: number; east: number }[] = [];
    for (let i = 0; i < 13; i++) {
      zig.push({
        north: (i % 2 === 0 ? 1 : -1) * (i * 1.5),
        east: Math.sin(i * 1.7) * 8 + i * 0.3,
      });
    }
    expect(tryWholeLoopFit(zig, 0.15)).toBeNull();
    const fitted = buildRoadMarkingFittedPath(zig);
    const srcExtent = pathExtentM(zig);
    expect(pathExtentM(fitted.samples)).toBeLessThan(srcExtent * 1.2 + 1);
    expect(polylineLengthM(fitted.samples)).toBeLessThan(polylineLengthM(zig) * 1.3 + 1);
  });

  it("rejects out-and-back whole-loop fits", () => {
    const outAndBack: { north: number; east: number }[] = [];
    for (let i = 0; i < 10; i++) outAndBack.push({ north: 0, east: i * 2 });
    for (let i = 9; i >= 0; i--) outAndBack.push({ north: 0.2, east: i * 2 });
    expect(tryWholeLoopFit(outAndBack, 0.2)).toBeNull();
  });

  it("still fits a dense near-closed ring as a single circle path", () => {
    // Nearly closed: first≈last within spacing-aware gap (real roundabout surveys).
    const ring = ringPoints(11.5, 146, 0.02);
    const closedish = ring.slice();
    // Nudge last toward first so gap is one sample step, not zero (open path).
    const last = closedish[closedish.length - 1];
    const first = closedish[0];
    closedish[closedish.length - 1] = {
      north: last.north * 0.15 + first.north * 0.85,
      east: last.east * 0.15 + first.east * 0.85,
    };
    const fit = tryWholeLoopFit(closedish, 0.15);
    expect(fit).not.toBeNull();
    expect(fit!.r).toBeGreaterThan(10);
    expect(fit!.r).toBeLessThan(13);

    const out = buildRoadMarkingPreviewPoints(closedish);
    expect(maxTurningAngleDeg(out)).toBeLessThanOrEqual(8);
    expect(pathExtentM(out)).toBeGreaterThan(pathExtentM(closedish) * 0.9);
  });

  it("never returns a silently collapsed dense fit", () => {
    const ring = ringPoints(11.5, 40, 0.02);
    const out = buildRoadMarkingPreviewPoints(ring);
    expect(pathExtentM(out) / pathExtentM(ring)).toBeGreaterThan(0.9);
  });

  it("validateFittedPath catches extent explosion", () => {
    const src = [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
      { north: 10, east: 10 },
    ];
    const huge = ringPoints(500, 32);
    const v = validateFittedPath(src, huge);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /explod/i.test(r))).toBe(true);
  });

  it("waypoint corner cut stays near paint budget for 90° with long legs", () => {
    const pts = [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
      { north: 10, east: 10 },
    ];
    const fitted = buildRoadMarkingFittedPath(pts);
    // Pin 2 is cut inside; deviation should be order of corner tolerance / r_min miss.
    const dev = maxSourceDeviationM(pts, fitted.samples);
    expect(dev).toBeLessThan(Math.max(CORNER_TOLERANCE_M * 4, R_MIN_ROVER_M));
  });

  it("exports production policy constants", () => {
    expect(R_MIN_ROVER_M).toBeGreaterThan(0);
    expect(CORNER_TOLERANCE_M).toBeGreaterThan(0);
  });

  it("dense-fits a real serpentine field survey instead of degrading to waypoint fillets (regression: field_test_02.csv, 2026-07-31)", () => {
    // Full raw 78-point RTK survey (field_test_02.csv), reported HRMS 0.02 m. A genuine
    // r=2.55m ~90deg turn partway through was previously flattened by
    // absorbSandwichedCornerArcs (neighbor-turn-angle heuristic, no overshoot check), missing
    // a surveyed point by 0.79m — 9x the fit tolerance — which tripped validateFittedPath and
    // dropped the WHOLE dense fit to the per-point waypoint-fillet fallback: every one of the
    // 78 raw fixes became its own straight leg with only light corner rounding, i.e. the
    // reported "wobbly, corners and edges instead of straight and curve" preview bug.
    const raw: { north: number; east: number }[] = [
      [0, 0], [1.8636, 0.0758], [4.0608, 0.1386], [6.228, 0.197], [8.6643, 0.3313], [10.9849, 0.38],
      [12.9965, 0.4038], [15.1848, 0.459], [17.2519, 0.511], [19.4925, 0.5056], [21.4362, 0.4633],
      [24.0081, 0.4103], [25.467, 0.4136], [26.729, 0.4114], [27.3317, 0.3724], [27.9333, 0.3356],
      [28.4581, 0.3648], [28.8707, 0.3995], [29.4366, 0.4742], [29.8692, 0.5142], [30.3507, 0.5619],
      [30.8132, 0.7892], [31.1846, 1.0967], [31.6016, 1.4788], [31.8651, 2.0223], [31.8907, 2.5008],
      [31.8974, 3.0821], [31.8996, 3.7837], [31.8295, 4.7764], [31.7395, 5.7334], [31.6783, 6.6774],
      [31.6272, 7.3681], [31.596, 8.4182], [31.5427, 9.4315], [31.5883, 10.394], [31.5871, 11.2817],
      [31.6261, 12.0644], [31.6294, 12.9478], [31.6361, 13.8951], [31.6772, 14.9116], [31.7617, 15.9401],
      [31.7973, 16.9393], [31.8796, 18.1107], [31.9007, 18.6065], [31.9763, 18.9367], [32.0542, 19.3513],
      [32.1843, 19.7519], [32.3288, 20.1546], [32.4967, 20.7814], [32.6857, 21.2881], [32.8625, 21.7882],
      [33.0583, 22.2408], [33.1906, 22.7128], [33.3318, 23.1675], [33.6031, 23.6189], [33.95, 24.2414],
      [34.3203, 24.8152], [34.6005, 25.233], [34.9775, 25.7397], [35.2721, 26.1814], [35.5157, 26.5527],
      [35.8593, 26.9739], [36.2596, 27.4415], [36.6376, 27.8778], [37.0335, 28.3173], [37.3848, 28.6659],
      [37.9753, 29.1856], [38.4801, 29.6933], [38.4768, 29.7009], [39.0683, 30.108], [39.5743, 30.476],
      [40.1959, 30.9578], [40.8975, 31.3789], [41.6625, 31.9841], [42.4842, 32.5557], [43.1603, 33.0515],
      [43.7096, 33.5214], [44.4824, 34.0453],
    ].map(([north, east]) => ({ north, east }));

    const fitted = buildRoadMarkingFittedPath(raw, { surveyRmsM: 0.02 });
    expect(fitted.mode).toBe("dense-fit");
    expect(fitted.quality.maxSourceDeviationM).toBeLessThan(CORNER_TOLERANCE_M);
    expect(polylineLengthM(fitted.samples) / polylineLengthM(raw)).toBeGreaterThan(0.95);
  });

  it("smooths the straight-to-curve joint below the clean-path turn bar (regression: field_test_02.csv chord/kink, 2026-07-31)", () => {
    // Same survey as above. Even once the dense fit is accepted, a fixed 3-sample linear
    // taper at the internal seam between the long straight run and the r=2.55m curve left a
    // 15.9deg direction snap — a visible "chord then corner" artifact reported after the
    // first fix, distinct from (and downstream of) the dense-fit-acceptance bug fixed above.
    const raw: { north: number; east: number }[] = [
      [0, 0], [1.8636, 0.0758], [4.0608, 0.1386], [6.228, 0.197], [8.6643, 0.3313], [10.9849, 0.38],
      [12.9965, 0.4038], [15.1848, 0.459], [17.2519, 0.511], [19.4925, 0.5056], [21.4362, 0.4633],
      [24.0081, 0.4103], [25.467, 0.4136], [26.729, 0.4114], [27.3317, 0.3724], [27.9333, 0.3356],
      [28.4581, 0.3648], [28.8707, 0.3995], [29.4366, 0.4742], [29.8692, 0.5142], [30.3507, 0.5619],
      [30.8132, 0.7892], [31.1846, 1.0967], [31.6016, 1.4788], [31.8651, 2.0223], [31.8907, 2.5008],
      [31.8974, 3.0821], [31.8996, 3.7837], [31.8295, 4.7764], [31.7395, 5.7334], [31.6783, 6.6774],
      [31.6272, 7.3681], [31.596, 8.4182], [31.5427, 9.4315], [31.5883, 10.394], [31.5871, 11.2817],
      [31.6261, 12.0644], [31.6294, 12.9478], [31.6361, 13.8951], [31.6772, 14.9116], [31.7617, 15.9401],
      [31.7973, 16.9393], [31.8796, 18.1107], [31.9007, 18.6065], [31.9763, 18.9367], [32.0542, 19.3513],
      [32.1843, 19.7519], [32.3288, 20.1546], [32.4967, 20.7814], [32.6857, 21.2881], [32.8625, 21.7882],
      [33.0583, 22.2408], [33.1906, 22.7128], [33.3318, 23.1675], [33.6031, 23.6189], [33.95, 24.2414],
      [34.3203, 24.8152], [34.6005, 25.233], [34.9775, 25.7397], [35.2721, 26.1814], [35.5157, 26.5527],
      [35.8593, 26.9739], [36.2596, 27.4415], [36.6376, 27.8778], [37.0335, 28.3173], [37.3848, 28.6659],
      [37.9753, 29.1856], [38.4801, 29.6933], [38.4768, 29.7009], [39.0683, 30.108], [39.5743, 30.476],
      [40.1959, 30.9578], [40.8975, 31.3789], [41.6625, 31.9841], [42.4842, 32.5557], [43.1603, 33.0515],
      [43.7096, 33.5214], [44.4824, 34.0453],
    ].map(([north, east]) => ({ north, east }));

    const fitted = buildRoadMarkingFittedPath(raw, { surveyRmsM: 0.02 });
    expect(fitted.mode).toBe("dense-fit");
    expect(fitted.warnings).toEqual([]);
    expect(fitted.quality.maxJointTurnDeg).toBeLessThanOrEqual(MAX_BARE_TURN_DEG);
    expect(fitted.quality.maxSourceDeviationM).toBeLessThan(CORNER_TOLERANCE_M);
  });
});
