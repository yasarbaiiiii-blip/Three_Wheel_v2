/**
 * Road-marking CSV path refinement (preview).
 *
 * Survey CSV points become an OPEN path of:
 *   - straight runs (line / infinite-radius generalized fit), and
 *   - circular-arc runs (Hyper algebraic circle fit),
 * with geometric fillets only at joints between fitted primitives.
 *
 * Pipeline (order matters — do not re-flatten fillets through another fit pass):
 *   1. dedupe + open-path guard
 *   2. collinear simplify + deterministic spike reject
 *   3. greedy segment into line/arc primitives (Hyper for arcs)
 *   4. geometric joint fillets from adjacent tangent directions
 *   5. tessellate once → open polyline samples
 *
 * Strictly no closed polygon / ring. DXF / other plan sources are not handled here.
 */

export type RoadMarkingNedPoint = {
  north: number;
  east: number;
};

export type RoadMarkingPathOptions = {
  /** Max orthogonal deviation from a line/arc (metres). */
  fitToleranceM?: number;
  /** Turning angle above this (deg) is treated as a sharp corner to fillet. */
  sharpCornerDeg?: number;
  /** Fillet radius as a fraction of the shorter adjacent segment. */
  filletRadiusFraction?: number;
  /** Absolute cap on fillet radius (metres). */
  maxFilletRadiusM?: number;
  /** Sample spacing along arcs / fillets for map preview (metres). */
  sampleSpacingM?: number;
  /** Min points (inclusive) needed to attempt an arc fit. */
  minArcPoints?: number;
  /** Max radius (m) still considered a curve (larger → treated as straight). */
  maxArcRadiusM?: number;
  /**
   * Spike reject: drop a vertex if pathLen/chord exceeds this and residual
   * exceeds outlierResidualFactor * fitToleranceM.
   */
  outlierPathChordRatio?: number;
  /** Residual multiplier for deterministic spike reject. */
  outlierResidualFactor?: number;
};

const DEFAULTS = {
  fitToleranceM: 0.08,
  sharpCornerDeg: 12,
  filletRadiusFraction: 0.4,
  maxFilletRadiusM: 8,
  sampleSpacingM: 0.35,
  minArcPoints: 4,
  maxArcRadiusM: 5000,
  outlierPathChordRatio: 2.5,
  outlierResidualFactor: 8,
} as const;

type Circle = { cn: number; ce: number; r: number };

/** Generalized algebraic fit: circle when |a| is meaningful; line when a≈0 / huge R. */
export type GeneralizedFit =
  | { kind: "line" }
  | { kind: "circle"; circle: Circle };

function dist(a: RoadMarkingNedPoint, b: RoadMarkingNedPoint): number {
  return Math.hypot(a.north - b.north, a.east - b.east);
}

function sub(a: RoadMarkingNedPoint, b: RoadMarkingNedPoint): RoadMarkingNedPoint {
  return { north: a.north - b.north, east: a.east - b.east };
}

function add(a: RoadMarkingNedPoint, b: RoadMarkingNedPoint): RoadMarkingNedPoint {
  return { north: a.north + b.north, east: a.east + b.east };
}

function scale(v: RoadMarkingNedPoint, s: number): RoadMarkingNedPoint {
  return { north: v.north * s, east: v.east * s };
}

function unit(v: RoadMarkingNedPoint): RoadMarkingNedPoint | null {
  const len = Math.hypot(v.north, v.east);
  if (len < 1e-9) return null;
  return { north: v.north / len, east: v.east / len };
}

/** Signed turning angle in degrees at `b` (0 = straight, ±180 = reverse). */
export function turningAngleDeg(
  a: RoadMarkingNedPoint,
  b: RoadMarkingNedPoint,
  c: RoadMarkingNedPoint
): number {
  const v1 = unit(sub(b, a));
  const v2 = unit(sub(c, b));
  if (!v1 || !v2) return 0;
  const cross = v1.north * v2.east - v1.east * v2.north;
  const dot = v1.north * v2.north + v1.east * v2.east;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/** Deduplicate consecutive near-identical points. */
export function dedupeNearPoints(
  points: RoadMarkingNedPoint[],
  minDistM = 0.02
): RoadMarkingNedPoint[] {
  if (points.length === 0) return [];
  const out: RoadMarkingNedPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (dist(out[out.length - 1], points[i]) >= minDistM) {
      out.push(points[i]);
    }
  }
  return out;
}

/**
 * Never close the path into a ring. If first≈last (looping survey), drop the
 * last point so Mapbox closedRing / polygon-style stroke cannot trigger.
 */
