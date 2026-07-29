/**
 * Shared geodetic projection — PX4 spherical local frame.
 *
 * Port of path_engine/parsers/georef.py (PX4 R = 6_371_000 m).
 * Both DXF local import and visual alignment must use this module so the app
 * and rover never disagree on metres-per-degree (G2).
 *
 * History (from georef.py):
 *  - WGS84 semi-major on both axes → +0.62 % north error at 13 °N
 *  - WGS84 M/N radii of curvature → 0.52 % short in the frame PX4 navigates
 *  - Correct: PX4 sphere CONSTANTS_RADIUS_OF_EARTH = 6_371_000 m
 */

/** PX4 geo.cpp CONSTANTS_RADIUS_OF_EARTH */
export const PX4_EARTH_RADIUS_M = 6_371_000;

/** offset / extent ≥ this → geographic (lat/lon) drawing */
export const GEO_OFFSET_EXTENT_RATIO = 1000;

/** A local site is never a whole degree across (~111 km) */
export const GEO_MAX_EXTENT_DEG = 1.0;

export type MetresPerDegree = {
  mPerDegNorth: number;
  mPerDegEast: number;
};

/**
 * (north, east) metres per degree at lat0 on the PX4 local-frame sphere.
 * Matches path_engine/parsers/georef.py metres_per_degree.
 */
export function metresPerDegreePx4(lat0Deg: number): MetresPerDegree {
  const lat0 = (lat0Deg * Math.PI) / 180;
  const perRad = Math.PI / 180;
  return {
    mPerDegNorth: PX4_EARTH_RADIUS_M * perRad,
    mPerDegEast: PX4_EARTH_RADIUS_M * perRad * Math.cos(lat0),
  };
}

/**
 * @deprecated Prefer metresPerDegreePx4 — kept as the shared name used by
 * visualAlignment consumers. Always PX4 sphere (not WGS84 ellipsoid).
 */
export function metresPerDegreeShared(lat0Deg: number): MetresPerDegree {
  return metresPerDegreePx4(lat0Deg);
}

export function projectLocalMetersToGps(
  north: number,
  east: number,
  originLat: number,
  originLon: number
): { lat: number; lon: number } {
  const { mPerDegNorth, mPerDegEast } = metresPerDegreePx4(originLat);
  return {
    lat: originLat + north / mPerDegNorth,
    lon: originLon + east / mPerDegEast,
  };
}

export function projectGpsToLocalMeters(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { north: number; east: number } {
  const { mPerDegNorth, mPerDegEast } = metresPerDegreePx4(originLat);
  return {
    north: (lat - originLat) * mPerDegNorth,
    east: (lon - originLon) * mPerDegEast,
  };
}

/**
 * Decide whether (lat, lon) / (north, east) points are WGS84 geographic.
 * Coordinate-driven: INSUNITS lies; values themselves are the signal.
 *
 * Points are (northish, eastish) — for a geo DXF that is (lat, lon).
 */
export function looksGeographic(
  points: Array<{ north: number; east: number } | [number, number]>
): { isGeographic: boolean; reason: string } {
  if (points.length < 2) {
    return { isGeographic: false, reason: "too few points" };
  }
  const pairs = points.map((p) =>
    Array.isArray(p) ? { north: p[0], east: p[1] } : p
  );
  const lats = pairs.map((p) => p.north);
  const lons = pairs.map((p) => p.east);
  if (
    Math.max(...lats.map(Math.abs)) > 90 ||
    Math.max(...lons.map(Math.abs)) > 180
  ) {
    return { isGeographic: false, reason: "out of lat/lon range (projected metres)" };
  }
  const latSpan = Math.max(...lats) - Math.min(...lats);
  const lonSpan = Math.max(...lons) - Math.min(...lons);
  const extent = Math.max(latSpan, lonSpan);
  if (extent <= 0) {
    return { isGeographic: false, reason: "degenerate extent" };
  }
  if (extent >= GEO_MAX_EXTENT_DEG) {
    return {
      isGeographic: false,
      reason: `extent ${extent.toFixed(3)} too large for a local site in degrees`,
    };
  }
  const cenLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const cenLon = lons.reduce((a, b) => a + b, 0) / lons.length;
  const offset = Math.max(Math.abs(cenLat), Math.abs(cenLon));
  const ratio = offset / extent;
  if (ratio < GEO_OFFSET_EXTENT_RATIO) {
    return {
      isGeographic: false,
      reason: `offset/extent ${ratio.toFixed(1)} below geographic threshold`,
    };
  }
  return {
    isGeographic: true,
    reason: `lat/lon centroid (${cenLat.toFixed(6)}, ${cenLon.toFixed(6)}), extent ${extent.toPrecision(6)} deg`,
  };
}

export type GeoProjectResult = {
  /** Centroid origin (lat, lon) */
  origin: { lat: number; lon: number };
  /** Points projected to local NED metres about origin */
  points: Array<{ north: number; east: number }>;
};

/**
 * Project geographic (lat, lon) points to local NED metres about the centroid.
 * Input points use north=lat, east=lon.
 */
export function projectGeographicToLocalNed(
  points: Array<{ north: number; east: number }>
): GeoProjectResult {
  if (points.length === 0) {
    return { origin: { lat: 0, lon: 0 }, points: [] };
  }
  const lat0 = points.reduce((s, p) => s + p.north, 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p.east, 0) / points.length;
  const { mPerDegNorth, mPerDegEast } = metresPerDegreePx4(lat0);
  return {
    origin: { lat: lat0, lon: lon0 },
    points: points.map((p) => ({
      north: (p.north - lat0) * mPerDegNorth,
      east: (p.east - lon0) * mPerDegEast,
    })),
  };
}
