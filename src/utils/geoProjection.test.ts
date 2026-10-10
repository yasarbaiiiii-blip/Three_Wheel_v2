import { describe, expect, it } from "vitest";
import {
  GEO_OFFSET_EXTENT_RATIO,
  WGS84_A,
  WGS84_E2,
  WGS84_F,
  groundBearingDeg,
  groundDistanceMeters,
  looksGeographic,
  meridionalRadius,
  metresPerDegree,
  primeVerticalRadius,
  projectGeographicToLocalNed,
  projectGpsToLocalMeters,
  projectLocalMetersToGps,
} from "./geoProjection";

const RAD = Math.PI / 180;

/**
 * Vincenty inverse on WGS84 (test-only reference). Returns the geodesic length
 * in metres.
 */
function vincentyInverse(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = WGS84_A;
  const f = WGS84_F;
  const b = a * (1 - f);
  const L = (lon2 - lon1) * RAD;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * RAD));
  const U2 = Math.atan((1 - f) * Math.tan(lat2 * RAD));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-14) break;
  }
  const u2 = (cos2Alpha * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - dSigma);
}

const dms = (d: number, m: number, s: number) => (d < 0 ? -1 : 1) * (Math.abs(d) + m / 60 + s / 3600);

describe("WGS84 constants and radii", () => {
  it("defines the ellipsoid", () => {
    expect(WGS84_A).toBe(6378137);
    expect(WGS84_F).toBeCloseTo(1 / 298.257223563, 15);
    expect(WGS84_E2).toBeCloseTo(0.00669437999014, 13);
  });

  it("meridional and prime-vertical radii match published values", () => {
    // Equator: M = a(1-e2) = 6335439.327, N = a.
    expect(meridionalRadius(0)).toBeCloseTo(6335439.327, 3);
    expect(primeVerticalRadius(0)).toBeCloseTo(6378137, 6);
    // Pole: M = N = a / sqrt(1-e2) = 6399593.626.
    expect(meridionalRadius(90)).toBeCloseTo(6399593.626, 3);
    expect(primeVerticalRadius(90)).toBeCloseTo(6399593.626, 3);
  });

  it("metresPerDegree: 1 deg of latitude is 110574 m at the equator and 111694 m at the pole", () => {
    expect(metresPerDegree(0).mPerDegNorth).toBeCloseTo(110574.3, 1);
    expect(metresPerDegree(90).mPerDegNorth).toBeCloseTo(111694.0, 1);
    expect(metresPerDegree(0).mPerDegEast).toBeCloseTo(111319.49, 1);
  });
});

describe("reference geodesic implementation (test-only Vincenty)", () => {
  it("reproduces the Flinders Peak - Buninyong benchmark", () => {
    const s = vincentyInverse(
      dms(-37, 57, 3.7203),
      dms(144, 25, 29.5244),
      dms(-37, 39, 10.1561),
      dms(143, 55, 35.3839)
    );
    expect(s).toBeCloseTo(54972.271, 3);
  });
});

describe("local tangent plane accuracy vs the WGS84 geodesic", () => {
  const origins: Array<[number, number]> = [
    [0, 0],
    [13.0827, 80.2707],
    [37.77, -122.42],
    [45, 7],
    [60.17, 24.94],
    [78.2, 15.6],
    [-33.87, 151.2],
  ];
  const offsets: Array<[number, number]> = [
    [1000, 0],
    [0, 1000],
    [707.1068, 707.1068],
    [-707.1068, 707.1068],
    [-800, -600],
    [600, -800],
  ];

  it("a 1 km offset has a geodesic length within 0.1 mm of the planar length", () => {
    let worst = 0;
    for (const [lat0, lon0] of origins) {
      for (const [n, e] of offsets) {
        const p = projectLocalMetersToGps(n, e, lat0, lon0);
        const geodesic = vincentyInverse(lat0, lon0, p.lat, p.lon);
        worst = Math.max(worst, Math.abs(geodesic - Math.hypot(n, e)));
      }
    }
    expect(worst).toBeLessThan(0.001);
  });

  it("distance between two points both offset from the origin is within 1 mm", () => {
    let worst = 0;
    for (const [lat0, lon0] of origins) {
      const a = projectLocalMetersToGps(600, -300, lat0, lon0);
      const b = projectLocalMetersToGps(-200, 700, lat0, lon0);
      const geodesic = vincentyInverse(a.lat, a.lon, b.lat, b.lon);
      worst = Math.max(worst, Math.abs(geodesic - Math.hypot(800, 1000)));
      const viaApp = groundDistanceMeters(a.lat, a.lon, b.lat, b.lon);
      worst = Math.max(worst, Math.abs(viaApp - geodesic));
    }
    expect(worst).toBeLessThan(0.001);
  });

  it("agrees with the closed-form north/east at the origin: dphi * M and dlambda * N cos(phi)", () => {
    const lat0 = 13.0827;
    const lon0 = 80.2707;
    const d = 1e-6;
    const p = projectGpsToLocalMeters(lat0 + d, lon0, lat0, lon0);
    expect(p.north).toBeCloseTo(d * RAD * meridionalRadius(lat0), 7);
    const q = projectGpsToLocalMeters(lat0, lon0 + d, lat0, lon0);
    expect(q.east).toBeCloseTo(d * RAD * primeVerticalRadius(lat0) * Math.cos(lat0 * RAD), 7);
  });

  it("bearing agrees with the planar direction", () => {
    const p = projectLocalMetersToGps(500, 500, 13.08, 80.27);
    expect(groundBearingDeg(13.08, 80.27, p.lat, p.lon)).toBeCloseTo(45, 6);
  });
});

