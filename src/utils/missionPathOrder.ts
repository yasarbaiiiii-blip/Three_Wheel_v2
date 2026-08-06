/**
 * Path order, paint/skip, and heading-reversal helpers for app-planned missions.
 * Pure logic; UI lives in CsvPathOrderStep / MissionPathOrderStep.
 *
 * Renamed from csvPathOrder.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";
import {
  analyticCurveTangents,
  buildCsvExtensionLines,
  buildCsvExtensionPreviews,
  buildExtensionTransitLines,
  csvExtensionLengthM,
  isLineLikePlanLine,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
  type CsvExtensionPreview,
} from "./missionExtensions";
import {
  buildTrajectory,
  MARK_CONTIGUOUS_GAP_M,
  planLineToNedPolyline,
  trajectoryTotals,
  type BuildTrajectoryOpts,
  type TrajectoryRun,
} from "./missionTrajectory";
import { buildCsvTransitLines } from "./localPointCsv";
import { sanitizePlanLines } from "./pathWorkflow";

export type { CsvExtensionConfig, CsvExtensionPreview };
export { buildCsvExtensionPreviews, csvExtensionLengthM, normalizeCsvExtensionConfig };

/** Operator turns sharper than this (deg) between consecutive painted runs trigger a warning. */
export const REVERSAL_HEADING_THRESHOLD_DEG = 120;

export type CsvPathOrderEntry = {
  lineId: string;
  label: string;
  /** When false the path is skipped (not painted, no travel into/out of it). */
  paint: boolean;
};

export type ReversalWarning = {
  fromIndex: number;
  toIndex: number;
  fromLabel: string;
  toLabel: string;
  headingChangeDeg: number;
};

/**
 * Heading of a polyline in degrees: 0 = +north, 90 = +east, range (-180, 180].
 * Uses the last segment of the polyline (exit heading).
 */
export function exitHeadingDeg(points: [number, number][]): number | null {
  if (points.length < 2) return null;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  const dn = b[0] - a[0];
  const de = b[1] - a[1];
  if (Math.hypot(dn, de) < 1e-9) return null;
  return (Math.atan2(de, dn) * 180) / Math.PI;
}

/** Entry heading of a polyline (first segment). Same convention as exitHeadingDeg. */
export function entryHeadingDeg(points: [number, number][]): number | null {
  if (points.length < 2) return null;
  const a = points[0];
  const b = points[1];
  const dn = b[0] - a[0];
  const de = b[1] - a[1];
  if (Math.hypot(dn, de) < 1e-9) return null;
  return (Math.atan2(de, dn) * 180) / Math.PI;
}

