/**
 * Shape-aware snap points for the Align DXF "Multi-Point Fit" manual-placement flow — AutoCAD-
 * style Endpoint/Midpoint/Center/Quadrant object snaps, derived from the plan's ACTUAL geometry
 * rather than its bounding box.
 *
 * A real DXF plan is rarely one hand-drawn polygon — it's often many segments across several
 * layers (boundary + marking + center-line), hatching, or a multi-pass spray path. To stay
 * robust regardless of that internal complexity, every line's rendered points are pooled into
 * one point cloud, which then reduces to a small, well-defined candidate set:
 *   - A true circle/ellipse (roughly constant radius from a common center once normalized by
 *     its own north/east extents) collapses to its center + 4 quadrant points (N/S/E/W extrema)
 *     — 5 points total — no matter how many segments/tessellated points make it up.
 *   - Anything else collapses to its 2D convex hull: N corners + N edge-midpoints + 1 overall
 *     center (2N+1 points), so a rectangle gives 9, a triangle 7, a pentagon 11, and an
 *     irregular multi-segment spray path collapses to whatever its outer boundary corners are —
 *     always a small, stable set, never one candidate per internal segment.
 *
 * Path scaffolding is excluded: PRE/AFT extension run-ups, inter-shape transit, and virtual
 * boundary aids must NOT enter the hull. Survey CSV refs land on field/plan corners; including
 * extension tips made Multi-Point Fit snap "slightly off" to where the extension finished.
 */
import type { PlanLine } from "../types/plan";
import { getPlanLineRenderPoints } from "./curveGeometry";

export type LocalMeters = { north: number; east: number };

/**
 * True for design/spray geometry that should define Multi-Point Fit object snaps.
 * Generated path scaffolding (extensions, transit, virtual boundary) is visual/path context
 * only — never a snap target for uploaded survey refs.
 */
export function isPlanSnapGeometryLine(line: PlanLine): boolean {
  const layer = line.layer;
  if (layer === "extension" || layer === "transit" || layer === "virtual_boundary") {
    return false;
  }
  // Defense if a stub was mis-tagged but still uses client-built ids.
  const id = String(line.id ?? "");
  if (
    id.startsWith("ext-pre-") ||
    id.startsWith("ext-aft-") ||
    id.startsWith("runtime-transit-") ||
    id.startsWith("transit-")
  ) {
    return false;
  }
  return true;
}

/**
 * Below this UNIQUE point count, a "good" circle/ellipse fit proves nothing — a regular polygon
 * (hexagon, octagon, ...) has ALL its vertices on a circumscribed circle by definition, so radial
 * variance alone can't tell them apart. What actually distinguishes them is density: a real
 * circle/arc entity is tessellated into dozens to hundreds of points (see CURVE_SAMPLE_STEPS /
 * MAP_CIRCLE_STEPS in curveGeometry.ts), while even a generously many-sided hand-drawn field
 * boundary tops out around a dozen or two real vertices. This threshold sits comfortably above
 * any realistic polygon vertex count and comfortably below any real tessellated curve.
 */
const MIN_POINTS_FOR_ELLIPSE_FIT = 32;
/** How tightly the point cloud must hug a common (normalized) radius to count as an ellipse. */
const ELLIPSE_FIT_MAX_COEFFICIENT_OF_VARIATION = 0.12;
const DEDUPE_EPSILON_M = 1e-4;

function collectPointCloud(lines: PlanLine[]): LocalMeters[] {
  const points: LocalMeters[] = [];
  for (const line of lines) {
    for (const pt of getPlanLineRenderPoints(line, true)) {
      if (Number.isFinite(pt.north) && Number.isFinite(pt.east)) {
        points.push({ north: pt.north, east: pt.east });
      }
    }
  }
  return points;
}

function dedupe(points: LocalMeters[]): LocalMeters[] {
  const out: LocalMeters[] = [];
  for (const p of points) {
    const isDuplicate = out.some(
      (q) => Math.abs(q.north - p.north) < DEDUPE_EPSILON_M && Math.abs(q.east - p.east) < DEDUPE_EPSILON_M
    );
    if (!isDuplicate) out.push(p);
  }
  return out;
}

/**
 * Fits an axis-aligned circle/ellipse to `points` if they closely follow one (constant
 * normalized radius from a common center) — a true circle is just the special case where the
 * two radii are equal. Returns null when the fit isn't good enough (it's a real polygon, not a
 * curve) or there aren't enough points to trust the fit.
 */
