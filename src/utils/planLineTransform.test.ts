import { describe, it, expect } from "vitest";
import type { PlanLine } from "../types/plan";
import { getCurveGeometry, sampleCurveEntityPoints } from "./curveGeometry";
import {
  similarityTransform,
  transformPlanLineGeometry,
  translationTransform,
} from "./planLineTransform";

function makeCircleLine(
  centerNorth: number,
  centerEast: number,
  radius: number
): PlanLine {
  const steps = 32;
  const preview_points = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return {
      north: centerNorth + radius * Math.sin(a),
      east: centerEast + radius * Math.cos(a),
    };
  });
  return {
    id: "circle-1",
    label: "circle",
    layer: "marking",
    from: { id: 1, x: centerNorth, y: centerEast - radius },
    to: { id: 2, x: centerNorth, y: centerEast + radius },
    width: 0.1,
    entity: {
      entity_id: "c1",
      entity_type: "CIRCLE",
      layer: "marking",
      color: 1,
      is_mark: true,
      length_m: 2 * Math.PI * radius,
      geometry: {
        center: [centerNorth, centerEast],
        centerNorth,
        centerEast,
        radius,
        startAngle: 0,
        endAngle: 360,
      },
      preview_points,
    },
  };
}

function makeStraightLine(): PlanLine {
  return {
    id: "line-1",
    label: "line",
    layer: "marking",
    from: { id: 1, x: 10, y: 5 },
    to: { id: 2, x: 20, y: 5 },
    width: 0.1,
  };
}

describe("transformPlanLineGeometry", () => {
  it("translates from/to for plain lines", () => {
    const line = makeStraightLine();
    const next = transformPlanLineGeometry(line, translationTransform(3, -2));
    expect(next.from.x).toBeCloseTo(13, 9);
    expect(next.from.y).toBeCloseTo(3, 9);
    expect(next.to.x).toBeCloseTo(23, 9);
    expect(next.to.y).toBeCloseTo(3, 9);
  });

  it("translates entity.geometry center (not only preview_points)", () => {
    const line = makeCircleLine(100, 50, 10);
    const next = transformPlanLineGeometry(line, translationTransform(4, -7));
    const curve = getCurveGeometry(next);
    expect(curve).not.toBeNull();
    expect(curve!.centerNorth).toBeCloseTo(104, 6);
    expect(curve!.centerEast).toBeCloseTo(43, 6);
    expect(curve!.radius).toBeCloseTo(10, 6);

    // Stale-center bug would leave geometry at 100,50 while preview moved.
    const geom = next.entity!.geometry as Record<string, unknown>;
    expect(geom.centerNorth).toBeCloseTo(104, 6);
    expect(geom.centerEast).toBeCloseTo(43, 6);
    expect((geom.center as number[])[0]).toBeCloseTo(104, 6);
    expect((geom.center as number[])[1]).toBeCloseTo(43, 6);

    expect(next.entity!.preview_points[0].north).toBeCloseTo(
      line.entity!.preview_points[0].north + 4,
      6
    );
  });

  it("applies similarity transform so getCurveGeometry matches transformed samples", () => {
    const line = makeCircleLine(0, 0, 5);
    const transformPt = similarityTransform({
      rotationDeg: 90,
      scale: 2,
      offsetN: 10,
      offsetE: -3,
    });
    const next = transformPlanLineGeometry(line, transformPt);
    const curve = getCurveGeometry(next)!;

    // Center (0,0) → offset only under pure rotation about origin then scale.
    expect(curve.centerNorth).toBeCloseTo(10, 5);
    expect(curve.centerEast).toBeCloseTo(-3, 5);
    expect(curve.radius).toBeCloseTo(10, 5); // 5 * scale 2

    // Sampled ring must sit on the transformed circle (frame-consistent).
    const samples = sampleCurveEntityPoints(next, 16, false);
    for (const pt of samples) {
      const d = Math.hypot(pt.north - curve.centerNorth, pt.east - curve.centerEast);
      expect(d).toBeCloseTo(curve.radius, 4);
    }
  });

  it("keeps map-style curve sampling aligned with transformed preview_points", () => {
    const line = makeCircleLine(20, -15, 3);
    const transformPt = similarityTransform({
      rotationDeg: 30,
      scale: 1.5,
      offsetN: 100,
      offsetE: 200,
    });
    const next = transformPlanLineGeometry(line, transformPt);
    const curve = getCurveGeometry(next)!;

    // preview_points were transformed independently of geometry — discrete ring
    // centroid should land near the transformed geometry center.
    const pts = next.entity!.preview_points;
    const meanN = pts.reduce((s, p) => s + p.north, 0) / pts.length;
    const meanE = pts.reduce((s, p) => s + p.east, 0) / pts.length;
    const drift = Math.hypot(meanN - curve.centerNorth, meanE - curve.centerEast);
    expect(drift).toBeLessThan(0.25);
  });

  it("transforms extension_preview points when present", () => {
    const line = makeStraightLine();
    line.entity = {
      entity_id: "e1",
      entity_type: "LINE",
      layer: "marking",
      color: 1,
      is_mark: true,
      length_m: 10,
      geometry: {},
      preview_points: [
        { north: 10, east: 5 },
        { north: 20, east: 5 },
      ],
      extension_preview: {
        enabled: true,
        pre_length_m: 0.5,
        aft_length_m: 0.5,
        pre_points: [{ north: 9, east: 5 }],
        aft_points: [{ north: 21, east: 5 }],
      },
    };
    const next = transformPlanLineGeometry(line, translationTransform(1, 2));
    expect(next.entity!.extension_preview!.pre_points[0].north).toBeCloseTo(10, 9);
    expect(next.entity!.extension_preview!.pre_points[0].east).toBeCloseTo(7, 9);
    expect(next.entity!.extension_preview!.aft_points[0].north).toBeCloseTo(22, 9);
    expect(next.entity!.extension_preview!.aft_points[0].east).toBeCloseTo(7, 9);
  });

  it("translates geometry.source_points and geometry.corners alongside preview_points", () => {
    const line = makeStraightLine();
    line.entity = {
      entity_id: "e1",
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 10,
      geometry: {
        road_marking: true,
        source_points: [
          { north: 10, east: 5, hrms_m: 0.02 },
          { north: 20, east: 5, hrms_m: 0.02 },
        ],
        corners: [{ atIndex: 1, turnDeg: 45, class: "clean", north: 15, east: 5 }],
      },
      preview_points: [
        { north: 10, east: 5 },
        { north: 20, east: 5 },
      ],
    };
    const next = transformPlanLineGeometry(line, translationTransform(3, -2));
    const geom = next.entity!.geometry as Record<string, unknown>;
    const sourcePoints = geom.source_points as Array<{ north: number; east: number; hrms_m: number }>;
    const corners = geom.corners as Array<{ north: number; east: number; class: string }>;

    expect(sourcePoints[0].north).toBeCloseTo(13, 9);
    expect(sourcePoints[0].east).toBeCloseTo(3, 9);
    expect(sourcePoints[1].north).toBeCloseTo(23, 9);
    expect(sourcePoints[1].east).toBeCloseTo(3, 9);
    // Non-geometric fields survive untouched.
    expect(sourcePoints[0].hrms_m).toBe(0.02);

    expect(corners[0].north).toBeCloseTo(18, 9);
    expect(corners[0].east).toBeCloseTo(3, 9);
    expect(corners[0].class).toBe("clean");
  });
});