/** Smallest signed turn from heading A to B in (-180, 180]. */
export function headingDeltaDeg(fromDeg: number, toDeg: number): number {
  let d = toDeg - fromDeg;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

export function absHeadingChangeDeg(fromDeg: number, toDeg: number): number {
  return Math.abs(headingDeltaDeg(fromDeg, toDeg));
}

/**
 * Detect large heading changes between consecutive *painted* mark paths
 * (travel legs ignored for the heading comparison — we compare exit of path N
 * to entry of path N+1, which is the turn the rover must take after transit).
 */
export function detectReversalWarnings(
  orderedPaintedLines: PlanLine[],
  thresholdDeg: number = REVERSAL_HEADING_THRESHOLD_DEG
): ReversalWarning[] {
  const warnings: ReversalWarning[] = [];
  const polylines: { line: PlanLine; pts: [number, number][] }[] = [];

  for (const line of orderedPaintedLines) {
    const pts = planLineToNedPolyline(line);
    if (!pts || pts.length < 2) continue;
    polylines.push({ line, pts });
  }

  for (let i = 0; i < polylines.length - 1; i++) {
    const exitH = exitHeadingDeg(polylines[i].pts);
    const entryH = entryHeadingDeg(polylines[i + 1].pts);
    if (exitH == null || entryH == null) continue;
    const change = absHeadingChangeDeg(exitH, entryH);
    if (change > thresholdDeg) {
      warnings.push({
        fromIndex: i,
        toIndex: i + 1,
        fromLabel: polylines[i].line.label,
        toLabel: polylines[i + 1].line.label,
        headingChangeDeg: change,
      });
    }
  }

  return warnings;
}

export type CurveDirectionWarning = {
  lineId: string;
  label: string;
  actualGapM: number;
  reversedGapM: number;
  /** Estimated avoidable distance if this curve were authored the other way. */
  wastedM: number;
};

/** Ignore savings below this — noise, not worth flagging. */
export const CURVE_DIRECTION_WARN_MIN_M = 1;

/**
 * For each curve (ARC/CIRCLE) in an already-ordered painted sequence, compare the
 * transit gap actually needed to enter it against the gap that would be needed if it
 * could be entered from its other end. A large gap between the two means this curve's
 * authored rotation direction is fighting the walk direction —
 * {@link chainMarkLinesByGeometry} cannot fix this (curves are never reversed; see
 * `analyticCurveTangents` in missionExtensions.ts), so this surfaces it for the operator
 * to fix at the source (re-author the arc, or accept the transit).
 *
 * Heuristic, not a global optimum: only checks the immediate entry gap, not knock-on
 * effects reversing this curve would have on the rest of the walk.
 */
export function detectCurveDirectionWarnings(
  orderedPaintedLines: PlanLine[],
  minWastedM: number = CURVE_DIRECTION_WARN_MIN_M
): CurveDirectionWarning[] {
  const warnings: CurveDirectionWarning[] = [];
  for (let i = 1; i < orderedPaintedLines.length; i++) {
    const line = orderedPaintedLines[i];
    if (!analyticCurveTangents(line)) continue; // ARC/CIRCLE only
    const prevPts = planLineToNedPolyline(orderedPaintedLines[i - 1]);
    const pts = planLineToNedPolyline(line);
    if (!prevPts || !pts || pts.length < 2) continue;
    const prevEnd = prevPts[prevPts.length - 1];
    const actualGapM = Math.hypot(pts[0][0] - prevEnd[0], pts[0][1] - prevEnd[1]);
    const reversedGapM = Math.hypot(
      pts[pts.length - 1][0] - prevEnd[0],
      pts[pts.length - 1][1] - prevEnd[1]
    );
    const wastedM = actualGapM - reversedGapM;
    if (wastedM >= minWastedM) {
      warnings.push({ lineId: line.id, label: line.label, actualGapM, reversedGapM, wastedM });
    }
  }
  return warnings;
}

export type DegenerateEntityWarning = {
  lineId: string;
  label: string;
  lengthM: number;
};

/** Below this, an entity is closer to a stray point than paintable geometry. */
export const DEGENERATE_ENTITY_MAX_M = 0.1;

/**
 * Flag mark entities so short they paint almost nothing but still cost a full transit
 * round-trip to visit — confirmed on a real survey DXF where two entities of 4 cm and 0.8 cm
 * added ~11 m of pure overhead. Source-agnostic: works the same for CSV and DXF, since it
 * only looks at each line's own painted length, not how it was produced.
 */
export function detectDegenerateEntityWarnings(
  orderedPaintedLines: PlanLine[],
  maxLengthM: number = DEGENERATE_ENTITY_MAX_M
): DegenerateEntityWarning[] {
  const warnings: DegenerateEntityWarning[] = [];
  for (const line of orderedPaintedLines) {
    const lengthM = line.entity?.length_m ?? 0;
    if (lengthM < maxLengthM) {
      warnings.push({ lineId: line.id, label: line.label, lengthM });
    }
  }
  return warnings;
}

/** Marking lines only — same allowlist as buildTrajectory (fail toward not-painting). */
export function selectMarkPlanLines(lines: PlanLine[]): PlanLine[] {
  // Lazy import avoided — keep filter in sync with isPaintableMarkLine rules.
  return lines.filter((l) => {
    if (l.layer === "transit" || l.layer === "extension" || l.layer === "virtual_boundary") {
      return false;
    }
    if (l.is_mark === false || l.entity?.is_mark === false) return false;
    if (l.layer === "marking" || l.layer === "center") return true;
    if (l.is_mark === true || l.entity?.is_mark === true) return true;
    // DXF primary geometry (line/arc/circle/polyline) on other CAD layers still paints
    // when the rover marked it as a mark entity (is_mark defaults true on server).
    const et = String(l.entity?.entity_type ?? "").trim().toLowerCase();
    if (
      et === "line" ||
      et === "arc" ||
      et === "circle" ||
      et === "lwpolyline" ||
      et === "polyline" ||
      et === "spline" ||
      et === "ellipse"
    ) {
      return true;
    }
    return false;
  });
}

/**
 * Apply operator order + paint flags to produce the mark list for buildTrajectory.
 * Unknown ids are dropped; paint=false is skipped.
 */
export function resolveOrderedPaintedLines(
  allLines: PlanLine[],
  order: CsvPathOrderEntry[]
): PlanLine[] {
  const byId = new Map(allLines.map((l) => [l.id, l]));
  const out: PlanLine[] = [];
  for (const entry of order) {
    if (!entry.paint) continue;
    const line = byId.get(entry.lineId);
    if (line) out.push(line);
  }
  return out;
}

/** Default order = current mark lines in array order, all painted. */
export function defaultPathOrder(markLines: PlanLine[]): CsvPathOrderEntry[] {
  return markLines.map((l) => ({
    lineId: l.id,
    label: l.label,
    paint: true,
  }));
}

// ── Geometric chaining (seeds the default order for CAD imports) ──────────────

/** First and last point of a plan line, in [north, east]. */
function lineEndpoints(
  line: PlanLine
): { start: [number, number]; end: [number, number] } | null {
  const pts = planLineToNedPolyline(line);
  if (!pts || pts.length < 2) return null;
  return { start: pts[0], end: pts[pts.length - 1] };
}

/**
 * Same line driven the other way: vertices reversed, `from`/`to` swapped.
 *
 * Only ever applied to line-like geometry. An ARC/CIRCLE takes its extension tangents from
 * `geometry.startAngle`/`endAngle` via `analyticCurveTangents`, which reversing the sampled
 * points alone would not flip — the run-ups would then point back into the curve.
 */
export function reversePlanLineDirection(line: PlanLine): PlanLine {
  const entity = line.entity;
  return {
    ...line,
    from: line.to ? { ...line.to } : line.from,
    to: line.from ? { ...line.from } : line.to,
    entity: entity
      ? {
          ...entity,
          preview_points:
            entity.preview_points && entity.preview_points.length >= 2
              ? [...entity.preview_points].reverse()
              : entity.preview_points,
        }
      : entity,
  };
}

/**
 * Greedy nearest-endpoint walk over `placeable`, seeded at `placeable[seedIdx]` (optionally
 * driven backwards if it's line-like). Pure helper — does not know about `unplaceable`/`others`.
 */
function greedyChainFrom(
  placeable: PlanLine[],
  seedIdx: number,
  seedReversed: boolean
): PlanLine[] {
  const remaining = placeable.slice();
  const [seed] = remaining.splice(seedIdx, 1);
  const chained: PlanLine[] = [seedReversed ? reversePlanLineDirection(seed) : seed];
  let cursor = lineEndpoints(chained[0])!.end;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestReversed = false;

    remaining.forEach((line, idx) => {
      const ends = lineEndpoints(line);
      if (!ends) return;
      const forward = Math.hypot(ends.start[0] - cursor[0], ends.start[1] - cursor[1]);
      if (forward < bestDist) {
        bestDist = forward;
        bestIdx = idx;
        bestReversed = false;
      }
      // A path whose far end is the nearer one continues the walk only when driven
      // backwards. Curves keep their authored direction (see reversePlanLineDirection).
      if (!isLineLikePlanLine(line)) return;
      const backward = Math.hypot(ends.end[0] - cursor[0], ends.end[1] - cursor[1]);
      if (backward < bestDist) {
        bestDist = backward;
        bestIdx = idx;
        bestReversed = true;
      }
    });

    const [picked] = remaining.splice(bestIdx, 1);
    const next = bestReversed ? reversePlanLineDirection(picked) : picked;
    chained.push(next);
    cursor = lineEndpoints(next)!.end;
  }

  return chained;
}

