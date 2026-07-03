import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { projectPlanLineToGpsSegments } from "./mapGeometryProjection";

function makeOrigin() {
  return {
    frame: "ALIGNED_DESIGN" as const,
    originLat: 12.9716,
    originLon: 77.5946,
    originDxfNorth: 0,
    originDxfEast: 0,
  };
}

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

/** A partial ARC entity (sweep < 360°). */
function makeArcLine(radius = 2, startAngle = 0, endAngle = 90): PlanLine {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  return {
    id: "arc-1",
    label: "Arc",
    layer: "marking",
    from: { id: 1, x: radius * Math.sin(toRad(startAngle)), y: radius * Math.cos(toRad(startAngle)) },
    to: { id: 2, x: radius * Math.sin(toRad(endAngle)), y: radius * Math.cos(toRad(endAngle)) },
    width: 0.1,
    entity: {
      entity_id: "ea",
      entity_type: "ARC",
      layer: "0",
      color: 7,
      is_mark: false,
      length_m: ((endAngle - startAngle) / 360) * 2 * Math.PI * radius,
      geometry: { centerNorth: 0, centerEast: 0, radius, startAngle, endAngle },
      preview_points: [],
    },
  };
}

/** Backend-style ARC entity with tessellated preview_points but no native curve geometry. */
function makePreviewOnlyArcLine(radius = 2, startAngle = 0, endAngle = 300): PlanLine {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const preview_points = Array.from({ length: 25 }, (_, index) => {
    const angle = startAngle + ((endAngle - startAngle) * index) / 24;
    return {
      north: radius * Math.sin(toRad(angle)),
      east: radius * Math.cos(toRad(angle)),
    };
  });
  const fromPt = preview_points[0];
  const toPt = preview_points[preview_points.length - 1];

  return {
    id: "arc-preview-only",
    label: "Arc Preview Only",
    layer: "marking",
    from: { id: 1, x: fromPt.north, y: fromPt.east },
    to: { id: 2, x: toPt.north, y: toPt.east },
    width: 0.1,
    entity: {
      entity_id: "ea-preview",
      entity_type: "ARC",
      layer: "0",
      color: 7,
      is_mark: false,
      length_m: ((endAngle - startAngle) / 360) * 2 * Math.PI * radius,
      geometry: {},
      preview_points,
    },
  };
}

/** A full CIRCLE entity (sweep 360°). */
function makeCircleLine(radius = 2): PlanLine {
  return {
    id: "circle-1",
    label: "Circle",
    layer: "marking",
    from: { id: 1, x: radius, y: 0 },
    to: { id: 2, x: radius, y: 0 },
    width: 0.1,
    entity: {
      entity_id: "ec",
      entity_type: "CIRCLE",
      layer: "0",
      color: 7,
      is_mark: false,
      length_m: 2 * Math.PI * radius,
      geometry: { centerNorth: 0, centerEast: 0, radius, startAngle: 0, endAngle: 360 },
      preview_points: [],
    },
  };
}

describe("mapGeometryProjection", () => {
  it("projects circle-like polylines with dense GPS rings", () => {
    const origin = makeOrigin();

    const segments = projectPlanLineToGpsSegments(makeClosedPolylineCircle(2), origin);
    expect(segments.length).toBeGreaterThan(64);
    const first = segments[0];
    const last = segments[segments.length - 1];
    expect(first[0]).toBeCloseTo(last[0], 5);
    expect(first[1]).toBeCloseTo(last[1], 5);
  });

  it("projects a partial ARC as an open arc, NOT a closed full circle", () => {
    const origin = makeOrigin();

    const segments = projectPlanLineToGpsSegments(makeArcLine(2, 0, 90), origin);
    expect(segments.length).toBeGreaterThan(8);

    // The arc must NOT close back onto its start point — that would be the old
    // turf.circle bug (which ignored start/end angles and drew a full circle).
    const first = segments[0];
    const last = segments[segments.length - 1];
    expect(Math.abs(first[0] - last[0])).toBeGreaterThan(1e-6);
    expect(Math.abs(first[1] - last[1])).toBeGreaterThan(1e-6);

    // Endpoints should sit at the projected start (angle 0) and end (angle 90):
    // angle 0 -> (north 0, east +2), angle 90 -> (north +2, east 0).
    const expectedStart = projectLatLonForOffset(origin, 0, 2);
    const expectedEnd = projectLatLonForOffset(origin, 2, 0);
    expect(first[0]).toBeCloseTo(expectedStart[0], 7);
    expect(first[1]).toBeCloseTo(expectedStart[1], 7);
    expect(last[0]).toBeCloseTo(expectedEnd[0], 7);
    expect(last[1]).toBeCloseTo(expectedEnd[1], 7);
  });

  it("projects preview-only ARC entities as their open preview polyline", () => {
    const origin = makeOrigin();

    const segments = projectPlanLineToGpsSegments(makePreviewOnlyArcLine(2, 0, 300), origin);
    expect(segments.length).toBe(25);

    const first = segments[0];
    const last = segments[segments.length - 1];
    expect(Math.abs(first[0] - last[0])).toBeGreaterThan(1e-6);
    expect(Math.abs(first[1] - last[1])).toBeGreaterThan(1e-6);

    const expectedStart = projectLatLonForOffset(origin, 0, 2);
    const expectedEnd = projectLatLonForOffset(origin, -Math.sqrt(3), 1);
    expect(first[0]).toBeCloseTo(expectedStart[0], 7);
    expect(first[1]).toBeCloseTo(expectedStart[1], 7);
    expect(last[0]).toBeCloseTo(expectedEnd[0], 7);
    expect(last[1]).toBeCloseTo(expectedEnd[1], 7);
  });

  it("projects a full CIRCLE as a closed dense ring", () => {
    const origin = makeOrigin();

    const segments = projectPlanLineToGpsSegments(makeCircleLine(2), origin);
    expect(segments.length).toBeGreaterThan(64);
    const first = segments[0];
    const last = segments[segments.length - 1];
    expect(first[0]).toBeCloseTo(last[0], 5);
    expect(first[1]).toBeCloseTo(last[1], 5);

    // Full circles should use the same parametric start point as SVG:
    // angle 0 -> (north 0, east +2).
    const expectedStart = projectLatLonForOffset(origin, 0, 2);
    expect(first[0]).toBeCloseTo(expectedStart[0], 7);
    expect(first[1]).toBeCloseTo(expectedStart[1], 7);
  });
});

/** Re-derive the [lat, lon] for a (northM, eastM) offset the same way production does. */
function projectLatLonForOffset(
  origin: ReturnType<typeof makeOrigin>,
  northM: number,
  eastM: number
): [number, number] {
  // Mirrors projectLocalMetersToGps() in visualAlignment.ts (same EARTH_RADIUS).
  const EARTH_RADIUS = 6378137.0;
  const originLatRad = (origin.originLat * Math.PI) / 180;
  const lat = origin.originLat + (northM / EARTH_RADIUS) * (180 / Math.PI);
  const lon = origin.originLon + (eastM / (EARTH_RADIUS * Math.cos(originLatRad))) * (180 / Math.PI);
  return [lat, lon];
}