export function ensureOpenPath(points: RoadMarkingNedPoint[]): RoadMarkingNedPoint[] {
  if (points.length < 2) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (dist(first, last) < 0.05) {
    return points.slice(0, -1);
  }
  return points.slice();
}

/** Max distance from points to the infinite line through first→last. */
function maxLineResidual(points: RoadMarkingNedPoint[]): number {
  if (points.length < 2) return 0;
  const a = points[0];
  const b = points[points.length - 1];
  const ab = sub(b, a);
  const len = Math.hypot(ab.north, ab.east);
  if (len < 1e-9) {
    let max = 0;
    for (const p of points) max = Math.max(max, dist(a, p));
    return max;
  }
  let max = 0;
  for (const p of points) {
    const ap = sub(p, a);
    const cross = Math.abs(ab.north * ap.east - ab.east * ap.north) / len;
    max = Math.max(max, cross);
  }
  return max;
}

function pointLineResidual(
  p: RoadMarkingNedPoint,
  a: RoadMarkingNedPoint,
  b: RoadMarkingNedPoint
): number {
  const ab = sub(b, a);
  const len = Math.hypot(ab.north, ab.east);
  if (len < 1e-9) return dist(a, p);
  const ap = sub(p, a);
  return Math.abs(ab.north * ap.east - ab.east * ap.north) / len;
}

/**
 * Drop GPS spikes (out-and-back outliers) without removing real corners.
 * Corner with equal legs @ 90° has pathLen/chord ≈ √2 ≈ 1.41; spikes are much larger.
 */
