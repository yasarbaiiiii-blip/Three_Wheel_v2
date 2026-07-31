import { describe, expect, it } from "vitest";
import {
  buildRoadMarkingFittedPath,
  RoadMarkingNedPoint,
} from "./roadMarkingCsvPath";

// Direction invariance (2026-08-01): the sequential fitter used to decompose
// the SAME ground points into different arc chains depending on traversal
// order — measured 2.20 cm mean / 6.12 cm max planned-path shift between the
// two directions of one 54-stake survey (PX4_DXP
// bags/31_07_2026/ANALYSIS_2026-07-31_CLEAN_vs_RAW.md §6). The fitter now
// canonicalises orientation internally, so A→B and B→A must yield the exact
// same polyline, traversed in the caller's direction.

/** Max distance (m) from each point of A to polyline B. */
function maxSep(A: RoadMarkingNedPoint[], B: RoadMarkingNedPoint[]): number {
  let worst = 0;
  for (const p of A) {
    let best = Infinity;
    for (let i = 0; i < B.length - 1; i++) {
      const ax = B[i].north;
      const ay = B[i].east;
      const dx = B[i + 1].north - ax;
      const dy = B[i + 1].east - ay;
      const L2 = dx * dx + dy * dy || 1e-12;
      let t = ((p.north - ax) * dx + (p.east - ay) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.north - (ax + dx * t), p.east - (ay + dy * t));
      if (d < best) best = d;
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** 54-point gentle S-curve with survey-like noise — same character as the
 * field_test_03 survey (52 m, ~1 m spacing, ±1.5 cm deterministic jitter). */
function surveyLikeCurve(): RoadMarkingNedPoint[] {
  const pts: RoadMarkingNedPoint[] = [];
  for (let i = 0; i < 54; i++) {
    const s = i * 0.98;
    pts.push({
      north: s,
      east:
        4.0 * Math.sin(s / 18.0) +
        0.015 * Math.sin(i * 2.399) +
        0.012 * Math.cos(i * 3.117),
    });
  }
  return pts;
}

describe("buildRoadMarkingFittedPath direction invariance", () => {
  it("A→B and B→A produce the identical geometry", () => {
    const fwdPts = surveyLikeCurve();
    const revPts = [...fwdPts].reverse();

    const fwd = buildRoadMarkingFittedPath(fwdPts, {});
    const rev = buildRoadMarkingFittedPath(revPts, {});

    expect(fwd.samples.length).toBeGreaterThan(2);
    expect(rev.samples.length).toBe(fwd.samples.length);

    // Same polyline, exactly (one is the reverse of the other).
    const revBack = [...rev.samples].reverse();
    for (let i = 0; i < fwd.samples.length; i++) {
      expect(revBack[i].north).toBeCloseTo(fwd.samples[i].north, 9);
      expect(revBack[i].east).toBeCloseTo(fwd.samples[i].east, 9);
    }
    expect(maxSep(fwd.samples, revBack)).toBeLessThan(1e-9);

    // Identical quality metrics.
    expect(rev.quality.maxJointTurnDeg).toBeCloseTo(
      fwd.quality.maxJointTurnDeg,
      9
    );
    expect(rev.quality.toleranceM).toBeCloseTo(fwd.quality.toleranceM, 9);
  });

  it("preserves the caller's traversal direction", () => {
    const fwdPts = surveyLikeCurve();
    const revPts = [...fwdPts].reverse();

    const fwd = buildRoadMarkingFittedPath(fwdPts, {});
    const rev = buildRoadMarkingFittedPath(revPts, {});

    // Forward input starts near (0,0); reversed input must start near the
    // far end — the canonicalisation is internal only.
    expect(Math.hypot(fwd.samples[0].north, fwd.samples[0].east)).toBeLessThan(
      1.0
    );
    const last = fwdPts[fwdPts.length - 1];
    expect(
      Math.hypot(
        rev.samples[0].north - last.north,
        rev.samples[0].east - last.east
      )
    ).toBeLessThan(1.0);
  });

  it("leaves closed loops untouched", () => {
    const loop: RoadMarkingNedPoint[] = [];
    for (let i = 0; i <= 36; i++) {
      const a = (i / 36) * 2 * Math.PI;
      loop.push({ north: 5 * Math.cos(a), east: 5 * Math.sin(a) });
    }
    // First ≈ last — must not throw and must still fit.
    const r = buildRoadMarkingFittedPath(loop, {});
    expect(r.samples.length).toBeGreaterThan(2);
  });
});
