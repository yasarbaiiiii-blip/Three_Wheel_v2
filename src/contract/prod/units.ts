/**
 * Single source of truth for physical units and coordinate transforms
 * between the production rover backend and the operator client.
 *
 * Rule: Production sends angles in radians (NED frame); the UI renders degrees.
 * Unit conversions must occur in this module only.
 */

/** Converts radians to degrees. */
export function radToDeg(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  return rad * (180 / Math.PI);
}

/** Converts degrees to radians. */
export function degToRad(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return deg * (Math.PI / 180);
}

/** Wraps an angle in radians to [-PI, PI]. */
export function wrapPi(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  let a = (rad + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  const res = a - Math.PI;
  return Object.is(res, -0) ? 0 : (res === -Math.PI && rad > 0 ? Math.PI : res);
}

/** Wraps an angle in degrees to [0, 360). */
export function wrap360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a < 0) a += 360;
  return Object.is(a, -0) || a === 360 ? 0 : a;
}

/** Formats a radian heading into a human-readable 0° - 359.9° string. */
export function formatHeadingDeg(headingRad: number | null | undefined, precision = 1): string {
  if (headingRad == null || !Number.isFinite(headingRad)) return "--";
  const deg = wrap360(radToDeg(headingRad));
  return `${deg.toFixed(precision)}°`;
}

/** Converts metres per second to km/h. */
export function mpsToKph(mps: number): number {
  if (!Number.isFinite(mps)) return 0;
  return mps * 3.6;
}

/** Formats metres per second as m/s with fallback. */
export function formatSpeedMps(speedMps: number | null | undefined, precision = 2): string {
  if (speedMps == null || !Number.isFinite(speedMps)) return "--";
  return `${speedMps.toFixed(precision)} m/s`;
}

/** Formats distance in metres with mm or cm precision. */
export function formatDistanceM(distM: number | null | undefined, precision = 2): string {
  if (distM == null || !Number.isFinite(distM)) return "--";
  return `${distM.toFixed(precision)} m`;
}