export function rejectPathSpikes(
  points: RoadMarkingNedPoint[],
  fitToleranceM: number,
  pathChordRatio: number,
  residualFactor: number
): RoadMarkingNedPoint[] {
  if (points.length < 3) return points.slice();
  const maxRes = residualFactor * fitToleranceM;
  const out: RoadMarkingNedPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const pathLen = dist(prev, cur) + dist(cur, next);
    const chord = dist(prev, next);
    const height = pointLineResidual(cur, prev, next);
    if (chord > 1e-9 && pathLen / chord > pathChordRatio && height > maxRes) {
      continue; // spike
    }
    out.push(cur);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Remove vertices that lie within `eps` of the chord of their neighbors.
 * Preserves curves (non-collinear) and real corners.
 */
export function simplifyCollinear(
  points: RoadMarkingNedPoint[],
  eps: number
): RoadMarkingNedPoint[] {
  if (points.length < 3) return points.slice();
  let pts = points.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const next: RoadMarkingNedPoint[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      if (pointLineResidual(pts[i], next[next.length - 1], pts[i + 1]) <= eps) {
        changed = true;
        continue;
      }
      next.push(pts[i]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/**
 * Collapse short opposite-sign turn pairs (S-jogs / GPS weave) by dropping the
 * kinkier interior vertex. Leaves long single corners (L-turns) intact.
 */
export function dampenOppositeJogs(
  points: RoadMarkingNedPoint[],
  minTurnDeg = 8,
  maxSegM = 3.5
): RoadMarkingNedPoint[] {
  if (points.length < 4) return points.slice();
  let pts = points.slice();
  let changed = true;
  let guard = 0;
  while (changed && pts.length >= 4 && guard++ < pts.length) {
    changed = false;
    for (let i = 1; i < pts.length - 2; i++) {
      const t1 = turningAngleDeg(pts[i - 1], pts[i], pts[i + 1]);
      const t2 = turningAngleDeg(pts[i], pts[i + 1], pts[i + 2]);
      if (Math.abs(t1) < minTurnDeg || Math.abs(t2) < minTurnDeg) continue;
      if (t1 * t2 >= 0) continue; // same side — not an S
      const d0 = dist(pts[i - 1], pts[i]);
      const d1 = dist(pts[i], pts[i + 1]);
      const d2 = dist(pts[i + 1], pts[i + 2]);
      // Local weave: short middle leg, and at least one adjacent leg short.
      // (Do not require all three short — approach legs to a jog can be longer.)
      if (d1 > maxSegM) continue;
      if (Math.min(d0, d2) > maxSegM * 1.25) continue;
      // Drop the vertex with the larger |turn| so the weave collapses.
      const removeIdx = Math.abs(t1) >= Math.abs(t2) ? i : i + 1;
      pts.splice(removeIdx, 1);
      changed = true;
      break;
    }
  }
  return pts;
}

/**
 * Algebraic circle fit (Kåsa) — kept for regression comparison.
 * Documented short-arc bias toward smaller radii; not used in the production pipeline.
 */
export function fitCircleKasa(points: RoadMarkingNedPoint[]): Circle | null {
  if (points.length < 3) return null;
  // Center for mild numerical stability (still Kåsa algebra).
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.east;
    my += p.north;
  }
  mx /= points.length;
  my /= points.length;

  let sumX = 0;
  let sumY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  let sumX3 = 0;
  let sumY3 = 0;
  let sumX2Y = 0;
  let sumXY2 = 0;
  const n = points.length;
  for (const p of points) {
    const x = p.east - mx;
    const y = p.north - my;
    const x2 = x * x;
    const y2 = y * y;
    sumX += x;
    sumY += y;
    sumX2 += x2;
    sumY2 += y2;
    sumXY += x * y;
    sumX3 += x2 * x;
    sumY3 += y2 * y;
    sumX2Y += x2 * y;
    sumXY2 += x * y2;
  }
  const C = n * sumX2 - sumX * sumX;
  const D = n * sumXY - sumX * sumY;
  const E = n * sumY2 - sumY * sumY;
  const G = 0.5 * (n * sumX3 - sumX * sumX2 + n * sumXY2 - sumX * sumY2);
  const H = 0.5 * (n * sumY3 - sumY * sumY2 + n * sumX2Y - sumY * sumX2);
  const denom = C * E - D * D;
  if (Math.abs(denom) < 1e-12) return null;
  const ce = (G * E - H * D) / denom + mx;
  const cn = (C * H - D * G) / denom + my;
  let rSum = 0;
  for (const p of points) {
    rSum += Math.hypot(p.north - cn, p.east - ce);
  }
  const r = rSum / n;
  if (!Number.isFinite(r) || r <= 0.05) return null;
  return { cn, ce, r };
}

/**
 * Hyperaccurate (HyperLS) circle fit — Al-Sharadqah & Chernov (2009).
 * Closed-form / Newton-on-cubic; essentially unbiased; same O(n) cost as Kåsa.
 * Coordinates are centered at the window centroid before building moments.
 *
 * Formula matches Chernov CircleFitByHyper (EJS 2009 / people.cas.uab.edu/~mosya/cl):
 *   A1 = Var_z*Mz + 4*Cov_xy*Mz - Mxz² - Myz²
 *   R  = √(cx² + cy² + Mz - 2x)
 * Do not substitute Zmean for the Mz factor in the 4*Cov_xy term with extra -Mzz*Mz
 * or flipped Mxz/Myz signs — that is a different (non-Hyper) cubic.
 */
export function fitCircleHyper(points: RoadMarkingNedPoint[]): Circle | null {
  if (points.length < 3) return null;

  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.east;
    my += p.north;
  }
  mx /= points.length;
  my /= points.length;

  let Mxx = 0;
  let Myy = 0;
  let Mxy = 0;
  let Mxz = 0;
  let Myz = 0;
  let Mzz = 0;
  const n = points.length;
  for (const p of points) {
    const x = p.east - mx;
    const y = p.north - my;
    const z = x * x + y * y;
    Mxx += x * x;
    Myy += y * y;
    Mxy += x * y;
    Mxz += x * z;
    Myz += y * z;
    Mzz += z * z;
  }
  Mxx /= n;
  Myy /= n;
  Mxy /= n;
  Mxz /= n;
  Myz /= n;
  Mzz /= n;

  // Chernov: Mz = Mxx+Myy (= mean of Zi under centroid centering).
  const Mz = Mxx + Myy;
  const Cov_xy = Mxx * Myy - Mxy * Mxy;
  const Var_z = Mzz - Mz * Mz;

  // Characteristic polynomial — Hyper (Chernov CircleFitByHyper.cpp).
  const A2 = 4 * Cov_xy - 3 * Mz * Mz - Mzz;
  const A1 = Var_z * Mz + 4 * Cov_xy * Mz - Mxz * Mxz - Myz * Myz;
  const A0 =
    Mxz * (Mxz * Myy - Myz * Mxy) + Myz * (Myz * Mxx - Mxz * Mxy) - Var_z * Cov_xy;
  const A22 = A2 + A2;

  // Newton for cubic root, start at x=0 with y=A0 (Chernov form).
  // Guaranteed to converge to the right root for this polynomial.
  let x = 0;
  let y = A0;
  for (let iter = 0; iter < 99; iter++) {
    const Dy = A1 + x * (A22 + 16 * x * x);
    if (!Number.isFinite(Dy) || Math.abs(Dy) < 1e-18) break;
    const xnew = x - y / Dy;
    if (!Number.isFinite(xnew) || xnew === x) break;
    const ynew = A0 + xnew * (A1 + xnew * (A2 + 4 * xnew * xnew));
    if (Math.abs(ynew) >= Math.abs(y)) break;
    x = xnew;
    y = ynew;
  }

  const DET = x * x - x * Mz + Cov_xy;
  if (Math.abs(DET) < 1e-18) return null;

  const centerX = (Mxz * (Myy - x) - Myz * Mxy) / DET / 2;
  const centerY = (Myz * (Mxx - x) - Mxz * Mxy) / DET / 2;
  const ce = centerX + mx;
  const cn = centerY + my;
  // Chernov: R = sqrt(cx² + cy² + Mz - 2x)
  const r = Math.sqrt(Math.abs(centerX * centerX + centerY * centerY + Mz - 2 * x));

  if (!Number.isFinite(r) || r <= 0.05) return null;
  return { cn, ce, r };
}

function maxCircleResidual(points: RoadMarkingNedPoint[], circle: Circle): number {
  let max = 0;
  for (const p of points) {
    const d = Math.abs(Math.hypot(p.north - circle.cn, p.east - circle.ce) - circle.r);
    max = Math.max(max, d);
  }
  return max;
}

/**
 * Unified line-or-circle classification for a window.
 * Uses Hyper when curvature is present; returns line when residual is flat or R huge.
 */
export function fitLineOrCircle(
  points: RoadMarkingNedPoint[],
  tol: number,
  minArcPoints: number,
  maxArcRadiusM: number
): GeneralizedFit {
  if (points.length < 2) return { kind: "line" };
  if (points.length === 2) return { kind: "line" };

  // Prefer straight when the chord residual already passes.
  if (maxLineResidual(points) <= tol) {
    return { kind: "line" };
  }

  if (points.length < minArcPoints) {
    return { kind: "line" };
  }

  const circle = fitCircleHyper(points);
  if (!circle) return { kind: "line" };
  if (circle.r > maxArcRadiusM) return { kind: "line" };
  if (maxCircleResidual(points, circle) > tol) return { kind: "line" };

  // Extra guard: if arc subtends a tiny angle, Hyper still has high variance —
  // prefer line + later joint fillet over a fragile short-arc primitive.
  const a0 = Math.atan2(points[0].north - circle.cn, points[0].east - circle.ce);
  const a1 = Math.atan2(
    points[points.length - 1].north - circle.cn,
    points[points.length - 1].east - circle.ce
  );
  let sweep = Math.abs(a1 - a0);
  if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
  const chord = dist(points[0], points[points.length - 1]);
  // Very short angular span relative to radius → treat as straight.
  if (sweep * circle.r < Math.max(chord * 0.15, 3 * tol) && sweep < 0.15) {
    return { kind: "line" };
  }

  return { kind: "circle", circle };
}

function fitsLine(points: RoadMarkingNedPoint[], tol: number): boolean {
  if (points.length < 2) return false;
  if (points.length === 2) return true;
  return maxLineResidual(points) <= tol;
}

function fitsArc(
  points: RoadMarkingNedPoint[],
  tol: number,
  minArcPoints: number,
  maxArcRadiusM: number
): Circle | null {
  const fit = fitLineOrCircle(points, tol, minArcPoints, maxArcRadiusM);
  return fit.kind === "circle" ? fit.circle : null;
}

function angleOf(p: RoadMarkingNedPoint, c: Circle): number {
  return Math.atan2(p.north - c.cn, p.east - c.ce);
}

function unwrapAngles(start: number, end: number, mid: number): { a0: number; a1: number } {
  const norm = (a: number) => {
    while (a <= -Math.PI) a += 2 * Math.PI;
    while (a > Math.PI) a -= 2 * Math.PI;
    return a;
  };
  let m = norm(mid - start);
  let e = norm(end - start);
  if (e < 0) e += 2 * Math.PI;
  if (m < 0) m += 2 * Math.PI;
  if (m <= e + 1e-9) {
    return { a0: start, a1: start + e };
  }
  e = norm(start - end);
  if (e < 0) e += 2 * Math.PI;
  return { a0: start, a1: start - e };
}

function sampleArc(
  c: Circle,
  a0: number,
  a1: number,
  spacingM: number
): RoadMarkingNedPoint[] {
  const sweep = a1 - a0;
  const arcLen = Math.abs(sweep) * c.r;
  const steps = Math.max(2, Math.ceil(arcLen / Math.max(spacingM, 0.05)));
  const out: RoadMarkingNedPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + sweep * t;
    out.push({
      north: c.cn + c.r * Math.sin(a),
      east: c.ce + c.r * Math.cos(a),
    });
  }
  return out;
}

function sampleLine(
  a: RoadMarkingNedPoint,
  b: RoadMarkingNedPoint,
  spacingM: number
): RoadMarkingNedPoint[] {
  const len = dist(a, b);
  if (len < 1e-9) return [a];
  const steps = Math.max(1, Math.ceil(len / Math.max(spacingM, 0.05)));
  const out: RoadMarkingNedPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({
      north: a.north + (b.north - a.north) * t,
      east: a.east + (b.east - a.east) * t,
    });
  }
  return out;
}

