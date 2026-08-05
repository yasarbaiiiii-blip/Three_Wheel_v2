/**
 * Recover classified corners after Send/Start hydration strips source geometry.
 *
 * Same pattern as mission-layer tagging: build a catalog from the pre-send
 * snapshot, then match hydrated polylines by nearest position.
 */

import { SHARP_CORNER_MODE, type SharpCornerMode } from "../config/featureFlags";
import type { PlanLine } from "../types/plan";
import type { CornerClass, SourceCorner } from "./roadMarkingCsvPath";
import { formatCornerWarnings } from "./roadMarkingCsvPath";

/** How a corner is executed on the rover (post-trajectory-build). */
export type CornerExecutionMode = "paint-through" | "teardrop" | "pivot" | "blocked";

export type CornerCatalogEntry = {
  north: number;
  east: number;
  class: CornerClass;
  turnDeg: number;
  radiusM: number | null;
  cutM: number | null;
  overBudget: boolean;
  undrivable: boolean;
  executionMode: CornerExecutionMode;
  sourceLineId: string;
  sourceLabel: string;
};

/** Match densified samples to a classified corner vertex (m). */
export const CORNER_LIFECYCLE_MATCH_M = 1.0;

export type CornerClassCounts = {
  total: number;
  clean: number;
  tight: number;
  sharp: number;
  reversal: number;
};

export function emptyCornerCounts(): CornerClassCounts {
  return { total: 0, clean: 0, tight: 0, sharp: 0, reversal: 0 };
}

export function countCornerClasses(
  corners: Array<{ class?: string } | null | undefined>
): CornerClassCounts {
  const c = emptyCornerCounts();
  for (const raw of corners) {
    if (!raw || typeof raw !== "object") continue;
    const cls = raw.class;
    if (cls === "clean" || cls === "tight" || cls === "sharp" || cls === "reversal") {
      c[cls] += 1;
      c.total += 1;
    }
  }
  return c;
}

/** Compact operator label, e.g. "2 clean · 1 sharp". */
export function formatCornerCountsSummary(counts: CornerClassCounts): string | null {
  if (counts.total === 0) return null;
  const parts: string[] = [];
  if (counts.clean) parts.push(`${counts.clean} clean`);
  if (counts.tight) parts.push(`${counts.tight} tight`);
  if (counts.sharp) parts.push(`${counts.sharp} sharp`);
  if (counts.reversal) parts.push(`${counts.reversal} reversal`);
  return parts.length > 0 ? parts.join(" · ") : `${counts.total} corner(s)`;
}

function executionModeFor(
  cls: CornerClass,
  undrivable: boolean,
  overBudget: boolean,
  sharpMode: SharpCornerMode
): CornerExecutionMode {
  if (cls === "reversal") return "blocked";
  // Gate on the actual constraint violation (undrivable / over the paint
  // budget), not just the coarse angle bucket — a 90° turn classifies as
  // "tight" (60-99°), not "sharp" (100-149°), but with short-enough legs it
  // still can't hold a fillet inside the paint budget without clamping to the
  // rover's floor (overBudget). That corner needs the same teardrop/pivot
  // treatment as a "sharp" one; using the class alone left every "tight"
  // corner painted straight through the budget overrun, unconditionally.
  if (cls === "sharp" || undrivable || overBudget) {
    return sharpMode === "pivot" ? "pivot" : "teardrop";
  }
  return "paint-through";
}

