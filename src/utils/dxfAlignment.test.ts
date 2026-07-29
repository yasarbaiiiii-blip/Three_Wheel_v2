import { describe, expect, it } from "vitest";
import type { PlanLine } from "../types/plan";
import {
  alignmentFromGeographic,
  applyAlignmentToLines,
  solveMultiPointAlignment,
} from "./dxfAlignment";
import { metresPerDegreePx4 } from "./geoProjection";

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
    };
    const out = applyAlignmentToLines(lines, a, 0, 0);
    // 90° CCW: (n,e)=(1,0) → (0,1) then *2 → (0,2)
    expect(out[0].from.x).toBeCloseTo(0, 6);
    expect(out[0].from.y).toBeCloseTo(2, 6);
    expect(out[0].entity!.preview_points[0].north).toBeCloseTo(0, 6);
    expect(out[0].entity!.preview_points[0].east).toBeCloseTo(2, 6);
  });

  it("multi-point RMSE is small for a pure translation", () => {
    const m = metresPerDegreePx4(13);
    const refs = [
      {
        designNorth: 0,
        designEast: 0,
        lat: 13,
        lon: 80,
      },
      {
        designNorth: 10,
        designEast: 0,
        lat: 13 + 10 / m.mPerDegNorth,
        lon: 80,
      },
    ];
    const a = solveMultiPointAlignment(refs, metresPerDegreePx4);
    expect(a.rmseM ?? 1).toBeLessThan(0.01);
    expect(a.scale).toBeCloseTo(1, 2);
  });
});
