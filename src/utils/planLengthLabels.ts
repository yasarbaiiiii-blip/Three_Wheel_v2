/**
 * Live path-length labels for plan geometry (fields preview + sticker edit).
 * Length is measured in world metres after the sticker transform so non-uniform
 * scaleNorth/scaleEast updates are correct in real time.
 *
 * Label sits near the **arc-length midpoint**, offset perpendicular to the stroke
 * so text does not merge into the path.
 */

import type { PlanLine } from "../types/plan";
import { formatFinite } from "./pathWorkflow";
import { getPlanLineRenderPoints } from "./curveGeometry";
import { transformVisualDxfPoint } from "./visualAlignment";

/**
 * Lines that get a length label. Includes extension run-ups when enabled so
 * PRE/AFT lengths stay visible; skips transit / virtual boundary noise.
 */
function isLengthLabelLine(line: PlanLine): boolean {
  const layer = line.layer;
  if (layer === "transit" || layer === "virtual_boundary") return false;
  const id = String(line.id ?? "");
  if (id.startsWith("runtime-transit-") || id.startsWith("transit-")) return false;
  return true;
}

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
  /** Independent north-axis scale (falls back to `scale`). */
  scaleNorth?: number;
  /** Independent east-axis scale (falls back to `scale`). */
  scaleEast?: number;
};

type WorldPt = { north: number; east: number };

/** Design/render points → world polyline after sticker transform. */
function transformedWorldPolyline(line: PlanLine, pose: StickerPose): WorldPt[] {
  const pts = getPlanLineRenderPoints(line, true);
  if (pts.length >= 2) {
    return pts.map((p) => transformVisualDxfPoint(p.north, p.east, pose));
  }
  if (line.from && line.to) {
    return [
      transformVisualDxfPoint(line.from.x, line.from.y, pose),
      transformVisualDxfPoint(line.to.x, line.to.y, pose),
    ];
  }
  return [];
}

/**
 * Total length + point at half arc-length (geometric centre of the path).
 * Returns null if the polyline is empty/degenerate.
 */
export function measurePathLengthAndCenter(
  worldPts: WorldPt[]
): { lengthM: number; center: WorldPt; tangent: WorldPt } | null {
  if (worldPts.length < 2) return null;

  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < worldPts.length; i++) {
    const d = Math.hypot(
      worldPts[i].north - worldPts[i - 1].north,
      worldPts[i].east - worldPts[i - 1].east
    );
    segs.push(d);
    total += d;
  }
  if (!(Number.isFinite(total) && total > 0)) return null;

  const half = total / 2;
  let walked = 0;
  for (let i = 0; i < segs.length; i++) {
    const segLen = segs[i];
    if (walked + segLen >= half - 1e-12) {
      const t = segLen > 1e-12 ? (half - walked) / segLen : 0;
      const a = worldPts[i];
      const b = worldPts[i + 1];
      const dn = b.north - a.north;
      const de = b.east - a.east;
      const inv = segLen > 1e-12 ? 1 / segLen : 0;
      return {
        lengthM: total,
        center: {
          north: a.north + dn * t,
          east: a.east + de * t,
        },
        // Unit tangent along the path at the centre.
        tangent: { north: dn * inv, east: de * inv },
      };
    }
    walked += segLen;
  }

  const last = worldPts[worldPts.length - 1];
  const prev = worldPts[worldPts.length - 2];
  const dn = last.north - prev.north;
  const de = last.east - prev.east;
  const inv = Math.hypot(dn, de) > 1e-12 ? 1 / Math.hypot(dn, de) : 0;
  return {
    lengthM: total,
    center: { north: last.north, east: last.east },
    tangent: { north: dn * inv, east: de * inv },
  };
}

/**
 * Offset label off the stroke so it stays readable (perpendicular to path tangent).
 * Keep the offset small so the number reads as belonging to that path.
 * Distance grows slightly with path length, clamped for dense small segments.
 */
export function offsetLabelFromPathCenter(
  center: WorldPt,
  tangent: WorldPt,
  lengthM: number,
  opts?: { minOffsetM?: number; maxOffsetM?: number; lengthFactor?: number }
): WorldPt {
  // Tight defaults: ~0.35–0.9 m off the stroke (was 1.25–3.5 m — too far on phone).
  const minOff = opts?.minOffsetM ?? 0.35;
  const maxOff = opts?.maxOffsetM ?? 0.9;
  const factor = opts?.lengthFactor ?? 0.012;
  const offsetM = Math.min(maxOff, Math.max(minOff, lengthM * factor));

  // Left-hand perpendicular in N/E plane: (-e, n)
  let pn = -tangent.east;
  let pe = tangent.north;
  const plen = Math.hypot(pn, pe);
  if (plen < 1e-9) {
    // Degenerate tangent — offset due north.
    pn = 1;
    pe = 0;
  } else {
    pn /= plen;
    pe /= plen;
  }
  return {
    north: center.north + pn * offsetM,
    east: center.east + pe * offsetM,
  };
}

/** Polyline length in world metres after sticker transform. */
export function measureTransformedLineLengthM(
  line: PlanLine,
  pose: StickerPose
): number | null {
  const world = transformedWorldPolyline(line, pose);
  const m = measurePathLengthAndCenter(world);
  return m?.lengthM ?? null;
}

/**
 * Arc-length centre (with readable offset) + world length.
 * Includes marking + extension when present; skips transit/virtual boundary.
 * `maxLabels` caps draw cost on huge DXFs.
 */
export function buildPlanLengthLabels(
  lines: PlanLine[],
  pose: StickerPose,
  opts?: { maxLabels?: number; minLengthM?: number }
): PlanLengthLabel[] {
  const maxLabels = opts?.maxLabels ?? 120;
  const minLengthM = opts?.minLengthM ?? 0.05;

  const out: PlanLengthLabel[] = [];
  for (const line of lines) {
    if (!isLengthLabelLine(line)) continue;

    const worldPts = transformedWorldPolyline(line, pose);
    const measured = measurePathLengthAndCenter(worldPts);
    if (!measured || !(measured.lengthM >= minLengthM)) continue;

    const placed = offsetLabelFromPathCenter(
      measured.center,
      measured.tangent,
      measured.lengthM
    );

    out.push({
      id: String(line.id),
      label: `${formatFinite(measured.lengthM, 2)} m`,
      lengthM: measured.lengthM,
      north: placed.north,
      east: placed.east,
    });
    if (out.length >= maxLabels) break;
  }
  return out;
}
