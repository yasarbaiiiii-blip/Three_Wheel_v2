/**
 * Shared geodetic projection: WGS84 local tangent plane (ENU).
 *
 * Every lat/lon <-> metre conversion in the app goes through this module (CSV
 * import, geographic DXF, alignment, rover position, preview, design anchors).
 * Metres are TRUE ground metres north / east of the origin on the WGS84
 * ellipsoid, which is what the rover assumes when it places an anchored
 * trajectory.
 *
 * Model. The point (phi, lambda, h = 0) and the origin are mapped to ECEF with
 * the meridional / prime-vertical radii of curvature
 *
 *   M(phi) = a (1 - e2) / (1 - e2 sin^2 phi)^(3/2)
 *   N(phi) = a / sqrt(1 - e2 sin^2 phi)
 *
 * (X, Y, Z) = (N cos phi cos lambda, N cos phi sin lambda, N (1 - e2) sin phi)
 *
 * and the difference vector is rotated into the east-north-up frame of the
 * origin. north / east are the first two components. Near the origin this is
 * north = dphi * M and east = dlambda * N cos(phi0); the full construction also
 * keeps the metric of *off-origin pairs* correct (meridian convergence), which
 * a fixed-radius or mid-latitude shortcut does not. Against the Vincenty
 * geodesic the error is below 10 micrometres at 1 km and a few millimetres at
 * 10 km.
 *
 * The inverse rotates the plane point (e, n, u = 0) back to ECEF and converts it
 * to geodetic lat/lon, dropping the height (see projectLocalMetersToGps).
 */

/** WGS84 semi-major axis (m). */
export const WGS84_A = 6378137.0;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 first eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const DEG = Math.PI / 180;

/** offset / extent >= this -> geographic (lat/lon) drawing */
export const GEO_OFFSET_EXTENT_RATIO = 1000;

/** A local site is never a whole degree across (~111 km) */
export const GEO_MAX_EXTENT_DEG = 1.0;

export type MetresPerDegree = {
  mPerDegNorth: number;
  mPerDegEast: number;
};

/** Meridional radius of curvature M(phi) in metres. */
export function meridionalRadius(latDeg: number): number {
  const s = Math.sin(latDeg * DEG);
  const w2 = 1 - WGS84_E2 * s * s;
  return (WGS84_A * (1 - WGS84_E2)) / (w2 * Math.sqrt(w2));
}

/** Prime-vertical radius of curvature N(phi) in metres. */
export function primeVerticalRadius(latDeg: number): number {
  const s = Math.sin(latDeg * DEG);
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
}

/**
 * Ground metres per degree of latitude / longitude at `latDeg`.
 * Use for local linearisations (bearings, small offsets); exact point
 * conversions use projectGpsToLocalMeters / projectLocalMetersToGps.
 */
export function metresPerDegree(latDeg: number): MetresPerDegree {
  return {
    mPerDegNorth: meridionalRadius(latDeg) * DEG,
    mPerDegEast: primeVerticalRadius(latDeg) * Math.cos(latDeg * DEG) * DEG,
  };
}

type Enu = { e: number; n: number; u: number };

function toEcef(latRad: number, lonRad: number): [number, number, number] {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    n * cosLat * Math.cos(lonRad),
    n * cosLat * Math.sin(lonRad),
    n * (1 - WGS84_E2) * sinLat,
  ];
}

function enuBasis(latRad: number, lonRad: number) {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  return {
    east: [-sinLon, cosLon, 0] as const,
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat] as const,
    up: [cosLat * cosLon, cosLat * sinLon, sinLat] as const,
  };
}

function ecefDeltaToEnu(
  d: [number, number, number],
  basis: ReturnType<typeof enuBasis>
): Enu {
  return {
    e: basis.east[0] * d[0] + basis.east[1] * d[1] + basis.east[2] * d[2],
    n: basis.north[0] * d[0] + basis.north[1] * d[1] + basis.north[2] * d[2],
    u: basis.up[0] * d[0] + basis.up[1] * d[1] + basis.up[2] * d[2],
  };
}

