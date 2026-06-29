/**
 * Pure geometry utilities for Phase 2 gesture editing.
 *
 * All functions in this file are:
 * - Framework-free (no React, no Mapbox, no gesture-handler imports)
 * - Pure: same input always produces same output, no side effects
 * - Unit-tested in mapGestureUtils.test.ts
 *
 * Coordinate convention (unchanged throughout the app):
 *   item.x = East metres, item.y = North metres
 *   PlanLine.from.x = North, PlanLine.from.y = East
 * These functions operate on the app's internal North/East metre space.
 */

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type Point2D = { north: number; east: number };

export type BoundingRect = {
  /** East coordinate of the left edge of the playable indent region */
  leftEast: number;
  /** East coordinate of the right edge */
  rightEast: number;
  /** North coordinate of the top edge */
  topNorth: number;
  /** North coordinate of the bottom edge */
  bottomNorth: number;
};

// ─────────────────────────────────────────────────────────────────
// 1. pixelDeltaToMetres
// ─────────────────────────────────────────────────────────────────

/**
 * Convert a screen pixel delta (dx, dy in screen space with Y-down) to
 * north/east metre deltas in the app's local NED frame.
 *
 * Screen space: +x = right = East, +y = down = South (i.e. -North).
 * Metre/pixel ratio is approximated as:
 *   1 pixel ≈ (groundWidth / screenWidth) metres
 * where groundWidth comes from the Mapbox `visibleBounds` span converted
 * to metres using the equirectangular approximation — the same math used
 * throughout this codebase (src/utils/visualAlignment.ts).
 *
 * @param dx - pixel delta in screen-x (positive = East)
 * @param dy - pixel delta in screen-y (positive = down = South = −North)
 * @param metersPerPixel - current ground resolution (metres per screen pixel)
 * @returns { northDelta, eastDelta } in metres
 */
export function pixelDeltaToMetres(
  dx: number,
  dy: number,
  metersPerPixel: number
): { northDelta: number; eastDelta: number } {
  return {
    northDelta: -dy * metersPerPixel, // screen-y down = south = negative north
    eastDelta: dx * metersPerPixel,
  };
}

// ─────────────────────────────────────────────────────────────────
// 2. calculateCentroid
// ─────────────────────────────────────────────────────────────────

/**
 * Calculate the centroid (mean centre) of a set of North/East points.
 * Returns { north: 0, east: 0 } for an empty array.
 */
export function calculateCentroid(points: Point2D[]): Point2D {
  if (points.length === 0) return { north: 0, east: 0 };
  let sumN = 0;
  let sumE = 0;
  for (const p of points) {
    sumN += p.north;
    sumE += p.east;
  }
  return { north: sumN / points.length, east: sumE / points.length };
}

// ─────────────────────────────────────────────────────────────────
// 3. rotateAroundCentroid
// ─────────────────────────────────────────────────────────────────

/**
 * Rotate a set of points by `angleDeltaDeg` degrees (clockwise, as used in
 * the app's rotation convention for placed items) around a given centroid.
 *
 * @param points - array of { north, east } points to rotate
 * @param centroid - pivot point
 * @param angleDeltaDeg - rotation delta in degrees (positive = clockwise)
 * @returns new array of rotated points
 */
export function rotateAroundCentroid(
  points: Point2D[],
  centroid: Point2D,
  angleDeltaDeg: number
): Point2D[] {
  if (angleDeltaDeg === 0) return points.map((p) => ({ ...p }));
  const theta = (angleDeltaDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return points.map((p) => {
    const dn = p.north - centroid.north;
    const de = p.east - centroid.east;
    return {
      north: centroid.north + dn * cos - de * sin,
      east: centroid.east + dn * sin + de * cos,
    };
  });
}

// ─────────────────────────────────────────────────────────────────
// 4. scaleAroundCentroid
// ─────────────────────────────────────────────────────────────────

/**
 * Scale a set of points by `scaleFactor` relative to a given centroid.
 * A factor of 1.0 is a no-op; < 1.0 shrinks; > 1.0 grows.
 *
 * @param points - array of { north, east } points
 * @param centroid - pivot point
 * @param scaleFactor - multiplicative scale factor (must be > 0)
 * @returns new array of scaled points
 */
export function scaleAroundCentroid(
  points: Point2D[],
  centroid: Point2D,
  scaleFactor: number
): Point2D[] {
  if (scaleFactor === 1) return points.map((p) => ({ ...p }));
  return points.map((p) => ({
    north: centroid.north + (p.north - centroid.north) * scaleFactor,
    east: centroid.east + (p.east - centroid.east) * scaleFactor,
  }));
}

// ─────────────────────────────────────────────────────────────────
// 5. clampToIndent
// ─────────────────────────────────────────────────────────────────

/**
 * Clamp an item's centre position so the item (with its half-extents in
 * North and East) stays fully inside the boundary indent playable region.
 *
 * Uses the same logic as the legacy Leaflet WebView `itemsMoved` handler
 * (see MapViewLeaflet.tsx) to maintain parity.
 *
 * @param itemEast - proposed item centre East (x)
 * @param itemNorth - proposed item centre North (y)
 * @param halfWidth - item's half-width in East direction (metres)
 * @param halfHeight - item's half-height in North direction (metres)
 * @param indent - playable region bounds
 * @returns clamped { east, north }
 */
export function clampToIndent(
  itemEast: number,
  itemNorth: number,
  halfWidth: number,
  halfHeight: number,
  indent: BoundingRect
): { east: number; north: number } {
  const east = Math.max(
    indent.leftEast + halfWidth,
    Math.min(itemEast, indent.rightEast - halfWidth)
  );
  const north = Math.max(
    indent.bottomNorth + halfHeight,
    Math.min(itemNorth, indent.topNorth - halfHeight)
  );
  return { east, north };
}

// ─────────────────────────────────────────────────────────────────
// 6. snapDistanceCheck
// ─────────────────────────────────────────────────────────────────

/**
 * Check whether a point is within `thresholdMetres` of a target (the rover).
 * Returns the snapped position if within threshold, null otherwise.
 *
 * @param point - point to test (e.g. a boundary control point)
 * @param target - snap target (e.g. rover position)
 * @param thresholdMetres - snap engagement radius (default 3 m per plan §2.6)
 * @returns `target` if within threshold, `null` if not
 */
export function snapDistanceCheck(
  point: Point2D,
  target: Point2D,
  thresholdMetres = 3
): Point2D | null {
  const dist = Math.hypot(
    point.north - target.north,
    point.east - target.east
  );
  return dist <= thresholdMetres ? target : null;
}