/** Sum of the transit gaps between consecutive entries — the quantity a chain minimizes. */
function totalGapM(chain: PlanLine[]): number {
  let total = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = lineEndpoints(chain[i]);
    const b = lineEndpoints(chain[i + 1]);
    if (!a || !b) continue;
    total += Math.hypot(b.start[0] - a.end[0], b.start[1] - a.end[1]);
  }
  return total;
}

/**
 * Above this many placeable marks, multi-start search is skipped in favor of the single
 * file-order seed — multi-start is O(n^3) (n candidate seeds x 2 directions x O(n^2) greedy
 * walk each), fine for a road-marking file's tens of entities but not worth risking on a
 * pathological input.
 */
export const CHAIN_MULTI_START_MAX_MARKS = 200;

/**
 * Order painted paths into one continuous walk, flipping any path drawn against it.
 *
 * Why this has to happen at import: PRE/AFT run-ups are joined by a connector spanning
 * **exit tip → next entry tip** (`buildExtensionTransitLines`), where "next" means next in
 * path order. Walk a square's four sides in perimeter order and every connector is the short
 * 0.71 m hypotenuse across a corner — the little triangle the run-ups are supposed to make.
 * Take the sides in the order CAD happened to store them, or with one side drawn backwards,
 * and consecutive edges are no longer adjacent: the connector jumps clean across the plan
 * (measured: 2.5 m and 3.5 m on a 2 m square) and the run-ups read as floating debris.
 *
 * The connector is not wrong there — it is honestly drawing the drive the order asks for.
 * The order is what needs fixing, so this runs once at import to seed the default. It is a
 * no-op on a file already stored in perimeter order, and the operator can still drag rows
 * afterwards; nothing re-chains behind them.
 *
 * Multi-start greedy nearest-endpoint: always seeding from the first mark in file order (in
 * its own authored direction) can lock in a bad walk when that entity happens to sit at the
 * "wrong end" relative to a fixed-direction curve elsewhere in the file — confirmed on a real
 * survey DXF, where seeding from entity 0 forced ~10 m of transit that seeding from a
 * different entity (or that entity reversed) does not. So every placeable entity is tried as
 * a candidate seed (and its reverse, when line-like), and whichever produces the least total
 * transit wins. Ties — most commonly a file that's already one continuous walk or a fully
 * closed loop, where every seed is equally good — favor the earliest-tried candidate, which
 * is `placeable[0]` walked forward: the mission still starts where file order started it
 * whenever that's already an optimal choice, matching prior behavior exactly in that case.
 */
