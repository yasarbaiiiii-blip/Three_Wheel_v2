/**
 * Shared bake transform for PlanLine geometry.
 *
 * Every site that moves a plan into a new frame (Fix Alignment affine,
 * stopPlanEditing sticker bake, auto-origin translation) MUST run through
 * this helper so `from`/`to`, `preview_points`, curve `entity.geometry`, and
 * extension previews stay frame-consistent.
 *
 * Why: map circle/arc rendering reads `entity.geometry` first via
 * `getCurveGeometry` (see curveGeometry.ts). Baking only endpoints +
 * preview_points left the center stale and produced a visible post-bake shift.
 */

import type { DxfEntity, DxfPoint, PlanLine } from "../types/plan";
import {
  getCurveGeometry,
  isCircleEntity,
  type CurveGeometry,
} from "./curveGeometry";

/** NED point map used by all bake sites (affine, sticker, pure translation). */
export type PlanPointTransform = (
  north: number,
  east: number
) => { north: number; east: number };

const FULL_CIRCLE_SWEEP = 360;
const FULL_CIRCLE_EPS_DEG = 1e-3;

function transformDxfPoint(pt: DxfPoint, transformPt: PlanPointTransform): DxfPoint {
  const next = transformPt(pt.north, pt.east);
  return { ...pt, north: next.north, east: next.east };
}

/**
 * Map the `north`/`east` fields of a loosely-typed geometry record (source_points
 * rows, corner metadata) through `transformPt`, preserving every other field.
 * Leaves the record untouched if it doesn't carry finite north/east.
 */
function transformNedRecord<T extends Record<string, unknown>>(
  record: T,
  transformPt: PlanPointTransform
): T {
  const north = record.north;
  const east = record.east;
  if (typeof north !== "number" || typeof east !== "number" || !Number.isFinite(north) || !Number.isFinite(east)) {
    return record;
  }
  const next = transformPt(north, east);
  return { ...record, north: next.north, east: next.east };
}

/**
 * Bake `source_points` (raw CSV survey rows — Anchor candidates) and `corners`
 * (fitter corner metadata — the map's corner-point layer) inside `geometry`, if
 * present. Both are plain NED point arrays stored alongside, not derived from,
 * `preview_points`, so they need their own pass through the same transform.
 */
function transformGeometryNedArrays(geometry: unknown, transformPt: PlanPointTransform): unknown {
  if (!geometry || typeof geometry !== "object") return geometry;
  const record = geometry as Record<string, unknown>;
  const sourcePoints = record.source_points;
  const corners = record.corners;
  const nextSourcePoints = Array.isArray(sourcePoints)
    ? sourcePoints.map((p) => transformNedRecord(p as Record<string, unknown>, transformPt))
    : sourcePoints;
  const nextCorners = Array.isArray(corners)
    ? corners.map((c) => transformNedRecord(c as Record<string, unknown>, transformPt))
    : corners;
  if (nextSourcePoints === sourcePoints && nextCorners === corners) return geometry;
  return {
    ...record,
    ...(Array.isArray(sourcePoints) ? { source_points: nextSourcePoints } : {}),
    ...(Array.isArray(corners) ? { corners: nextCorners } : {}),
  };
}

/**
 * Angle convention matches `curvePointAtAngle`:
 *   north = centerN + r * sin(α)
 *   east  = centerE + r * cos(α)
 * so α = atan2(north, east) in degrees.
 */
function angleFromRelativeNed(north: number, east: number): number {
  return (Math.atan2(north, east) * 180) / Math.PI;
}

function isFullCircleSweep(curve: CurveGeometry, line: PlanLine): boolean {
  if (isCircleEntity(line)) return true;
  const sweep = curve.endAngle - curve.startAngle;
  return Math.abs(sweep - FULL_CIRCLE_SWEEP) <= FULL_CIRCLE_EPS_DEG || sweep >= FULL_CIRCLE_SWEEP - FULL_CIRCLE_EPS_DEG;
}

/**
 * Transform explicit curve geometry so `getCurveGeometry` stays valid after a bake.
 * Center is mapped; radius and arc angles are recovered from transformed sample points
 * so rotation + scale (similarity) stay consistent without a separate rotationDeg arg.
 */