/**
 * Geometric circular fillet from two unit tangents at a joint (exact Euclidean
 * construction — not a statistical fit to noisy corner points).
 *
 * Tangent offset uses r * tan(|θ|/2) so the arc is true radius r for any turn angle.
 */
export function geometricFilletFromTangents(
  joint: RoadMarkingNedPoint,
  uIn: RoadMarkingNedPoint,
  uOut: RoadMarkingNedPoint,
  radiusM: number,
  sampleSpacingM: number
): { t1: RoadMarkingNedPoint; t2: RoadMarkingNedPoint; samples: RoadMarkingNedPoint[] } | null {
  const uI = unit(uIn);
  const uO = unit(uOut);
  if (!uI || !uO || radiusM < 0.05) return null;

  const cross = uI.north * uO.east - uI.east * uO.north;
  const dot = Math.max(-1, Math.min(1, uI.north * uO.north + uI.east * uO.east));
  const turnRad = Math.atan2(cross, dot);
  const absTurn = Math.abs(turnRad);
  if (absTurn < 1e-4 || absTurn > Math.PI - 1e-4) return null;

  const offset = radiusM * Math.tan(absTurn / 2);
  if (!Number.isFinite(offset) || offset < 0.02) return null;

  const t1 = add(joint, scale(uI, -offset));
  const t2 = add(joint, scale(uO, offset));

  const sign = turnRad >= 0 ? 1 : -1;
  const nIn = { north: -uI.east * sign, east: uI.north * sign };
  const center = add(t1, scale(nIn, radiusM));
  const circle: Circle = { cn: center.north, ce: center.east, r: radiusM };

  const a0 = angleOf(t1, circle);
  const a1 = angleOf(t2, circle);
  // Mid-angle toward the joint side of the fillet.
  const midGuess = angleOf(joint, circle);
  const { a0: aa, a1: ab } = unwrapAngles(a0, a1, midGuess);
  const samples = sampleArc(circle, aa, ab, sampleSpacingM);
  return { t1, t2, samples };
}

