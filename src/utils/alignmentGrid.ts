/**
 * Grid + snap helpers for the Align DXF "Multi-Point Fit" manual-placement flow.
 *
 * The grid is anchored to the user's reference points (CSV-imported or tapped), NOT to the
 * DXF drawing's own coordinate system — it exists purely to help the user judge scale and
 * position while dragging the plan on the map. All math here operates in a single flat
 * "local metres" frame (north/east) relative to the CURRENT drag session's projection
 * origin; converting into/out of that frame is the caller's job (see MapViewNative.tsx).
 */
import { snapToGrid as snapVertexToGrid } from "./designSnap";

export type LocalMeters = { north: number; east: number };

export type GridBounds = {
  minNorth: number;
  maxNorth: number;
  minEast: number;
  maxEast: number;
  spacing: number;
};

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

  let minNorth = Infinity;
  let maxNorth = -Infinity;
  let minEast = Infinity;
  let maxEast = -Infinity;
  for (const p of finitePoints) {
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
  };
}

const MAX_GRID_LINES = 400; // hard safety cap — never build a pathologically huge grid

/** Builds the grid's line segments (in local metres) for rendering as map polylines. */
export function buildGridLineSegments(bounds: GridBounds): Array<[LocalMeters, LocalMeters]> {
  const { minNorth, maxNorth, minEast, maxEast, spacing } = bounds;
  if (!Number.isFinite(spacing) || spacing <= 0) return [];

  const segments: Array<[LocalMeters, LocalMeters]> = [];
  const startNorth = Math.ceil(minNorth / spacing) * spacing;
  for (let n = startNorth; n <= maxNorth && segments.length < MAX_GRID_LINES; n += spacing) {
    segments.push([
      { north: n, east: minEast },
      { north: n, east: maxEast },
    ]);
  }
  const startEast = Math.ceil(minEast / spacing) * spacing;
  for (let e = startEast; e <= maxEast && segments.length < MAX_GRID_LINES; e += spacing) {
    segments.push([
      { north: minNorth, east: e },
      { north: maxNorth, east: e },
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
    return snapPointToGrid(current, bounds.spacing);
  }
  return null;
}