/** (lat, lon) -> true ground metres north / east of (originLat, originLon). */
export function projectGpsToLocalMeters(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { north: number; east: number } {
  const lat0 = originLat * DEG;
  const lon0 = originLon * DEG;
  const o = toEcef(lat0, lon0);
  const p = toEcef(lat * DEG, lon * DEG);
  const enu = ecefDeltaToEnu(
    [p[0] - o[0], p[1] - o[1], p[2] - o[2]],
    enuBasis(lat0, lon0)
  );
  return { north: enu.n, east: enu.e };
}

/**
 * (n, e) metres in the tangent plane -> lat/lon. The ENU point (e, n, u = 0) is
 * rotated back to ECEF, added to the anchor's ECEF and converted to geodetic
 * coordinates; the height is dropped. This is the placement the rover applies to
 * an anchored mission, so the app uses the identical construction.
 *
 * Because the plane point sits above the ellipsoid (about s^2 / 2R, 78 mm at
 * 1 km), forward(inverse(x)) differs from x by that height times s / R: about
 * 12 micrometres at 1 km and 1.5 mm at 5 km.
 */
export function projectLocalMetersToGps(
  north: number,
  east: number,
  originLat: number,
  originLon: number
): { lat: number; lon: number } {
  const lat0 = originLat * DEG;
  const lon0 = originLon * DEG;
  const o = toEcef(lat0, lon0);
  const b = enuBasis(lat0, lon0);
  const x = o[0] + east * b.east[0] + north * b.north[0];
  const y = o[1] + east * b.east[1] + north * b.north[1];
  const z = o[2] + east * b.east[2] + north * b.north[2];
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 20; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const next = Math.atan2(z + WGS84_E2 * n * sinLat, p);
    const done = Math.abs(next - lat) < 1e-14;
    lat = next;
    if (done) break;
  }
  return { lat: lat / DEG, lon: Math.atan2(y, x) / DEG };
}

/** True ground distance (m) between two lat/lon points on the tangent plane. */
export function groundDistanceMeters(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number
): number {
  const d = projectGpsToLocalMeters(latB, lonB, latA, lonA);
  return Math.hypot(d.north, d.east);
}

/** Ground bearing (degrees clockwise from north, -180..180) from A to B. */
export function groundBearingDeg(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number
): number {
  const d = projectGpsToLocalMeters(latB, lonB, latA, lonA);
  return (Math.atan2(d.east, d.north) * 180) / Math.PI;
}

/**
 * Decide whether (lat, lon) / (north, east) points are WGS84 geographic.
 * Coordinate-driven: INSUNITS lies; values themselves are the signal.
 *
 * Points are (northish, eastish) -- for a geo DXF that is (lat, lon).
 */
export function looksGeographic(
  points: Array<{ north: number; east: number } | [number, number]>
): { isGeographic: boolean; reason: string } {
  if (points.length < 2) {
    return { isGeographic: false, reason: "too few points" };
  }
  // Single pass: spreading a large array into Math.max overflows the stack.
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let maxAbsLat = 0;
  let maxAbsLon = 0;
  let sumLat = 0;
  let sumLon = 0;
  for (const p of points) {
    const lat = Array.isArray(p) ? p[0] : p.north;
    const lon = Array.isArray(p) ? p[1] : p.east;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    const al = Math.abs(lat);
    const ao = Math.abs(lon);
    if (al > maxAbsLat) maxAbsLat = al;
    if (ao > maxAbsLon) maxAbsLon = ao;
    sumLat += lat;
    sumLon += lon;
  }
  if (maxAbsLat > 90 || maxAbsLon > 180) {
    return { isGeographic: false, reason: "out of lat/lon range (projected metres)" };
  }
  const extent = Math.max(maxLat - minLat, maxLon - minLon);
  if (extent <= 0) {
    return { isGeographic: false, reason: "degenerate extent" };
  }
  if (extent >= GEO_MAX_EXTENT_DEG) {
    return {
      isGeographic: false,
      reason: `extent ${extent.toFixed(3)} too large for a local site in degrees`,
    };
  }
  const cenLat = sumLat / points.length;
  const cenLon = sumLon / points.length;
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
  let sumLat = 0;
  let sumLon = 0;
  for (const p of points) {
    sumLat += p.north;
    sumLon += p.east;
  }
  const lat0 = sumLat / points.length;
  const lon0 = sumLon / points.length;
  return {
    origin: { lat: lat0, lon: lon0 },
    points: points.map((p) => projectGpsToLocalMeters(p.north, p.east, lat0, lon0)),
  };
}
