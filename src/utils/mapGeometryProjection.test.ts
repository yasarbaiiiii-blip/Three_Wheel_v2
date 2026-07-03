import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { projectPlanLineToGpsSegments } from "./mapGeometryProjection";

function makeClosedPolylineCircle(radius = 2): PlanLine {
  const preview_points = Array.from({ length: 10 }, (_, index) => {
    const angle = (2 * Math.PI * index) / 10;
    return {
      north: radius * Math.sin(angle),
      east: radius * Math.cos(angle),
    };
  });

  return {
    id: "circle-poly",
    label: "Circle",
    layer: "marking",
    from: { id: 1, x: 0, y: radius },
    to: { id: 2, x: 0, y: radius },
    width: 0.1,
    entity: {
      entity_id: "e1",
      entity_type: "LWPOLYLINE",
      layer: "0",
      color: 7,
      is_mark: false,
      length_m: 2 * Math.PI * radius,
      geometry: { closed: true, vertexCount: 10 },
      preview_points,
    },
  };
}

describe("mapGeometryProjection", () => {
  it("projects circle-like polylines with dense GPS rings", () => {
    const origin = {
      frame: "ALIGNED_DESIGN" as const,
      originLat: 12.9716,
      originLon: 77.5946,
      originDxfNorth: 0,
      originDxfEast: 0,
    };

    const segments = projectPlanLineToGpsSegments(makeClosedPolylineCircle(2), origin);
    expect(segments.length).toBeGreaterThan(64);
    const first = segments[0];
    const last = segments[segments.length - 1];
    expect(first[0]).toBeCloseTo(last[0], 5);
    expect(first[1]).toBeCloseTo(last[1], 5);
  });
});