function readSourceCorners(line: PlanLine): SourceCorner[] {
  const raw = line.entity?.geometry?.corners;
  if (!Array.isArray(raw)) return [];
  const out: SourceCorner[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const north = Number((c as { north?: number }).north);
    const east = Number((c as { east?: number }).east);
    if (!Number.isFinite(north) || !Number.isFinite(east)) continue;
    const cls = (c as { class?: string }).class;
    if (cls !== "clean" && cls !== "tight" && cls !== "sharp" && cls !== "reversal") {
      continue;
    }
    const turnDeg = Number((c as { turnDeg?: number }).turnDeg);
    const radiusM = (c as { radiusM?: number | null }).radiusM;
    const cutM = (c as { cutM?: number | null }).cutM;
    out.push({
      atIndex: Number((c as { atIndex?: number }).atIndex) || 0,
      turnDeg: Number.isFinite(turnDeg) ? turnDeg : 0,
      class: cls,
      radiusM: radiusM == null || !Number.isFinite(radiusM) ? null : Number(radiusM),
      cutM: cutM == null || !Number.isFinite(cutM) ? null : Number(cutM),
      overBudget: (c as { overBudget?: boolean }).overBudget === true,
      undrivable: (c as { undrivable?: boolean }).undrivable === true,
      north,
      east,
    });
  }
  return out;
}

/**
 * Catalog of classified corners from pre-Send source lines (still carry
 * entity.geometry.corners from the fitter).
 */
export function buildCornerCatalog(
  paintedLines: PlanLine[],
  sharpMode: SharpCornerMode = SHARP_CORNER_MODE
): CornerCatalogEntry[] {
  const out: CornerCatalogEntry[] = [];
  for (const line of paintedLines) {
    if (line.layer === "extension" || line.layer === "transit") continue;
    for (const c of readSourceCorners(line)) {
      out.push({
        north: c.north,
        east: c.east,
        class: c.class,
        turnDeg: c.turnDeg,
        radiusM: c.radiusM,
        cutM: c.cutM,
        overBudget: c.overBudget,
        undrivable: c.undrivable,
        executionMode: executionModeFor(c.class, c.undrivable, c.overBudget, sharpMode),
        sourceLineId: line.id,
        sourceLabel: line.label || line.id,
      });
    }
  }
  return out;
}

function lineSamplePoints(line: PlanLine): Array<{ north: number; east: number }> {
  const pts = line.entity?.preview_points;
  if (Array.isArray(pts) && pts.length > 0) {
    return pts
      .map((p) => ({
        north: Number((p as { north?: number }).north),
        east: Number((p as { east?: number }).east),
      }))
      .filter((p) => Number.isFinite(p.north) && Number.isFinite(p.east));
  }
  const fn = line.from?.x;
  const fe = line.from?.y;
  const tn = line.to?.x;
  const te = line.to?.y;
  if (
    fn != null &&
    fe != null &&
    tn != null &&
    te != null &&
    Number.isFinite(fn) &&
    Number.isFinite(fe) &&
    Number.isFinite(tn) &&
    Number.isFinite(te)
  ) {
    return [
      { north: fn, east: fe },
      { north: tn, east: te },
    ];
  }
  return [];
}

