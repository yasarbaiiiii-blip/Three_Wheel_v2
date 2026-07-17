import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildPlanLineSvgPath,
  computePlanBoundingBoxLegacy,
  getCurveSelectionAnchors,
  getPlanLineRenderPoints,
  inferCurveGeometryFromPreviewPoints,
  isCircleLikeLine,
  sampleCurveEntityPoints,
} from "./curveGeometry";
function makeCircleLine(radius = 1.5): PlanLine {
  return {
    id: "circle-1",
    label: "Circle",
    layer: "marking",
    from: { id: 1, x: radius, y: 0 },
    to: { id: 2, x: radius, y: 0 },
    width: 0.1,
    entity: {
      entity_id: "e1",
      entity_type: "CIRCLE",
      layer: "0",
      color: 7,
      is_mark: false,
      length_m: 2 * Math.PI * radius,
      geometry: {
        centerNorth: 0,
        centerEast: 0,
        radius,
        startAngle: 0,
        endAngle: 360,
      },
      preview_points: [],
    },
  };
}

describe("curveGeometry", () => {
  it("computes non-degenerate bbox for a full circle where from equals to", () => {
    const lines = [makeCircleLine(1.5)];
    const box = computePlanBoundingBoxLegacy(lines);

    expect(box.maxX - box.minX).toBeCloseTo(3, 5);
    expect(box.maxY - box.minY).toBeCloseTo(3, 5);
  });

  it("builds native SVG arc commands for circles", () => {
    const path = buildPlanLineSvgPath(makeCircleLine(2));
    expect(path).toMatch(/^M/);
    expect(path).toContain("A2 2");
    expect(path).not.toContain("L");
  });

  it("samples smooth curve points for map rendering", () => {
    const points = sampleCurveEntityPoints(makeCircleLine(1));
    expect(points.length).toBeGreaterThan(32);
    expect(points[0].east).toBeCloseTo(1, 5);
    expect(points[0].north).toBeCloseTo(0, 5);
  });

  it("uses a single center anchor for circle selection", () => {
    const anchors = getCurveSelectionAnchors(makeCircleLine(1));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({ north: 0, east: 0 });
  });

  it("infers a closed coarse polyline as a circle", () => {
    const radius = 2.5;
    const steps = 10;
    const preview_points = Array.from({ length: steps }, (_, index) => {
      const angle = (2 * Math.PI * index) / steps;
      return {
        north: radius * Math.sin(angle),
        east: radius * Math.cos(angle),
      };
    });

    const inferred = inferCurveGeometryFromPreviewPoints(preview_points, "LWPOLYLINE");
    expect(inferred).not.toBeNull();
    expect(inferred?.radius).toBeCloseTo(radius, 1);
    expect(inferred?.centerNorth).toBeCloseTo(0, 1);
    expect(inferred?.centerEast).toBeCloseTo(0, 1);
  });

  it("renders circle-like API entities with dense map samples", () => {
    const radius = 1.5;
    const preview_points = Array.from({ length: 10 }, (_, index) => {
      const angle = (2 * Math.PI * index) / 10;
      return {
        north: radius * Math.sin(angle),
        east: radius * Math.cos(angle),
      };
    });
    const line: PlanLine = {
      id: "poly-circle",
      label: "Poly circle",
      layer: "marking",
      from: { id: 1, x: 0, y: radius },
      to: { id: 2, x: 0, y: radius },
      width: 0.1,
      entity: {
        entity_id: "e-poly",
        entity_type: "LWPOLYLINE",
        layer: "0",
        color: 7,
        is_mark: false,
        length_m: 2 * Math.PI * radius,
        geometry: { closed: true, vertexCount: 10 },
        preview_points,
      },
    };

    expect(isCircleLikeLine(line)).toBe(true);
    const mapPoints = getPlanLineRenderPoints(line, true);
    expect(mapPoints.length).toBeGreaterThan(64);
    const path = buildPlanLineSvgPath(line);
    expect(path).toContain("A");
    expect(path).not.toContain("L");
  });

  it("renders extension stubs as pre/aft polylines even when parent metadata is CIRCLE", () => {
    const prePoints = [
      { north: 0, east: -1 },
      { north: 0, east: 0 },
    ];
    // Legacy shape: extension line that still carried parent circle entity_type/geometry.
    const extensionLine: PlanLine = {
      id: "ext-pre-e1",
      label: "Pre-extension",
      layer: "extension",
      from: { id: 1, x: 0, y: -1 },
      to: { id: 2, x: 0, y: 0 },
      width: 0.1,
      entity: {
        entity_id: "e1",
        entity_type: "CIRCLE",
        layer: "0",
        color: 7,
        is_mark: true,
        length_m: 99,
        geometry: {
          centerNorth: 0,
          centerEast: 0,
          radius: 2,
          startAngle: 0,
          endAngle: 360,
        },
        preview_points: prePoints,
        extension_preview: {
          enabled: true,
          pre_length_m: 1,
          aft_length_m: 1,
          pre_points: prePoints,
          aft_points: [],
        },
      },
    };

    expect(isCircleLikeLine(extensionLine)).toBe(false);
    const points = getPlanLineRenderPoints(extensionLine);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ north: 0, east: -1 });
    expect(points[1]).toEqual({ north: 0, east: 0 });
    const path = buildPlanLineSvgPath(extensionLine);
    expect(path).toContain("L");
    expect(path).not.toContain("A");
  });

});