export function chainMarkLinesByGeometry(lines: PlanLine[]): PlanLine[] {
  const marks = selectMarkPlanLines(lines);
  const markIds = new Set(marks.map((m) => m.id));
  const others = lines.filter((l) => !markIds.has(l.id));
  if (marks.length < 2) return [...marks, ...others];

  // Paths with no usable polyline cannot be chained — keep them, in file order, at the end.
  const placeable: PlanLine[] = [];
  const unplaceable: PlanLine[] = [];
  for (const line of marks) {
    (lineEndpoints(line) ? placeable : unplaceable).push(line);
  }
  if (placeable.length < 2) return [...marks, ...others];

  let bestChain: PlanLine[] = greedyChainFrom(placeable, 0, false);
  let bestTotal = totalGapM(bestChain);

  if (placeable.length <= CHAIN_MULTI_START_MAX_MARKS) {
    for (let i = 0; i < placeable.length; i++) {
      if (i > 0) {
        const forward = greedyChainFrom(placeable, i, false);
        const forwardTotal = totalGapM(forward);
        if (forwardTotal < bestTotal) {
          bestTotal = forwardTotal;
          bestChain = forward;
        }
      }
      if (isLineLikePlanLine(placeable[i])) {
        const reversed = greedyChainFrom(placeable, i, true);
        const reversedTotal = totalGapM(reversed);
        if (reversedTotal < bestTotal) {
          bestTotal = reversedTotal;
          bestChain = reversed;
        }
      }
    }
  }

  return [...bestChain, ...unplaceable, ...others];
}