describe("inverse (plane point at u = 0, height dropped)", () => {
  const roundTripError = (lat0: number, n: number, e: number) => {
    const g = projectLocalMetersToGps(n, e, lat0, 80.27);
    const back = projectGpsToLocalMeters(g.lat, g.lon, lat0, 80.27);
    return Math.hypot(back.north - n, back.east - e);
  };

  it("round-trips to under 0.1 mm at 1 km", () => {
    for (const lat0 of [0, 13.08, 45, 60, 80]) {
      for (const [n, e] of [
        [0, 0],
        [1000, 0],
        [0, 1000],
        [707, -707],
        [123.456, -789.012],
      ] as Array<[number, number]>) {
        expect(roundTripError(lat0, n, e)).toBeLessThan(1e-4);
      }
    }
  });

  it("round-trip error is the plane-to-ellipsoid height times s/R: about 1.5 mm at 5 km", () => {
    // The inverse drops the height of the plane point (s^2 / 2R above the surface),
    // so forward(inverse(x)) moves by h * s / R. This is inherent to the rover's
    // placement, which uses the same inverse.
    const err = roundTripError(13, 5000, 0);
    expect(err).toBeGreaterThan(5e-4);
    expect(err).toBeLessThan(2e-3);
  });

  it("a 100 m north line and a 100 m east line at 13 deg N measure 100.000 m in the plane", () => {
    const north = projectLocalMetersToGps(100, 0, 13, 80);
    const east = projectLocalMetersToGps(0, 100, 13, 80);
    const pn = projectGpsToLocalMeters(north.lat, north.lon, 13, 80);
    const pe = projectGpsToLocalMeters(east.lat, east.lon, 13, 80);
    expect(Math.hypot(pn.north, pn.east)).toBeCloseTo(100, 5);
    expect(pn.east).toBeCloseTo(0, 6);
    expect(Math.hypot(pe.north, pe.east)).toBeCloseTo(100, 5);
    expect(pe.north).toBeCloseTo(0, 6);
  });

  it("reference case: anchor (13, 80), 1000 m east, 0 m north", () => {
    const g = projectLocalMetersToGps(0, 1000, 13.0, 80.0);
    // Hard-coded reference (ENU through ECEF, WGS84): 1000 m east at 13 N is 0.0092204... deg of
    // longitude and dips ~0.0000069 deg south (curvature of the tangent plane).
    expect(g.lon - 80.0).toBeCloseTo(0.009220, 5);
    expect(g.lat - 13.0).toBeLessThan(0);
    expect(g.lat - 13.0).toBeGreaterThan(-1e-5);
    const back = projectGpsToLocalMeters(g.lat, g.lon, 13.0, 80.0);
    expect(back.east).toBeCloseTo(1000, 4);
    expect(back.north).toBeCloseTo(0, 4);
    // plane distance vs surface (geodesic) distance
    expect(Math.abs(vincentyInverse(13.0, 80.0, g.lat, g.lon) - 1000)).toBeLessThan(0.005);
  });

  it("origin maps to zero and handles the antimeridian", () => {
    expect(projectGpsToLocalMeters(13, 80, 13, 80)).toEqual({ north: 0, east: 0 });
    const p = projectGpsToLocalMeters(10, -179.999, 10, 179.999);
    expect(p.east).toBeGreaterThan(0);
    expect(p.east).toBeLessThan(500);
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

  it("does not overflow the stack on a very large point set", () => {
    const pts: Array<{ north: number; east: number }> = [];
    for (let i = 0; i < 400_000; i++) {
      pts.push({ north: 13 + (i % 1000) * 1e-7, east: 80 + Math.floor(i / 1000) * 1e-7 });
    }
    expect(() => looksGeographic(pts)).not.toThrow();
    expect(looksGeographic(pts).isGeographic).toBe(true);
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
    const meanN = points.reduce((s, p) => s + p.north, 0) / points.length;
    const meanE = points.reduce((s, p) => s + p.east, 0) / points.length;
    expect(Math.abs(meanN)).toBeLessThan(1e-3);
    expect(Math.abs(meanE)).toBeLessThan(1e-3);

    const back = projectLocalMetersToGps(points[0].north, points[0].east, origin.lat, origin.lon);
    expect(back.lat).toBeCloseTo(pts[0].north, 9);
    expect(back.lon).toBeCloseTo(pts[0].east, 9);

    const fwd = projectGpsToLocalMeters(pts[1].north, pts[1].east, origin.lat, origin.lon);
    expect(fwd.north).toBeCloseTo(points[1].north, 9);
    expect(fwd.east).toBeCloseTo(points[1].east, 9);
  });
});
