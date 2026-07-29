/**
 * Path order, paint/skip, and heading-reversal helpers for app-planned missions.
 * Pure logic; UI lives in CsvPathOrderStep / MissionPathOrderStep.
 *
 * Renamed from csvPathOrder.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";
import {
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
 * Greedy nearest-endpoint from the first path in file order, which keeps the mission
 * starting where it starts today.
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

  const remaining = placeable.slice();
  const chained: PlanLine[] = [remaining.shift() as PlanLine];
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

  return [...chained, ...unplaceable, ...others];
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
 * Preview transit leg between two consecutive painted paths (end of A → start of B).
 * Matches map geometry from {@link buildCsvTransitLines}.
 */
export type CsvTransitPreview = {
  id: string;
  fromLineId: string;
  toLineId: string;
  fromLabel: string;
  toLabel: string;
  lengthM: number;
};

/** Build operator-facing transit previews for consecutive painted paths in order. */
export function buildCsvTransitPreviews(
  allLines: PlanLine[],
  order: CsvPathOrderEntry[]
): CsvTransitPreview[] {
  const painted = resolveOrderedPaintedLines(allLines, order);
  const transitLines = buildCsvTransitLines(painted);
  const previews: CsvTransitPreview[] = [];
  // buildCsvTransitLines skips tiny gaps, so index against consecutive painted pairs
  // by matching endpoints rather than assuming 1:1 with painted.length - 1.
  let paintedPair = 0;
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
    if (lengthM < 0.02) continue;
    const matching = transitLines[paintedPair];
    paintedPair += 1;
    previews.push({
      id: matching?.id ?? `csv-transit-preview-${i}`,
      fromLineId: from.id,
      toLineId: to.id,
      fromLabel: from.label,
      toLabel: to.label,
      lengthM: matching?.entity?.length_m ?? lengthM,
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
