import { describe, expect, it } from "vitest";
import type { PlanLine } from "../types/plan";
import {
  alignmentFromGeographic,
  applyAlignmentToLines,
  solveMultiPointAlignment,
} from "./dxfAlignment";
import {
  ALIGNMENT_MAX_ORIGIN_OFFSET_M,
  ALIGNMENT_MAX_RESIDUAL_M,
  ALIGNMENT_MAX_RMSE_M,
  assessAlignmentTrust,
} from "./designAlignmentPolicy";
import { projectGpsToLocalMeters, projectLocalMetersToGps } from "./geoProjection";

function line(n0: number, e0: number, n1: number, e1: number): PlanLine {
  return {
    id: "l1",
    label: "l1",
    layer: "marking",
    from: { id: 1, x: n0, y: e0 },
    to: { id: 2, x: n1, y: e1 },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: "l1",
      entity_type: "LINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: Math.hypot(n1 - n0, e1 - e0),
      geometry: {},
      preview_points: [
        { north: n0, east: e0 },
        { north: n1, east: e1 },
      ],
    },
  };
}

describe("dxfAlignment", () => {
  it("geographic alignment is identity transform params", () => {
    const a = alignmentFromGeographic({ lat: 13.1, lon: 80.2 });
    expect(a.originGps).toEqual([13.1, 80.2]);
    expect(a.rotationDeg).toBe(0);
    expect(a.scale).toBe(1);
  });

  it("applyAlignmentToLines rotates and scales about origin", () => {
    const lines = [line(1, 0, 2, 0)];
    const a = {
      method: "visual" as const,
      originGps: [0, 0] as [number, number],
      rotationDeg: 90,
      scale: 2,
      rmseM: null,
      residualsM: [],
      warnings: [],
      originOffsetM: 0,
    };
    const out = applyAlignmentToLines(lines, a, 0, 0);
    // 90° CCW: (n,e)=(1,0) → (0,1) then *2 → (0,2)
    expect(out[0].from.x).toBeCloseTo(0, 6);
    expect(out[0].from.y).toBeCloseTo(2, 6);
    expect(out[0].entity!.preview_points[0].north).toBeCloseTo(0, 6);
    expect(out[0].entity!.preview_points[0].east).toBeCloseTo(2, 6);
  });

  const refFor = (lat0: number, lon0: number, n: number, e: number) => {
    const g = projectLocalMetersToGps(n, e, lat0, lon0);
    return { designNorth: n, designEast: e, lat: g.lat, lon: g.lon };
  };

  it("a metric design fits survey points at scale 1 with ~zero residual (WGS84 maths)", () => {
    const refs = [
      refFor(13.0827, 80.2707, 0, 0),
      refFor(13.0827, 80.2707, 400, 0),
      refFor(13.0827, 80.2707, 400, 300),
      refFor(13.0827, 80.2707, 0, 300),
    ];
    const a = solveMultiPointAlignment(refs);
    expect(a.scale).toBeCloseTo(1, 6);
    expect(a.rotationDeg).toBeCloseTo(0, 3); // residual is true meridian convergence (~0.0004 deg over 300 m)
    expect(a.rmseM!).toBeLessThan(1e-4);
    const trust = assessAlignmentTrust(a);
    expect(trust.ok).toBe(true);
    expect(trust.blockers).toEqual([]);
    // origin_gps is the GPS of design (0, 0)
    const back = projectGpsToLocalMeters(a.originGps[0], a.originGps[1], refs[0].lat, refs[0].lon);
    expect(Math.hypot(back.north, back.east)).toBeLessThan(1e-4);
  });

  it("reports the fitted scale unclamped", () => {
    const refs = [
      refFor(13, 80, 0, 0),
      refFor(13, 80, 10, 0),
    ].map((r) => ({ ...r, designNorth: r.designNorth / 100, designEast: r.designEast / 100 }));
    const a = solveMultiPointAlignment(refs);
    expect(a.scale).toBeCloseTo(100, 3);
  });

  it("blocks a scale error above 0.5 percent as a probable unit or survey error", () => {
    const refs = [refFor(13, 80, 0, 0), refFor(13, 80, 100, 0), refFor(13, 80, 100, 100)].map(
      (r) => ({ ...r, designNorth: r.designNorth * 1.01, designEast: r.designEast * 1.01 })
    );
    const a = solveMultiPointAlignment(refs);
    expect(a.scale).toBeCloseTo(1 / 1.01, 4);
    const trust = assessAlignmentTrust(a);
    expect(trust.ok).toBe(false);
    expect(trust.blockers.join(" ")).toMatch(/scale/i);
    expect(trust.blockers.join(" ")).toMatch(/unit or survey error/i);
  });

  it("accepts a scale within 0.5 percent", () => {
    const refs = [refFor(13, 80, 0, 0), refFor(13, 80, 100, 0), refFor(13, 80, 100, 100)].map(
      (r) => ({ ...r, designNorth: r.designNorth * 1.003, designEast: r.designEast * 1.003 })
    );
    expect(assessAlignmentTrust(solveMultiPointAlignment(refs)).ok).toBe(true);
  });

  it("blocks when RMSE exceeds 3 cm", () => {
    const refs = [
      refFor(13, 80, 0, 0),
      refFor(13, 80, 200, 0),
      refFor(13, 80, 200, 200),
      refFor(13, 80, 0, 200),
    ];
    // Move one survey point 8 cm: RMSE ~ 0.03+, and well above both limits' neighbourhood.
    const bent = refs.map((r, i) =>
      i === 2 ? { ...r, ...projectLocalMetersToGps(200.2, 200, 13, 80) } : r
    );
    const a = solveMultiPointAlignment(bent);
    expect(a.rmseM!).toBeGreaterThan(ALIGNMENT_MAX_RMSE_M);
    const trust = assessAlignmentTrust(a);
    expect(trust.ok).toBe(false);
    expect(trust.blockers.join(" ")).toMatch(/RMSE/);
  });

  it("blocks when a single residual exceeds 5 cm even if RMSE is below 3 cm", () => {
    const base = Array.from({ length: 16 }, (_, i) => refFor(13, 80, (i % 4) * 100, Math.floor(i / 4) * 100));
    const bent = base.map((r, i) =>
      i === 5 ? { ...r, ...projectLocalMetersToGps(100 + 0.1, 100, 13, 80) } : r
    );
    const a = solveMultiPointAlignment(bent);
    expect(a.rmseM!).toBeLessThan(ALIGNMENT_MAX_RMSE_M);
    expect(Math.max(...a.residualsM)).toBeGreaterThan(ALIGNMENT_MAX_RESIDUAL_M);
    const trust = assessAlignmentTrust(a);
    expect(trust.ok).toBe(false);
    expect(trust.blockers.join(" ")).toMatch(/misses by/);
  });

  it("single reference point: translation only, origin shifted by the design offset, rotation warning", () => {
    const ref = refFor(13.0827, 80.2707, 0, 0);
    const a = solveMultiPointAlignment([
      { designNorth: 50, designEast: 20, lat: ref.lat, lon: ref.lon },
    ]);
    expect(a.rotationDeg).toBe(0);
    expect(a.scale).toBe(1);
    expect(a.warnings.join(" ")).toMatch(/rotation is unverified/i);
    expect(a.warnings.join(" ")).toMatch(/north is assumed/i);
    // design (0,0) sits 50 m south and 20 m west of the reference point
    const back = projectGpsToLocalMeters(a.originGps[0], a.originGps[1], ref.lat, ref.lon);
    expect(back.north).toBeCloseTo(-50, 5);
    expect(back.east).toBeCloseTo(-20, 5);
    const trust = assessAlignmentTrust(a);
    expect(trust.ok).toBe(true);
    expect(trust.warnings.length).toBe(1);
  });

  it("envelope assertion: an origin extrapolated 1000 km away is blocked", () => {
    const ref = refFor(13, 80, 0, 0);
    const a = solveMultiPointAlignment([
      { designNorth: 1_000_000, designEast: 0, lat: ref.lat, lon: ref.lon },
    ]);
    expect(a.originOffsetM).toBeGreaterThan(ALIGNMENT_MAX_ORIGIN_OFFSET_M);
    const trust = assessAlignmentTrust(a);
    expect(trust.ok).toBe(false);
    expect(trust.blockers.join(" ")).toMatch(/km from the reference points/);
  });

  it("multi-point RMSE is small for a pure translation", () => {
    const refs = [refFor(13, 80, 0, 0), refFor(13, 80, 10, 0)];
    const a = solveMultiPointAlignment(refs);
    expect(a.rmseM ?? 1).toBeLessThan(0.01);
    expect(a.scale).toBeCloseTo(1, 2);
  });
});
