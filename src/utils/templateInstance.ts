/**
 * Placed template / character instances on the Fields map.
 *
 * A placed sign or string is one Upload file (lineIdPrefix) plus an instance
 * transform. Source strokes stay in local drawing space; bake applies the same
 * NED sticker transform as Move/Rotate Plan so drag / scale / rotate match.
 */

import { prefixDxfLineIds } from "./dxfLocalImport";
import { extractTemplateLocalPolyline } from "./csvTemplatePlacement";
import { transformVisualDxfPoint } from "./visualAlignment";
import type { PlanLine } from "../types/plan";
import type { PlacedTemplateInstance, UploadedFileEntry } from "../types/uploadedFiles";

export type TemplatePose = {
  north: number;
  east: number;
  rotationDeg: number;
  scale: number;
};

/** Axis-aligned center of local drawing strokes (x right, y up). */
export function localTemplateCentroid(sourceLines: PlanLine[]): { x: number; y: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const line of sourceLines) {
    for (const [x, y] of extractTemplateLocalPolyline(line)) {
      any = true;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!any) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Convert generator strokes into centered plan-frame lines (x=north, y=east).
 * Design origin is the drawing centroid so sticker rotate/scale match bake.
 */
export function toCenteredPlanFrameLines(sourceLines: PlanLine[]): PlanLine[] {
  const center = localTemplateCentroid(sourceLines);
  return sourceLines.map((line, index) => {
    const local = extractTemplateLocalPolyline(line);
    if (local.length < 2) return line;
    const pts = local.map(([x, y]) => ({
      north: y - center.y,
      east: x - center.x,
    }));
    const first = pts[0];
    const last = pts[pts.length - 1];
    const id = line.id || `tpl-${index}`;
    return {
      ...line,
      id,
      from: { id: 1, x: first.north, y: first.east },
      to: { id: 2, x: last.north, y: last.east },
      entity: {
        entity_id: id,
        entity_type: pts.length > 2 ? "LWPOLYLINE" : "LINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 0,
        geometry: { source: "template" },
        preview_points: pts,
      },
    };
  });
}

function poseItem(pose: TemplatePose) {
  const scale = Number.isFinite(pose.scale) && pose.scale > 0 ? pose.scale : 1;
  return {
    x: pose.east,
    y: pose.north,
    rotation: pose.rotationDeg || 0,
    scale,
  };
}

function applyPoseToPlanLines(
  sourceNed: PlanLine[],
  pose: TemplatePose,
  idPrefix: string,
  labelPrefix: string
): PlanLine[] {
  const item = poseItem(pose);
  const out: PlanLine[] = [];
  sourceNed.forEach((line, index) => {
    const src =
      line.entity?.preview_points && line.entity.preview_points.length >= 2
        ? line.entity.preview_points
        : line.from && line.to
          ? [
              { north: line.from.x, east: line.from.y },
              { north: line.to.x, east: line.to.y },
            ]
          : [];
    if (src.length < 2) return;
    const world = src.map((pt) => transformVisualDxfPoint(pt.north, pt.east, item));
    const first = world[0];
    const last = world[world.length - 1];
    let length_m = 0;
    for (let i = 1; i < world.length; i++) {
      length_m += Math.hypot(
        world[i].north - world[i - 1].north,
        world[i].east - world[i - 1].east
      );
    }
    const id = `${idPrefix}-s${index}`;
    out.push({
      ...line,
      id,
      label:
        line.label && line.label !== "Sign Line"
          ? `${labelPrefix}: ${line.label}`
          : `${labelPrefix} ${index + 1}`,
      layer: "marking",
      from: { id: 1, x: first.north, y: first.east },
      to: { id: 2, x: last.north, y: last.east },
      width: line.width ?? 0.1,
      is_mark: true,
      entity: {
        entity_id: id,
        entity_type: world.length > 2 ? "LWPOLYLINE" : "LINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m,
        geometry: {
          closed: false,
          road_marking: true,
          source: "template",
          vertexCount: world.length,
        },
        preview_points: world,
      },
    });
  });
  return out;
}

/** Bake instance source + pose into mission-frame mark lines (prefixed). */
export function bakeTemplateInstance(instance: PlacedTemplateInstance): PlanLine[] {
  const local = toCenteredPlanFrameLines(instance.sourceLines);
  const placed = applyPoseToPlanLines(
    local,
    {
      north: instance.north,
      east: instance.east,
      rotationDeg: instance.rotationDeg,
      scale: instance.scale,
    },
    "s",
    instance.fileName
  );
  return prefixDxfLineIds(placed, instance.lineIdPrefix);
}

export function ghostLinesForPose(
  sourceLines: PlanLine[],
  pose: TemplatePose,
  idPrefix = "ghost-tpl"
): PlanLine[] {
  const local = toCenteredPlanFrameLines(sourceLines);
  return applyPoseToPlanLines(local, pose, idPrefix, "Ghost");
}

export function replacePrefixedLines(
  lines: PlanLine[],
  prefix: string,
  nextPrefixed: PlanLine[]
): PlanLine[] {
  const token = `${prefix}__`;
  const kept = lines.filter((line) => !line.id.startsWith(token) && !line.id.startsWith(`${prefix}-`));
  const boundary = kept.filter((line) => line.layer === "virtual_boundary");
  const rest = kept.filter((line) => line.layer !== "virtual_boundary");
  return [...boundary, ...rest, ...nextPrefixed];
}

export function removePrefixedLines(lines: PlanLine[], prefix: string): PlanLine[] {
  const token = `${prefix}__`;
  return lines.filter((line) => !line.id.startsWith(token) && !line.id.startsWith(`${prefix}-`));
}

export function prefixOfLineId(lineId: string): string | null {
  const sep = lineId.indexOf("__");
  if (sep <= 0) return null;
  return lineId.slice(0, sep);
}

export function instanceForLineId(
  instances: PlacedTemplateInstance[],
  lineId: string | null | undefined
): PlacedTemplateInstance | null {
  if (!lineId) return null;
  const prefix = prefixOfLineId(lineId);
  if (prefix) {
    const byPrefix = instances.find((item) => item.lineIdPrefix === prefix);
    if (byPrefix) return byPrefix;
  }
  return instances.find((item) => lineId.startsWith(`${item.lineIdPrefix}-`)) ?? null;
}

export function hitTestTemplateInstance(
  instances: PlacedTemplateInstance[],
  bakedByPrefix: Map<string, PlanLine[]>,
  north: number,
  east: number,
  radiusM: number
): PlacedTemplateInstance | null {
  let best: PlacedTemplateInstance | null = null;
  let bestDist = radiusM;
  for (const instance of instances) {
    const baked = bakedByPrefix.get(instance.lineIdPrefix) ?? [];
    for (const line of baked) {
      const pts = line.entity?.preview_points;
      if (pts && pts.length >= 2) {
        for (let i = 0; i < pts.length - 1; i++) {
          const d = distToSegment(
            north,
            east,
            pts[i].north,
            pts[i].east,
            pts[i + 1].north,
            pts[i + 1].east
          );
          if (d < bestDist) {
            bestDist = d;
            best = instance;
          }
        }
      } else if (line.from && line.to) {
        const d = distToSegment(north, east, line.from.x, line.from.y, line.to.x, line.to.y);
        if (d < bestDist) {
          bestDist = d;
          best = instance;
        }
      }
    }
  }
  return best;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function buildTemplateFileEntry(
  instance: PlacedTemplateInstance
): UploadedFileEntry {
  return {
    id: instance.id,
    fileName: instance.fileName,
    kind: "template",
    isGeographic: true,
    status: "verified",
    lineIdPrefix: instance.lineIdPrefix,
  };
}

export function createPlacedTemplateInstance(args: {
  id: string;
  fileName: string;
  kind: PlacedTemplateInstance["kind"];
  lineIdPrefix: string;
  sourceLines: PlanLine[];
  north: number;
  east: number;
}): PlacedTemplateInstance {
  return {
    id: args.id,
    fileName: args.fileName,
    kind: args.kind,
    lineIdPrefix: args.lineIdPrefix,
    sourceLines: args.sourceLines,
    north: args.north,
    east: args.east,
    rotationDeg: 0,
    scale: 1,
  };
}
