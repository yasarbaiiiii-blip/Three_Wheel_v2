/**
 * Reference-point snap helper for the Align DXF "Multi-Point Fit" manual-placement flow.
 *
 * The plan is dragged/rotated freely by the user; while it's close to one of the reference
 * points (CSV-imported or tapped), it magnetically snaps onto that point, and the caller shows
 * a Figma/Illustrator-style guide line connecting the point to the plan (see MapViewNative.tsx's
 * `applyPointSnap` / `buildSnapGuideFC`). This module only does the plain-geometry nearest-point
 * search — everything GPS/rendering-related lives in the caller.
 */

export type LocalMeters = { north: number; east: number };

/**
 * Finds the point in `points` closest to `current`, if any lie within `radiusM` — the magnetic
 * snap target (and guide-line anchor) for the Multi-Point Fit manual-placement flow. Returns
 * `null` when `current` isn't finite or nothing qualifies.
 *
 * Generic over `T` (rather than fixed to `LocalMeters`) so a caller can pass richer points (e.g.
 * carrying the original lat/lon alongside north/east) and get the SAME object back — needed to
 * identify which specific reference point is active for highlighting, not just its coordinates.
 */
export function findNearestPointWithinRadius<T extends LocalMeters>(
  current: LocalMeters,
  points: T[],
  radiusM: number
): T | null {
  if (!Number.isFinite(current.north) || !Number.isFinite(current.east)) return null;

  let best: T | null = null;
  let bestDist = radiusM;
  for (const p of points) {
    if (!Number.isFinite(p.north) || !Number.isFinite(p.east)) continue;
    const d = Math.hypot(current.north - p.north, current.east - p.east);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}
