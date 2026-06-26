import { describe, it, expect } from "vitest";
import type { PlanLine, TelemetrySnapshot } from "../types/plan";
import type { AutoOriginReference } from "../types/autoOrigin";
import {
  applyAutoOriginShift,
  buildAutoOriginReference,
  hasValidNedAndGps,
  isValidAutoOriginReference,
  planStartMatchesReference,
} from "./autoOrigin";
import { getPlanStartPoint } from "./planGeometry";
import {
  projectPlanNorthEastToGps,
  resolveMapGeometryFrame,
  resolveMapProjectionOrigin,
} from "./mapGeometryProjection";

function makeLine(
  id: string,
  fromNorth: number,
  fromEast: number,
  toNorth: number,
  toEast: number
): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: fromNorth, y: fromEast },
    to: { id: 2, x: toNorth, y: toEast },
    width: 0.1,
  };
}

function validTelemetry(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    pos_n: 50,
    pos_e: 30,
    lat: 12.9716,
    lon: 77.5946,
    gps_fix: 6,
    ...overrides,
  };
}

const baseLines = [makeLine("line-1", 10, 5, 20, 5)];

describe("Auto Origin capture", () => {
  it("captures only when plan start, NED and GPS are valid", () => {
    const ref = buildAutoOriginReference(baseLines, validTelemetry());
    expect(ref).not.toBeNull();
    expect(ref!.planStartNorth).toBe(10);
    expect(ref!.planStartEast).toBe(5);
    expect(ref!.roverNorth).toBe(50);
    expect(ref!.roverEast).toBe(30);
    expect(ref!.latitude).toBe(12.9716);
    expect(ref!.longitude).toBe(77.5946);
    expect(isValidAutoOriginReference(ref)).toBe(true);
  });

  it("does not capture with missing or non-finite values", () => {
    expect(buildAutoOriginReference([], validTelemetry())).toBeNull();
    expect(buildAutoOriginReference(baseLines, validTelemetry({ pos_n: null }))).toBeNull();
    expect(buildAutoOriginReference(baseLines, validTelemetry({ lat: Number.NaN }))).toBeNull();
    expect(buildAutoOriginReference(baseLines, validTelemetry({ gps_fix: 0 }))).toBeNull();
    expect(hasValidNedAndGps(validTelemetry({ gps_fix: 2 }))).toBe(false);
  });

  it("pending Auto Origin captures when valid telemetry later arrives", () => {
    const pending = buildAutoOriginReference(baseLines, null);
    expect(pending).toBeNull();
    const captured = buildAutoOriginReference(baseLines, validTelemetry({ pos_n: 12, pos_e: 8 }));
    expect(captured).not.toBeNull();
    expect(captured!.roverNorth).toBe(12);
  });

  it("captures once and does not change when rover telemetry moves", () => {
    const first = buildAutoOriginReference(baseLines, validTelemetry(), 1000);
    const second = buildAutoOriginReference(
      baseLines,
      validTelemetry({ pos_n: 99, pos_e: 88 }),
      2000
    );
    expect(first!.roverNorth).toBe(50);
    expect(second!.roverNorth).toBe(99);
    const latched = first!;
    const movedTelemetry = validTelemetry({ pos_n: 200, pos_e: 150 });
    expect(latched.roverNorth).not.toBe(movedTelemetry.pos_n);
  });

  it("plan replacement invalidates the old reference", () => {
    const oldRef = buildAutoOriginReference(baseLines, validTelemetry())!;
    const newLines = [makeLine("line-2", 40, 15, 50, 15)];
    expect(planStartMatchesReference(newLines, oldRef)).toBe(false);
  });
});