/**
 * Replace sharp corners on a polyline with geometric fillets.
 * Used for raw polylines and as a helper; production path fillets primitive joints.
 */
export function filletSharpCorners(
  points: RoadMarkingNedPoint[],
  options: Required<
    Pick<
      typeof DEFAULTS,
      "sharpCornerDeg" | "filletRadiusFraction" | "maxFilletRadiusM" | "sampleSpacingM"
    >
  >
): RoadMarkingNedPoint[] {
  if (points.length < 3) return points.slice();

  const out: RoadMarkingNedPoint[] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const turn = Math.abs(turningAngleDeg(prev, cur, next));
    if (turn < options.sharpCornerDeg) {
      out.push(cur);
      continue;
    }

    const dPrev = dist(prev, cur);
    const dNext = dist(cur, next);
    const r = Math.min(
      options.maxFilletRadiusM,
      options.filletRadiusFraction * Math.min(dPrev, dNext)
    );
    const turnRad = (turn * Math.PI) / 180;
    const need = r * Math.tan(turnRad / 2);
    if (r < 0.05 || dPrev < need * 1.05 || dNext < need * 1.05) {
      out.push(cur);
      continue;
    }

    const uIn = unit(sub(cur, prev));
    const uOut = unit(sub(next, cur));
    if (!uIn || !uOut) {
      out.push(cur);
      continue;
    }

    const fillet = geometricFilletFromTangents(cur, uIn, uOut, r, options.sampleSpacingM);
    if (!fillet) {
      out.push(cur);
      continue;
    }
    for (let k = 0; k < fillet.samples.length; k++) {
      const p = fillet.samples[k];
      if (k === 0 && dist(out[out.length - 1], p) < 0.02) continue;
      out.push(p);
    }
  }

  out.push(points[points.length - 1]);
  return dedupeNearPoints(out, 0.015);
}

