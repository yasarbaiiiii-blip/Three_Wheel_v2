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
  normalizeCsvExtensionConfig,
  terminalUnitVector,
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
 * were driven the other way. A large gap between the two means this curve's direction is
 * fighting the walk direction. {@link chainMarkLinesByGeometry} already drives curves
 * either way when it orders a file, so this is for orders it did not produce (operator
 * drag-and-drop, a re-anchored path) — it surfaces the avoidable transit for the operator.
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

type Ned = [number, number];

/** First and last point of a plan line, in [north, east]. */
function lineEndpoints(line: PlanLine): { start: Ned; end: Ned } | null {
  const pts = planLineToNedPolyline(line);
  if (!pts || pts.length < 2) return null;
  return { start: pts[0], end: pts[pts.length - 1] };
}

/**
 * Same line driven the other way: vertices reversed, `from`/`to` swapped.
 *
 * Valid for every geometry, curves included. An ARC/CIRCLE derives its extension tangents
 * from the direction its polyline actually runs (see `analyticCurveTangents` in
 * missionExtensions.ts), so a reversed arc's run-up and run-out flip with the points and
 * stay consistent with `planLineToNedPolyline`, the trajectory and the preview.
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

/** Rover start position in the plan frame: [north, east] metres. */
export type ChainStartPosition = readonly [number, number];

export type ChainOptions = {
  /**
   * Where the rover starts. When given, the greedy walk may begin at the nearest endpoint to
   * it and the travel from this point to the first mark counts in every cost. Omitted: the
   * walk is free to start anywhere and the entry leg costs nothing.
   */
  startPosition?: ChainStartPosition | null;
  /**
   * Extension config the order will be driven with. Run-ups shift where the rover leaves one
   * mark and joins the next, which decides what a connector drives over. Disabled or omitted:
   * connectors span mark end to next mark start.
   */
  extensionConfig?: Partial<CsvExtensionConfig> | null;
};

/**
 * Cost, in metres, charged for each mark already on the ground that a connector drives over
 * (wet paint). Port of `wet_paint_penalty_m` in the rover's `segment_order.py`.
 */
export const WET_PAINT_PENALTY_M = 5;

/**
 * Improvement passes (2-opt slice reversal, or-opt relocation) run only up to this many
 * placeable marks; above it the multi-start greedy result is returned as is. Port of the
 * rover's `max_two_opt_segments`.
 */
export const CHAIN_OPTIMIZE_MAX_MARKS = 80;

/** Fewer marks than this are left to the greedy walk (the rover's 2-opt returns early). */
const CHAIN_OPTIMIZE_MIN_MARKS = 4;

/** Maximum alternating 2-opt / or-opt rounds. */
const CHAIN_OPTIMIZE_MAX_PASSES = 20;

/** Longest run of consecutive marks or-opt will lift out and re-insert. */
const OR_OPT_MAX_RUN = 3;

/** A candidate must beat the incumbent by more than this to be accepted. */
const COST_EPS = 1e-9;

/** Collinear-point tolerance when simplifying obstacle polylines (m). */
const SIMPLIFY_TOL_M = 0.01;

/**
 * A connector springs from one mark's run-out and lands on the next mark's run-up, so it
 * grazes both near its own endpoints. Crossings within this distance of either end are
 * ignored; the marks themselves are not skipped, because a connector leaving a closed shape
 * can genuinely re-cross it further along.
 */
const ENDPOINT_GRAZE_M = 0.06;

