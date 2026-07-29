import { describe, expect, it } from "vitest";
import {
  GEO_OFFSET_EXTENT_RATIO,
  looksGeographic,
  metresPerDegreePx4,
  projectGeographicToLocalNed,
  projectGpsToLocalMeters,
  projectLocalMetersToGps,
  PX4_EARTH_RADIUS_M,
} from "./geoProjection";

describe("metresPerDegreePx4", () => {
  it("matches PX4 sphere at equator", () => {
    const { mPerDegNorth, mPerDegEast } = metresPerDegreePx4(0);
    const expected = (PX4_EARTH_RADIUS_M * Math.PI) / 180;
    expect(mPerDegNorth).toBeCloseTo(expected, 9);
    expect(mPerDegEast).toBeCloseTo(expected, 9);
  });

  it("scales east by cos(lat)", () => {
    const lat = 13;
    const { mPerDegNorth, mPerDegEast } = metresPerDegreePx4(lat);
    const perRad = Math.PI / 180;
    expect(mPerDegNorth).toBeCloseTo(PX4_EARTH_RADIUS_M * perRad, 9);
    expect(mPerDegEast).toBeCloseTo(
      PX4_EARTH_RADIUS_M * perRad * Math.cos((lat * Math.PI) / 180),
      9
    );
  });
});

describe("looksGeographic", () => {
  it("accepts a small site far from origin in degrees", () => {
    const pts = [
      { north: 13.0, east: 80.0 },
      { north: 13.00002, east: 80.0 },
      { north: 13.00002, east: 80.00002 },
      { north: 13.0, east: 80.00002 },
    ];
    const r = looksGeographic(pts);
    expect(r.isGeographic).toBe(true);
    // offset/extent huge
    const extent = 0.00002;
    const offset = 80;
    expect(offset / extent).toBeGreaterThan(GEO_OFFSET_EXTENT_RATIO);
  });

  it("rejects metric square", () => {
    expect(
      looksGeographic([
        { north: 0, east: 0 },
        { north: 2, east: 2 },
      ]).isGeographic
    ).toBe(false);
  });

  it("rejects out-of-range projected metres", () => {
    expect(
      looksGeographic([
        { north: 100, east: 200 },
        { north: 101, east: 201 },
      ]).isGeographic
    ).toBe(false);
  });
});

describe("projectGeographicToLocalNed", () => {
  it("centres about centroid and round-trips via project helpers", () => {
    const pts = [
      { north: 13.0, east: 80.0 },
      { north: 13.001, east: 80.001 },
    ];
    const { origin, points } = projectGeographicToLocalNed(pts);
    expect(origin.lat).toBeCloseTo(13.0005, 9);
    expect(origin.lon).toBeCloseTo(80.0005, 9);
    // Mean of projected ≈ 0
    const meanN = points.reduce((s, p) => s + p.north, 0) / points.length;
    const meanE = points.reduce((s, p) => s + p.east, 0) / points.length;
    expect(meanN).toBeCloseTo(0, 9);
    expect(meanE).toBeCloseTo(0, 9);

    const back = projectLocalMetersToGps(points[0].north, points[0].east, origin.lat, origin.lon);
    expect(back.lat).toBeCloseTo(pts[0].north, 9);
    expect(back.lon).toBeCloseTo(pts[0].east, 9);

    const fwd = projectGpsToLocalMeters(pts[1].north, pts[1].east, origin.lat, origin.lon);
    expect(fwd.north).toBeCloseTo(points[1].north, 9);
    expect(fwd.east).toBeCloseTo(points[1].east, 9);
  });
});