export type PathPrimitive =
  | { kind: "line"; i0: number; i1: number }
  | { kind: "arc"; i0: number; i1: number; circle: Circle };

/**
 * Greedy longest line/arc segmentation using Hyper for arcs.
 * Does not tessellate — keeps primitives so joints can be filleted first.
 */
export function segmentIntoPrimitives(
  points: RoadMarkingNedPoint[],
  options: Required<
    Pick<typeof DEFAULTS, "fitToleranceM" | "minArcPoints" | "maxArcRadiusM">
  >
): PathPrimitive[] {
  if (points.length < 2) return [];
  if (points.length === 2) return [{ kind: "line", i0: 0, i1: 1 }];

  const prims: PathPrimitive[] = [];
  let i = 0;
  const n = points.length;

  while (i < n - 1) {
    let bestJ = i + 1;
    let best: PathPrimitive = { kind: "line", i0: i, i1: bestJ };

    for (let j = i + 2; j < n; j++) {
      const slice = points.slice(i, j + 1);
      if (fitsLine(slice, options.fitToleranceM)) {
        bestJ = j;
        best = { kind: "line", i0: i, i1: j };
        continue;
      }
      const circle = fitsArc(
        slice,
        options.fitToleranceM,
        options.minArcPoints,
        options.maxArcRadiusM
      );
      if (circle) {
        bestJ = j;
        best = { kind: "arc", i0: i, i1: j, circle };
        continue;
      }
      break;
    }

    prims.push(best);
    if (bestJ <= i) break;
    i = bestJ;
  }

  return prims;
}

/** Unit tangent arriving at the end of a primitive (direction of travel). */
function tangentInAtEnd(points: RoadMarkingNedPoint[], prim: PathPrimitive): RoadMarkingNedPoint | null {
  if (prim.kind === "line") {
    return unit(sub(points[prim.i1], points[prim.i0]));
  }
  const end = points[prim.i1];
  const c = prim.circle;
  const radial = unit({ north: end.north - c.cn, east: end.east - c.ce });
  if (!radial) return null;
  // Arc travel direction: use mid-point to determine CW vs CCW.
  const mid = points[Math.floor((prim.i0 + prim.i1) / 2)];
  const a0 = angleOf(points[prim.i0], c);
  const a1 = angleOf(end, c);
  const midA = angleOf(mid, c);
  const { a0: aa, a1: ab } = unwrapAngles(a0, a1, midA);
  const ccw = ab >= aa;
  // With (east, north) = r (cos θ, sin θ), unit CCW tangent is (-sin, cos) =
  // (-radial.north, radial.east) in (east, north) → { north: radial.east, east: -radial.north }.
  const tCcw = { north: radial.east, east: -radial.north };
  return ccw ? tCcw : scale(tCcw, -1);
}

/** Unit tangent leaving the start of a primitive. */
function tangentOutAtStart(
  points: RoadMarkingNedPoint[],
  prim: PathPrimitive
): RoadMarkingNedPoint | null {
  if (prim.kind === "line") {
    return unit(sub(points[prim.i1], points[prim.i0]));
  }
  const start = points[prim.i0];
  const c = prim.circle;
  const radial = unit({ north: start.north - c.cn, east: start.east - c.ce });
  if (!radial) return null;
  const mid = points[Math.floor((prim.i0 + prim.i1) / 2)];
  const a0 = angleOf(start, c);
  const a1 = angleOf(points[prim.i1], c);
  const midA = angleOf(mid, c);
  const { a0: aa, a1: ab } = unwrapAngles(a0, a1, midA);
  const ccw = ab >= aa;
  const tCcw = { north: radial.east, east: -radial.north };
  return ccw ? tCcw : scale(tCcw, -1);
}

function primitiveLength(points: RoadMarkingNedPoint[], prim: PathPrimitive): number {
  if (prim.kind === "line") {
    return dist(points[prim.i0], points[prim.i1]);
  }
  const mid = points[Math.floor((prim.i0 + prim.i1) / 2)];
  const a0 = angleOf(points[prim.i0], prim.circle);
  const a1 = angleOf(points[prim.i1], prim.circle);
  const midA = angleOf(mid, prim.circle);
  const { a0: aa, a1: ab } = unwrapAngles(a0, a1, midA);
  return Math.abs(ab - aa) * prim.circle.r;
}

/**
 * Tessellate primitives once, inserting geometric fillets only at joints.
 * Fillet samples are never re-fed into Hyper/Kåsa — avoids re-flatten bug.
 */
