/**
 * Simple marking arrows in local drawing space (x right, y up).
 * Placement/bake convert this the same way as road signs.
 */

import type { PlanLine } from "../types/plan";

export type ArrowType = "up" | "down" | "left" | "right";

export const ARROW_LABELS: Record<ArrowType, string> = {
  up: "Arrow N",
  down: "Arrow S",
  left: "Arrow W",
  right: "Arrow E",
};

export const ARROW_TYPES: ArrowType[] = ["up", "down", "left", "right"];

type Pt = [number, number];

/** Unit arrow pointing +Y (drawing up / map north after placement). */
const UNIT_UP: Array<[Pt, Pt]> = [
  [[0, -0.46], [0, 0.12]],
  [[-0.07, -0.46], [0.07, -0.46]],
  [[-0.24, 0.08], [0, 0.48]],
  [[0.24, 0.08], [0, 0.48]],
  [[-0.24, 0.08], [0.24, 0.08]],
];

function rotate(p: Pt, deg: number): Pt {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

function rotationFor(type: ArrowType): number {
  if (type === "right") return -90;
  if (type === "down") return 180;
  if (type === "left") return 90;
  return 0;
}

export function generateArrowLines(type: ArrowType, size: number): PlanLine[] {
  const mag = Number.isFinite(size) && size > 0 ? size : 1;
  const rot = rotationFor(type);
  const lines: PlanLine[] = [];
  let pid = 1;
  UNIT_UP.forEach((seg, i) => {
    const a = rotate(seg[0], rot);
    const b = rotate(seg[1], rot);
    lines.push({
      id: `arrow-${type}-${i}`,
      label: `${ARROW_LABELS[type]} ${i + 1}`,
      layer: "marking",
      width: 0.1,
      is_mark: true,
      from: { id: pid++, x: a[0] * mag, y: a[1] * mag },
      to: { id: pid++, x: b[0] * mag, y: b[1] * mag },
    });
  });
  return lines;
}

export function templateBoundsM(lines: PlanLine[]): { widthM: number; heightM: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.from.x, line.to.x);
    maxX = Math.max(maxX, line.from.x, line.to.x);
    minY = Math.min(minY, line.from.y, line.to.y);
    maxY = Math.max(maxY, line.from.y, line.to.y);
  }
  if (!Number.isFinite(minX)) return { widthM: 0, heightM: 0 };
  return { widthM: Math.max(0, maxX - minX), heightM: Math.max(0, maxY - minY) };
}