/** Drop collinear interior vertices so crossing tests stay cheap on densified marks. */
function simplifyPolyline(points: Ned[], tolM: number = SIMPLIFY_TOL_M): Ned[] {
  if (points.length < 3) return points.slice();
  const out: Ned[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const ex = c[0] - a[0];
    const ey = c[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const d = Math.abs((b[0] - a[0]) * ey - (b[1] - a[1]) * ex) / len;
    if (d > tolM) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Where the open segments p1p2 and p3p4 properly cross, or null. */
function properCrossPoint(p1: Ned, p2: Ned, p3: Ned, p4: Ned): Ned | null {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t > 0 && t < 1 && u > 0 && u < 1) {
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  }
  return null;
}

function nedDist(a: Ned, b: Ned): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * A route is a list of oriented marks. Each entry is `index * 2 + (reversed ? 1 : 0)`, where
 * `index` is the mark's position in the placeable list. Flipping a mark's direction is `^ 1`.
 */
type RouteCode = number;

type OrderModel = {
  readonly n: number;
  readonly startPosition: Ned | null;
  /** Mark start / end per code (what the deadhead distance measures). */
  readonly start: Ned[];
  readonly end: Ned[];
  /** Where the rover leaves (AFT tip) and joins (PRE tip) per code. */
  readonly exit: Ned[];
  readonly entry: Ned[];
  /** Line as driven, per code. */
  readonly lineOf: PlanLine[];
  /** Simplified obstacle polyline and bounding box per mark index. */
  readonly poly: Ned[][];
  readonly bbox: [number, number, number, number][];
  readonly crossCache: Map<number, number[]>;
};

function resolveExtensionLengths(
  config: Partial<CsvExtensionConfig> | null | undefined
): { preM: number; aftM: number } {
  const cfg = normalizeCsvExtensionConfig(config);
  return cfg.enabled ? { preM: cfg.preM, aftM: cfg.aftM } : { preM: 0, aftM: 0 };
}

/**
 * Unit run-in / run-out directions of a line as driven. Curves use their analytic tangents
 * (the same ones the extensions are built from); everything else the end segments.
 */
function runDirections(line: PlanLine, pts: Ned[]): { startDir: Ned | null; endDir: Ned | null } {
  const curve = analyticCurveTangents(line);
  if (curve) return { startDir: curve[0], endDir: curve[1] };
  return { startDir: terminalUnitVector(pts, "start"), endDir: terminalUnitVector(pts, "end") };
}

function buildOrderModel(
  placeable: PlanLine[],
  options: ChainOptions | undefined
): OrderModel {
  const { preM, aftM } = resolveExtensionLengths(options?.extensionConfig);
  const sp = options?.startPosition;
  const startPosition: Ned | null =
    sp && Number.isFinite(sp[0]) && Number.isFinite(sp[1]) ? [sp[0], sp[1]] : null;

  const n = placeable.length;
  const model: OrderModel = {
    n,
    startPosition,
    start: new Array<Ned>(2 * n),
    end: new Array<Ned>(2 * n),
    exit: new Array<Ned>(2 * n),
    entry: new Array<Ned>(2 * n),
    lineOf: new Array<PlanLine>(2 * n),
    poly: new Array<Ned[]>(n),
    bbox: new Array<[number, number, number, number]>(n),
    crossCache: new Map(),
  };

  placeable.forEach((line, idx) => {
    const forward = planLineToNedPolyline(line)!;
    const backward = forward.slice().reverse();
    const reversedLine = reversePlanLineDirection(line);
    const orientations: [PlanLine, Ned[]][] = [
      [line, forward],
      [reversedLine, backward],
    ];
    orientations.forEach(([oriented, pts], flip) => {
      const code = idx * 2 + flip;
      const s = pts[0];
      const e = pts[pts.length - 1];
      model.lineOf[code] = oriented;
      model.start[code] = s;
      model.end[code] = e;
      let entry = s;
      let exit = e;
      if (preM > 0 || aftM > 0) {
        const { startDir, endDir } = runDirections(oriented, pts);
        if (preM > 0 && startDir) entry = [s[0] - startDir[0] * preM, s[1] - startDir[1] * preM];
        if (aftM > 0 && endDir) exit = [e[0] + endDir[0] * aftM, e[1] + endDir[1] * aftM];
      }
      model.entry[code] = entry;
      model.exit[code] = exit;
    });
    model.poly[idx] = simplifyPolyline(forward);
    let minN = Infinity;
    let minE = Infinity;
    let maxN = -Infinity;
    let maxE = -Infinity;
    for (const p of model.poly[idx]) {
      if (p[0] < minN) minN = p[0];
      if (p[0] > maxN) maxN = p[0];
      if (p[1] < minE) minE = p[1];
      if (p[1] > maxE) maxE = p[1];
    }
    model.bbox[idx] = [minN, minE, maxN, maxE];
  });
  return model;
}

/** Indices of the marks the connector `a -> b` drives over, whatever the paint order. */
function connectorCrossings(model: OrderModel, a: RouteCode, b: RouteCode): number[] {
  const key = a * 2 * model.n + b;
  const cached = model.crossCache.get(key);
  if (cached) return cached;

  const p1 = model.exit[a];
  const p2 = model.entry[b];
  const loN = Math.min(p1[0], p2[0]) - 1e-9;
  const hiN = Math.max(p1[0], p2[0]) + 1e-9;
  const loE = Math.min(p1[1], p2[1]) - 1e-9;
  const hiE = Math.max(p1[1], p2[1]) + 1e-9;

  const hits: number[] = [];
  for (let m = 0; m < model.n; m++) {
    const [minN, minE, maxN, maxE] = model.bbox[m];
    if (maxN < loN || minN > hiN || maxE < loE || minE > hiE) continue;
    const poly = model.poly[m];
    for (let i = 0; i < poly.length - 1; i++) {
      const x = properCrossPoint(p1, p2, poly[i], poly[i + 1]);
      if (!x) continue;
      if (nedDist(x, p1) < ENDPOINT_GRAZE_M || nedDist(x, p2) < ENDPOINT_GRAZE_M) continue;
      hits.push(m);
      break;
    }
  }
  model.crossCache.set(key, hits);
  return hits;
}

/** Sum of the transit gaps between consecutive entries — the quantity a chain minimizes. */
export function totalGapM(chain: PlanLine[]): number {
  let total = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = lineEndpoints(chain[i]);
    const b = lineEndpoints(chain[i + 1]);
    if (!a || !b) continue;
    total += Math.hypot(b.start[0] - a.end[0], b.start[1] - a.end[1]);
  }
  return total;
}

/** Transit distance of a route: start position (if any) -> first mark, then end -> next start. */
function deadheadM(model: OrderModel, route: RouteCode[]): number {
  let total = 0;
  let cursor = model.startPosition;
  for (const code of route) {
    if (cursor) total += nedDist(cursor, model.start[code]);
    cursor = model.end[code];
  }
  return total;
}

/**
 * Metres-equivalent cost of driving over paint already on the ground. Only marks laid
 * earlier in the route count (the mark just finished included); crossing geometry that has
 * not been painted yet is free, which is what lets an enclosed shape be visited before the
 * shape around it.
 */
function wetPaintPenaltyM(model: OrderModel, route: RouteCode[]): number {
  const painted = new Uint8Array(model.n);
  let hitsOnPaint = 0;
  for (let k = 0; k < route.length - 1; k++) {
    painted[route[k] >> 1] = 1;
    for (const m of connectorCrossings(model, route[k], route[k + 1])) {
      if (painted[m]) hitsOnPaint++;
    }
  }
  return WET_PAINT_PENALTY_M * hitsOnPaint;
}

function routeCostM(model: OrderModel, route: RouteCode[]): number {
  return deadheadM(model, route) + wetPaintPenaltyM(model, route);
}

/**
 * Nearest-endpoint walk. Seeded at `seedCode` when given, else at the start position (which
 * the caller guarantees exists). Ties favour the earlier mark, and the forward direction
 * over the backward one.
 */
function greedyRoute(model: OrderModel, seedCode: RouteCode | null): RouteCode[] {
  const { n } = model;
  const used = new Uint8Array(n);
  const route: RouteCode[] = [];
  let cursor: Ned;
  if (seedCode !== null) {
    route.push(seedCode);
    used[seedCode >> 1] = 1;
    cursor = model.end[seedCode];
  } else {
    cursor = model.startPosition!;
  }

  while (route.length < n) {
    let bestCode = -1;
    let bestDist = Infinity;
    for (let id = 0; id < n; id++) {
      if (used[id]) continue;
      const forward = nedDist(cursor, model.start[id * 2]);
      if (forward < bestDist) {
        bestDist = forward;
        bestCode = id * 2;
      }
      // A mark whose far end is nearer continues the walk when driven backwards.
      const backward = nedDist(cursor, model.start[id * 2 + 1]);
      if (backward < bestDist) {
        bestDist = backward;
        bestCode = id * 2 + 1;
      }
    }
    route.push(bestCode);
    used[bestCode >> 1] = 1;
    cursor = model.end[bestCode];
  }
  return route;
}

/** Reverse a slice of the route: order flips and so does every mark's direction. */
function reverseSlice(route: RouteCode[], i: number, k: number): RouteCode[] {
  const out = route.slice(0, i);
  for (let x = k; x >= i; x--) out.push(route[x] ^ 1);
  for (let x = k + 1; x < route.length; x++) out.push(route[x]);
  return out;
}

/**
 * Lift a run of 1-3 marks out and re-insert it elsewhere, in either direction. Returns the
 * first improving move found, or null. `locked` leading marks never move and nothing is
 * inserted before them.
 */
function orOptMove(
  model: OrderModel,
  best: RouteCode[],
  bestCost: number,
  locked: number
): { route: RouteCode[]; cost: number } | null {
  const n = best.length;
  for (let run = 1; run <= OR_OPT_MAX_RUN; run++) {
    for (let i = locked; i <= n - run; i++) {
      const chunk = best.slice(i, i + run);
      const rest = best.slice(0, i).concat(best.slice(i + run));
      const flipped = chunk.slice().reverse().map((c) => c ^ 1);
      for (let j = locked; j <= rest.length; j++) {
        if (j === i) continue; // back where it came from
        for (const piece of [chunk, flipped]) {
          const cand = rest.slice(0, j).concat(piece, rest.slice(j));
          const cost = routeCostM(model, cand);
          if (cost + COST_EPS < bestCost) return { route: cand, cost };
        }
      }
    }
  }
  return null;
}

/**
 * 2-opt slice reversals alternated with or-opt relocations until neither improves (at most
 * {@link CHAIN_OPTIMIZE_MAX_PASSES} rounds). Faithful port of the rover's `_apply_two_opt`:
 * 2-opt cannot lift a stranded mark out and re-place it, or-opt cannot undo a crossed pair
 * of legs, so the two move sets are used together.
 *
 * The first `locked` marks (an operator-pinned seed) keep their place and direction.
 */
function improveRoute(model: OrderModel, route: RouteCode[], locked: number): RouteCode[] {
  const n = route.length;
  if (n < CHAIN_OPTIMIZE_MIN_MARKS) return route;

  let best = route.slice();
  let bestCost = routeCostM(model, best);

  for (let pass = 0; pass < CHAIN_OPTIMIZE_MAX_PASSES; pass++) {
    let changed = false;

    for (let i = locked; i < n - 2; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = reverseSlice(best, i, k);
        const cost = routeCostM(model, cand);
        if (cost + COST_EPS < bestCost) {
          best = cand;
          bestCost = cost;
          changed = true;
        }
      }
    }

    const moved = orOptMove(model, best, bestCost, locked);
    if (moved) {
      best = moved.route;
      bestCost = moved.cost;
      changed = true;
    }

    if (!changed) break;
  }
  return best;
}

