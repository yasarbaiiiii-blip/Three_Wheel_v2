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

// Not `as const`: callers and internal helpers pass runtime `number`s (adaptive
// tolerance, overrides). Literal types would make every option assignment fail tsc.
const DEFAULTS: Required<RoadMarkingPathOptions> = {
  fitToleranceM: 0.08,
  sharpCornerDeg: 12,
  filletRadiusFraction: 0.4,
  maxFilletRadiusM: 8,
  sampleSpacingM: 0.35,
  minArcPoints: 4,
  maxArcRadiusM: 5000,
  outlierPathChordRatio: 2.5,
  outlierResidualFactor: 8,
};

export type Circle = { cn: number; ce: number; r: number };

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

export type RoadMarkingGroupKey = string | number | undefined;

const JUMP_SPLIT_MIN_M = 5;
const JUMP_SPLIT_SPACING_MULTIPLE = 20;

function splitByGroupKey(
  points: RoadMarkingNedPoint[],
  groupKeys: RoadMarkingGroupKey[] | undefined
): RoadMarkingNedPoint[][] {
  if (!groupKeys) return [points.slice()];
  const groups: RoadMarkingNedPoint[][] = [];
  let cur: RoadMarkingNedPoint[] = [];
  let prevKey: RoadMarkingGroupKey;
  let started = false;
  for (let i = 0; i < points.length; i++) {
    const key = groupKeys[i];
    if (started && key !== prevKey) {
      groups.push(cur);
      cur = [];
    }
    cur.push(points[i]);
    prevKey = key;
    started = true;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/** Split wherever a jump is far larger than the group's own typical point spacing. */
function splitByJumpDistance(points: RoadMarkingNedPoint[]): RoadMarkingNedPoint[][] {
  if (points.length < 3) return [points];
  const diffs: number[] = [];
  for (let i = 1; i < points.length; i++) diffs.push(dist(points[i - 1], points[i]));
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0.5;
  const threshold = Math.max(JUMP_SPLIT_MIN_M, JUMP_SPLIT_SPACING_MULTIPLE * median);
  const groups: RoadMarkingNedPoint[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    if (dist(points[i - 1], points[i]) > threshold) groups.push([]);
    groups[groups.length - 1].push(points[i]);
  }
  return groups;
}

/**
 * Split a point sequence into independent open paths. Never reorders points — only splits
 * the existing sequence. Two signals decide a boundary, applied in order:
 *
 *  1. An explicit per-point group key (e.g. a CSV "feature"/"road" column, passed via
 *     `groupKeys`, same length/order as `points`) — any change in key starts a new group.
 *     Rows sharing a key are never bridged with rows from a different key, however close.
 *  2. Within each key-group (or across the whole sequence when no keys are given at all),
 *     a jump far larger than that group's own typical point spacing also starts a new
 *     group. This catches multiple unrelated features bundled in one CSV with no name
 *     column, and a real GPS dropout mid-survey — showing two separate paths with a gap is
 *     the safe failure mode, not a fabricated straight line bridging missing data.
 *
 * Known limitation: two genuinely unrelated paths that happen to end/start close together
 * (below the jump threshold) with no group key will still be bridged. A real name/feature
 * column always resolves this; there is no reliable way to detect it from geometry alone
 * without risking false splits on legitimate dense data.
 */
export function splitIntoOpenPathGroups(
  points: RoadMarkingNedPoint[],
  groupKeys?: RoadMarkingGroupKey[]
): RoadMarkingNedPoint[][] {
  if (points.length === 0) return [];
  const byKey = splitByGroupKey(points, groupKeys);
  const out: RoadMarkingNedPoint[][] = [];
  for (const group of byKey) {
    out.push(...splitByJumpDistance(group));
  }
  return out.filter((g) => g.length > 0);
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

const ADAPTIVE_TOLERANCE_MIN_M = 0.05;
const ADAPTIVE_TOLERANCE_MAX_M = 1.5;
const ADAPTIVE_TOLERANCE_MULTIPLE = 2.5;

/** 90th percentile of a sample set, or `fallback` when empty. */
function percentile90(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.9)] ?? fallback;
}

/** p90 of |offset of p[i] from the chord p[i-k] → p[i+k]| across the path. */
function chordResidualP90(points: RoadMarkingNedPoint[], k: number, fallback: number): number {
  const residuals: number[] = [];
  for (let i = k; i < points.length - k; i++) {
    residuals.push(pointLineResidual(points[i], points[i - k], points[i + k]));
  }
  return percentile90(residuals, fallback);
}

/**
 * Estimate this path's own measurement noise, so the fit tolerance adapts to the survey
 * instead of assuming one. Real files range from a few cm (RTK) to tens of cm (consumer /
 * vehicle GPS), and a single fixed tolerance either over-fragments clean data or fails to
 * fit noisy data at all.
 *
 * A chord residual mixes TWO things: measurement noise, and the real curvature of the path.
 * Measuring at one window size cannot tell them apart, and that is not a theoretical
 * concern — it silently destroyed geometry. The residual of a curve sampled every `d`
 * metres carries a sagitta of `d²/8R`, so on a SPARSE survey the residual is mostly
 * curvature: a 23 m roundabout shot with 40 points instead of 146 estimated its "noise" at
 * 0.41 m instead of 0.07 m, the segmenter then swallowed the whole ring into a couple of
 * primitives, and the preview rendered a 1.8 m stub of a 23 m circle with no warning.
 *
 * The two terms separate by how they SCALE with the window. Doubling the window leaves the
 * noise term unchanged (the chord-midpoint residual of white noise has variance 1.5σ²
 * regardless of k) while quadrupling the curvature term (sagitta ∝ chord²). So with
 *
 *     r₁ = noise + c,    r₂ = noise + 4c
 *
 * both are recoverable: `c = (r₂ - r₁)/3` and `noise = r₁ - c`. A straight or densely
 * sampled path has r₂ ≈ r₁, which yields c ≈ 0 and reproduces the old single-window
 * estimate — so this only changes files that were being mis-measured.
 */
export function estimateAdaptiveTolerance(points: RoadMarkingNedPoint[]): number {
  if (points.length < 3) return DEFAULTS.fitToleranceM;

  const r1 = chordResidualP90(points, 1, DEFAULTS.fitToleranceM);
  // Needs 5 points for a k=2 window. Below that, fall back to the single-window estimate:
  // too short to measure a scaling law, and too short to hide much curvature either.
  const r2 = points.length >= 5 ? chordResidualP90(points, 2, r1) : r1;

  // Curvature grows with the window, noise does not. A negative slope means no measurable
  // curvature at this scale, so attribute everything to noise.
  const curvature = Math.max(0, (r2 - r1) / 3);
  const noise = Math.max(0, r1 - curvature);

  return Math.min(
    ADAPTIVE_TOLERANCE_MAX_M,
    Math.max(ADAPTIVE_TOLERANCE_MIN_M, ADAPTIVE_TOLERANCE_MULTIPLE * noise)
  );
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

const WHOLE_LOOP_MIN_POINTS = 8;
const WHOLE_LOOP_GAP_MIN_M = 0.15;
const WHOLE_LOOP_GAP_FRACTION = 0.05;
/**
 * A loop cannot close tighter than its own sampling: shoot a ring every 0.3 m and the first
 * and last shot are ~0.3 m apart no matter how perfectly closed the real feature is. Judging
 * that gap against a fixed distance therefore rejects coarsely-surveyed loops for being
 * coarsely surveyed. Allowing one and a half sample steps keeps genuinely open paths out
 * (their ends are metres apart, not one step).
 */
const WHOLE_LOOP_GAP_SPACING_MULTIPLE = 1.5;

/**
 * Output-integrity check (see `coversSourceExtent`). A refined path must keep at least this
 * fraction of the surveyed extent on every axis longer than the floor. Deliberately loose:
 * legitimate refinement trims a few centimetres at the termini, catastrophic failure loses
 * most of the path, and there is nothing in between worth flagging here.
 */
const EXTENT_CHECK_MIN_RATIO = 0.9;
/** Axes shorter than this are ignored — a straight run has no extent across its width. */
const EXTENT_CHECK_MIN_AXIS_M = 0.5;

/**
 * Target ceiling on preview vertices for one path. Sits well above what any road-scale
 * survey produces at the default spacing (the 1.1 km College Road run lands near 4k), so it
 * only engages on surveys large enough for arc-length pacing to run away.
 *
 * A TARGET, not a hard bound: the spacing is derived from the surveyed chord polygon, which
 * underestimates the length of the arcs fitted through it (by ~0.1 % on a 40-point ring,
 * more on coarser input). Overshoot is a fraction of a percent — enough to bound the
 * pathological case, not enough to be worth an exact second pass.
 */
const PREVIEW_SAMPLE_TARGET = 8000;

/** Total length along a polyline, in metres. */
function polylineLengthM(points: RoadMarkingNedPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Median distance between consecutive points — this survey's own sampling step. */
function medianSpacing(points: RoadMarkingNedPoint[]): number {
  if (points.length < 2) return 0;
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) steps.push(dist(points[i - 1], points[i]));
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] ?? 0;
}

/**
 * How far a fitted primitive may sit from the surveyed points it replaces.
 *
 * This is a different quantity from the noise tolerance and must not be conflated with it.
 * The noise floor answers "how precisely was this measured"; this answers "how much paint
 * error is acceptable when we replace the operator's samples with a smooth primitive". The
 * rover draws the same distinction (`rms_m` vs `MAX_ARC_DEVIATION_M`) and picks the same
 * 15 cm, so the tablet and the rover agree on what is fittable.
 *
 * Concretely: a surveyed roundabout is never a perfect circle. The real Egmore rings sit
 * ~11-13 cm off their best-fit circle — well beyond RTK noise, but well inside the paint
 * budget. Judging them against the noise floor rejected the circle and shattered the ring
 * into faceted arcs; judging them against this budget keeps them round.
 */
const MAX_FIT_DEVIATION_M = 0.15;

/**
 * Fast path for a near-closed loop (roundabout, small track): fit ONE circle to the whole
 * group instead of letting the greedy segmenter piece it together from many short arcs
 * that each only locally pass tolerance — a real closed loop can fragment into a dozen
 * tiny arcs even though a single circle fits the whole thing comfortably.
 *
 * Accepted when every point sits within the larger of the survey's own noise floor and the
 * fit-deviation budget, so a genuinely non-circular closed shape (an oval, an irregular
 * boundary) still falls through to normal segmentation instead of being forced into a wrong
 * circle. Comparing a MAX over every point against a PER-POINT noise floor — as this used
 * to — is an apples-to-oranges test that gets stricter the more points a loop has, which is
 * backwards.
 */
export function tryWholeLoopFit(points: RoadMarkingNedPoint[], tol: number): Circle | null {
  if (points.length < WHOLE_LOOP_MIN_POINTS) return null;
  let centerNorth = 0;
  let centerEast = 0;
  for (const p of points) {
    centerNorth += p.north;
    centerEast += p.east;
  }
  centerNorth /= points.length;
  centerEast /= points.length;
  let roughRadius = 0;
  for (const p of points) {
    roughRadius = Math.max(roughRadius, Math.hypot(p.north - centerNorth, p.east - centerEast));
  }
  const gap = dist(points[0], points[points.length - 1]);
  const gapLimit = Math.max(
    WHOLE_LOOP_GAP_MIN_M,
    WHOLE_LOOP_GAP_FRACTION * roughRadius,
    WHOLE_LOOP_GAP_SPACING_MULTIPLE * medianSpacing(points)
  );
  if (gap > gapLimit) return null;

  const fit = fitCircleHyper(points);
  if (!fit) return null;
  if (maxCircleResidual(points, fit) > Math.max(tol, MAX_FIT_DEVIATION_M)) return null;
  return fit;
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

/**
 * Cap on the angle a single tessellated sample step may subtend, independent of
 * `sampleSpacingM`'s fixed arc-length pacing. Arc-length-only spacing is radius-blind: a
 * large-radius arc (e.g. an ~11.5 m roundabout) lands well under 2° per step "for free," but
 * a tight-radius real road curve (a few metres — typical for a street curve/intersection)
 * lands 8-11° per step at the same spacing — visually a series of straight facets ("minor
 * edges"), not a smooth curve, even though the underlying primitive is a single perfect
 * circle. ~3° matches the smoothness large-radius arcs already get for free.
 */
const MAX_ARC_SAMPLE_ANGLE_RAD = (3 * Math.PI) / 180;

/**
 * Floor for "is this joint worth a fillet at all," independent of `sharpCornerDeg` (see
 * `tessellatePrimitivesWithJointFillets`). ~3° matches MAX_ARC_SAMPLE_ANGLE_RAD — turns
 * below this are the same order of magnitude as a single arc-sampling step, i.e. genuinely
 * imperceptible; turns at or above it read as a visible kink if left as a bare vertex.
 */
const MIN_VISIBLE_TURN_DEG = 3;

/** Minimum tangent offset for a joint fillet — see the flooring logic in
 * `tessellatePrimitivesWithJointFillets`: a visible turn is floored up to this instead of
 * being skipped when the geometrically-derived offset lands marginally below it. */
const MIN_FILLET_OFFSET_M = 0.02;

function sampleArc(
  c: Circle,
  a0: number,
  a1: number,
  spacingM: number
): RoadMarkingNedPoint[] {
  const sweep = a1 - a0;
  const arcLen = Math.abs(sweep) * c.r;
  const stepsFromSpacing = Math.ceil(arcLen / Math.max(spacingM, 0.05));
  const stepsFromAngle = Math.ceil(Math.abs(sweep) / MAX_ARC_SAMPLE_ANGLE_RAD);
  const steps = Math.max(2, stepsFromSpacing, stepsFromAngle);
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

/**
 * Split-and-merge cleanup: collapse adjacent same-kind primitives when their union still
 * fits within tolerance. The greedy left-to-right pass in `segmentIntoPrimitives` can
 * fragment one true arc (or one true straight run) into several neighbors whenever a local
 * window's residual transiently exceeds tolerance partway through — merging repairs that
 * without re-flattening real corners (only same-kind neighbors are ever candidates).
 *
 * Line-line merges use the same strict residual check `segmentIntoPrimitives` itself uses
 * for line classification (`fitsLine`) — NOT `fitLineOrCircle`'s "line" return value, which
 * is also its defensive fallback whenever a circle fit fails to satisfy tolerance. Trusting
 * that fallback here would merge two lines straight across a real corner between them.
 */
export function mergeAdjacentPrimitives(
  points: RoadMarkingNedPoint[],
  prims: PathPrimitive[],
  tol: number,
  minArcPoints: number,
  maxArcRadiusM: number
): PathPrimitive[] {
  let cur = prims.slice();
  let changed = true;
  let guard = 0;
  while (changed && cur.length > 1 && guard++ < prims.length + 5) {
    changed = false;
    const next: PathPrimitive[] = [];
    let i = 0;
    while (i < cur.length) {
      if (i < cur.length - 1 && cur[i].kind === cur[i + 1].kind) {
        const union = points.slice(cur[i].i0, cur[i + 1].i1 + 1);
        let merged: PathPrimitive | null = null;
        if (cur[i].kind === "line") {
          if (fitsLine(union, tol)) {
            merged = { kind: "line", i0: cur[i].i0, i1: cur[i + 1].i1 };
          }
        } else {
          const fit = fitLineOrCircle(union, tol, minArcPoints, maxArcRadiusM);
          if (fit.kind === "circle") {
            merged = { kind: "arc", i0: cur[i].i0, i1: cur[i + 1].i1, circle: fit.circle };
          }
        }
        if (merged) {
          next.push(merged);
          i += 2;
          changed = true;
          continue;
        }
      }
      next.push(cur[i]);
      i++;
    }
    cur = next;
  }
  return cur;
}

/**
 * Reclassify an 'arc' primitive as 'line' when its own sagitta (max deviation from the
 * straight chord between its endpoints, chord²/8r) is already within tolerance — i.e. a
 * straight line between its endpoints represents it just as well, so calling it an arc adds
 * a misleading (often very large, e.g. hundreds of metres) radius for no visual benefit.
 *
 * This targets a specific failure mode of the greedy window growth in
 * `segmentIntoPrimitives`: `fitLineOrCircle`'s straight-chord residual check compares every
 * point to the chord between the CURRENT window's two endpoints. When that window boundary
 * lands mid-transition (partway into a real corner rather than fully past it), points on
 * the straight portion can read as deviating from that particular chord even though the
 * data before the corner is genuinely straight — and a large-radius circle then satisfies
 * tolerance too, winning by virtue of its extra degree of freedom, not real curvature.
 *
 * Never reclassifies a genuinely visible curve: a real arc's sagitta exceeds tolerance by
 * construction (that is why a straight line could not already represent it).
 */
export function dropNegligibleArcs(
  points: RoadMarkingNedPoint[],
  prims: PathPrimitive[],
  tol: number
): PathPrimitive[] {
  return prims.map((p) => {
    if (p.kind !== "arc") return p;
    const chord = dist(points[p.i0], points[p.i1]);
    if (chord < 1e-6) return p;
    const sagitta = (chord * chord) / (8 * p.circle.r);
    if (sagitta <= tol) return { kind: "line", i0: p.i0, i1: p.i1 };
    return p;
  });
}

function primitiveNeighborTurnDeg(
  points: RoadMarkingNedPoint[],
  a: PathPrimitive,
  b: PathPrimitive
): number | null {
  const uIn = tangentInAtEnd(points, a);
  const uOut = tangentOutAtStart(points, b);
  if (!uIn || !uOut) return null;
  const cross = uIn.north * uOut.east - uIn.east * uOut.north;
  const dot = uIn.north * uOut.north + uIn.east * uOut.east;
  return Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
}

/**
 * Reclassify a short 'arc' primitive to 'line' when BOTH its neighbors turn sharply away
 * from it — i.e. it is really just the corner transition between two other runs, not a
 * genuine road-scale curve feature. A genuine curve has smooth tangent continuity at its
 * own boundaries by construction (that continuity is what made it classify as one arc), so
 * this only ever fires on a short arc "spike" flanked by real corners on both sides.
 *
 * Two independent joint fillets straddling that short arc each compute their trim budget
 * from the arc's FULL length without knowing the sibling joint on the other end also
 * claims a share of it — for a short, tightly-sandwiched arc this can produce conflicting
 * trims and a mis-parameterized (even backtracking) tessellated sample. Collapsing it to
 * one line lets the existing single-joint fillet mechanism round the whole transition in
 * one already-well-tested pass instead.
 */
export function absorbSandwichedCornerArcs(
  points: RoadMarkingNedPoint[],
  prims: PathPrimitive[],
  sharpCornerDeg: number
): PathPrimitive[] {
  if (prims.length < 3) return prims;
  return prims.map((p, idx) => {
    if (p.kind !== "arc" || idx === 0 || idx === prims.length - 1) return p;
    const turnIn = primitiveNeighborTurnDeg(points, prims[idx - 1], p);
    const turnOut = primitiveNeighborTurnDeg(points, p, prims[idx + 1]);
    if (turnIn == null || turnOut == null) return p;
    if (turnIn < sharpCornerDeg || turnOut < sharpCornerDeg) return p;
    return { kind: "line", i0: p.i0, i1: p.i1 };
  });
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

/** Samples over which a forced arc-boundary correction is tapered — see `blendArcBoundary`. */
const BOUNDARY_BLEND_SAMPLES = 3;

/**
 * Final near-duplicate-point dedupe threshold for the tessellated preview. Must stay well
 * below the finest sample spacing MAX_ARC_SAMPLE_ANGLE_RAD legitimately produces for a
 * small-radius fillet (e.g. a 0.2 m-radius fillet's 3°-capped samples land ~1 cm apart) — the
 * previous 0.015 m (1.5 cm) threshold sat right in that range and silently discarded roughly
 * every other sample from exactly these small fillets, undoing the angular-resolution fix and
 * leaving an uneven, visibly kinked result at tight corners (confirmed against the real
 * roads_coordinates.csv fixture). 3 mm is comfortably below any intentional fine sampling
 * this module produces, while still collapsing genuine floating-point-precision duplicates.
 */
const TESSELLATION_DEDUPE_M = 0.003;

/**
 * Nudge `samples[endIdx]` to exactly `target`, tapering a fraction of that same
 * correction into the `BOUNDARY_BLEND_SAMPLES - 1` samples walking inward from it (full
 * correction at `endIdx`, decreasing to zero by the edge of the blend window). Spreads a
 * forced position correction (fitted-circle reconstruction vs. the exact point a neighbor
 * uses for the same joint) across several segments instead of dumping it into one.
 */
function blendArcBoundary(
  samples: RoadMarkingNedPoint[],
  endIdx: number,
  target: RoadMarkingNedPoint
): void {
  const step = endIdx === 0 ? 1 : -1;
  const maxReach = Math.floor((samples.length - 1) / 2);
  const blendN = Math.max(1, Math.min(BOUNDARY_BLEND_SAMPLES, maxReach));
  const dn = target.north - samples[endIdx].north;
  const de = target.east - samples[endIdx].east;
  for (let k = 0; k < blendN; k++) {
    const idx = endIdx + k * step;
    const w = 1 - k / blendN;
    samples[idx] = {
      north: samples[idx].north + dn * w,
      east: samples[idx].east + de * w,
    };
  }
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
  > &
    // Optional: enables the data-aware fillet radius below (a line-line joint prefers a
    // radius the raw points actually support over the pure tangent/segment-length
    // heuristic). Omitting these keeps the original heuristic-only behavior.
    Partial<Pick<typeof DEFAULTS, "minArcPoints" | "fitToleranceM">>
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
    // Gate on whichever is smaller: the caller's configured sharpCornerDeg, or
    // MIN_VISIBLE_TURN_DEG. `sharpCornerDeg` alone (12° default) leaves plenty of
    // genuinely visible joints unrounded: a real, gentle road bend routinely segments into
    // several short line primitives each turning less than 12° (the arc-fit heuristic
    // deliberately prefers "line" over a fragile short/shallow-sweep arc — see
    // fitLineOrCircle) — every one of those sub-12° joints was a bare, unfilleted vertex, so
    // a chain of them reads as a series of small "minor edges" even though each individual
    // turn looks negligible in isolation. Confirmed against the real roads_coordinates.csv
    // fixture: an ~11° joint stayed a bare kink even after the arc-sampling fix (which only
    // helps a joint's SAMPLING density, not whether a joint gets rounded at all). A caller
    // that explicitly configures a SMALLER sharpCornerDeg (more aggressive smoothing) is
    // still honored via the min().
    if (turn < Math.min(options.sharpCornerDeg, MIN_VISIBLE_TURN_DEG)) {
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

    // Data-aware radius: when neither neighbor is already a fitted arc, prefer a corner
    // radius the raw survey points actually support over the pure tangent/segment-length
    // heuristic above, which has no relationship to the real curvature and can visibly
    // pull the path away from where the source data placed the corner. Only ever shrinks
    // r (never grows it), so this can only make the fillet MORE faithful to the data, never
    // less conservative than the existing heuristic.
    if (
      prev.kind === "line" &&
      next.kind === "line" &&
      options.minArcPoints != null &&
      options.fitToleranceM != null
    ) {
      const jointIdx = prev.i1;
      const windowStart = Math.max(0, jointIdx - options.minArcPoints);
      const windowEnd = Math.min(points.length - 1, jointIdx + options.minArcPoints);
      if (windowEnd - windowStart + 1 >= options.minArcPoints * 2) {
        const window = points.slice(windowStart, windowEnd + 1);
        const localFit = fitCircleHyper(window);
        if (
          localFit &&
          localFit.r >= 0.05 &&
          localFit.r < r &&
          maxCircleResidual(window, localFit) <= options.fitToleranceM
        ) {
          r = localFit.r;
        }
      }
    }

    const turnRad = (turn * Math.PI) / 180;
    let offset = r * Math.tan(turnRad / 2);
    if (offset > budget && turnRad > 1e-6) {
      r = budget / Math.tan(turnRad / 2);
      offset = budget;
    }
    // A joint that already cleared the MIN_VISIBLE_TURN_DEG gate above is a genuinely visible
    // turn — never leave it completely unrounded just because the geometrically-derived
    // offset happens to land marginally under MIN_FILLET_OFFSET_M (a tight per-joint budget,
    // or a data-aware radius fit across a real corner rather than real curvature, both push r
    // — and so offset — down). Floor the offset up to the minimum instead of skipping,
    // as long as it still fits the budget; only a truly degenerate turn or an
    // impossibly-tight budget still falls through to skip.
    if (turnRad > 1e-6 && offset < MIN_FILLET_OFFSET_M && MIN_FILLET_OFFSET_M <= budget) {
      offset = MIN_FILLET_OFFSET_M;
      r = offset / Math.tan(turnRad / 2);
    }
    if (r < 0.05 || offset < MIN_FILLET_OFFSET_M) {
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
      if (out.length > 0 && dist(out[out.length - 1], p) < TESSELLATION_DEDUPE_M) continue;
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
        const arcSamples = sampleArc(prim.circle, aa, ab, options.sampleSpacingM);
        // Anchor a boundary to `start`/`end` (the raw survey vertex, or the fillet's own
        // tangent point) ONLY when a neighboring primitive/fillet shares that same
        // boundary — i.e. never at i===0's start or the last primitive's end, which are
        // termini of the whole open path with nothing to match, where the fitted circle's
        // own smooth angle+radius reconstruction is preferred. At a genuine internal
        // joint, the Hyper fit only approximates the data (residual up to fitToleranceM),
        // so that reconstruction can land a few cm sideways of the exact point the
        // neighboring primitive/fillet uses for the SAME joint — a hard single-sample
        // snap there would fix the position gap but dump the whole correction into one
        // segment, still reading as a small kink (confirmed on the real roads_coordinates
        // fixture: a snap-only version left a 5-10° kink at exactly this seam). Instead
        // taper the correction across `BOUNDARY_BLEND_SAMPLES` samples, so no single
        // segment absorbs more than a fraction of the fit residual. Samples beyond the
        // blend window keep the pure fitted-circle interpolation.
        if (i > 0) blendArcBoundary(arcSamples, 0, start);
        if (i < prims.length - 1) blendArcBoundary(arcSamples, arcSamples.length - 1, end);
        pushSamples(arcSamples);
      }
    }

    if (filletOut) {
      pushSamples(filletOut.samples);
    }
  }

  if (out.length < 2) return points.slice();
  return dedupeNearPoints(out, TESSELLATION_DEDUPE_M);
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

  let prims = segmentIntoPrimitives(points, {
    fitToleranceM: options.fitToleranceM,
    minArcPoints: options.minArcPoints,
    maxArcRadiusM: options.maxArcRadiusM,
  });
  // Repair fragmentation from the greedy left-to-right pass (one true arc/line split into
  // several neighbors because a local window transiently missed tolerance partway through).
  prims = mergeAdjacentPrimitives(points, prims, options.fitToleranceM, options.minArcPoints, options.maxArcRadiusM);
  // Undo large-radius false-arc artifacts from window boundaries landing mid-transition,
  // then merge once more — a reclassified line can now legitimately join a straight
  // neighbor it couldn't join as an arc.
  prims = dropNegligibleArcs(points, prims, options.fitToleranceM);
  prims = mergeAdjacentPrimitives(points, prims, options.fitToleranceM, options.minArcPoints, options.maxArcRadiusM);
  // Undo short arcs sandwiched between two real corners (conflicting joint-fillet trims);
  // merge once more in case that also opens up a new same-kind neighbor merge.
  prims = absorbSandwichedCornerArcs(points, prims, options.sharpCornerDeg);
  prims = mergeAdjacentPrimitives(points, prims, options.fitToleranceM, options.minArcPoints, options.maxArcRadiusM);
  return tessellatePrimitivesWithJointFillets(points, prims, {
    sharpCornerDeg: options.sharpCornerDeg,
    filletRadiusFraction: options.filletRadiusFraction,
    maxFilletRadiusM: options.maxFilletRadiusM,
    sampleSpacingM: options.sampleSpacingM,
    minArcPoints: options.minArcPoints,
    fitToleranceM: options.fitToleranceM,
  });
}

/**
 * Full production pipeline:
 * open → spike reject → S-jog dampen → [whole-loop fit | segment (Hyper) + merge] →
 * joint fillets → open.
 */
export function buildRoadMarkingPreviewPoints(
  points: RoadMarkingNedPoint[],
  options: RoadMarkingPathOptions = {}
): RoadMarkingNedPoint[] {
  const opts = { ...DEFAULTS, ...options };
  let pts = dedupeNearPoints(points, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) return pts;

  // Derive tolerance from this path's own measured noise unless the caller pinned one
  // explicitly. A single fixed tolerance either over-fragments clean/dense data or fails
  // to fit noisier real GPS survey data at all (see docs/csv-road-marking-workflow.md).
  const fitToleranceM = options.fitToleranceM ?? estimateAdaptiveTolerance(pts);

  pts = rejectPathSpikes(pts, fitToleranceM, opts.outlierPathChordRatio, opts.outlierResidualFactor);
  pts = ensureOpenPath(pts);

  // Collapse short opposite-turn weaves (S-jogs) that max-angle checks miss.
  pts = dampenOppositeJogs(pts, Math.max(opts.sharpCornerDeg * 0.65, 6), 3.5);
  pts = dedupeNearPoints(pts, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) return pts;

  // NOTE: a Douglas-Peucker-style collinear simplify used to run here before
  // classification. It deleted the point density segmentIntoPrimitives needs to satisfy
  // minArcPoints, so real curves collapsed into a raw jagged polyline of trivial 2-point
  // line primitives instead of being recognized as arcs — segmentIntoPrimitives already
  // performs the equivalent simplification as a side effect of correct classification, so
  // a second blind decimation pass ahead of it only starves it of support (see
  // docs/csv-road-marking-workflow.md).

  // Whole-path single-circle fast path for a near-closed loop (roundabout, small track):
  // avoids fragmenting one true circle into many short arcs. Falls through to normal
  // segmentation for anything that isn't actually close to one circle.
  const source = pts;

  // Sampling is paced by arc length, so output size grows with the SIZE of the survey, not
  // its complexity: a 40-point ring of 1 km radius asks for ~18k preview vertices — one map
  // line heavy enough to hurt a tablet, for no visible gain at that scale. Stretch the
  // spacing just enough to stay under the cap. Road-scale files never reach it and are
  // byte-for-byte unchanged; the per-step angular cap still governs how round curves look.
  const sourceLengthM = polylineLengthM(pts);
  const sampleSpacingM = Math.max(opts.sampleSpacingM, sourceLengthM / PREVIEW_SAMPLE_TARGET);

  const loopFit = tryWholeLoopFit(pts, fitToleranceM);
  if (loopFit) {
    pts = tessellatePrimitivesWithJointFillets(
      pts,
      [{ kind: "arc", i0: 0, i1: pts.length - 1, circle: loopFit }],
      {
        sharpCornerDeg: opts.sharpCornerDeg,
        filletRadiusFraction: opts.filletRadiusFraction,
        maxFilletRadiusM: opts.maxFilletRadiusM,
        sampleSpacingM,
        minArcPoints: opts.minArcPoints,
        fitToleranceM,
      }
    );
  } else {
    pts = segmentAndTessellate(pts, {
      fitToleranceM,
      sampleSpacingM,
      minArcPoints: opts.minArcPoints,
      maxArcRadiusM: opts.maxArcRadiusM,
      sharpCornerDeg: opts.sharpCornerDeg,
      filletRadiusFraction: opts.filletRadiusFraction,
      maxFilletRadiusM: opts.maxFilletRadiusM,
    });
  }
  pts = ensureOpenPath(pts);

  // Last line of defence: never hand back a refinement that lost the path.
  //
  // Refinement is an approximation pipeline with several stages that can each, on some
  // unforeseen input, decide the whole path is one degenerate primitive. When that happened
  // it happened SILENTLY — a 23 m surveyed roundabout rendered as a 1.8 m stub, with no
  // error and no warning, which is the worst way for geometry to fail. The individual causes
  // are fixed, but the class is not closable by fixing causes one at a time, so verify the
  // OUTPUT against the input it claims to represent and fall back to the raw surveyed
  // polyline when it does not cover it. A raw jagged path is a visibly worse preview; a
  // silently truncated one is a wrong mission.
  if (!coversSourceExtent(source, pts)) return source;
  return pts;
}

/**
 * Does `refined` still span the same ground as `source`?
 *
 * Compared on bounding-box extent per axis rather than point count or length: a refinement
 * legitimately changes both (an arc replaces its chords, fillets add samples), but it can
 * never legitimately shrink the ground the path covers. The tolerance is generous — this is
 * a catastrophe detector, not a quality gate — and axes shorter than the fit tolerance are
 * skipped, since a straight run has no meaningful extent across its own width.
 */
function coversSourceExtent(
  source: RoadMarkingNedPoint[],
  refined: RoadMarkingNedPoint[]
): boolean {
  if (source.length < 2) return true;
  if (refined.length < 2) return false;

  const extent = (pts: RoadMarkingNedPoint[]) => {
    let minN = Infinity;
    let maxN = -Infinity;
    let minE = Infinity;
    let maxE = -Infinity;
    for (const p of pts) {
      if (p.north < minN) minN = p.north;
      if (p.north > maxN) maxN = p.north;
      if (p.east < minE) minE = p.east;
      if (p.east > maxE) maxE = p.east;
    }
    return { n: maxN - minN, e: maxE - minE };
  };

  const src = extent(source);
  const ref = extent(refined);
  const floor = Math.max(EXTENT_CHECK_MIN_AXIS_M, 0);
  const axisOk = (s: number, r: number) => s <= floor || r >= s * EXTENT_CHECK_MIN_RATIO;
  return axisOk(src.n, ref.n) && axisOk(src.e, ref.e);
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
