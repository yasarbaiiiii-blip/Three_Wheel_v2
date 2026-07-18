/**
 * Live path-length labels for the Multi-Point Fit sticker (design length × scale).
 */

import type { PlanLine } from "../types/plan";
import { getLineLengthM, formatFinite } from "./pathWorkflow";
import { getPlanLineRenderPoints } from "./curveGeometry";
import { isPlanSnapGeometryLine } from "./planShapeSnapPoints";
import { transformVisualDxfPoint } from "./visualAlignment";

export type PlanLengthLabel = {
  id: string;
  label: string;
  lengthM: number;
  north: number;
  east: number;
};

export type StickerPose = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
};

/**
 * Midpoint + scaled length for spray/marking geometry (skips extension/transit scaffolding).
 * `maxLabels` caps draw cost on huge DXFs.
 */
export function buildPlanLengthLabels(
  lines: PlanLine[],
  pose: StickerPose,
  opts?: { maxLabels?: number; minLengthM?: number }
): PlanLengthLabel[] {
  const maxLabels = opts?.maxLabels ?? 80;
  const minLengthM = opts?.minLengthM ?? 0.05;
  const scale =
    Number.isFinite(pose.scale) && pose.scale > 0 ? pose.scale : 1;

  const out: PlanLengthLabel[] = [];
  for (const line of lines) {
    if (!isPlanSnapGeometryLine(line)) continue;
    const designLen = getLineLengthM(line);
    if (designLen == null || !(designLen * scale >= minLengthM)) continue;

    const pts = getPlanLineRenderPoints(line, true);
    if (pts.length < 2) continue;
    const mid = pts[Math.floor(pts.length / 2)];
    const world = transformVisualDxfPoint(mid.north, mid.east, pose);
    const lengthM = designLen * scale;
    out.push({
      id: String(line.id),
      label: `${formatFinite(lengthM, 2)} m`,
      lengthM,
      north: world.north,
      east: world.east,
    });
    if (out.length >= maxLabels) break;
  }
  return out;
}
