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
  /**
   * The survey's own reported horizontal precision (m) — GNSS HRMS / Lateral RMS from an RTK
   * receiver, one figure per group. Scales the sparse-arc residual gate (see
   * {@link sparseArcResidualGateM}); null/omitted falls back to a fixed default, so files with
   * no quality column behave exactly as before this option existed.
   */
  surveyRmsM?: number | null;
};

// Not `as const`: callers and internal helpers pass runtime `number`s (adaptive
// tolerance, overrides). Literal types would make every option assignment fail tsc.
const DEFAULTS: Required<RoadMarkingPathOptions> = {
  fitToleranceM: 0.08,
  sharpCornerDeg: 12,
  filletRadiusFraction: 0.4,
  /**
   * Sanity bound on a fillet radius — deliberately NOT a policy knob.
   *
   * The two ceilings that encode real policy are the paint budget (how much corner cut we may
   * spend) and the leg budget (fillets must not overlap). This cap existed at 8 m, which is
   * below both of them for any turn under ~22°, so on a gently-curving path IT became the
   * binding constraint: a surveyed curve of radius 26.8 m was filleted at 8 m, bending 3.4×
   * too tight for 1.4 m and then running dead straight for 3.27 m between vertices. Eight of
   * those in a row is the faceting operators reported as "shake".
   *
   * Raised to a value above any fillet the paint budget would actually allow, so policy comes
   * from the paint and leg budgets again. Verified over turn 3–179° × legs {0.5,1,2,5,20}: the
   * worst in-budget corner cut is 0.1500 m against the 0.15 m budget, never above, and every
   * turn ≥ 20° is bit-identical to the old value — squares and zig-zags do not move.
   */
  maxFilletRadiusM: 40,
  sampleSpacingM: 0.35,
  minArcPoints: 4,
  maxArcRadiusM: 5000,
  outlierPathChordRatio: 2.5,
  outlierResidualFactor: 8,
  surveyRmsM: null,
};

/**
 * Production geometry policy (CSV road-marking).
 *
 * R_MIN_ROVER_M: kinematic floor for fillet arcs. Conservative default for a
 * three-wheel paint platform; override via RoadMarkingPathOptions later if needed.
 * CORNER_TOLERANCE_M: max acceptable corner cut (paint budget) — matches MAX_FIT_DEVIATION_M.
 */
export const R_MIN_ROVER_M = 0.5;
export const CORNER_TOLERANCE_M = 0.15;
/**
 * Max paint error (m) we may spend replacing operator stakes with clean primitives.
 * Single policy constant for dense deviation, corner cut, and flat-arc bow flatten.
 */
export const PAINT_ERROR_BUDGET_M = 0.15;
/** Classify as sparse waypoints when point count is at or below this. */
export const SPARSE_MAX_POINTS = 15;
/** Classify as dense only when point count is at least this. */
export const DENSE_MIN_POINTS = 20;
export const SPARSE_MIN_MEDIAN_SPACING_M = 2.0;
export const DENSE_MAX_MEDIAN_SPACING_M = 1.5;
/** P1 operator bound: max bare turning angle on tessellated samples (deg). */
export const MAX_BARE_TURN_DEG = 8;
/** Hard reversal guard (deg). */
export const MAX_INTERIOR_TURN_DEG = 120;

/**
 * Sparse arc-run gates — when a sparse point list may be read as ONE surveyed curve rather
 * than a chain of design vertices.
 *
 * Filleting bends AT a vertex, so its error is a corner cut of r·(sec(θ/2) − 1) and the paint
 * budget caps how smooth it can ever be. Fitting an arc THROUGH the points has no corner to
 * cut: on the reported 10-point curve the fitted arc sits 0.007 m from the operator's points
 * where the fillet path sits 0.031 m. The smooth answer is the more accurate one — but only
 * when the points really are samples of an arc, which is what these gates establish.
 *
 * Which gate stops what — measured, because the intuitive answer is wrong twice over:
 *
 *  - {@link SPARSE_ARC_CORNER_TURN_DEG} is the ONLY thing that saves a square, and nothing else
 *    can. The four corners of a square lie exactly on their circumcircle: residual zero,
 *    deviation from the source points zero, angular progression perfectly monotone. Every other
 *    test waves a square through. A vertex that turns this hard is a corner, full stop.
 *  - {@link SPARSE_ARC_MAX_RESIDUAL_M} is what stops a zig-zag. Measured over 9-point zig-zags:
 *    residual 0.70 m at 45° turns, 0.47 m at 30°, 0.24 m at 15°, 0.13 m at 8° — all far outside
 *    the 0.05 m gate. It is deliberately much tighter than the 0.15 m paint budget: a genuine
 *    surveyed curve fits to centimetres, so there is no reason to spend paint error buying a fit.
 *  - {@link isMonotoneAngularProgression} does NOT stop zig-zags, contrary to the obvious guess —
 *    a zig-zag advancing along a corridor sweeps monotonically about its own distant best-fit
 *    centre, and it passed this gate in every case measured. It is kept as a cheap guard on
 *    traversal ORDER (retraced or out-and-back arcs, where position-based gates see nothing
 *    wrong), which is the one thing the other two do not look at.
 *
 * The resulting invariant, and the thing to assert in tests: an accepted arc never sits more
 * than {@link SPARSE_ARC_MAX_RESIDUAL_M} from any point the operator surveyed. Anything that
 * would need a point moved further than that is rejected and left to
 * {@link buildWaypointFilletPath} unchanged, so the blast radius of this feature is bounded by
 * the gates.
 *
 * Known and accepted: an alternating wiggle small enough to fit inside the residual gate IS
 * smoothed. Measured on 9-point zig-zags with 1 m legs, under the endpoint-constrained fit:
 * 8° turns give residual 0.050 m and are preserved, 5° give 0.031 m and are smoothed. That
 * boundary lands at roughly a 2 cm alternation, which is RTK noise on a line painted ~10 cm
 * wide — not a zig-zag anyone specified. Smoothing it is noise removal, bounded by the same
 * 5 cm invariant as everything else.
 */
export const SPARSE_ARC_CORNER_TURN_DEG = 30;
/** Three points always define a circle exactly, so three carry no evidence of one. */
export const SPARSE_ARC_MIN_POINTS = 4;
/**
 * Max |distance-to-centre − r| over the source points for the fit to be believed (m) — used
 * as-is when the survey reports no precision figure. When it does, {@link sparseArcResidualGateM}
 * scales this per file instead; see that function for why a single fixed number is knife's-edge
 * for real RTK data.
 */
export const SPARSE_ARC_MAX_RESIDUAL_M = 0.05;
/** Multiplier on the survey's own reported horizontal RMS — see {@link sparseArcResidualGateM}. */
export const SPARSE_ARC_RESIDUAL_RMS_MULTIPLE = 4;
/** Sanity floor so a broken/zero RMS reading cannot collapse the gate toward nothing. */
export const SPARSE_ARC_RESIDUAL_FLOOR_M = 0.02;

/**
 * Residual gate for {@link trySparseArcFit}, scaled to what the survey itself reports.
 *
 * The fixed {@link SPARSE_ARC_MAX_RESIDUAL_M} is knife's-edge for real RTK surveys. Measured
 * on an operator-reported case (curve_6_points.csv, Lateral RMS 1.6–1.8 cm): its own best-fit
 * circle sits at 3.4 cm unconstrained / 5.18 cm endpoint-constrained — genuinely one smooth
 * curve by any reasonable reading — rejected by 1.8 mm under the fixed gate. Falling through to
 * per-vertex fillets is the worst place for that near-miss to land: fillet radius is derived
 * from local turn angle, a second difference of noisy position, so it amplifies exactly the GPS
 * noise the arc fit was rejected over. On this file the implied per-vertex radius swung
 * 1.48 m → 4.90 m → 1.48 m across three consecutive points whose true curve is a near-constant
 * ~2.4 m — that oscillation is the reported "jiggle".
 *
 *   gate = clamp(K · reportedRmsM, FLOOR, CORNER_TOLERANCE_M)
 *
 * K ({@link SPARSE_ARC_RESIDUAL_RMS_MULTIPLE}) covers the MAX, not the mean, of several noisy
 * points: the expected max of N draws of 2-D Gaussian position error (a Rayleigh-distributed
 * magnitude) grows like σ·√(2·ln N) — ≈2.0σ at N=8 — plus margin, since the fitted circle is
 * itself only an approximation of the true curve. FLOOR keeps a broken/zero RMS column from
 * collapsing the gate to nothing. The ceiling is {@link CORNER_TOLERANCE_M}: RMS-derived
 * confidence may loosen the gate, but never past the same "paint error we are willing to spend
 * replacing the operator's points" budget the dense pipeline is already judged against
 * ({@link MAX_FIT_DEVIATION_M}'s sibling constant) — so a badly noisy survey can relax the gate
 * only as far as policy already allows elsewhere, never further.
 *
 * No reported RMS (plain NED CSV, synthetic data, existing unit tests) ⇒
 * {@link SPARSE_ARC_MAX_RESIDUAL_M} unchanged — this is purely additive for files that carry a
 * quality column to scale from.
 */