export function transformCurveGeometry(
  curve: CurveGeometry,
  transformPt: PlanPointTransform,
  line: PlanLine
): CurveGeometry {
  const center = transformPt(curve.centerNorth, curve.centerEast);

  const startRad = (curve.startAngle * Math.PI) / 180;
  const endRad = (curve.endAngle * Math.PI) / 180;

  const startLocal = {
    north: curve.centerNorth + curve.radius * Math.sin(startRad),
    east: curve.centerEast + curve.radius * Math.cos(startRad),
  };
  const endLocal = {
    north: curve.centerNorth + curve.radius * Math.sin(endRad),
    east: curve.centerEast + curve.radius * Math.cos(endRad),
  };

  const startT = transformPt(startLocal.north, startLocal.east);
  const endT = transformPt(endLocal.north, endLocal.east);

  const sn = startT.north - center.north;
  const se = startT.east - center.east;
  const en = endT.north - center.north;
  const ee = endT.east - center.east;

  const radiusFromStart = Math.hypot(sn, se);
  const radiusFromEnd = Math.hypot(en, ee);
  const newRadius =
    Number.isFinite(radiusFromStart) && radiusFromStart > 0
      ? radiusFromStart
      : Number.isFinite(radiusFromEnd) && radiusFromEnd > 0
        ? radiusFromEnd
        : curve.radius;

  const newStart = angleFromRelativeNed(sn, se);
  let newEnd = angleFromRelativeNed(en, ee);

  if (isFullCircleSweep(curve, line)) {
    newEnd = newStart + FULL_CIRCLE_SWEEP;
  } else {
    // Preserve original sweep magnitude and direction under similarity transforms.
    const oldSweep = curve.endAngle - curve.startAngle;
    let newSweep = newEnd - newStart;
    // Unwrap so the signed sweep stays in a comparable range.
    while (newSweep - oldSweep > 180) newSweep -= 360;
    while (oldSweep - newSweep > 180) newSweep += 360;
    // Prefer magnitude from the original sweep when transform is orientation-preserving.
    if (Math.abs(Math.abs(newSweep) - Math.abs(oldSweep)) > 1e-3 && Math.abs(oldSweep) > FULL_CIRCLE_EPS_DEG) {
      // Keep measured newStart; rebuild end from old sweep sign when scale flipped poorly.
      const measuredMag = Math.abs(newSweep);
      const targetMag = Math.abs(oldSweep);
      if (Math.abs(measuredMag - targetMag) > 1.0) {
        newSweep = Math.sign(oldSweep || 1) * targetMag;
      }
    }
    newEnd = newStart + newSweep;
  }

  return {
    centerNorth: center.north,
    centerEast: center.east,
    radius: newRadius,
    startAngle: newStart,
    endAngle: newEnd,
  };
}

/**
 * Write transformed curve back into entity.geometry in the canonical NED field
 * names that `readGeometryFields` prefers first, and keep a matching `center`
 * tuple so backend-style readers stay consistent.
 */
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
    // Backend tuple form is [north, east] (see curveGeometry readGeometryFields).
    center: [curve.centerNorth, curve.centerEast],
    // Clear legacy DXF-axis aliases so they cannot outrank the updated NED fields
    // if a future reader reorders preference (cx=east, cy=north historically).
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

/**
 * Apply `transformPt` to every geometric channel on a PlanLine that map
 * rendering and snap tools can read.
 */
export function transformPlanLineGeometry(
  line: PlanLine,
  transformPt: PlanPointTransform
): PlanLine {
  const fromT = transformPt(line.from.x, line.from.y);
  const toT = transformPt(line.to.x, line.to.y);

  let entity = line.entity;
  if (entity) {
    const curve = getCurveGeometry(line);
    let geometry = entity.geometry;

    if (curve) {
      const nextCurve = transformCurveGeometry(curve, transformPt, line);
      geometry = writeCurveGeometry(entity, nextCurve);
    }

    geometry = transformGeometryNedArrays(geometry, transformPt);

    const preview_points = Array.isArray(entity.preview_points)
      ? entity.preview_points.map((pt) => transformDxfPoint(pt, transformPt))
      : entity.preview_points;

    let extension_preview = entity.extension_preview;
    if (extension_preview) {
      extension_preview = {
        ...extension_preview,
        pre_points: Array.isArray(extension_preview.pre_points)
          ? extension_preview.pre_points.map((pt) => transformDxfPoint(pt, transformPt))
          : extension_preview.pre_points,
        aft_points: Array.isArray(extension_preview.aft_points)
          ? extension_preview.aft_points.map((pt) => transformDxfPoint(pt, transformPt))
          : extension_preview.aft_points,
      };
    }

    entity = {
      ...entity,
      ...(geometry !== undefined ? { geometry } : {}),
      preview_points,
      ...(extension_preview ? { extension_preview } : {}),
    };
  }

  return {
    ...line,
    from: { ...line.from, x: fromT.north, y: fromT.east },
    to: { ...line.to, x: toT.north, y: toT.east },
    ...(entity ? { entity } : {}),
  };
}

/** Map a list of lines through the shared bake helper. */
export function transformPlanLinesGeometry(
  lines: PlanLine[],
  transformPt: PlanPointTransform
): PlanLine[] {
  return lines.map((line) => transformPlanLineGeometry(line, transformPt));
}

/** Convenience: build a pure NED translation transform. */
export function translationTransform(
  dNorth: number,
  dEast: number
): PlanPointTransform {
  return (north, east) => ({ north: north + dNorth, east: east + dEast });
}

/**
 * Similarity transform matching visual sticker / backend affine:
 *   n' = (n * cos − e * sin) * scale + offsetN
 *   e' = (n * sin + e * cos) * scale + offsetE
 */
export function similarityTransform(opts: {
  rotationDeg: number;
  scale?: number;
  offsetN?: number;
  offsetE?: number;
}): PlanPointTransform {
  const scale = opts.scale ?? 1;
  const offsetN = opts.offsetN ?? 0;
  const offsetE = opts.offsetE ?? 0;
  const rad = (opts.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return (north, east) => {
    const sn = north * scale;
    const se = east * scale;
    return {
      north: sn * cos - se * sin + offsetN,
      east: sn * sin + se * cos + offsetE,
    };
  };
}

