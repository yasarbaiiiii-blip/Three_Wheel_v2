/**
 * Inner/outer (buffer) offset — move each mark along its own outward normal
 * rather than a single compass translation. Planar NED metres; no geographic
 * turf projection (those packages assume lon/lat and would warp the plan).
 *
 * Circles/arcs change radius about a fixed center. Polylines and LINE segments
 * take a parallel offset. "Out" moves away from the marks' centroid (or
 * expands a closed ring); "In" is the opposite. Returns null when the offset
 * cannot be applied without collapsing a curve.
 */

import type { DxfEntity, PlanLine } from "../types/plan";
import { getCurveGeometry, sampleCurveEntityPoints, type CurveGeometry } from "./curveGeometry";

export type PlanBufferDirection = "out" | "in";

type Ned = { north: number; east: number };

const EPS = 1e-9;
const MIN_RADIUS_M = 0.01;
const MITER_LIMIT = 4;

function hypotNed(a: Ned, b: Ned): number {
  return Math.hypot(a.north - b.north, a.east - b.east);
}

function linePoints(line: PlanLine): Ned[] {
  const preview = line.entity?.preview_points;
  if (Array.isArray(preview) && preview.length >= 2) {
    return preview
      .filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east))
      .map((p) => ({ north: p.north, east: p.east }));
  }
  if (
    Number.isFinite(line.from.x) &&
    Number.isFinite(line.from.y) &&
    Number.isFinite(line.to.x) &&
    Number.isFinite(line.to.y)
  ) {
    return [
      { north: line.from.x, east: line.from.y },
      { north: line.to.x, east: line.to.y },
    ];
  }
  return [];
}

function isClosedRing(points: Ned[]): boolean {
  if (points.length < 3) return false;
  return hypotNed(points[0], points[points.length - 1]) <= 1e-6;
}

/** Shoelace in east/north (x/y). Positive = CCW. */
function signedArea(points: Ned[]): number {
  const ring = isClosedRing(points) ? points.slice(0, -1) : points;
  if (ring.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    area += ring[i].east * ring[j].north - ring[j].east * ring[i].north;
  }
  return area / 2;
}

export function marksCentroid(lines: PlanLine[]): Ned | null {
  let n = 0;
  let east = 0;
  let north = 0;
  for (const line of lines) {
    const curve = getCurveGeometry(line);
    if (curve) {
      north += curve.centerNorth;
      east += curve.centerEast;
      n += 1;
      continue;
    }
    for (const p of linePoints(line)) {
      north += p.north;
      east += p.east;
      n += 1;
    }
  }
  if (n === 0) return null;
  return { north: north / n, east: east / n };
}

/** Unit left-of-travel normal in NED: T=(dN,dE) → left=(dE, −dN). */
function leftUnit(dn: number, de: number): Ned | null {
  const len = Math.hypot(dn, de);
  if (len < EPS) return null;
  return { north: de / len, east: -dn / len };
}

function outwardUnit(a: Ned, b: Ned, centroid: Ned): Ned | null {
  const left = leftUnit(b.north - a.north, b.east - a.east);
  if (!left) return null;
  const mid: Ned = { north: (a.north + b.north) / 2, east: (a.east + b.east) / 2 };
  const dLeft = hypotNed(
    { north: mid.north + left.north, east: mid.east + left.east },
    centroid
  );
  const dRight = hypotNed(
    { north: mid.north - left.north, east: mid.east - left.east },
    centroid
  );
  if (dLeft >= dRight) return left;
  return { north: -left.north, east: -left.east };
}

function offsetBy(point: Ned, normal: Ned, dist: number): Ned {
  return {
    north: point.north + normal.north * dist,
    east: point.east + normal.east * dist,
  };
}

/**
 * Parallel-offset a polyline along its left-of-travel normal by `signedLeftDist`
 * metres (negative = right). Open paths offset end vertices along the terminal
 * edge; interior / closed vertices use a miter capped at MITER_LIMIT.
 */
