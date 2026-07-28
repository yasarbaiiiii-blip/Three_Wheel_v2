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
});