export function tessellatePrimitivesWithJointFillets(
  points: RoadMarkingNedPoint[],
  prims: PathPrimitive[],
  options: Required<
    Pick<
      typeof DEFAULTS,
      | "sharpCornerDeg"
      | "filletRadiusFraction"
      | "maxFilletRadiusM"
      | "sampleSpacingM"
    >
  >
): RoadMarkingNedPoint[] {
  if (prims.length === 0) return points.slice();
  if (prims.length === 1) {
    const p = prims[0];
    if (p.kind === "line") {
      return sampleLine(points[p.i0], points[p.i1], options.sampleSpacingM);
    }
    const mid = points[Math.floor((p.i0 + p.i1) / 2)];
    const a0 = angleOf(points[p.i0], p.circle);
    const a1 = angleOf(points[p.i1], p.circle);
    const midA = angleOf(mid, p.circle);
    const { a0: aa, a1: ab } = unwrapAngles(a0, a1, midA);
    return sampleArc(p.circle, aa, ab, options.sampleSpacingM);
  }

  // Precompute fillet at each joint i (between prims[i] and prims[i+1]).
  type JointFillet = {
    t1: RoadMarkingNedPoint;
    t2: RoadMarkingNedPoint;
    samples: RoadMarkingNedPoint[];
    trimIn: number; // metres to trim from end of prev prim
    trimOut: number;
  };
  const joints: Array<JointFillet | null> = [];

  for (let i = 0; i < prims.length - 1; i++) {
    const prev = prims[i];
    const next = prims[i + 1];
    const joint = points[prev.i1];
    // Prefer shared vertex; next should start there.
    const jointPt =
      dist(joint, points[next.i0]) < 0.05 ? joint : points[next.i0];

    const uIn = tangentInAtEnd(points, prev);
    const uOut = tangentOutAtStart(points, next);
    if (!uIn || !uOut) {
      joints.push(null);
      continue;
    }

    // Probe turn with short steps along tangents.
    const probeA = add(jointPt, scale(uIn, -1));
    const probeB = add(jointPt, scale(uOut, 1));
    const turn = Math.abs(turningAngleDeg(probeA, jointPt, probeB));
    if (turn < options.sharpCornerDeg) {
      joints.push(null);
      continue;
    }

    const lenPrev = primitiveLength(points, prev);
    const lenNext = primitiveLength(points, next);
    // Leave half of each primitive for the other joint / body.
    const budget = 0.45 * Math.min(lenPrev, lenNext);
    let r = Math.min(
      options.maxFilletRadiusM,
      options.filletRadiusFraction * Math.min(lenPrev, lenNext)
    );
    const turnRad = (turn * Math.PI) / 180;
    let offset = r * Math.tan(turnRad / 2);
    if (offset > budget && turnRad > 1e-6) {
      r = budget / Math.tan(turnRad / 2);
      offset = budget;
    }
    if (r < 0.05 || offset < 0.02) {
      joints.push(null);
      continue;
    }

    const fillet = geometricFilletFromTangents(
      jointPt,
      uIn,
      uOut,
      r,
      options.sampleSpacingM
    );
    if (!fillet) {
      joints.push(null);
      continue;
    }
    joints.push({
      t1: fillet.t1,
      t2: fillet.t2,
      samples: fillet.samples,
      trimIn: offset,
      trimOut: offset,
    });
  }

  const out: RoadMarkingNedPoint[] = [];
  const pushSamples = (samples: RoadMarkingNedPoint[]) => {
    for (const p of samples) {
      if (out.length > 0 && dist(out[out.length - 1], p) < 0.015) continue;
      out.push(p);
    }
  };

  for (let i = 0; i < prims.length; i++) {
    const prim = prims[i];
    const filletIn = i > 0 ? joints[i - 1] : null;
    const filletOut = i < prims.length - 1 ? joints[i] : null;

    let start = points[prim.i0];
    let end = points[prim.i1];
    if (filletIn) start = filletIn.t2;
    if (filletOut) end = filletOut.t1;

    if (prim.kind === "line") {
      if (dist(start, end) >= 0.02) {
        pushSamples(sampleLine(start, end, options.sampleSpacingM));
      } else if (out.length === 0) {
        out.push(start);
      }
    } else {
      // Trim arc by re-targeting start/end angles to fillet tangent points.
      const mid = points[Math.floor((prim.i0 + prim.i1) / 2)];
      const aStart = angleOf(start, prim.circle);
      const aEnd = angleOf(end, prim.circle);
      const midA = angleOf(mid, prim.circle);
      const { a0: aa, a1: ab } = unwrapAngles(aStart, aEnd, midA);
      if (Math.abs(ab - aa) * prim.circle.r >= 0.02) {
        pushSamples(sampleArc(prim.circle, aa, ab, options.sampleSpacingM));
      }
    }

    if (filletOut) {
      pushSamples(filletOut.samples);
    }
  }

  if (out.length < 2) return points.slice();
  return dedupeNearPoints(out, 0.015);
}