export function reorderPathOrder(
  order: CsvPathOrderEntry[],
  fromIndex: number,
  toIndex: number
): CsvPathOrderEntry[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= order.length ||
    toIndex >= order.length ||
    fromIndex === toIndex
  ) {
    return order.slice();
  }
  const next = order.slice();
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export function setPathPaint(
  order: CsvPathOrderEntry[],
  lineId: string,
  paint: boolean
): CsvPathOrderEntry[] {
  return order.map((e) => (e.lineId === lineId ? { ...e, paint } : e));
}

/**
 * Preview transit leg between consecutive painted paths.
 * Matches map geometry: mark-end→next mark-start via {@link buildCsvTransitLines}
 * when extensions are off; AFT-tip→next PRE-tip via {@link buildExtensionTransitLines}
 * when PRE/AFT run-ups are present (same branch as {@link applyCsvOrderToPlanLines}).
 */
export type CsvTransitPreview = {
  id: string;
  fromLineId: string;
  toLineId: string;
  fromLabel: string;
  toLabel: string;
  lengthM: number;
};

const EXT_JOIN_ID_RE = /^ext-join-(.+)->(.+)$/;

function transitLengthM(line: PlanLine): number {
  const fromEntity = line.entity?.length_m;
  if (typeof fromEntity === "number" && Number.isFinite(fromEntity)) return fromEntity;
  const a = line.from;
  const b = line.to;
  if (
    a != null &&
    b != null &&
    Number.isFinite(a.x) &&
    Number.isFinite(a.y) &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y)
  ) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  return 0;
}

/**
 * Build operator-facing transit previews for consecutive painted paths in order.
 * Lengths come from the same transit PlanLines the map draws — never a separate
 * mark-end→mark-start calculation that can diverge once extensions are on.
 */
export function buildCsvTransitPreviews(
  allLines: PlanLine[],
  order: CsvPathOrderEntry[],
  extensionConfig?: Partial<CsvExtensionConfig> | null
): CsvTransitPreview[] {
  const painted = resolveOrderedPaintedLines(allLines, order);
  const byId = new Map(painted.map((p) => [p.id, p]));
  // Same branch as applyCsvOrderToPlanLines so row numbers cannot drift from map lines.
  const extensions = buildCsvExtensionLines(painted, extensionConfig);

  if (extensions.length > 0) {
    // Extension-join ids encode which edges connect (ext-join-<id>-><id>) — attribution
    // is exact and never ambiguous, even if two joins happen to share coordinates.
    const transitLines = buildExtensionTransitLines(painted, extensionConfig);
    const previews: CsvTransitPreview[] = [];
    for (const tl of transitLines) {
      const lengthM = transitLengthM(tl);
      const joinMatch = EXT_JOIN_ID_RE.exec(tl.id);
      const fromLine = joinMatch ? byId.get(joinMatch[1]) : undefined;
      const toLine = joinMatch ? byId.get(joinMatch[2]) : undefined;
      previews.push({
        id: tl.id,
        fromLineId: fromLine?.id ?? joinMatch?.[1] ?? tl.id,
        toLineId: toLine?.id ?? joinMatch?.[2] ?? tl.id,
        fromLabel: fromLine?.label ?? joinMatch?.[1] ?? "?",
        toLabel: toLine?.label ?? joinMatch?.[2] ?? "?",
        lengthM,
      });
    }
    return previews;
  }

  // Plain mark-to-mark connectors. buildCsvTransitLines walks consecutive painted pairs
  // in order and pushes one entry per pair that doesn't already touch, so POSITION (not
  // coordinates) is what ties a transit line back to the pair it came from. A coordinate
  // search can misattribute two distinct legs that happen to share endpoints — e.g. a
  // forced "there and back" detour around a curve entered from the wrong end (see
  // field_test_01.DXF) — silently collapsing both legs onto the same row.
  const transitLines = buildCsvTransitLines(painted);
  const previews: CsvTransitPreview[] = [];
  let transitCursor = 0;
  for (let i = 0; i < painted.length - 1; i++) {
    const from = painted[i];
    const to = painted[i + 1];
    const fromPt = from.to;
    const toPt = to.from;
    if (
      fromPt == null ||
      toPt == null ||
      !Number.isFinite(fromPt.x) ||
      !Number.isFinite(fromPt.y) ||
      !Number.isFinite(toPt.x) ||
      !Number.isFinite(toPt.y)
    ) {
      continue;
    }
    const lengthM = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
    // Same "already touching" predicate buildCsvTransitLines used to decide whether it
    // emitted a transit line for this pair — keeps the cursor in lockstep with transitLines.
    if (lengthM < MARK_CONTIGUOUS_GAP_M) continue;
    const tl = transitLines[transitCursor];
    transitCursor += 1;
    previews.push({
      id: tl?.id ?? `csv-transit-preview-${i}`,
      fromLineId: from.id,
      toLineId: to.id,
      fromLabel: from.label,
      toLabel: to.label,
      lengthM: tl ? transitLengthM(tl) : lengthM,
    });
  }
  return previews;
}