export function sparseArcResidualGateM(surveyRmsM?: number | null): number {
  if (surveyRmsM == null || !Number.isFinite(surveyRmsM) || surveyRmsM <= 0) {
    return SPARSE_ARC_MAX_RESIDUAL_M;
  }
  const scaled = SPARSE_ARC_RESIDUAL_RMS_MULTIPLE * surveyRmsM;
  return Math.min(CORNER_TOLERANCE_M, Math.max(SPARSE_ARC_RESIDUAL_FLOOR_M, scaled));
}

export type PointSequenceClass = "dense-survey" | "sparse-waypoints";

export type CornerClass = "clean" | "tight" | "sharp" | "reversal";

/**
 * Classified interior corner on a source polyline (Track C).
 * `radiusM` / `cutM` come from {@link waypointCornerRadiusM} when a geometric
 * fillet is possible; null when the turn is a hard reversal or unfittable.
 */
export type SourceCorner = {
  atIndex: number;
  turnDeg: number;
  class: CornerClass;
  /** Selected fillet radius (m), or null when no fillet. */
  radiusM: number | null;
  /** Corner cut / miss distance (m), or null when no fillet. */
  cutM: number | null;
  overBudget: boolean;
  undrivable: boolean;
  /** Source vertex NED (for trajectory split / lifecycle matching). */
  north: number;
  east: number;
};

export type FittedPathResult = {
  samples: RoadMarkingNedPoint[];
  mode: "dense-fit" | "waypoint-fillet" | "degraded-fillet" | "sparse-arc";
  warnings: string[];
  /** False when geometry cannot be made paintable (e.g. undrivable corners, validation fail). */
  paintable: boolean;
  quality: {
    class: PointSequenceClass;
    toleranceM: number;
    maxJointTurnDeg: number;
    lengthRatio: number;
    maxSourceDeviationM: number;
    /** Interior corners classified on the source polyline (Track C). */
    corners?: SourceCorner[];
  };
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
export function polylineLengthM(points: RoadMarkingNedPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Median distance between consecutive points — this survey's own sampling step. */
export function medianSpacing(points: RoadMarkingNedPoint[]): number {
  if (points.length < 2) return 0;
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) steps.push(dist(points[i - 1], points[i]));
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] ?? 0;
}

/** Axis-aligned path extent (max of north/east spans), metres. */
export function pathExtentM(points: RoadMarkingNedPoint[]): number {
  if (points.length === 0) return 0;
  let minN = Infinity;
  let maxN = -Infinity;
  let minE = Infinity;
  let maxE = -Infinity;
  for (const p of points) {
    if (p.north < minN) minN = p.north;
    if (p.north > maxN) maxN = p.north;
    if (p.east < minE) minE = p.east;
    if (p.east > maxE) maxE = p.east;
  }
  return Math.max(maxN - minN, maxE - minE);
}

/**
 * Classify survey density before refining.
 * Ambiguous files default to sparse-waypoints (preserves design vertices).
 */
export function classifyPointSequence(
  points: RoadMarkingNedPoint[]
): { class: PointSequenceClass; warning?: string } {
  const n = points.length;
  if (n < 3) return { class: "sparse-waypoints" };
  const med = medianSpacing(points);
  const extent = pathExtentM(points);

  if (n <= SPARSE_MAX_POINTS || med >= SPARSE_MIN_MEDIAN_SPACING_M) {
    return { class: "sparse-waypoints" };
  }
  if (
    n >= DENSE_MIN_POINTS &&
    med <= DENSE_MAX_MEDIAN_SPACING_M &&
    (extent <= 1e-6 || med < extent * 0.25)
  ) {
    return { class: "dense-survey" };
  }
  return {
    class: "sparse-waypoints",
    warning:
      "Path classification near the dense/sparse boundary — treating vertices as design waypoints.",
  };
}

/** Max distance from any source vertex to the nearest sample on the fitted path. */
export function maxSourceDeviationM(
  source: RoadMarkingNedPoint[],
  fitted: RoadMarkingNedPoint[]
): number {
  if (source.length === 0 || fitted.length < 2) return 0;
  let maxD = 0;
  for (const s of source) {
    let best = Infinity;
    for (let i = 0; i < fitted.length - 1; i++) {
      const a = fitted[i];
      const b = fitted[i + 1];
      const abN = b.north - a.north;
      const abE = b.east - a.east;
      const len2 = abN * abN + abE * abE;
      let t = 0;
      if (len2 > 1e-18) {
        t = ((s.north - a.north) * abN + (s.east - a.east) * abE) / len2;
        t = Math.max(0, Math.min(1, t));
      }
      const pn = a.north + abN * t;
      const pe = a.east + abE * t;
      const d = Math.hypot(s.north - pn, s.east - pe);
      if (d < best) best = d;
    }
    if (best > maxD) maxD = best;
  }
  return maxD;
}

function angularCoverageOk(points: RoadMarkingNedPoint[], circle: Circle, minCoverageDeg = 300): boolean {
  if (points.length < 3) return false;
  const angles = points
    .map((p) => Math.atan2(p.north - circle.cn, p.east - circle.ce))
    .sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < angles.length; i++) {
    maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  }
  // Wrap-around gap
  maxGap = Math.max(maxGap, angles[0] + 2 * Math.PI - angles[angles.length - 1]);
  const maxGapDeg = (maxGap * 180) / Math.PI;
  return maxGapDeg <= 360 - minCoverageDeg + 1e-6;
}

/**
 * Angles of `points` about `circle`, unwrapped so the series follows travel order instead of
 * jumping at ±π. Shared by the monotonicity gate and by arc sampling, which must sweep the same
 * way round the circle the operator surveyed.
 *
 * Convention matches {@link sampleArc}: north = cn + r·sin(a), east = ce + r·cos(a).
 */
export function unwrappedAngles(points: RoadMarkingNedPoint[], circle: Circle): number[] {
  if (points.length === 0) return [];
  let prev = Math.atan2(points[0].north - circle.cn, points[0].east - circle.ce);
  let unwrapped = prev;
  const series: number[] = [unwrapped];
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i].north - circle.cn, points[i].east - circle.ce);
    let delta = a - prev;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    unwrapped += delta;
    series.push(unwrapped);
    prev = a;
  }
  return series;
}

export function isMonotoneAngularProgression(
  points: RoadMarkingNedPoint[],
  circle: Circle
): boolean {
  if (points.length < 3) return true;
  const series = unwrappedAngles(points, circle);
  // Overall direction
  const total = series[series.length - 1] - series[0];
  if (Math.abs(total) < 1e-3) return false;
  const dir = total >= 0 ? 1 : -1;
  let reversals = 0;
  for (let i = 1; i < series.length; i++) {
    const step = series[i] - series[i - 1];
    if (step * dir < -0.15) reversals += 1; // ~8.6° against the flow
  }
  // Allow a couple of local wobbles; reject zig-zag / out-and-back.
  return reversals <= Math.max(1, Math.floor(points.length * 0.08));
}

/**
 * Best-fit circle constrained to pass exactly through the first and last points.
 *
 * The unconstrained fit and the I1 terminus rule ("hard-anchor free termini to source
 * vertices") pull in opposite directions: the circle is the best compromise over ALL points,
 * so it generally misses the two ends, and then anchoring drags those ends onto the operator's
 * points. That skews the first and last CHORDS, and the skew is visible twice over — as a kink
 * at the first joint, and in the run-up, because `terminalUnitVector` aims PRE/AFT along that
 * chord. Measured on a 10-point arc with one terminus 3 cm off the circle: the first joint
 * turned 1.24° where every other joint turned 0.74°, and the run-up left 2.35° off tangent.
 *
 * Interpolating the ends removes the conflict instead of trading it off. A circle through two
 * fixed points has its centre on their perpendicular bisector, leaving one free parameter:
 *   C(t) = M + t·n̂,  r(t) = √(h² + t²)
 * with M the chord midpoint, n̂ the chord normal and h the half-chord. Minimising the sum of
 * squared radial residuals over the interior points is then a well-conditioned 1-D problem,
 * solved here by golden-section search seeded from the unconstrained fit — a fixed iteration
 * count, so the output is deterministic to the bit.
 *
 * Returns null when the endpoints coincide (a closed loop has no chord and no bisector).
 */
export function fitCircleThroughEndpoints(
  points: RoadMarkingNedPoint[],
  seed?: Circle | null
): Circle | null {
  const n = points.length;
  if (n < 3) return null;
  const p0 = points[0];
  const pn = points[n - 1];
  const dN = pn.north - p0.north;
  const dE = pn.east - p0.east;
  const chord = Math.hypot(dN, dE);
  if (!(chord > 1e-9)) return null;

  const mN = (p0.north + pn.north) / 2;
  const mE = (p0.east + pn.east) / 2;
  const h = chord / 2;
  // Unit normal to the chord — the bisector direction the centre must lie along.
  const nN = -dE / chord;
  const nE = dN / chord;

  const cost = (t: number): number => {
    const cn = mN + t * nN;
    const ce = mE + t * nE;
    const r = Math.hypot(h, t);
    let sum = 0;
    for (let i = 1; i < n - 1; i++) {
      const d = Math.hypot(points[i].north - cn, points[i].east - ce) - r;
      sum += d * d;
    }
    return sum;
  };

  // Seed from the unconstrained centre projected onto the bisector; it is already close, so a
  // bracket around it is ample and keeps the search inside the basin containing the answer.
  const t0 = seed ? (seed.cn - mN) * nN + (seed.ce - mE) * nE : 0;
  const span = Math.max(Math.abs(t0), chord) * 2 + chord;
  let lo = t0 - span;
  let hi = t0 + span;

  const PHI_INV = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - PHI_INV * (hi - lo);
  let x2 = lo + PHI_INV * (hi - lo);
  let f1 = cost(x1);
  let f2 = cost(x2);
  // Fixed iteration count, not a tolerance loop: byte-identical output for identical input.
  for (let i = 0; i < 100; i++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - PHI_INV * (hi - lo);
      f1 = cost(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + PHI_INV * (hi - lo);
      f2 = cost(x2);
    }
  }

  const t = (lo + hi) / 2;
  const circle: Circle = { cn: mN + t * nN, ce: mE + t * nE, r: Math.hypot(h, t) };
  if (!Number.isFinite(circle.cn) || !Number.isFinite(circle.ce) || !Number.isFinite(circle.r)) {
    return null;
  }
  return circle;
}

