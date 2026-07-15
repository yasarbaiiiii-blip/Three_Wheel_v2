/**
 * Grid + snap helpers for the Align DXF "Multi-Point Fit" manual-placement flow.
 *
 * The grid is anchored to the user's reference points (CSV-imported or tapped), NOT to the
 * DXF drawing's own coordinate system — it exists purely to help the user judge scale and
 * position while dragging the plan on the map. All math here operates in a single flat
 * "local metres" frame (north/east) relative to the CURRENT drag session's projection
 * origin; converting into/out of that frame is the caller's job (see MapViewNative.tsx).
 *
 * The grid is also ROTATED to match the reference points' own dominant orientation (see
 * `computeOrientationDeg`) instead of always being compass-aligned — real-world field
 * boundaries are rarely square to true north, and a fixed north/east grid would cross them
 * diagonally, defeating its purpose as a placement aid.
 */
import { snapToGrid as snapVertexToGrid } from "./designSnap";

export type LocalMeters = { north: number; east: number };

export type GridBounds = {
  minNorth: number;
  maxNorth: number;
  minEast: number;
  maxEast: number;
  spacing: number;
  /**
   * Bearing (degrees, clockwise from true north) the grid is rotated to so it runs
   * parallel/perpendicular to the reference points' own layout instead of always being
   * compass-aligned — see `computeOrientationDeg`. 0 = compass-aligned (the fallback for
   * <2 points or a point cloud with no clear dominant axis).
   *
   * minNorth/maxNorth/minEast/maxEast above are expressed in the ROTATED "grid-local" frame
   * (rotate a world point by -orientationDeg around `pivot` to get its grid-local position).
   * `buildGridLineSegments` and `findSnapTarget` convert back to world local-metres
   * internally, so callers never need to do this rotation themselves. Optional so a
   * hand-built bounds literal (e.g. in tests) defaults to a plain compass-aligned grid.
   */
  orientationDeg?: number;
  /** Pivot (world local-metres) the rotation above happens around — the point cloud centroid. */
  pivot?: LocalMeters;
};

/**
 * Estimates the reference points' own dominant orientation (bearing, degrees clockwise from
 * true north) via PCA on their local-metres positions, so the grid can be rotated to match
 * how the field/survey points actually lay out — real-world field boundaries are rarely
 * square to true north, and a compass-aligned grid crosses them diagonally, which defeats
 * the whole point of using it as a placement aid. Returns 0 (compass-aligned fallback) when
 * there are fewer than 2 points, or the point cloud has no clear dominant axis (e.g. a
 * perfectly square/circular arrangement — genuinely ambiguous under a variance-based fit).
 */
export function computeOrientationDeg(points: LocalMeters[]): number {
  const pts = points.filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east));
  if (pts.length < 2) return 0;

  const n = pts.length;
  let meanNorth = 0;
  let meanEast = 0;
  for (const p of pts) {
    meanNorth += p.north;
    meanEast += p.east;
  }
  meanNorth /= n;
  meanEast /= n;

  let covNN = 0;
  let covEE = 0;
  let covNE = 0;
  for (const p of pts) {
    const dn = p.north - meanNorth;
    const de = p.east - meanEast;
    covNN += dn * dn;
    covEE += de * de;
    covNE += dn * de;
  }

  // No dominant axis (isotropic spread) — stay compass-aligned rather than pick an arbitrary angle.
  if (Math.abs(covNE) < 1e-9 && Math.abs(covNN - covEE) < 1e-9) return 0;

  // Principal-axis angle of the 2x2 covariance matrix, measured the same way as a compass
  // bearing (clockwise from north) — matches PlanLine/PlacedItem's rotation convention.
  const bearingRad = 0.5 * Math.atan2(2 * covNE, covNN - covEE);
  return (bearingRad * 180) / Math.PI;
}

/** Rotates a local-metres point around `pivot` by `deg` (bearing convention: positive =
 *  clockwise from north), matching `transformVisualDxfPoint`'s rotation direction. */
function rotateAroundPivot(point: LocalMeters, pivot: LocalMeters, deg: number): LocalMeters {
  if (!deg) return point;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dn = point.north - pivot.north;
  const de = point.east - pivot.east;
  return {
    north: dn * cos - de * sin + pivot.north,
    east: dn * sin + de * cos + pivot.east,
  };
}

/**
 * Picks a "nice" grid spacing (1/2/5 × 10^n) for a given span, aiming for roughly
 * `targetDivisions` grid lines across it — the same rounding approach chart/graph axis
 * tick labels use, so the grid never shows an arbitrary spacing like "0.37m".
 */