/**
 * Apply operator path order to plan lines: marks follow order, transit connectors
 * and extension PRE/AFT lines are rebuilt from consecutive *painted* paths.
 * Stale `layer:"transit"` and `layer:"extension"` lines are stripped (never kept as orphans).
 * Other non-mark layers (virtual box, etc.) are preserved.
 */
export function applyCsvOrderToPlanLines(
  allLines: PlanLine[],
  order: CsvPathOrderEntry[],
  extensionConfig?: Partial<CsvExtensionConfig> | null
): PlanLine[] {
  const marks = selectMarkPlanLines(allLines);
  const byId = new Map(marks.map((m) => [m.id, m]));
  const orderedMarks: PlanLine[] = [];
  const seen = new Set<string>();
  for (const entry of order) {
    const line = byId.get(entry.lineId);
    if (line && !seen.has(line.id)) {
      orderedMarks.push(line);
      seen.add(line.id);
    }
  }
  for (const line of marks) {
    if (!seen.has(line.id)) {
      orderedMarks.push(line);
      seen.add(line.id);
    }
  }

  const painted = resolveOrderedPaintedLines(orderedMarks, order);
  const extensions = buildCsvExtensionLines(painted, extensionConfig);
  // With extensions on, travel spans AFT-tip → next PRE-tip; the plain mark-to-mark
  // connector would cut across the run-ups and leave them floating on the map. Same rule
  // the rover applies once extensions exist (_insert_transit_connectors_between_segments
  // is then its only routing pass). Falls back to mark-to-mark when there are none.
  const extensionTransit = buildExtensionTransitLines(painted, extensionConfig);
  const transit =
    extensions.length > 0 ? extensionTransit : buildCsvTransitLines(painted);
  const others = allLines.filter(
    (l) =>
      l.layer !== "transit" &&
      l.layer !== "extension" &&
      !marks.some((m) => m.id === l.id)
  );
  return sanitizePlanLines([...orderedMarks, ...transit, ...extensions, ...others]);
}

/**
 * Build trajectory for the current order/paint state and return operator-facing totals.
 */
export function buildOrderedTrajectory(
  allLines: PlanLine[],
  order: CsvPathOrderEntry[],
  opts: BuildTrajectoryOpts
): {
  runs: TrajectoryRun[];
  paintedLines: PlanLine[];
  reversals: ReversalWarning[];
  totals: ReturnType<typeof trajectoryTotals>;
  warnings: string[];
} {
  const paintedLines = resolveOrderedPaintedLines(allLines, order);
  const { runs, warnings } = buildTrajectory(paintedLines, opts);
  const reversals = detectReversalWarnings(paintedLines);
  const totals = trajectoryTotals(runs);
  return { runs, paintedLines, reversals, totals, warnings };
}