function fitAxisAlignedEllipse(
  points: LocalMeters[]
): { centerNorth: number; centerEast: number; radiusNorth: number; radiusEast: number } | null {
  if (points.length < MIN_POINTS_FOR_ELLIPSE_FIT) return null;

  let minNorth = Infinity;
  let maxNorth = -Infinity;
  let minEast = Infinity;
  let maxEast = -Infinity;
  for (const p of points) {
    if (p.north < minNorth) minNorth = p.north;
    if (p.north > maxNorth) maxNorth = p.north;
    if (p.east < minEast) minEast = p.east;
    if (p.east > maxEast) maxEast = p.east;
  }
  const centerNorth = (minNorth + maxNorth) / 2;
  const centerEast = (minEast + maxEast) / 2;
  const radiusNorth = (maxNorth - minNorth) / 2;
  const radiusEast = (maxEast - minEast) / 2;
  if (!(radiusNorth > 0) || !(radiusEast > 0)) return null;

  const normalizedRadii = points.map((p) =>
    Math.hypot((p.north - centerNorth) / radiusNorth, (p.east - centerEast) / radiusEast)
  );
  const mean = normalizedRadii.reduce((sum, r) => sum + r, 0) / normalizedRadii.length;
  if (!(mean > 0)) return null;
  const variance = normalizedRadii.reduce((sum, r) => sum + (r - mean) ** 2, 0) / normalizedRadii.length;
  const coefficientOfVariation = Math.sqrt(variance) / mean;
  if (coefficientOfVariation > ELLIPSE_FIT_MAX_COEFFICIENT_OF_VARIATION) return null;

  return { centerNorth, centerEast, radiusNorth, radiusEast };
}

function crossProduct(o: LocalMeters, a: LocalMeters, b: LocalMeters): number {
  return (a.east - o.east) * (b.north - o.north) - (a.north - o.north) * (b.east - o.east);
}

/**
 * 2D convex hull (monotone chain / Andrew's algorithm), returned in order, collinear points
 * dropped — reduces an arbitrarily large/complex point cloud to its true outer corners in
 * O(n log n), so a boundary re-traced by hundreds of internal spray-path segments still yields
 * just its real corners, not one candidate per segment.
 */
function convexHull(points: LocalMeters[]): LocalMeters[] {
  const unique = dedupe(points);
  if (unique.length <= 2) return unique;

  const sorted = [...unique].sort((a, b) => a.east - b.east || a.north - b.north);

  const lower: LocalMeters[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: LocalMeters[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Computes the shape-aware snap candidates for a plan's geometry: a circle/ellipse yields its
 * center + 4 quadrant points (5); any other shape yields its convex hull's corners + edge-
 * midpoints + overall center (2N+1). Returns an empty array for an empty plan, and a single
 * point for a fully degenerate (all-coincident) one.
 *
 * Extension / transit / virtual_boundary lines are filtered out first so enabling DXF
 * extensions never moves snap magnets onto run-up/run-out tips.
 */
export function computeShapeSnapPoints(lines: PlanLine[]): LocalMeters[] {
  if (lines.length === 0) return [];
  const geometryLines = lines.filter(isPlanSnapGeometryLine);
  if (geometryLines.length === 0) return [];
  // Dedupe up front — shared vertices between adjacent segments would otherwise double-count
  // toward MIN_POINTS_FOR_ELLIPSE_FIT and skew nothing (duplicates don't affect variance) but
  // waste work; convexHull's own internal dedupe then becomes a cheap no-op on this input.
  const cloud = dedupe(collectPointCloud(geometryLines));
  if (cloud.length === 0) return [];

  const ellipse = fitAxisAlignedEllipse(cloud);
  if (ellipse) {
    const { centerNorth, centerEast, radiusNorth, radiusEast } = ellipse;
    return [
      { north: centerNorth, east: centerEast },
      { north: centerNorth - radiusNorth, east: centerEast },
      { north: centerNorth + radiusNorth, east: centerEast },
      { north: centerNorth, east: centerEast - radiusEast },
      { north: centerNorth, east: centerEast + radiusEast },
    ];
  }

  const hull = convexHull(cloud);
  if (hull.length <= 1) return hull;

  const n = hull.length;
  let centerNorth = 0;
  let centerEast = 0;
  for (const p of hull) {
    centerNorth += p.north;
    centerEast += p.east;
  }
  centerNorth /= n;
  centerEast /= n;

  const points: LocalMeters[] = [...hull];
  const edgeCount = n === 2 ? 1 : n; // a 2-point hull has exactly one distinct edge, not two
  for (let i = 0; i < edgeCount; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    points.push({ north: (a.north + b.north) / 2, east: (a.east + b.east) / 2 });
  }
  points.push({ north: centerNorth, east: centerEast });

  return dedupe(points);
}