export type SparseArcFit = {
  circle: Circle;
  /** Max |distance-to-centre − r| over the source points (m). */
  maxResidualM: number;
  /** The gate `maxResidualM` was actually judged against — see {@link sparseArcResidualGateM}. */
  gateM: number;
  /** Signed total sweep in radians, in travel order. */
  sweepRad: number;
};

/**
 * Decide whether a sparse point list is ONE surveyed arc, and fit it if so.
 *
 * Returns null — meaning "fall back to waypoint fillets, unchanged" — for anything it cannot
 * establish. See {@link SPARSE_ARC_CORNER_TURN_DEG} for why each gate exists and which shape
 * each one is there to protect.
 *
 * Deliberately whole-path only. A path containing a hard corner is left entirely to the fillet
 * pipeline rather than being split into arc runs joined at the corner, because a corner fillet
 * sizes itself from the legs either side of it (`legCeil = 0.45·min(legIn,legOut)/tan(θ/2)`)
 * and arc samples land 0.35 m apart — feeding a densified run into a corner starves that fillet
 * of leg budget and drives it under the rover's 0.5 m floor, turning a drivable corner into a
 * non-paintable one. Splitting properly means trimming each run back to the fillet's tangent
 * points, which is a bigger change than this one is worth until real files ask for it.
 */
export function trySparseArcFit(
  points: RoadMarkingNedPoint[],
  opts?: { maxArcRadiusM?: number; surveyRmsM?: number | null }
): SparseArcFit | null {
  if (points.length < SPARSE_ARC_MIN_POINTS) return null;

  // Gate 1 — a hard turn is a design corner, and no fit may absorb it.
  for (let i = 1; i < points.length - 1; i++) {
    const turn = Math.abs(turningAngleDeg(points[i - 1], points[i], points[i + 1]));
    if (!Number.isFinite(turn)) return null;
    if (turn > SPARSE_ARC_CORNER_TURN_DEG) return null;
  }

  // Interpolate the termini rather than best-fitting past them — see
  // fitCircleThroughEndpoints for why anchoring an unconstrained fit kinks the first joint and
  // misaims the run-up. No silent fallback to the unconstrained circle: a fit that cannot hold
  // the endpoints is one we do not want, so it falls through to waypoint fillets instead.
  const seed = fitCircleHyper(points) ?? fitCircleKasa(points);
  const circle = fitCircleThroughEndpoints(points, seed);
  if (!circle || !Number.isFinite(circle.r)) return null;
  // Below the rover's floor it cannot be driven; above maxArcRadius it is a straight line by
  // any useful measure, and the fillet path already handles those without faceting.
  if (!(circle.r >= R_MIN_ROVER_M)) return null;
  if (!(circle.r <= (opts?.maxArcRadiusM ?? DEFAULTS.maxArcRadiusM))) return null;

  // Gate 2 — sweeping back and forth about the centre is a zig-zag, not an arc.
  if (!isMonotoneAngularProgression(points, circle)) return null;

  // Gate 3 — the points must actually lie on it.
  let maxResidualM = 0;
  for (const p of points) {
    const d = Math.hypot(p.north - circle.cn, p.east - circle.ce);
    maxResidualM = Math.max(maxResidualM, Math.abs(d - circle.r));
  }
  const gateM = sparseArcResidualGateM(opts?.surveyRmsM);
  if (!(maxResidualM <= gateM)) return null;

  const series = unwrappedAngles(points, circle);
  const sweepRad = series[series.length - 1] - series[0];
  if (!Number.isFinite(sweepRad) || Math.abs(sweepRad) < 1e-6) return null;

  return { circle, maxResidualM, gateM, sweepRad };
}

/**
 * Exact circumcircle through three points (closed-form perpendicular-bisector intersection).
 * Null for a (near-)collinear triple — no circle, or one too large to be a meaningful radius.
 */
function circumcircle(
  a: RoadMarkingNedPoint,
  b: RoadMarkingNedPoint,
  c: RoadMarkingNedPoint
): Circle | null {
  const d = 2 * (a.north * (b.east - c.east) + b.north * (c.east - a.east) + c.north * (a.east - b.east));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const aSq = a.north * a.north + a.east * a.east;
  const bSq = b.north * b.north + b.east * b.east;
  const cSq = c.north * c.north + c.east * c.east;
  const cn = (aSq * (b.east - c.east) + bSq * (c.east - a.east) + cSq * (a.east - b.east)) / d;
  const ce = (aSq * (c.north - b.north) + bSq * (a.north - c.north) + cSq * (b.north - a.north)) / d;
  if (!Number.isFinite(cn) || !Number.isFinite(ce)) return null;
  const r = Math.hypot(a.north - cn, a.east - ce);
  if (!Number.isFinite(r) || r < 1e-6) return null;
  return { cn, ce, r };
}

/**
 * Arc (or straight-chord fallback) samples for one segment of a point chain, built from the
 * circumcircle of a 3-point window straddling it. `pairIndex` selects which adjacent pair of
 * the triple this segment actually is: 0 = (triple[0]→triple[1]), 1 = (triple[1]→triple[2]).
 * Falls back to a straight chord — still hitting both endpoints exactly — when the triple is
 * (near-)collinear or the local radius is outside what the rover/geometry policy allows.
 */
function arcOrLineThroughSegment(
  triple: [RoadMarkingNedPoint, RoadMarkingNedPoint, RoadMarkingNedPoint],
  pairIndex: 0 | 1,
  spacingM: number
): RoadMarkingNedPoint[] {
  const p0 = triple[pairIndex];
  const p1 = triple[pairIndex + 1];
  const circle = circumcircle(triple[0], triple[1], triple[2]);
  if (!circle || !(circle.r >= R_MIN_ROVER_M) || !(circle.r <= DEFAULTS.maxArcRadiusM)) {
    return sampleLine(p0, p1, spacingM);
  }
  const angles = unwrappedAngles(triple, circle);
  return sampleArc(circle, angles[pairIndex], angles[pairIndex + 1], spacingM);
}

/** Append `segment`, skipping its first sample when it exactly repeats the running output's last. */
function appendSamples(out: RoadMarkingNedPoint[], segment: RoadMarkingNedPoint[]): void {
  for (let k = 0; k < segment.length; k++) {
    if (k === 0 && out.length > 0 && dist(out[out.length - 1], segment[k]) < 1e-6) continue;
    out.push(segment[k]);
  }
}

/**
 * ONE unit tangent (direction of travel) per surveyed point, from the circumcircle of the
 * triple CENTERED on that point.
 *
 * This is the G1 fix for the per-triple tessellation below: building segment [P_i, P_i+1]
 * from triple (P_i, P_i+1, P_i+2) and the next segment from the NEXT triple means two
 * different circumcircles meet at P_i+1 — G0 by construction, and their tangent mismatch is
 * NOT "small" when real curvature changes between points. Measured on the 2026-07-30
 * curve_6_points-1 mission (8 RTK stakes): −9.99°/+4.05°/−9.99° single-vertex jumps landing
 * exactly on stakes 9/10/11; the rover cannot step its heading, saturated at κ=−3.7 m⁻¹
 * against a 0.384 rad/s firmware yaw-rate limit, ran 6.4 cm wide and the spray safety gate
 * cut a 31 cm hole in the mark. The centered triple's tangent at its middle point is the
 * natural single answer both neighbouring spans can share.
 *
 * Termini use their one-sided triple; a degenerate (collinear) triple falls back to the
 * neighbouring chord direction. Never returns a zero vector for distinct points.
 */
export function sparsePointTangents(points: RoadMarkingNedPoint[]): RoadMarkingNedPoint[] {
  const n = points.length;
  const out: RoadMarkingNedPoint[] = [];
  for (let i = 0; i < n; i++) {
    // Travel reference: the chord bridging this point's neighbours.
    const refA = points[Math.max(0, i - 1)];
    const refB = points[Math.min(n - 1, i + 1)];
    let rn = refB.north - refA.north;
    let re = refB.east - refA.east;
    const rm = Math.hypot(rn, re);
    if (rm > 1e-12) {
      rn /= rm;
      re /= rm;
    }
    const lo = Math.min(Math.max(0, i - 1), n - 3);
    const triple = [points[lo], points[lo + 1], points[lo + 2]];
    const circle = n >= 3 ? circumcircle(triple[0], triple[1], triple[2]) : null;
    if (!circle) {
      out.push({ north: rn, east: re });
      continue;
    }
    // Tangent of the circumcircle at this point: perpendicular to the radial,
    // oriented along travel.
    const radN = points[i].north - circle.cn;
    const radE = points[i].east - circle.ce;
    const radM = Math.hypot(radN, radE);
    if (radM < 1e-12) {
      out.push({ north: rn, east: re });
      continue;
    }
    let tn = -radE / radM;
    let te = radN / radM;
    if (tn * rn + te * re < 0) {
      tn = -tn;
      te = -te;
    }
    out.push({ north: tn, east: te });
  }
  return out;
}