export function offsetPolylineLeft(points: Ned[], signedLeftDist: number): Ned[] {
  if (!Number.isFinite(signedLeftDist) || Math.abs(signedLeftDist) < EPS) return points;
  if (points.length < 2) return points;

  const closed = isClosedRing(points);
  const work = closed ? points.slice(0, -1) : points.slice();
  const n = work.length;
  if (n < 2) return points;

  const dir = (i: number, j: number): Ned | null => {
    const dn = work[j].north - work[i].north;
    const de = work[j].east - work[i].east;
    const len = Math.hypot(dn, de);
    if (len < EPS) return null;
    return { north: dn / len, east: de / len };
  };

  const leftOf = (d: Ned): Ned => ({ north: d.east, east: -d.north });

  const offsetVertex = (i: number): Ned => {
    const prev = closed ? (i - 1 + n) % n : i - 1;
    const next = closed ? (i + 1) % n : i + 1;

    if (!closed && i === 0) {
      const d = dir(0, 1);
      if (!d) return work[i];
      return offsetBy(work[i], leftOf(d), signedLeftDist);
    }
    if (!closed && i === n - 1) {
      const d = dir(n - 2, n - 1);
      if (!d) return work[i];
      return offsetBy(work[i], leftOf(d), signedLeftDist);
    }

    const dIn = dir(prev, i);
    const dOut = dir(i, next);
    if (!dIn && !dOut) return work[i];
    if (!dIn && dOut) return offsetBy(work[i], leftOf(dOut), signedLeftDist);
    if (dIn && !dOut) return offsetBy(work[i], leftOf(dIn), signedLeftDist);

    const n1 = leftOf(dIn!);
    const n2 = leftOf(dOut!);
    const sum: Ned = { north: n1.north + n2.north, east: n1.east + n2.east };
    const sumLen = Math.hypot(sum.north, sum.east);
    if (sumLen < 1e-8) return offsetBy(work[i], n1, signedLeftDist);

    const miter: Ned = { north: sum.north / sumLen, east: sum.east / sumLen };
    const den = miter.north * n1.north + miter.east * n1.east;
    let scale = Math.abs(den) < 1e-8 ? signedLeftDist : signedLeftDist / den;
    const cap = Math.abs(signedLeftDist) * MITER_LIMIT;
    if (Math.abs(scale) > cap) scale = Math.sign(scale) * cap;
    return offsetBy(work[i], miter, scale);
  };

  const result = work.map((_, i) => offsetVertex(i));
  if (closed && result.length > 0) result.push({ ...result[0] });
  return result;
}

function signedLeftDistanceForPolyline(
  points: Ned[],
  distanceM: number,
  direction: PlanBufferDirection,
  centroid: Ned
): number {
  const mag = Math.abs(distanceM);
  const sign = direction === "out" ? 1 : -1;
  if (points.length >= 3 && (isClosedRing(points) || signedArea(points) !== 0)) {
    const area = signedArea(points);
    if (Math.abs(area) > EPS) {
      // CCW (area > 0): left-of-travel is inward, so out = right = negative left.
      const leftIsOut = area < 0;
      return sign * mag * (leftIsOut ? 1 : -1);
    }
  }
  const a = points[0];
  const b = points[1];
  const left = leftUnit(b.north - a.north, b.east - a.east);
  const out = outwardUnit(a, b, centroid);
  if (!left || !out) return sign * mag;
  const leftIsOut = left.north * out.north + left.east * out.east >= 0;
  return sign * mag * (leftIsOut ? 1 : -1);
}

function writeCurveGeometry(entity: DxfEntity, curve: CurveGeometry): DxfEntity["geometry"] {
  const prev =
    entity.geometry && typeof entity.geometry === "object"
      ? (entity.geometry as Record<string, unknown>)
      : {};
  return {
    ...prev,
    centerNorth: curve.centerNorth,
    centerEast: curve.centerEast,
    center_north: curve.centerNorth,
    center_east: curve.centerEast,
    center: [curve.centerNorth, curve.centerEast],
    cx: curve.centerEast,
    cy: curve.centerNorth,
    radius: curve.radius,
    r: curve.radius,
    startAngle: curve.startAngle,
    endAngle: curve.endAngle,
    start_angle: curve.startAngle,
    end_angle: curve.endAngle,
  };
}

