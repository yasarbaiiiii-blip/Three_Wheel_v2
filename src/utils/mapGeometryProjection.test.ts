import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import type { AutoOriginReference } from "../types/autoOrigin";
import {
  buildPlanManipulationAnchor,
  projectPlanLineToGpsSegments,
  projectPlanNorthEastToGps,
  resolvePreviewProjectionOrigin,
} from "./mapGeometryProjection";
import { projectLocalMetersToGps } from "./visualAlignment";

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

describe("buildPlanManipulationAnchor / no-jump Move-Rotate enter", () => {
  const baseLines: PlanLine[] = [
    {
      id: "line-1",
      label: "L1",
      layer: "marking",
      from: { id: 1, x: 10, y: 5 },
      to: { id: 2, x: 20, y: 5 },
      width: 0.1,
    },
  ];

  const autoOriginRef: AutoOriginReference = {
    planStartNorth: 10,
    planStartEast: 5,
    roverNorth: 100,
    roverEast: 200,
    latitude: 12.97,
    longitude: 77.59,
    capturedAtMs: 1,
  };

  it("uses auto-origin capture GPS + planStart (not live telemetry / firstLine-2)", () => {
    const anchor = buildPlanManipulationAnchor({
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: autoOriginRef,
      autoOriginEnabled: true,
      stableFallbackOrigin: { lat: 1, lon: 2 },
      lines: baseLines,
    });
    expect(anchor.originLat).toBeCloseTo(12.97, 8);
    expect(anchor.originLon).toBeCloseTo(77.59, 8);
    expect(anchor.originDxfNorth).toBe(10);
    expect(anchor.originDxfEast).toBe(5);
  });

  it("identity sticker keeps plan GPS identical to fields preview under auto-origin", () => {
    const fieldsOrigin = resolvePreviewProjectionOrigin({
      mode: "fields",
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: autoOriginRef,
      autoOriginEnabled: true,
      lines: baseLines,
    })!;
    const anchor = buildPlanManipulationAnchor({
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: autoOriginRef,
      autoOriginEnabled: true,
      lines: baseLines,
    });
    // Enter Move/Rotate: sticky anchor + identity transform
    const stickerOrigin = resolvePreviewProjectionOrigin({
      mode: "templates",
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: autoOriginRef,
      autoOriginEnabled: true,
      visualAlignmentAnchor: anchor,
      lines: [],
      placedItemLines: baseLines,
    })!;

    const pt = { north: 15, east: 8 };
    const before = projectPlanNorthEastToGps(pt.north, pt.east, fieldsOrigin);
    // identity item: transformVisualDxfPoint is a no-op
    const after = projectPlanNorthEastToGps(pt.north, pt.east, stickerOrigin);
    expect(after.lat).toBeCloseTo(before.lat, 10);
    expect(after.lon).toBeCloseTo(before.lon, 10);
  });

  it("prefers aligned ref over auto-origin (same as map frame priority)", () => {
    const anchor = buildPlanManipulationAnchor({
      alignedRefPoints: [{ dxf_x: 30, dxf_y: 40, lat: 13.1, lon: 77.7 }],
      stagedVerified: false,
      autoOriginReference: autoOriginRef,
      autoOriginEnabled: true,
      lines: baseLines,
    });
    expect(anchor.originLat).toBeCloseTo(13.1, 8);
    expect(anchor.originLon).toBeCloseTo(77.7, 8);
    expect(anchor.originDxfNorth).toBe(40);
    expect(anchor.originDxfEast).toBe(30);
  });

  it("fallback uses firstLine-2 and latched GPS (not a different constant)", () => {
    const anchor = buildPlanManipulationAnchor({
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: null,
      autoOriginEnabled: false,
      stableFallbackOrigin: { lat: 28.6, lon: 77.2 },
      lines: baseLines,
    });
    expect(anchor.originLat).toBeCloseTo(28.6, 8);
    expect(anchor.originLon).toBeCloseTo(77.2, 8);
    expect(anchor.originDxfNorth).toBe(10 - 2);
    expect(anchor.originDxfEast).toBe(5 - 2);
  });

  it("keeps existing sticky anchor on re-entry (post-bake)", () => {
    const existing = {
      originLat: 11.1,
      originLon: 76.6,
      originDxfNorth: 3,
      originDxfEast: 4,
    };
    const anchor = buildPlanManipulationAnchor({
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: autoOriginRef,
      autoOriginEnabled: true,
      existingAnchor: existing,
      lines: baseLines,
    });
    expect(anchor).toEqual(existing);
  });
});

/** Re-derive the [lat, lon] for a (northM, eastM) offset the same way production does. */
function projectLatLonForOffset(
  origin: ReturnType<typeof makeOrigin>,
  northM: number,
  eastM: number
): [number, number] {
  // Delegate to the real projection (WGS84 meridional/prime-vertical radii) so
  // this helper can never drift from production, as it did when it hardcoded a
  // single spherical radius.
  const { lat, lon } = projectLocalMetersToGps(
    northM,
    eastM,
    origin.originLat,
    origin.originLon
  );
  return [lat, lon];
}