/**
 * Samples of the circular arc that leaves `p` along unit tangent `t` and ends at `q`,
 * inclusive of both endpoints. Falls back to the straight chord when the constraint is
 * (near-)collinear, and returns null when the implied radius is below the rover's floor —
 * the caller then keeps its previous behaviour instead of emitting an undrivable arc.
 */
function sampleArcFromTangent(
  p: RoadMarkingNedPoint,
  t: RoadMarkingNedPoint,
  q: RoadMarkingNedPoint,
  spacingM: number
): RoadMarkingNedPoint[] | null {
  const cn = q.north - p.north;
  const ce = q.east - p.east;
  const chord = Math.hypot(cn, ce);
  if (chord < 1e-9) return [p, q];
  // Signed perpendicular offset of q from the tangent line at p.
  const y = t.north * ce - t.east * cn;
  if (Math.abs(y) < 1e-6 * chord) return sampleLine(p, q, spacingM);
  const r = (chord * chord) / (2 * Math.abs(y));
  if (r < R_MIN_ROVER_M) return null;
  // cross(t, chord) > 0 ⇔ q sits RIGHT of travel ⇔ clockwise arc, centre right.
  const sign = y > 0 ? 1 : -1;
  const centre = {
    cn: p.north + r * sign * -t.east,
    ce: p.east + r * sign * t.north,
    r,
  };
  const a0 = angleOf(p, centre);
  const a1raw = angleOf(q, centre);
  let sweep = a1raw - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  // In the north=sin/east=cos parametrization, increasing angle = CCW = a LEFT
  // (y<0) turn, so a CCW arc must sweep positive and a CW arc negative. Each
  // biarc half is under a half-turn, so the wrapped delta is already right;
  // this guard only repairs the sign on a wrap-boundary case.
  if (sign < 0 && sweep < 0) sweep += 2 * Math.PI;
  if (sign > 0 && sweep > 0) sweep -= 2 * Math.PI;
  const pts = sampleArc(centre, a0, a0 + sweep, spacingM);
  if (pts.length >= 2) {
    pts[0] = { ...p };
    pts[pts.length - 1] = { ...q };
  }
  return pts;
}

/**
 * G1 biarc from (p0, t0) to (p1, t1): two circular arcs, tangent-continuous at both
 * endpoints and at their own join (equal-parameter construction). Inclusive of both
 * endpoints. Returns null on a degenerate construction or an undrivable radius; the caller
 * falls back to the previous per-triple arc, so this can only remove kinks, never add risk.
 */
function sampleBiarc(
  p0: RoadMarkingNedPoint,
  t0: RoadMarkingNedPoint,
  p1: RoadMarkingNedPoint,
  t1: RoadMarkingNedPoint,
  spacingM: number
): RoadMarkingNedPoint[] | null {
  const vn = p1.north - p0.north;
  const ve = p1.east - p0.east;
  const vv = vn * vn + ve * ve;
  if (vv < 1e-18) return null;
  const un = t0.north + t1.north;
  const ue = t0.east + t1.east;
  const vu = vn * un + ve * ue;
  const denom = 2 * (1 - (t0.north * t1.north + t0.east * t1.east));
  if (denom < 1e-9) {
    // Tangents (near-)parallel: a single arc satisfies both end tangents.
    return sampleArcFromTangent(p0, t0, p1, spacingM);
  }
  const disc = vu * vu + denom * vv;
  if (disc < 0) return null;
  const d = (-vu + Math.sqrt(disc)) / denom;
  if (!Number.isFinite(d) || d <= 0) return null;
  const join = {
    north: (p0.north + d * t0.north + p1.north - d * t1.north) / 2,
    east: (p0.east + d * t0.east + p1.east - d * t1.east) / 2,
  };
  const first = sampleArcFromTangent(p0, t0, join, spacingM);
  if (!first) return null;
  // Second half built backwards from (p1, −t1) so its p1 tangent is exact, then reversed.
  const secondRev = sampleArcFromTangent(
    p1,
    { north: -t1.north, east: -t1.east },
    join,
    spacingM
  );
  if (!secondRev) return null;
  const second = secondRev.slice().reverse();
  const merged = first.slice();
  appendSamples(merged, second);
  return merged;
}

/**
 * Tessellate the fitted arc across the surveyed span — interpolating EVERY surveyed point,
 * not just the two termini.
 *
 * FRONTEND_NOTE_sparse_arc_fit_misses_survey_points.md: resampling the single
 * endpoint-constrained circle from `fit` left interior points wherever that circle happened to
 * land — up to the residual gate away (measured: up to 7 cm on a ±2 cm paint spec). The first
 * rewrite built one circumcircle arc per segment from the FORWARD point triple, which fixed the
 * displacement (every surveyed point became an exact vertex) but joined consecutive segments
 * with two DIFFERENT circles at each shared point — G0, and the "small tangent mismatch" that
 * design assumed proved false whenever real curvature changes between points: the 2026-07-30
 * curve_6_points-1 mission staged −9.99°/+4.05°/−9.99° single-vertex tangent jumps landing
 * exactly on surveyed stakes, which the rover physically cannot track at speed (6.4 cm
 * excursion, 31 cm spray-gate hole — see the PX4_DXP consolidated analysis of that date).
 *
 * G1 construction (this revision): first derive ONE tangent per surveyed point from the triple
 * CENTERED on it ({@link sparsePointTangents}), then build each segment [P_i, P_i+1] as a
 * BIARC matching those end tangents exactly. Both neighbouring segments share the same tangent
 * at their shared point, so the chain is tangent-continuous everywhere by construction — and
 * every surveyed point is still an exact vertex of the output (deviation 0, unchanged).
 *
 * Termini are still pinned exactly to the operator's first and last points (I1, matching
 * {@link buildWaypointFilletPath}). A degenerate biarc or one whose radius falls below the
 * rover floor falls back to the previous per-triple arc, and that falls back to a straight
 * chord — never throws, never drops a point.
 *
 * The {@link PREVIEW_SAMPLE_TARGET} budget is unchanged: a 1 km-radius ring surveyed with 40
 * points is still 6.3 km of arc, so the total-length estimate from `fit` still paces sampling
 * the same way it did before this change (only the underlying curve construction is new).
 */
export function buildSparseArcSamples(
  points: RoadMarkingNedPoint[],
  fit: SparseArcFit,
  sampleSpacingM: number
): RoadMarkingNedPoint[] {
  const n = points.length;
  if (n < 2) return points.slice();
  const totalArcLenEstM = Math.abs(fit.sweepRad) * fit.circle.r;
  const spacingM = Math.max(sampleSpacingM, totalArcLenEstM / PREVIEW_SAMPLE_TARGET);
  if (n === 2) return sampleLine(points[0], points[1], spacingM);

  const tangents = sparsePointTangents(points);
  const out: RoadMarkingNedPoint[] = [];
  for (let i = 0; i < n - 1; i++) {
    const g1 = sampleBiarc(points[i], tangents[i], points[i + 1], tangents[i + 1], spacingM);
    if (g1) {
      appendSamples(out, g1);
      continue;
    }
    // Fallback = the previous per-triple behaviour, so a degenerate biarc can only ever
    // reproduce the old geometry, never invent worse.
    const useForwardTriple = i + 2 <= n - 1;
    const triple: [RoadMarkingNedPoint, RoadMarkingNedPoint, RoadMarkingNedPoint] = useForwardTriple
      ? [points[i], points[i + 1], points[i + 2]]
      : [points[i - 1], points[i], points[i + 1]];
    const pairIndex: 0 | 1 = useForwardTriple ? 0 : 1;
    appendSamples(out, arcOrLineThroughSegment(triple, pairIndex, spacingM));
  }
  // I1 — belt and suspenders against any floating-point drift from the arc math above.
  if (out.length >= 2) {
    out[0] = { ...points[0] };
    out[out.length - 1] = { ...points[n - 1] };
  }
  return dedupeNearPoints(out, TESSELLATION_DEDUPE_M);
}

/**
 * Fillet radius at a waypoint corner from paint budget + leg budget + rover floor.
 * Returns null when no geometric fillet is possible.
 *
 * Single sizing policy for sparse (`buildWaypointFilletPath`) and dense
 * (`tessellatePrimitivesWithJointFillets`) pipelines — do not re-derive radius
 * from `filletRadiusFraction` alone at call sites.
 */