export function pickNiceGridSpacing(spanMeters: number, targetDivisions = 8): number {
  if (!Number.isFinite(spanMeters) || spanMeters <= 0) return 1;
  const rough = spanMeters / Math.max(targetDivisions, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const niceNormalized = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/**
 * Bounding box of a set of points (local metres), expanded by a margin so the grid extends
 * beyond the points themselves — the user explicitly needs to place the plan either inside
 * or outside the point cluster, not just exactly on top of it.
 */
export function computeGridBounds(
  points: LocalMeters[],
  opts?: { marginFactor?: number; minMarginM?: number; targetDivisions?: number }
): GridBounds | null {
  const finitePoints = points.filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east));
  if (finitePoints.length === 0) return null;

  const pivot = {
    north: finitePoints.reduce((sum, p) => sum + p.north, 0) / finitePoints.length,
    east: finitePoints.reduce((sum, p) => sum + p.east, 0) / finitePoints.length,
  };
  const orientationDeg = computeOrientationDeg(finitePoints);
  // Bring the points into the grid's own (rotated) frame so the bounding box below hugs
  // their natural layout instead of the true-north-aligned diagonal extent.
  const localPoints = finitePoints.map((p) => rotateAroundPivot(p, pivot, -orientationDeg));

  let minNorth = Infinity;
  let maxNorth = -Infinity;
  let minEast = Infinity;
  let maxEast = -Infinity;
  for (const p of localPoints) {
    if (p.north < minNorth) minNorth = p.north;
    if (p.north > maxNorth) maxNorth = p.north;
    if (p.east < minEast) minEast = p.east;
    if (p.east > maxEast) maxEast = p.east;
  }

  const spanNorth = maxNorth - minNorth;
  const spanEast = maxEast - minEast;
  const span = Math.max(spanNorth, spanEast, 1);
  const spacing = pickNiceGridSpacing(span, opts?.targetDivisions ?? 8);
  const marginFactor = opts?.marginFactor ?? 0.75;
  const minMarginM = opts?.minMarginM ?? 2;
  const margin = Math.max(span * marginFactor, minMarginM, spacing * 2);

  return {
    minNorth: minNorth - margin,
    maxNorth: maxNorth + margin,
    minEast: minEast - margin,
    maxEast: maxEast + margin,
    spacing,
    orientationDeg,
    pivot,
  };
}

const MAX_GRID_LINES = 400; // hard safety cap — never build a pathologically huge grid

/** Builds the grid's line segments (world local metres) for rendering as map polylines. */
export function buildGridLineSegments(bounds: GridBounds): Array<[LocalMeters, LocalMeters]> {
  const { minNorth, maxNorth, minEast, maxEast, spacing } = bounds;
  if (!Number.isFinite(spacing) || spacing <= 0) return [];

  const orientationDeg = bounds.orientationDeg ?? 0;
  const pivot = bounds.pivot ?? { north: 0, east: 0 };
  const toWorld = (p: LocalMeters): LocalMeters => rotateAroundPivot(p, pivot, orientationDeg);

  const segments: Array<[LocalMeters, LocalMeters]> = [];
  const startNorth = Math.ceil(minNorth / spacing) * spacing;
  for (let n = startNorth; n <= maxNorth && segments.length < MAX_GRID_LINES; n += spacing) {
    segments.push([
      toWorld({ north: n, east: minEast }),
      toWorld({ north: n, east: maxEast }),
    ]);
  }
  const startEast = Math.ceil(minEast / spacing) * spacing;
  for (let e = startEast; e <= maxEast && segments.length < MAX_GRID_LINES; e += spacing) {
    segments.push([
      toWorld({ north: minNorth, east: e }),
      toWorld({ north: maxNorth, east: e }),
    ]);
  }
  return segments;
}

/** Quantizes a local-metres point to the nearest grid intersection. */
export function snapPointToGrid(point: LocalMeters, spacing: number): LocalMeters {
  const snapped = snapVertexToGrid({ northM: point.north, eastM: point.east }, spacing);
  return { north: snapped.northM, east: snapped.eastM };
}

/** Snaps a rotation (degrees) to the nearest increment (e.g. 15°). No-op for increment <= 0. */
export function snapRotationDeg(rotationDeg: number, incrementDeg: number): number {
  if (!Number.isFinite(rotationDeg)) return rotationDeg;
  if (!Number.isFinite(incrementDeg) || incrementDeg <= 0) return rotationDeg;
  return Math.round(rotationDeg / incrementDeg) * incrementDeg;
}

/**
 * Finds the best snap target for `current`: an explicit reference point within
 * `pointSnapRadiusM` wins (precise point-to-point alignment), otherwise falls back to the
 * nearest grid intersection when `bounds` is given. Returns null when there's nothing to
 * snap to (no nearby point and no grid), so the caller can leave the position untouched.
 */
export function findSnapTarget(
  current: LocalMeters,
  points: LocalMeters[],
  bounds: GridBounds | null,
  pointSnapRadiusM: number
): LocalMeters | null {
  if (!Number.isFinite(current.north) || !Number.isFinite(current.east)) return null;

  let best: LocalMeters | null = null;
  let bestDist = pointSnapRadiusM;
  for (const p of points) {
    if (!Number.isFinite(p.north) || !Number.isFinite(p.east)) continue;
    const d = Math.hypot(current.north - p.north, current.east - p.east);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (best) return best;
  if (bounds && Number.isFinite(bounds.spacing) && bounds.spacing > 0) {
    const orientationDeg = bounds.orientationDeg ?? 0;
    const pivot = bounds.pivot ?? { north: 0, east: 0 };
    // Snap in the grid's own (possibly rotated) frame, then rotate the result back —
    // rounding world north/east directly would snap to a compass grid even when the
    // rendered grid (and the points it's anchored to) is rotated to match the points.
    const gridLocal = rotateAroundPivot(current, pivot, -orientationDeg);
    const snappedLocal = snapPointToGrid(gridLocal, bounds.spacing);
    return rotateAroundPivot(snappedLocal, pivot, orientationDeg);
  }
  return null;
}
