/**
 * Phase 2 — place template PlanLines into the CSV mission NED frame.
 *
 * Axis conventions (do not mix without this convert):
 * - Template generators (`generateRoadSignLines`, `generateTextLines`): local drawing
 *   coords on PlanPoint `{ x, y }` with no NED meaning (x right, y up).
 * - TemplatePanel placement (DXF path): treats x as east-ish, y as north-ish —
 *   `x += roverE`, `y += roverN`.
 * - CSV / road-marking PlanLines: `x = north`, `y = east`, and
 *   `entity.preview_points` are explicit `{ north, east }`.
 *
 * Dense / curved templates: if `entity.preview_points` has ≥ 2 points, the full
 * polyline is placed (finding 4). Local drawing coords on those points are recovered
 * by matching the first preview vertex to from.x/from.y.
 */

import type { PlanLine } from "../types/plan";

export type TemplatePlacementOpts = {
  /** Rover NED north (m). Default 0. */
  roverNorth?: number;
  /** Rover NED east (m). Default 0. */
  roverEast?: number;
  /**
   * Extra east offset applied the same way TemplatePanel does for non-boundary
   * placement (default +2 m east of rover).
   */
  offsetEast?: number;
  /** Extra north offset (default 0). */
  offsetNorth?: number;
  /** Id prefix for generated lines. */
  idPrefix?: string;
  /** Label prefix for generated lines. */
  labelPrefix?: string;
};

/** Local drawing polyline as [localX, localY][] (TemplatePanel axes). */
export function extractTemplateLocalPolyline(line: PlanLine): [number, number][] {
  const pp = line.entity?.preview_points;
  if (pp && pp.length >= 2) {
    // Recover which preview field is localX vs localY by matching from.
    const fx = line.from?.x;
    const fy = line.from?.y;
    if (Number.isFinite(fx) && Number.isFinite(fy)) {
      const dEastX = Math.hypot(pp[0].east - fx, pp[0].north - fy);
      const dNorthX = Math.hypot(pp[0].north - fx, pp[0].east - fy);
      if (dEastX <= dNorthX) {
        // east ↔ localX, north ↔ localY (natural for post-place NED storage)
        return pp
          .filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east))
          .map((p) => [p.east, p.north] as [number, number]);
      }
      // north ↔ localX, east ↔ localY (swapped storage)
      return pp
        .filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east))
        .map((p) => [p.north, p.east] as [number, number]);
    }
    // No from anchor — assume east=localX, north=localY
    return pp
      .filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east))
      .map((p) => [p.east, p.north] as [number, number]);
  }

  if (
    line.from != null &&
    line.to != null &&
    Number.isFinite(line.from.x) &&
    Number.isFinite(line.from.y) &&
    Number.isFinite(line.to.x) &&
    Number.isFinite(line.to.y)
  ) {
    return [
      [line.from.x, line.from.y],
      [line.to.x, line.to.y],
    ];
  }
  return [];
}

/**
 * Convert local template lines into CSV-frame mark lines ready for
 * `buildTrajectory` / map overlay.
 *
 * Placement math mirrors TemplatePanel:
 *   worldEast  = localX + roverEast  + offsetEast
 *   worldNorth = localY + roverNorth + offsetNorth
 * then stores CSV convention:
 *   PlanPoint.x = worldNorth, PlanPoint.y = worldEast
 *   preview_points = [{ north, east }, ...]  (full polyline, not just chord)
 */
export function placeTemplateLinesInCsvFrame(
  localTemplateLines: PlanLine[],
  opts: TemplatePlacementOpts = {}
): PlanLine[] {
  const roverN = opts.roverNorth ?? 0;
  const roverE = opts.roverEast ?? 0;
  const offsetE = opts.offsetEast ?? 2.0;
  const offsetN = opts.offsetNorth ?? 0;
  const idPrefix = opts.idPrefix ?? "csv-template";
  const labelPrefix = opts.labelPrefix ?? "Template";

  const out: PlanLine[] = [];
  for (let index = 0; index < localTemplateLines.length; index++) {
    const line = localTemplateLines[index];
    const local = extractTemplateLocalPolyline(line);
    if (local.length < 2) {
      // Fail closed rather than emit a degenerate stroke.
      continue;
    }

    const world = local.map(([lx, ly]) => {
      const east = lx + roverE + offsetE;
      const north = ly + roverN + offsetN;
      return { north, east };
    });

    const first = world[0];
    const last = world[world.length - 1];
    let length_m = 0;
    for (let i = 1; i < world.length; i++) {
      length_m += Math.hypot(world[i].north - world[i - 1].north, world[i].east - world[i - 1].east);
    }

    const id = `${idPrefix}-${line.id || index}`;
    out.push({
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
  }
  return out;
}

/** Axis-aligned N/E extents of a set of CSV-frame PlanLines (for transpose guards). */
export function csvFrameExtents(lines: PlanLine[]): {
  northMin: number;
  northMax: number;
  eastMin: number;
  eastMax: number;
} | null {
  let northMin = Infinity;
  let northMax = -Infinity;
  let eastMin = Infinity;
  let eastMax = -Infinity;
  let any = false;

  for (const line of lines) {
    const pts = line.entity?.preview_points;
    if (pts && pts.length > 0) {
      for (const p of pts) {
        if (!Number.isFinite(p.north) || !Number.isFinite(p.east)) continue;
        any = true;
        northMin = Math.min(northMin, p.north);
        northMax = Math.max(northMax, p.north);
        eastMin = Math.min(eastMin, p.east);
        eastMax = Math.max(eastMax, p.east);
      }
    } else {
      for (const p of [line.from, line.to]) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        any = true;
        northMin = Math.min(northMin, p.x);
        northMax = Math.max(northMax, p.x);
        eastMin = Math.min(eastMin, p.y);
        eastMax = Math.max(eastMax, p.y);
      }
    }
  }

  if (!any) return null;
  return { northMin, northMax, eastMin, eastMax };
}

/**
 * Build an asymmetric "L" in local template drawing coords (x right, y up).
 * Used only in tests as a transpose canary — not a shipped template.
 */
export function makeAsymmetricLTemplate(size = 1): PlanLine[] {
  return [
    {
      id: "l-stem",
      label: "L stem",
      layer: "marking",
      width: 0.1,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 0, y: size },
    },
    {
      id: "l-base",
      label: "L base",
      layer: "marking",
      width: 0.1,
      from: { id: 3, x: 0, y: 0 },
      to: { id: 4, x: size * 0.5, y: 0 },
    },
  ];
}