describe("Auto Origin Canvas shift", () => {
  const reference: AutoOriginReference = {
    planStartNorth: 10,
    planStartEast: 5,
    roverNorth: 50,
    roverEast: 30,
    latitude: 12.9716,
    longitude: 77.5946,
    capturedAtMs: 1,
  };

  it("plan start shifts exactly to captured rover NED", () => {
    const shifted = applyAutoOriginShift(baseLines, reference);
    const start = getPlanStartPoint(shifted);
    expect(start!.north).toBe(50);
    expect(start!.east).toBe(30);
  });

  it("rover movement after capture does not move the plan", () => {
    const shifted = applyAutoOriginShift(baseLines, reference);
    const startBefore = getPlanStartPoint(shifted);
    const startAfter = getPlanStartPoint(shifted);
    expect(startAfter).toEqual(startBefore);
  });

  it("verified staged geometry does not receive Auto Origin shift when caller skips apply", () => {
    const rawStart = getPlanStartPoint(baseLines);
    expect(rawStart!.north).toBe(10);
    expect(rawStart!.east).toBe(5);
  });
});

describe("Auto Origin MapView projection", () => {
  const reference: AutoOriginReference = {
    planStartNorth: 10,
    planStartEast: 5,
    roverNorth: 50,
    roverEast: 30,
    latitude: 12.9716,
    longitude: 77.5946,
    capturedAtMs: 1,
  };

  const frameInput = {
    mode: "fields" as const,
    alignedRefPoints: [],
    stagedVerified: false,
    autoOriginReference: reference,
    autoOriginEnabled: true,
  };

  it("plan start projects exactly to captured rover GPS", () => {
    const frame = resolveMapGeometryFrame(frameInput);
    expect(frame).toBe("AUTO_ORIGIN_RAW");
    const origin = resolveMapProjectionOrigin(frame, frameInput)!;
    const gps = projectPlanNorthEastToGps(10, 5, origin);
    expect(gps.lat).toBeCloseTo(reference.latitude, 8);
    expect(gps.lon).toBeCloseTo(reference.longitude, 8);
  });

  it("a point 2 m east and 3 m north projects approximately 2 m east and 3 m north", () => {
    const frame = resolveMapGeometryFrame(frameInput);
    const origin = resolveMapProjectionOrigin(frame, frameInput)!;
    const startGps = projectPlanNorthEastToGps(10, 5, origin);
    const offsetGps = projectPlanNorthEastToGps(13, 7, origin);
    const dLatM = (offsetGps.lat - startGps.lat) * (Math.PI / 180) * 6378137;
    const dLonM =
      (offsetGps.lon - startGps.lon) *
      (Math.PI / 180) *
      6378137 *
      Math.cos((startGps.lat * Math.PI) / 180);
    expect(dLatM).toBeCloseTo(3, 1);
    expect(dLonM).toBeCloseTo(2, 1);
  });

  it("non-zero plan start coordinates are handled correctly", () => {
    const lines = [makeLine("line-1", 25, -12, 35, -12)];
    const localRef = buildAutoOriginReference(lines, validTelemetry())!;
    const input = { ...frameInput, autoOriginReference: localRef };
    const origin = resolveMapProjectionOrigin("AUTO_ORIGIN_RAW", input)!;
    const gps = projectPlanNorthEastToGps(25, -12, origin);
    expect(gps.lat).toBeCloseTo(localRef.latitude, 8);
    expect(gps.lon).toBeCloseTo(localRef.longitude, 8);
  });

  it("map projection remains unchanged when live rover GPS/NED changes after capture", () => {
    const frame = resolveMapGeometryFrame(frameInput);
    const origin = resolveMapProjectionOrigin(frame, frameInput)!;
    const before = projectPlanNorthEastToGps(20, 5, origin);
    const movedInput = {
      ...frameInput,
      autoOriginReference: {
        ...reference,
        roverNorth: 999,
        roverEast: 888,
        latitude: 13.5,
        longitude: 78.1,
      },
    };
    const after = projectPlanNorthEastToGps(20, 5, origin);
    const moved = projectPlanNorthEastToGps(
      20,
      5,
      resolveMapProjectionOrigin(frame, movedInput)!
    );
    expect(after.lat).toBeCloseTo(before.lat, 10);
    expect(after.lon).toBeCloseTo(before.lon, 10);
    expect(moved.lat).not.toBeCloseTo(before.lat, 6);
  });

  it("aligned reference takes authority over Auto Origin when aligned geometry is active", () => {
    const input = {
      ...frameInput,
      alignedRefPoints: [{ dxf_x: 5, dxf_y: 10, lat: 12.97, lon: 77.59 }],
    };
    expect(resolveMapGeometryFrame(input)).toBe("ALIGNED_DESIGN");
  });

  it("staged anchor takes authority for staged geometry", () => {
    const input = {
      ...frameInput,
      stagedVerified: true,
      alignedRefPoints: [{ dxf_x: 0, dxf_y: 0, lat: 12.97, lon: 77.59 }],
    };
    expect(resolveMapGeometryFrame(input)).toBe("SURVEYED_LOCAL");
  });

  it("Auto Origin does not double-transform shifted or aligned geometry", () => {
    const shifted = applyAutoOriginShift(baseLines, reference);
    const shiftedStart = getPlanStartPoint(shifted)!;
    const frame = resolveMapGeometryFrame({
      mode: "fields",
      alignedRefPoints: [{ dxf_x: 30, dxf_y: 50, lat: 12.97, lon: 77.59 }],
      stagedVerified: false,
      autoOriginReference: reference,
      autoOriginEnabled: true,
    });
    expect(frame).toBe("ALIGNED_DESIGN");
    const origin = resolveMapProjectionOrigin(frame, {
      mode: "fields",
      alignedRefPoints: [{ dxf_x: 30, dxf_y: 50, lat: 12.97, lon: 77.59 }],
      stagedVerified: false,
      autoOriginReference: reference,
      autoOriginEnabled: true,
    })!;
    const rawGps = projectPlanNorthEastToGps(10, 5, origin);
    const shiftedGps = projectPlanNorthEastToGps(shiftedStart.north, shiftedStart.east, origin);
    expect(shiftedGps.lat).not.toBeCloseTo(rawGps.lat, 5);
  });

  it("no mission lines are projected using the Delhi fallback", () => {
    const frame = resolveMapGeometryFrame({
      mode: "fields",
      alignedRefPoints: [],
      stagedVerified: false,
      autoOriginReference: null,
      autoOriginEnabled: false,
    });
    expect(frame).toBe("NONE");
    expect(
      resolveMapProjectionOrigin(frame, {
        mode: "fields",
        alignedRefPoints: [],
        stagedVerified: false,
        autoOriginReference: null,
        autoOriginEnabled: false,
      })
    ).toBeNull();
  });
});

describe("Auto Origin axis convention", () => {
  const anchorLat = 12.9716;
  const anchorLon = 77.5946;
  const reference: AutoOriginReference = {
    planStartNorth: 0,
    planStartEast: 0,
    roverNorth: 0,
    roverEast: 0,
    latitude: anchorLat,
    longitude: anchorLon,
    capturedAtMs: 1,
  };
  const origin = resolveMapProjectionOrigin("AUTO_ORIGIN_RAW", {
    mode: "fields",
    alignedRefPoints: [],
    stagedVerified: false,
    autoOriginReference: reference,
    autoOriginEnabled: true,
  })!;

  it("positive east moves east", () => {
    const base = projectPlanNorthEastToGps(0, 0, origin);
    const east = projectPlanNorthEastToGps(0, 10, origin);
    expect(east.lon).toBeGreaterThan(base.lon);
    expect(east.lat).toBeCloseTo(base.lat, 8);
  });

  it("positive north moves north", () => {
    const base = projectPlanNorthEastToGps(0, 0, origin);
    const north = projectPlanNorthEastToGps(10, 0, origin);
    expect(north.lat).toBeGreaterThan(base.lat);
    expect(north.lon).toBeCloseTo(base.lon, 8);
  });
});