/**
 * Above this many placeable marks, multi-start search is skipped in favor of the single
 * file-order seed — multi-start is O(n^3) (n candidate seeds x 2 directions x O(n^2) greedy
 * walk each), fine for a road-marking file's tens of entities but not worth risking on a
 * pathological input.
 */
export const CHAIN_MULTI_START_MAX_MARKS = 200;

/**
 * Cheapest greedy walk over every candidate seed. The incumbent is the start-position walk
 * when a start position exists, else `placeable[0]` forward; a later candidate replaces it
 * only when strictly cheaper, so ties keep the earliest-tried one.
 */
function bestGreedyRoute(model: OrderModel): RouteCode[] {
  let bestRoute = greedyRoute(model, model.startPosition ? null : 0);
  let bestTotal = deadheadM(model, bestRoute);
  if (model.n > CHAIN_MULTI_START_MAX_MARKS) return bestRoute;

  const consider = (seed: RouteCode) => {
    const candidate = greedyRoute(model, seed);
    const total = deadheadM(model, candidate);
    if (total < bestTotal) {
      bestTotal = total;
      bestRoute = candidate;
    }
  };
  for (let i = 0; i < model.n; i++) {
    // Without a start position `i = 0` forward is already the incumbent.
    if (model.startPosition || i > 0) consider(i * 2);
    consider(i * 2 + 1);
  }
  return bestRoute;
}