/**
 * Greedy segment + joint fillet + single tessellation.
 * Public wrapper kept for tests / callers that pass a raw polyline.
 */
export function segmentAndTessellate(
  points: RoadMarkingNedPoint[],
  options: Required<
    Pick<
      typeof DEFAULTS,
      | "fitToleranceM"
      | "sampleSpacingM"
      | "minArcPoints"
      | "maxArcRadiusM"
      | "sharpCornerDeg"
      | "filletRadiusFraction"
      | "maxFilletRadiusM"
    >
  >
): RoadMarkingNedPoint[] {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return sampleLine(points[0], points[1], options.sampleSpacingM);

  const prims = segmentIntoPrimitives(points, {
    fitToleranceM: options.fitToleranceM,
    minArcPoints: options.minArcPoints,
    maxArcRadiusM: options.maxArcRadiusM,
  });
  return tessellatePrimitivesWithJointFillets(points, prims, {
    sharpCornerDeg: options.sharpCornerDeg,
    filletRadiusFraction: options.filletRadiusFraction,
    maxFilletRadiusM: options.maxFilletRadiusM,
    sampleSpacingM: options.sampleSpacingM,
  });
}

/**
 * Full production pipeline:
 * open → spike reject → collinear simplify → segment (Hyper) → joint fillets → open.
 */
export function buildRoadMarkingPreviewPoints(
  points: RoadMarkingNedPoint[],
  options: RoadMarkingPathOptions = {}
): RoadMarkingNedPoint[] {
  const opts = { ...DEFAULTS, ...options };
  let pts = dedupeNearPoints(points, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) return pts;

  pts = rejectPathSpikes(
    pts,
    opts.fitToleranceM,
    opts.outlierPathChordRatio,
    opts.outlierResidualFactor
  );
  pts = ensureOpenPath(pts);

  // Collapse short opposite-turn weaves (S-jogs) that max-angle checks miss.
  pts = dampenOppositeJogs(pts, Math.max(opts.sharpCornerDeg * 0.65, 6), 3.5);
  pts = ensureOpenPath(pts);

  // Light simplify: keep structure for corners/curves; collapse dense straight GPS.
  pts = simplifyCollinear(pts, opts.fitToleranceM * 0.75);
  pts = dedupeNearPoints(pts, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) return pts;

  pts = segmentAndTessellate(pts, {
    fitToleranceM: opts.fitToleranceM,
    sampleSpacingM: opts.sampleSpacingM,
    minArcPoints: opts.minArcPoints,
    maxArcRadiusM: opts.maxArcRadiusM,
    sharpCornerDeg: opts.sharpCornerDeg,
    filletRadiusFraction: opts.filletRadiusFraction,
    maxFilletRadiusM: opts.maxFilletRadiusM,
  });
  pts = ensureOpenPath(pts);
  return pts;
}

/** Max |turning angle| along the path (degrees). 0 for <3 points. */
export function maxTurningAngleDeg(points: RoadMarkingNedPoint[]): number {
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    max = Math.max(max, Math.abs(turningAngleDeg(points[i - 1], points[i], points[i + 1])));
  }
  return max;
}

/**
 * Largest |turn_i| + |turn_{i+1}| where consecutive interior turns have opposite sign.
 * Catches S-shaped jogs that individually stay under a max-turn threshold.
 * Returns 0 when no opposite-sign pair exists (or path too short).
 */
export function maxOppositeTurnPairDeg(
  points: RoadMarkingNedPoint[],
  minTurnDeg = 3
): number {
  if (points.length < 4) return 0;
  const turns: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    turns.push(turningAngleDeg(points[i - 1], points[i], points[i + 1]));
  }
  let maxPair = 0;
  for (let i = 0; i < turns.length - 1; i++) {
    const a = turns[i];
    const b = turns[i + 1];
    if (Math.abs(a) < minTurnDeg || Math.abs(b) < minTurnDeg) continue;
    if (a * b < 0) {
      maxPair = Math.max(maxPair, Math.abs(a) + Math.abs(b));
    }
  }
  return maxPair;
}