function minDistToPolylineM(
  north: number,
  east: number,
  samples: Array<{ north: number; east: number }>
): number {
  if (samples.length === 0) return Infinity;
  let best = Infinity;
  for (const p of samples) {
    const d = Math.hypot(p.north - north, p.east - east);
    if (d < best) best = d;
  }
  // Also distance to segments for long sparsely sampled legs.
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const abn = b.north - a.north;
    const abe = b.east - a.east;
    const len2 = abn * abn + abe * abe;
    let t =
      len2 < 1e-18
        ? 0
        : ((north - a.north) * abn + (east - a.east) * abe) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(north - (a.north + abn * t), east - (a.east + abe * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Attach matched catalog corners onto hydrated lines so Path Order / map still
 * know class + teardrop/pivot after stage/hydrate strip source ids.
 */
export function tagLinesWithCorners(
  lines: PlanLine[],
  catalog: CornerCatalogEntry[],
  matchTolM: number = CORNER_LIFECYCLE_MATCH_M
): PlanLine[] {
  if (catalog.length === 0) return lines;

  return lines.map((line) => {
    // Only paint / mark legs carry corner semantics.
    if (line.layer === "extension" || line.layer === "transit") return line;
    if (line.is_mark === false) return line;

    const samples = lineSamplePoints(line);
    if (samples.length === 0) return line;

    const matched: CornerCatalogEntry[] = [];
    for (const c of catalog) {
      if (minDistToPolylineM(c.north, c.east, samples) <= matchTolM) {
        matched.push(c);
      }
    }
    if (matched.length === 0) return line;

    // Dedupe by position (same corner may appear if catalog has duplicates).
    const seen = new Set<string>();
    const unique: CornerCatalogEntry[] = [];
    for (const c of matched) {
      const key = `${c.north.toFixed(3)},${c.east.toFixed(3)},${c.class}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }

    const cornersPayload = unique.map((c, i) => ({
      atIndex: i,
      turnDeg: c.turnDeg,
      class: c.class,
      radiusM: c.radiusM,
      cutM: c.cutM,
      overBudget: c.overBudget,
      undrivable: c.undrivable,
      north: c.north,
      east: c.east,
      executionMode: c.executionMode,
      sourceLineId: c.sourceLineId,
    }));

    const asSource: SourceCorner[] = unique.map((c, i) => ({
      atIndex: i,
      turnDeg: c.turnDeg,
      class: c.class,
      radiusM: c.radiusM,
      cutM: c.cutM,
      overBudget: c.overBudget,
      undrivable: c.undrivable,
      north: c.north,
      east: c.east,
    }));

    const prevGeom =
      line.entity?.geometry && typeof line.entity.geometry === "object"
        ? { ...line.entity.geometry }
        : {};
    const prevWarnings = Array.isArray(prevGeom.fit_warnings)
      ? (prevGeom.fit_warnings as unknown[]).filter((w): w is string => typeof w === "string")
      : [];
    const cornerNotes = formatCornerWarnings(asSource).filter(
      (w) => !prevWarnings.some((p) => p === w || p.includes(w))
    );
    // Prefix recovered corners so operators know this survived hydrate.
    const recovered = formatCornerCountsSummary(countCornerClasses(unique));
    const recoveryLine = recovered
      ? `Corners (recovered after stage): ${recovered}`
      : null;

    const fit_warnings = [
      ...prevWarnings.filter((w) => !/^Corners( \(recovered after stage\))?:/i.test(w)),
      ...(recoveryLine ? [recoveryLine] : []),
      ...cornerNotes.filter((w) => !w.startsWith("Corners:")),
    ];

    // Hydrated lines carry no `paintable` flag of their own (the backend round trip
    // has no such field) — without this, a reversal corner recovered post-hydrate
    // would show as drivable again the moment a mission is re-inspected after Send.
    const hasReversal = unique.some((c) => c.class === "reversal");
    const paintable = hasReversal ? false : (prevGeom.paintable as boolean | undefined) !== false;

    const entity = line.entity
      ? {
          ...line.entity,
          geometry: {
            ...prevGeom,
            corners: cornersPayload,
            fit_warnings,
            paintable,
          },
        }
      : {
          entity_id: line.id,
          entity_type: "LWPOLYLINE",
          layer: "MARK",
          color: 7,
          is_mark: true,
          length_m: 0,
          geometry: {
            corners: cornersPayload,
            fit_warnings,
            paintable,
            road_marking: true,
          },
          preview_points: samples,
        };

    return { ...line, entity };
  });
}

/**
 * Convenience: catalog from source lines + tag hydrated lines in one call.
 */
export function recoverCornersAfterHydration(
  hydratedLines: PlanLine[],
  sourcePaintedLines: PlanLine[],
  sharpMode: SharpCornerMode = SHARP_CORNER_MODE
): PlanLine[] {
  const catalog = buildCornerCatalog(sourcePaintedLines, sharpMode);
  return tagLinesWithCorners(hydratedLines, catalog);
}