export function waypointCornerRadiusM(
  turnDeg: number,
  legInM: number,
  legOutM: number,
  opts?: { rMinM?: number; cornerTolM?: number; maxFilletM?: number }
): { r: number; missM: number; overBudget: boolean; undrivable: boolean } | null {
  const rMin = opts?.rMinM ?? R_MIN_ROVER_M;
  const D = opts?.cornerTolM ?? CORNER_TOLERANCE_M;
  const maxF = opts?.maxFilletM ?? DEFAULTS.maxFilletRadiusM;
  const absTurn = Math.abs(turnDeg);
  if (absTurn < MIN_VISIBLE_TURN_DEG || absTurn > 179) return null;
  const half = (absTurn * Math.PI) / 180 / 2;
  const tanHalf = Math.tan(half);
  const secHalf = 1 / Math.cos(half);
  if (!(tanHalf > 1e-9) || !(secHalf > 1)) return null;

  const paintCeil = D / (secHalf - 1);
  const legCeil = (0.45 * Math.min(legInM, legOutM)) / tanHalf;
  const hardCeil = Math.min(paintCeil, legCeil, maxF);
  if (!(hardCeil >= 0.05)) return null;

  let r: number;
  let overBudget = false;
  let undrivable = false;
  if (hardCeil >= rMin) {
    // Largest radius within paint+leg budget (smooth) — still ≥ rMin.
    r = hardCeil;
  } else {
    // Kinematics want more cut than the paint budget allows.
    const legOnly = Math.min(legCeil, maxF);
    if (legOnly >= rMin) {
      r = rMin;
      overBudget = true;
    } else if (legOnly >= 0.05) {
      r = legOnly;
      overBudget = true;
      undrivable = true;
    } else {
      return null;
    }
  }
  const missM = r * (secHalf - 1);
  return { r, missM, overBudget: overBudget || missM > D + 1e-9, undrivable };
}

/**
 * Map turn + leg geometry to a drivability class using the same budgets as
 * {@link waypointCornerRadiusM}. Reversal threshold is {@link MAX_INTERIOR_TURN_DEG}.
 */
export function classifyCornerDrivability(
  turnDeg: number,
  legInM: number,
  legOutM: number,
  opts?: { rMinM?: number; cornerTolM?: number; maxFilletM?: number }
): Omit<SourceCorner, "atIndex" | "north" | "east"> {
  const absTurn = Math.abs(turnDeg);
  if (absTurn >= MAX_INTERIOR_TURN_DEG) {
    return {
      turnDeg: absTurn,
      class: "reversal",
      radiusM: null,
      cutM: null,
      overBudget: true,
      undrivable: true,
    };
  }
  const info = waypointCornerRadiusM(absTurn, legInM, legOutM, opts);
  if (!info) {
    return {
      turnDeg: absTurn,
      class: "sharp",
      radiusM: null,
      cutM: null,
      overBudget: true,
      undrivable: true,
    };
  }
  if (info.undrivable) {
    return {
      turnDeg: absTurn,
      class: "sharp",
      radiusM: info.r,
      cutM: info.missM,
      overBudget: info.overBudget,
      undrivable: true,
    };
  }
  if (info.overBudget) {
    return {
      turnDeg: absTurn,
      class: "tight",
      radiusM: info.r,
      cutM: info.missM,
      overBudget: true,
      undrivable: false,
    };
  }
  return {
    turnDeg: absTurn,
    class: "clean",
    radiusM: info.r,
    cutM: info.missM,
    overBudget: false,
    undrivable: false,
  };
}

/**
 * Sparse-waypoint pipeline: preserve every vertex, straight legs + geometric fillets only
 * below the corner line — never above it.
 *
 * A turn at or above {@link SPARSE_ARC_CORNER_TURN_DEG} is a genuine design corner (the same
 * line {@link trySparseArcFit}'s gate 1 uses: "a vertex that turns this hard is a corner, full
 * stop") and renders sharp — the rover stops and pivots in place at a waypoint turn rather
 * than needing a matching physical turning radius, so a sharp corner is correct, not a
 * fallback. A turn below that line is not a corner at all; it is one vertex of a coarse
 * curve/ring approximation (e.g. a 40-point survey of a roundabout that missed
 * {@link trySparseArcFit}'s stricter residual gate) and still gets a small fillet so the
 * curve reads as smooth instead of faceted.
 *
 * Never estimates noise, never deletes points, never invents arcs from data.
 */
export function buildWaypointFilletPath(
  points: RoadMarkingNedPoint[],
  options: RoadMarkingPathOptions = {}
): { samples: RoadMarkingNedPoint[]; warnings: string[]; paintable: boolean } {
  const opts = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  let pts = dedupeNearPoints(points, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) return { samples: pts, warnings, paintable: false };
  if (pts.length === 2) {
    return {
      samples: sampleLine(pts[0], pts[1], opts.sampleSpacingM),
      warnings,
      paintable: true,
    };
  }

  const out: RoadMarkingNedPoint[] = [pts[0]];
  const paintable = true;

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const turn = Math.abs(turningAngleDeg(prev, cur, next));

    // Genuine corner: sharp, no fillet attempted.
    if (turn >= SPARSE_ARC_CORNER_TURN_DEG || turn < MIN_VISIBLE_TURN_DEG) {
      out.push(cur);
      continue;
    }

    // Below the corner line: still a curve vertex, not a corner — soften it as before.
    const dPrev = dist(prev, cur);
    const dNext = dist(cur, next);
    const radiusInfo = waypointCornerRadiusM(turn, dPrev, dNext, {
      rMinM: R_MIN_ROVER_M,
      cornerTolM: CORNER_TOLERANCE_M,
      maxFilletM: opts.maxFilletRadiusM,
    });

    if (!radiusInfo) {
      out.push(cur);
      continue;
    }

    const uIn = unit(sub(cur, prev));
    const uOut = unit(sub(next, cur));
    if (!uIn || !uOut) {
      out.push(cur);
      continue;
    }
    const fillet = geometricFilletFromTangents(cur, uIn, uOut, radiusInfo.r, opts.sampleSpacingM);
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

  out.push(pts[pts.length - 1]);
  // I1: hard-anchor free termini to source vertices.
  if (out.length >= 2) {
    out[0] = { ...pts[0] };
    out[out.length - 1] = { ...pts[pts.length - 1] };
  }
  return { samples: dedupeNearPoints(out, TESSELLATION_DEDUPE_M), warnings, paintable };
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

  // Physical bounds — without these a zig-zag or out-and-back over ~40 m can accept
  // an r = hundreds-of-metres circle and tessellate as kilometres of paint.
  if (fit.r > DEFAULTS.maxArcRadiusM) return null;
  const extent = pathExtentM(points);
  if (extent > 1e-6 && fit.r > 2 * extent) return null;
  if (!angularCoverageOk(points, fit, 300)) return null;
  if (!isMonotoneAngularProgression(points, fit)) return null;
  const srcLen = polylineLengthM(points);
  const loopLen = 2 * Math.PI * fit.r;
  if (srcLen > 1e-6 && (loopLen < 0.8 * srcLen || loopLen > 1.25 * srcLen)) return null;

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
  // Fabricated huge-R arcs through a tiny window (nearly collinear) — not genuine
  // curvature. κ must stay large enough for real arcs sampled in short segmenter
  // windows (a r=12 m quarter-circle window of a few metres is legitimate).
  const windowSpan = pathExtentM(points);
  if (windowSpan > 1e-6 && circle.r > 25 * windowSpan) return { kind: "line" };
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

/** Min |turn| (deg) to treat an interior vertex as a corner candidate. */
const CORNER_CLASSIFY_MIN_TURN_DEG = 30;

/**
 * Classify interior vertices by drivability (Track C1).
 * Open paths: indices 1..n-2 only. Uses paint budget + leg budget + rover floor
 * via {@link classifyCornerDrivability} — not bare angle buckets.
 */
export function classifySourceCorners(
  points: RoadMarkingNedPoint[],
  opts?: { rMinM?: number; cornerTolM?: number; maxFilletM?: number }
): SourceCorner[] {
  const out: SourceCorner[] = [];
  if (points.length < 3) return out;
  for (let i = 1; i < points.length - 1; i++) {
    const turnDeg = Math.abs(turningAngleDeg(points[i - 1], points[i], points[i + 1]));
    if (turnDeg < CORNER_CLASSIFY_MIN_TURN_DEG) continue;
    const legIn = dist(points[i - 1], points[i]);
    const legOut = dist(points[i], points[i + 1]);
    const d = classifyCornerDrivability(turnDeg, legIn, legOut, opts);
    out.push({
      atIndex: i,
      north: points[i].north,
      east: points[i].east,
      ...d,
    });
  }
  return out;
}

/**
 * Operator-facing summary lines for classified corners (fit_warnings / UI).
 */
export function formatCornerWarnings(corners: SourceCorner[]): string[] {
  if (corners.length === 0) return [];
  const counts: Record<CornerClass, number> = {
    clean: 0,
    tight: 0,
    sharp: 0,
    reversal: 0,
  };
  for (const c of corners) counts[c.class] += 1;
  const parts: string[] = [];
  if (counts.clean) parts.push(`${counts.clean} clean`);
  if (counts.tight) parts.push(`${counts.tight} tight`);
  if (counts.sharp) parts.push(`${counts.sharp} sharp`);
  if (counts.reversal) parts.push(`${counts.reversal} reversal`);
  const summary = `Corners: ${corners.length} (${parts.join(", ")})`;
  const detail: string[] = [summary];
  for (const c of corners) {
    if (c.class === "clean") continue;
    const cut =
      c.cutM != null ? `, cut ${(c.cutM * 100).toFixed(0)} cm` : "";
    const r = c.radiusM != null ? `, r=${c.radiusM.toFixed(2)} m` : "";
    detail.push(
      `  · vertex ${c.atIndex + 1}: ${c.class} (${c.turnDeg.toFixed(0)}°${r}${cut})`
    );
  }
  return detail;
}

/**
 * Short TRAVEL loop at R_min that reorients from arrival to departure heading
 * and returns to the vertex (MARK→TRAVEL→MARK teardrop for sharp corners).
 * Start and end are the vertex so travel-touch rules hold.
 */
export function buildTeardropTravelPoints(
  vertex: RoadMarkingNedPoint,
  prev: RoadMarkingNedPoint,
  next: RoadMarkingNedPoint,
  rMin: number = R_MIN_ROVER_M,
  sampleSpacingM: number = 0.15
): RoadMarkingNedPoint[] {
  const dIn = dist(prev, vertex);
  const dOut = dist(vertex, next);
  if (dIn < 1e-9 || dOut < 1e-9) {
    return [vertex, vertex];
  }
  const uIn = unit(sub(vertex, prev));
  const uOut = unit(sub(next, vertex));
  if (!uIn || !uOut) return [vertex, vertex];

  const cross = uIn.north * uOut.east - uIn.east * uOut.north;
  const dot = uIn.north * uOut.north + uIn.east * uOut.east;
  let turn = Math.atan2(cross, dot);
  if (Math.abs(turn) < 1e-3) {
    // Nearly straight — tiny lateral nudge so the run still has ≥2 distinct points.
    return [
      vertex,
      { north: vertex.north + uOut.north * 0.05, east: vertex.east + uOut.east * 0.05 },
      vertex,
    ];
  }

  // Prefer the shorter exterior reorient when the interior fold is very sharp.
  if (Math.abs(turn) > Math.PI) {
    turn = turn > 0 ? turn - 2 * Math.PI : turn + 2 * Math.PI;
  }

  // Circle center to the left of arrival for CCW (positive) turn.
  const left = { north: -uIn.east, east: uIn.north };
  const sign = turn >= 0 ? 1 : -1;
  const center = {
    north: vertex.north + sign * left.north * rMin,
    east: vertex.east + sign * left.east * rMin,
  };

  // Match angleOf / sampleArc convention: atan2(north − c, east − c).
  const ang0 = Math.atan2(vertex.north - center.north, vertex.east - center.east);
  const sweep = turn;
  const arcLen = Math.abs(sweep) * rMin;
  const steps = Math.max(4, Math.ceil(arcLen / Math.max(0.05, sampleSpacingM)));
  const pts: RoadMarkingNedPoint[] = [{ ...vertex }];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a = ang0 + sweep * t;
    // Inverse of atan2(n, e): n = r·sin(a)? Wait — atan2(n, e) means
    // cos(a) aligns with east, sin(a) with north.
    pts.push({
      north: center.north + rMin * Math.sin(a),
      east: center.east + rMin * Math.cos(a),
    });
  }
  // Close back to vertex for mark-touch rules.
  if (dist(pts[pts.length - 1], vertex) > 0.02) {
    pts.push({ ...vertex });
  } else {
    pts[pts.length - 1] = { ...vertex };
  }
  if (pts.length < 2) pts.push({ ...vertex });
  return pts;
}