function bufferCurveLine(line: PlanLine, curve: CurveGeometry, newRadius: number): PlanLine | null {
  if (!Number.isFinite(newRadius) || newRadius < MIN_RADIUS_M) return null;
  const nextCurve: CurveGeometry = { ...curve, radius: newRadius };
  const geometry = line.entity ? writeCurveGeometry(line.entity, nextCurve) : nextCurve;
  const drafted: PlanLine = {
    ...line,
    entity: line.entity
      ? { ...line.entity, geometry, length_m: 2 * Math.PI * newRadius }
      : line.entity,
  };
  const sampled = sampleCurveEntityPoints(drafted);
  const preview =
    sampled.length >= 2
      ? sampled
      : [
          { north: nextCurve.centerNorth, east: nextCurve.centerEast - newRadius },
          { north: nextCurve.centerNorth, east: nextCurve.centerEast + newRadius },
        ];
  const first = preview[0];
  const last = preview[preview.length - 1];
  return {
    ...drafted,
    from: { ...line.from, x: first.north, y: first.east },
    to: { ...line.to, x: last.north, y: last.east },
    entity: drafted.entity
      ? { ...drafted.entity, preview_points: preview, length_m: 2 * Math.PI * newRadius }
      : drafted.entity,
  };
}

function withPolyline(line: PlanLine, points: Ned[]): PlanLine {
  if (points.length < 2) return line;
  const first = points[0];
  const last = points[points.length - 1];
  let length = 0;
  for (let i = 1; i < points.length; i++) length += hypotNed(points[i - 1], points[i]);
  const preview_points = points.map((p) => ({ north: p.north, east: p.east }));
  const entity = line.entity
    ? { ...line.entity, preview_points, length_m: length }
    : undefined;
  return {
    ...line,
    from: { ...line.from, x: first.north, y: first.east },
    to: { ...line.to, x: last.north, y: last.east },
    ...(entity ? { entity } : {}),
  };
}

function bufferOneLine(
  line: PlanLine,
  distanceM: number,
  direction: PlanBufferDirection,
  centroid: Ned
): PlanLine | null {
  const curve = getCurveGeometry(line);
  if (curve) {
    const delta = direction === "out" ? Math.abs(distanceM) : -Math.abs(distanceM);
    return bufferCurveLine(line, curve, curve.radius + delta);
  }

  const points = linePoints(line);
  if (points.length < 2) return line;

  if (points.length === 2) {
    const out = outwardUnit(points[0], points[1], centroid);
    if (!out) return line;
    const signed = direction === "out" ? Math.abs(distanceM) : -Math.abs(distanceM);
    return withPolyline(line, [offsetBy(points[0], out, signed), offsetBy(points[1], out, signed)]);
  }

  const signedLeft = signedLeftDistanceForPolyline(points, distanceM, direction, centroid);
  return withPolyline(line, offsetPolylineLeft(points, signedLeft));
}

/**
 * Buffer every line in `lines` by `distanceM` in `direction`. Returns null when
 * the distance is non-finite, or any curve would collapse below MIN_RADIUS_M.
 * `distanceM === 0` is a no-op and returns the input array.
 */
export function bufferPlanLines(
  lines: PlanLine[],
  distanceM: number,
  direction: PlanBufferDirection
): PlanLine[] | null {
  if (!Number.isFinite(distanceM)) return null;
  if (distanceM === 0) return lines;
  if (direction !== "out" && direction !== "in") return null;

  const centroid = marksCentroid(lines);
  if (!centroid) return lines;

  const next: PlanLine[] = [];
  for (const line of lines) {
    const buffered = bufferOneLine(line, Math.abs(distanceM), direction, centroid);
    if (!buffered) return null;
    next.push(buffered);
  }
  return next;
}