/**
 * Split marks into those with a usable polyline and those without. Paths with no usable
 * polyline cannot be chained; callers keep them, in file order, after the chain.
 */
function partitionPlaceable(marks: PlanLine[]): { placeable: PlanLine[]; unplaceable: PlanLine[] } {
  const placeable: PlanLine[] = [];
  const unplaceable: PlanLine[] = [];
  for (const line of marks) {
    (lineEndpoints(line) ? placeable : unplaceable).push(line);
  }
  return { placeable, unplaceable };
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
 * Construction is multi-start greedy nearest-endpoint: always seeding from the first mark in
 * file order (in its own authored direction) can lock in a bad walk when that entity happens
 * to sit at the "wrong end" relative to another entity elsewhere in the file — confirmed on a
 * real survey DXF, where seeding from entity 0 forced ~10 m of transit that seeding from a
 * different entity (or that entity reversed) does not. So every placeable entity is tried as
 * a candidate seed in both directions, and whichever produces the least total transit wins.
 * Ties — most commonly a file that's already one continuous walk or a fully closed loop,
 * where every seed is equally good — favor the earliest-tried candidate, which is
 * `placeable[0]` walked forward: the mission still starts where file order started it
 * whenever that's already an optimal choice.
 *
 * Any path, a curve included, may be driven in either direction. A reversed ARC/CIRCLE keeps
 * consistent extension tangents because they follow the direction its polyline runs.
 *
 * Up to {@link CHAIN_OPTIMIZE_MAX_MARKS} marks the greedy result is then refined by 2-opt
 * slice reversal and or-opt relocation, against transit distance plus a
 * {@link WET_PAINT_PENALTY_M} charge per already-painted mark a connector drives over. Port
 * of the rover's `optimize_segment_order`. Deterministic: same input, same output.
 */
export function chainMarkLinesByGeometry(
  lines: PlanLine[],
  options?: ChainOptions
): PlanLine[] {
  const marks = selectMarkPlanLines(lines);
  const markIds = new Set(marks.map((m) => m.id));
  const others = lines.filter((l) => !markIds.has(l.id));
  const { placeable, unplaceable } = partitionPlaceable(marks);

  if (placeable.length === 1 && options?.startPosition && marks.length === 1) {
    // A lone mark is only worth turning around: enter it from whichever end is nearer.
    const model = buildOrderModel(placeable, options);
    const sp = model.startPosition;
    const reversed = sp != null && nedDist(sp, model.start[1]) < nedDist(sp, model.start[0]);
    return [model.lineOf[reversed ? 1 : 0], ...others];
  }
  if (marks.length < 2 || placeable.length < 2) return [...marks, ...others];

  const model = buildOrderModel(placeable, options);
  let route = bestGreedyRoute(model);
  if (model.n <= CHAIN_OPTIMIZE_MAX_MARKS) route = improveRoute(model, route, 0);

  return [...route.map((code) => model.lineOf[code]), ...unplaceable, ...others];
}

/**
 * Re-chain mark lines starting from an operator-picked seed (Anchor point selection),
 * instead of `chainMarkLinesByGeometry`'s auto-optimized seed. The same greedy walk and
 * improvement passes as import-time chaining, with the seed pinned: it stays first, and in
 * the direction asked for, however the rest is rearranged.
 *
 * `seedFromEnd` requests starting the seed line from its `to` end instead of `from`.
 *
 * No-ops (returns `lines` marks/others unchanged) when `seedLineId` is not a
 * placeable mark line in `lines` — defensive only; callers are expected to pass a
 * seed that was itself sourced from this same line list.
 */
export function chainMarkLinesFromSeed(
  lines: PlanLine[],
  seedLineId: string,
  seedFromEnd: boolean,
  options?: Pick<ChainOptions, "extensionConfig">
): PlanLine[] {
  const marks = selectMarkPlanLines(lines);
  const markIds = new Set(marks.map((m) => m.id));
  const others = lines.filter((l) => !markIds.has(l.id));
  if (marks.length < 2) return [...marks, ...others];

  const { placeable, unplaceable } = partitionPlaceable(marks);

  const seedIdx = placeable.findIndex((l) => l.id === seedLineId);
  if (seedIdx < 0) return [...marks, ...others];

  const model = buildOrderModel(placeable, options);
  let route = greedyRoute(model, seedIdx * 2 + (seedFromEnd ? 1 : 0));
  if (model.n <= CHAIN_OPTIMIZE_MAX_MARKS) route = improveRoute(model, route, 1);

  return [...route.map((code) => model.lineOf[code]), ...unplaceable, ...others];
}

export type MarkOrderCost = {
  /** Transit distance: start position (if any) to the first mark, then each end to the next start. */
  deadheadM: number;
  /** {@link WET_PAINT_PENALTY_M} per already-painted mark a connector drives over. */
  wetPaintPenaltyM: number;
  totalM: number;
};

/**
 * The objective the chaining minimizes, for an order as given (marks without a usable
 * polyline are ignored). Exposed so callers and tests can compare orders on the same terms.
 */
export function evaluateMarkOrder(lines: PlanLine[], options?: ChainOptions): MarkOrderCost {
  const { placeable } = partitionPlaceable(selectMarkPlanLines(lines));
  const model = buildOrderModel(placeable, options);
  const route = placeable.map((_, idx) => idx * 2);
  const deadhead = deadheadM(model, route);
  const penalty = wetPaintPenaltyM(model, route);
  return { deadheadM: deadhead, wetPaintPenaltyM: penalty, totalM: deadhead + penalty };
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

/**
 * Reverse walk sequence only — paint flags stay on the same path ids.
 * Does not flip CAD direction (arcs/circles must not be reversed here).
 */
export function reversePathOrder(order: CsvPathOrderEntry[]): CsvPathOrderEntry[] {
  if (order.length < 2) return order.slice();
  return order.slice().reverse();
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