/**
 * Post-pass: convert ARC primitives whose bow (max chord residual) is within
 * `bowBudgetM` into LINE (flat giant-R arcs).
 */
export function flattenArcsByBow(
  points: RoadMarkingNedPoint[],
  prims: PathPrimitive[],
  bowBudgetM: number
): PathPrimitive[] {
  return prims.map((p) => {
    if (p.kind !== "arc") return p;
    const a = points[p.i0];
    const b = points[p.i1];
    if (!a || !b) return p;
    const abN = b.north - a.north;
    const abE = b.east - a.east;
    const len2 = abN * abN + abE * abE;
    let maxBow = 0;
    for (let i = p.i0; i <= p.i1; i++) {
      const pt = points[i];
      if (!pt) continue;
      let t =
        len2 < 1e-18
          ? 0
          : ((pt.north - a.north) * abN + (pt.east - a.east) * abE) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(
        pt.north - (a.north + abN * t),
        pt.east - (a.east + abE * t)
      );
      if (d > maxBow) maxBow = d;
    }
    if (maxBow <= bowBudgetM) {
      return { kind: "line" as const, i0: p.i0, i1: p.i1 };
    }
    return p;
  });
}

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
 * A local direction swing sharper than `MAX_BARE_TURN_DEG` (the same "target quality" bar
 * `buildRoadMarkingFittedPath` already warns against for a whole path), measured immediately
 * after trimming a candidate sandwiched arc with its real joint fillets, marks the
 * tessellation as having actually overshot/backtracked — as opposed to merely tracing a
 * tight-but-well-behaved curve. Reusing that existing bar (rather than a fresh ad-hoc
 * multiple of `sharpCornerDeg`) keeps this check and the path-level warning agreeing on what
 * "clean" means, and it is what correctly separates a real sagitta-significant survey curve
 * (kept) from an S-jog remnant (flattened) once the joint taper itself is smooth (see
 * `blendArcBoundary`) — both can look similar by sagitta and neighbor-turn angle alone.
 */
const SANDWICHED_ARC_OVERSHOOT_DEG_THRESHOLD = MAX_BARE_TURN_DEG;

/** True when consecutive tessellated samples ever swing more than `maxDeg` degrees. */
function hasLocalOvershoot(samples: RoadMarkingNedPoint[], maxDeg: number): boolean {
  const cosThreshold = Math.cos((maxDeg * Math.PI) / 180);
  for (let i = 1; i < samples.length - 1; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const c = samples[i + 1];
    const v1n = b.north - a.north;
    const v1e = b.east - a.east;
    const v2n = c.north - b.north;
    const v2e = c.east - b.east;
    const m1 = Math.hypot(v1n, v1e);
    const m2 = Math.hypot(v2n, v2e);
    if (m1 < 1e-9 || m2 < 1e-9) continue;
    const cos = (v1n * v2n + v1e * v2e) / (m1 * m2);
    if (cos < cosThreshold) return true;
  }
  return false;
}

/**
 * Reclassify a sandwiched 'arc' primitive to 'line' when BOTH its neighbors turn sharply
 * away from it AND tessellating it with its real joint fillets actually overshoots —
 * i.e. it is really just the corner transition between two other runs, not a genuine
 * road-scale curve feature. A genuine curve has smooth tangent continuity at its own
 * boundaries by construction, so the neighbor-turn condition alone flags this as a
 * candidate; but neighbor turn angle cannot by itself distinguish a real, sagitta-significant
 * curve (which must be kept) from an S-jog remnant (which must be flattened) — both can
 * report similar sagitta and similar neighbor turn (measured: a real 2.55 m-radius survey
 * curve and a synthetic S-jog remnant both sit in the same 0.4-0.7 m sagitta band). What
 * differs is what actually happens once the real joint fillets are laid down: two
 * independent fillets straddling a short arc each compute their trim budget from the arc's
 * FULL length without knowing the sibling joint on the other end also claims a share of it,
 * and for a short, tightly-sandwiched arc this can produce conflicting trims and a
 * mis-parameterized (even backtracking) tessellated sample. Only collapse to a line when
 * that actually happens; otherwise keep the arc.
 */
export function absorbSandwichedCornerArcs(
  points: RoadMarkingNedPoint[],
  prims: PathPrimitive[],
  sharpCornerDeg: number,
  tessellationOpts?: { sampleSpacingM: number; filletRadiusFraction: number; maxFilletRadiusM: number }
): PathPrimitive[] {
  if (prims.length < 3) return prims;
  return prims.map((p, idx) => {
    if (p.kind !== "arc" || idx === 0 || idx === prims.length - 1) return p;
    const turnIn = primitiveNeighborTurnDeg(points, prims[idx - 1], p);
    const turnOut = primitiveNeighborTurnDeg(points, p, prims[idx + 1]);
    if (turnIn == null || turnOut == null) return p;
    if (turnIn < sharpCornerDeg || turnOut < sharpCornerDeg) return p;
    if (!tessellationOpts) return { kind: "line", i0: p.i0, i1: p.i1 };
    const microChain = [prims[idx - 1], p, prims[idx + 1]];
    const microSamples = tessellatePrimitivesWithJointFillets(points, microChain, {
      sharpCornerDeg,
      filletRadiusFraction: tessellationOpts.filletRadiusFraction,
      maxFilletRadiusM: tessellationOpts.maxFilletRadiusM,
      sampleSpacingM: tessellationOpts.sampleSpacingM,
    });
    if (!hasLocalOvershoot(microSamples, SANDWICHED_ARC_OVERSHOOT_DEG_THRESHOLD)) return p;
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

/**
 * Samples over which a forced arc-boundary correction is tapered — see `blendArcBoundary`.
 * Was 3 with a linear weight; measured on a real survey (field_test_02.csv, 2026-07-31) to
 * leave a 15.9 deg direction snap right at the seam between a straight run and a tight
 * (r=2.55 m) real curve — a visible "chord/corner" artifact even though the underlying
 * survey trend there is smooth. Widening to 8 (with the smoothstep weighting below) spreads
 * the same position correction over more distance: measured worst joint turn on that same
 * file drops to 7.0 deg (under the existing MAX_BARE_TURN_DEG=8 deg "clean" bar, warning
 * clears), at the cost of ~0.03 m more max source deviation — still well inside
 * CORNER_TOLERANCE_M. Verified no regression on roundabout_coordinates.csv or the
 * Haddows Road half of roads_coordinates.csv (loaded directly, not via synthetic stand-ins).
 */
const BOUNDARY_BLEND_SAMPLES = 8;

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
 *
 * Weighted by smoothstep (3t^2-2t^3), not a linear ramp: a linear ramp's weight has a
 * discontinuous slope at the far edge of the window (full-strength correction one sample,
 * none the next), which is exactly what reads as a direction "snap" right where the taper
 * ends. Smoothstep's derivative is zero at both ends of the window, so the correction fades
 * in and back out gradually instead of stopping abruptly.
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
    const t = 1 - k / blendN;
    const w = t * t * (3 - 2 * t);
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
    const arcSamples = sampleArc(p.circle, aa, ab, options.sampleSpacingM);
    // I1: free termini of a single open arc — anchor to the raw survey vertices.
    // (Closed whole-loop fits have first≈last and are exempt from strict I1.)
    if (arcSamples.length >= 2) {
      const gapEnds = dist(points[p.i0], points[p.i1]);
      if (gapEnds > 0.05) {
        blendArcBoundary(arcSamples, 0, points[p.i0]);
        blendArcBoundary(arcSamples, arcSamples.length - 1, points[p.i1]);
      }
    }
    return arcSamples;
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
    // Leave ~half of each primitive for the other joint / body (same 45% as sparse).
    const budget = 0.45 * Math.min(lenPrev, lenNext);
    const fractionCap = options.filletRadiusFraction * Math.min(lenPrev, lenNext);

    // Radius policy:
    // - Real corners (≥ CORNER_CLASSIFY_MIN_TURN_DEG): same paint+leg+R_min formula as
    //   sparse `buildWaypointFilletPath` so dense/sparse agree on squares & zig-zags.
    // - Mild residual joints on a dense fit: keep the fraction×leg cap so paint-ceil
    //   cannot invent a multi-metre fillet that over-trims short arcs (field_test_02).
    const radiusInfo = waypointCornerRadiusM(turn, lenPrev, lenNext, {
      rMinM: R_MIN_ROVER_M,
      cornerTolM: CORNER_TOLERANCE_M,
      maxFilletM: options.maxFilletRadiusM,
    });
    let r: number;
    if (turn >= CORNER_CLASSIFY_MIN_TURN_DEG && radiusInfo) {
      r = radiusInfo.r;
    } else if (radiusInfo) {
      r = Math.min(radiusInfo.r, Math.max(fractionCap, 0.05));
    } else {
      r = Math.min(options.maxFilletRadiusM, Math.max(fractionCap, 0.05));
    }

    // Data-aware radius: when neither neighbor is already a fitted arc, prefer a corner
    // radius the raw survey points actually support. Only ever shrinks r (never grows it).
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
    // Visible turn: never leave completely unrounded when a tiny floor still fits the budget.
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
        // Anchor boundaries with a tapered blend (blendArcBoundary):
        // - Internal seams (i>0 / i<last): required so neighboring primitives share one
        //   point without dumping the full Hyper residual into a single segment (snap-only
        //   left a 5–10° kink on roads_coordinates).
        // - Free termini (i===0 start / last end): also required for I1 endpoint anchoring.
        //   There is no neighboring geometry to kink against at a free end, so anchoring
        //   the fitted reconstruction onto the raw survey vertex costs nothing and keeps
        //   the path pinned to the pins. Use the source vertex, not only the local start/
        //   end which may already be a fillet tangent.
        if (i > 0) {
          blendArcBoundary(arcSamples, 0, start);
        } else {
          blendArcBoundary(arcSamples, 0, points[prim.i0]);
        }
        if (i < prims.length - 1) {
          blendArcBoundary(arcSamples, arcSamples.length - 1, end);
        } else {
          blendArcBoundary(arcSamples, arcSamples.length - 1, points[prim.i1]);
        }
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
  prims = absorbSandwichedCornerArcs(points, prims, options.sharpCornerDeg, {
    sampleSpacingM: options.sampleSpacingM,
    filletRadiusFraction: options.filletRadiusFraction,
    maxFilletRadiusM: options.maxFilletRadiusM,
  });
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
 * Two-sided extent + length + turn + fidelity gate. Replaces one-sided coversSourceExtent
 * (which accepted kilometre-scale rings from metre-scale surveys).
 */
export function validateFittedPath(
  source: RoadMarkingNedPoint[],
  fitted: RoadMarkingNedPoint[],
  opts?: { maxDeviationM?: number; waypointMode?: boolean }
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (source.length < 2) return { ok: true, reasons };
  if (fitted.length < 2) return { ok: false, reasons: ["fitted path has fewer than 2 points"] };

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
  const ref = extent(fitted);
  const floor = Math.max(EXTENT_CHECK_MIN_AXIS_M, 0);
  const axisBothWays = (s: number, r: number, axis: string) => {
    if (s <= floor) return;
    if (r < s * 0.9) reasons.push(`${axis} extent collapsed (${r.toFixed(2)} < 0.9×${s.toFixed(2)})`);
    if (r > s * 1.15) reasons.push(`${axis} extent exploded (${r.toFixed(2)} > 1.15×${s.toFixed(2)})`);
  };
  axisBothWays(src.n, ref.n, "north");
  axisBothWays(src.e, ref.e, "east");

  const srcLen = polylineLengthM(source);
  const fitLen = polylineLengthM(fitted);
  if (srcLen > 1e-6) {
    const ratio = fitLen / srcLen;
    if (ratio < 0.75 || ratio > 1.25) {
      reasons.push(`length ratio ${ratio.toFixed(3)} outside [0.75, 1.25]`);
    }
  }

  const maxTurn = maxTurningAngleDeg(fitted);
  if (maxTurn > MAX_INTERIOR_TURN_DEG) {
    reasons.push(`interior turn ${maxTurn.toFixed(1)}° exceeds ${MAX_INTERIOR_TURN_DEG}°`);
  }

  // I1 endpoint anchoring (open paths).
  const endGap = dist(source[0], source[source.length - 1]);
  if (endGap > 0.05) {
    const d0 = dist(fitted[0], source[0]);
    const d1 = dist(fitted[fitted.length - 1], source[source.length - 1]);
    if (d0 > 0.01) reasons.push(`start endpoint drift ${d0.toFixed(3)} m`);
    if (d1 > 0.01) reasons.push(`end endpoint drift ${d1.toFixed(3)} m`);
  }

  const maxDev = maxSourceDeviationM(source, fitted);
  const devBudget = opts?.maxDeviationM ?? (opts?.waypointMode ? CORNER_TOLERANCE_M * 3 : MAX_FIT_DEVIATION_M);
  // Waypoint mode: corner cut is intentional up to ~r*(sec-1); allow more.
  if (!opts?.waypointMode && maxDev > devBudget) {
    reasons.push(`max source deviation ${maxDev.toFixed(3)} m > ${devBudget} m`);
  }

  return { ok: reasons.length === 0, reasons };
}

function runDensePipeline(
  points: RoadMarkingNedPoint[],
  opts: Required<RoadMarkingPathOptions>,
  fitToleranceM: number
): { samples: RoadMarkingNedPoint[]; cleanedSource: RoadMarkingNedPoint[] } {
  let pts = points.slice();
  pts = rejectPathSpikes(pts, fitToleranceM, opts.outlierPathChordRatio, opts.outlierResidualFactor);
  pts = ensureOpenPath(pts);
  pts = dampenOppositeJogs(pts, Math.max(opts.sharpCornerDeg * 0.65, 6), 3.5);
  pts = dedupeNearPoints(pts, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) return { samples: pts, cleanedSource: pts };

  // Validate fidelity against the cleaned survey (after deliberate spike/jog removal),
  // not the raw input — otherwise dampenOppositeJogs always "fails" max-deviation.
  const cleanedSource = pts.slice();

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

  // I1 hard snap of free termini for open dense paths.
  if (pts.length >= 2 && cleanedSource.length >= 2) {
    const open = dist(cleanedSource[0], cleanedSource[cleanedSource.length - 1]) > 0.05;
    if (open) {
      pts[0] = { ...cleanedSource[0] };
      pts[pts.length - 1] = { ...cleanedSource[cleanedSource.length - 1] };
    }
  }
  return { samples: pts, cleanedSource };
}

/**
 * Full production pipeline with classification, validation, and never-raw fallback.
 *
 * Dense: spike reject → S-jog dampen → [whole-loop | segment+fillet] → validate.
 * Sparse: waypoint straights + geometric fillets only.
 * On validation failure: degrade to waypoint-fillet (never return the raw polyline).
 */
export function buildRoadMarkingFittedPath(
  points: RoadMarkingNedPoint[],
  options: RoadMarkingPathOptions = {}
): FittedPathResult {
  // Direction invariance (2026-08-01): the sequential fitter decomposes the
  // SAME ground points into different arc chains depending on traversal
  // order — measured 2.20 cm mean / 6.12 cm max planned-path shift between
  // the two directions of one 54-stake survey (PX4_DXP
  // bags/31_07_2026/ANALYSIS_2026-07-31_CLEAN_vs_RAW.md §6). Fit every open
  // path in a canonical orientation (lexicographically smaller endpoint
  // first) and restore the caller's direction on the way out, so A→B and
  // B→A yield the identical painted line. Closed loops are left untouched.
  // Note: warning texts that reference point indices refer to the canonical
  // order when the input was flipped.
  const n = points.length;
  if (n >= 2) {
    const a = points[0];
    const b = points[n - 1];
    const closed = Math.hypot(a.north - b.north, a.east - b.east) < 1e-6;
    const reversedOrder =
      b.north < a.north - 1e-9 ||
      (Math.abs(b.north - a.north) <= 1e-9 && b.east < a.east - 1e-9);
    if (!closed && reversedOrder) {
      const result = buildRoadMarkingFittedPathDirected(
        [...points].reverse(),
        options
      );
      return { ...result, samples: [...result.samples].reverse() };
    }
  }
  return buildRoadMarkingFittedPathDirected(points, options);
}

function buildRoadMarkingFittedPathDirected(
  points: RoadMarkingNedPoint[],
  options: RoadMarkingPathOptions = {}
): FittedPathResult {
  const opts = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  let pts = dedupeNearPoints(points, 0.02);
  pts = ensureOpenPath(pts);
  if (pts.length < 2) {
    return {
      samples: pts,
      mode: "waypoint-fillet",
      warnings: ["Path has fewer than 2 points after cleanup."],
      paintable: false,
      quality: {
        class: "sparse-waypoints",
        toleranceM: opts.fitToleranceM,
        maxJointTurnDeg: 0,
        lengthRatio: 1,
        maxSourceDeviationM: 0,
      },
    };
  }

  const classification = classifyPointSequence(pts);
  if (classification.warning) warnings.push(classification.warning);
  const source = pts;
  const srcLen = polylineLengthM(source);

  // Explicit fitTolerance from caller ⇒ dense pipeline (tests / advanced callers).
  const forceDense = options.fitToleranceM != null;

  if (classification.class === "sparse-waypoints" && !forceDense) {
    // One surveyed arc, or a chain of design vertices? Only the first can be fitted through;
    // trySparseArcFit returns null for everything it cannot establish, so the fillet path
    // below stays the default and this is purely additive.
    const arcFit = trySparseArcFit(source, {
      maxArcRadiusM: opts.maxArcRadiusM,
      surveyRmsM: opts.surveyRmsM,
    });
    if (arcFit) {
      const arcSamples = buildSparseArcSamples(source, arcFit, opts.sampleSpacingM);
      const arcValidation = validateFittedPath(source, arcSamples, { waypointMode: true });
      if (arcValidation.ok && arcSamples.length >= 2) {
        const arcLen = polylineLengthM(arcSamples);
        const corners = classifySourceCorners(source, { maxFilletM: opts.maxFilletRadiusM });
        for (const w of formatCornerWarnings(corners)) warnings.push(w);
        const hasReversal = corners.some((c) => c.class === "reversal");
        if (hasReversal) {
          warnings.push("Path has a reversal corner — fix the survey or skip this path before Send.");
        }
        return {
          samples: arcSamples,
          mode: "sparse-arc",
          warnings,
          paintable: !hasReversal,
          quality: {
            class: "sparse-waypoints",
            toleranceM: arcFit.gateM,
            maxJointTurnDeg: maxTurningAngleDeg(arcSamples),
            lengthRatio: srcLen > 1e-9 ? arcLen / srcLen : 1,
            maxSourceDeviationM: maxSourceDeviationM(source, arcSamples),
            corners,
          },
        };
      }
      warnings.push(
        `Surveyed-arc fit rejected by validation (${arcValidation.reasons.join("; ")}); using waypoint fillets.`
      );
    }

    const wp = buildWaypointFilletPath(source, options);
    warnings.push(...wp.warnings);
    const v = validateFittedPath(source, wp.samples, { waypointMode: true });
    if (!v.ok) {
      warnings.push(`Waypoint path validation: ${v.reasons.join("; ")}`);
    }
    const corners = classifySourceCorners(source, { maxFilletM: opts.maxFilletRadiusM });
    for (const w of formatCornerWarnings(corners)) warnings.push(w);
    const hasReversal = corners.some((c) => c.class === "reversal");
    if (hasReversal) {
      warnings.push("Path has a reversal corner — fix the survey or skip this path before Send.");
    }
    const fitLen = polylineLengthM(wp.samples);
    return {
      samples: wp.samples,
      mode: "waypoint-fillet",
      warnings,
      // Sharp corners stay paintable (teardrop at trajectory); only reversal / validation fail.
      paintable: wp.paintable && v.ok && !hasReversal,
      quality: {
        class: "sparse-waypoints",
        toleranceM: CORNER_TOLERANCE_M,
        maxJointTurnDeg: maxTurningAngleDeg(wp.samples),
        lengthRatio: srcLen > 1e-9 ? fitLen / srcLen : 1,
        maxSourceDeviationM: maxSourceDeviationM(source, wp.samples),
        corners,
      },
    };
  }

  // Dense survey path
  const fitToleranceM = options.fitToleranceM ?? estimateAdaptiveTolerance(pts);
  // Clamp noise estimate so it cannot saturate and swallow real corners.
  // When the caller pins fitToleranceM, honor it (tests / advanced overrides).
  const med = medianSpacing(pts);
  const shortestLeg = (() => {
    let m = Infinity;
    for (let i = 1; i < pts.length; i++) m = Math.min(m, dist(pts[i - 1], pts[i]));
    return Number.isFinite(m) ? m : med;
  })();
  const clampedTol =
    options.fitToleranceM != null
      ? fitToleranceM
      : Math.min(
          fitToleranceM,
          ADAPTIVE_TOLERANCE_MAX_M,
          Math.max(ADAPTIVE_TOLERANCE_MIN_M, Math.min(med * 1.0, shortestLeg * 0.35))
        );

  const dense = runDensePipeline(pts, opts, clampedTol);
  let fitted = dense.samples;
  let mode: FittedPathResult["mode"] = "dense-fit";
  let paintable = true;

  // Extent/length against original source; deviation against cleaned (post-spike/jog).
  let validation = validateFittedPath(dense.cleanedSource, fitted, {
    maxDeviationM: Math.max(MAX_FIT_DEVIATION_M * 2, clampedTol * 4),
  });
  // Also reject catastrophic extent explosion vs the original survey envelope.
  const extentVsOriginal = validateFittedPath(source, fitted, {
    maxDeviationM: 1e9, // skip deviation vs raw (jogs intentionally removed)
  });
  if (!extentVsOriginal.ok && extentVsOriginal.reasons.some((r) => /explod|collapsed|length ratio/i.test(r))) {
    validation = {
      ok: false,
      reasons: [...validation.reasons, ...extentVsOriginal.reasons],
    };
  }

  if (!validation.ok) {
    warnings.push(`Dense fit rejected (${validation.reasons.join("; ")}); falling back to waypoint fillets.`);
    const wp = buildWaypointFilletPath(dense.cleanedSource, options);
    warnings.push(...wp.warnings);
    fitted = wp.samples;
    mode = "degraded-fillet";
    paintable = wp.paintable;
    validation = validateFittedPath(dense.cleanedSource, fitted, { waypointMode: true });
    if (!validation.ok) {
      warnings.push(`Fallback validation failed: ${validation.reasons.join("; ")}. Path marked non-paintable.`);
      paintable = false;
      // Last resort: still emit fillet samples — never silent raw polyline.
      if (fitted.length < 2 && dense.cleanedSource.length >= 2) {
        fitted = sampleLine(
          dense.cleanedSource[0],
          dense.cleanedSource[dense.cleanedSource.length - 1],
          opts.sampleSpacingM
        );
        paintable = false;
      }
    }
  }

  // Soft P1: high bare turn is a warning, not always a hard fail (dense roads can be ~7–8°).
  const maxTurn = maxTurningAngleDeg(fitted);
  if (maxTurn > MAX_BARE_TURN_DEG) {
    warnings.push(
      `Path has a max turning angle of ${maxTurn.toFixed(1)}° (target ≤ ${MAX_BARE_TURN_DEG}°).`
    );
  }

  const corners = classifySourceCorners(source, {
    maxFilletM: opts.maxFilletRadiusM,
  });
  for (const w of formatCornerWarnings(corners)) warnings.push(w);
  // Reversal blocks paint; sharp is handled as teardrop at trajectory time.
  if (corners.some((c) => c.class === "reversal")) {
    paintable = false;
    warnings.push("Path has a reversal corner — fix the survey or skip this path before Send.");
  }

  const fitLen = polylineLengthM(fitted);
  return {
    samples: fitted,
    mode,
    warnings,
    paintable,
    quality: {
      class: "dense-survey",
      toleranceM: clampedTol,
      maxJointTurnDeg: maxTurn,
      lengthRatio: srcLen > 1e-9 ? fitLen / srcLen : 1,
      maxSourceDeviationM: maxSourceDeviationM(source, fitted),
      corners,
    },
  };
}

/**
 * Full production pipeline (sample points only — backward compatible).
 * Prefer `buildRoadMarkingFittedPath` when warnings / paintable status are needed.
 */
export function buildRoadMarkingPreviewPoints(
  points: RoadMarkingNedPoint[],
  options: RoadMarkingPathOptions = {}
): RoadMarkingNedPoint[] {
  return buildRoadMarkingFittedPath(points, options).samples;
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
