/**
 * App-planned mission trajectory builder (source-agnostic: CSV + DXF).
 *
 * Builds ordered mark/travel runs from fitted PlanLine[] for POST /api/path/plan-trajectory.
 * Does not touch the network.
 *
 * Critical invariant (backend validation rule 1): never emit two adjacent `mark` runs.
 * Preview helper `buildCsvTransitLines` skips gaps under 0.02 m (invisible on the map).
 * That leaves adjacent marks, which the backend rejects with 422. For trajectory we
 * **merge, don't bridge** any gap under MARK_CONTIGUOUS_GAP_M (0.05 m), matching backend
 * rules 2/3 endpoint-touch tolerance.
 *
 * Axis convention: run points are always [north_m, east_m]. Points are taken from
 * `entity.preview_points` (explicit north/east). Fallback from/to uses CSV convention
 * (PlanPoint.x = north, PlanPoint.y = east) — same as `buildPlanLineForGroup`.
 * Templates still use the opposite placement convention in TemplatePanel; convert them
 * to this NED shape *before* calling buildTrajectory.
 *
 * Renamed from csvTrajectory.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";
import {
  buildExtendedMarkChain,
  edgeEntryPoint,
  edgeExitPoint,
  extensionEndpointsForLine,
  EXT_SEGMENT_JOIN_TOL_M,
  isMissionClosedLoop,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "./missionExtensions";

/** [north_m, east_m] — explicit NED pair for the plan-trajectory payload. */
export type NedPair = [number, number];

export type TrajectoryRunKind = "mark" | "travel";

export type TrajectoryRun = {
  kind: TrajectoryRunKind;
  /** ≥ 2 points, each [north, east]. */
  points: NedPair[];
  speed_m_s: number;
  label?: string;
};

/** Survey ground truth index into densified-or-sent run points (backend §3.1). */
export type SurveyGroundTruthPoint = {
  run_index: number;
  point_index: number;
  lat: number;
  lon: number;
};

/** Optional surveyed source vertex for ground-truth attachment. */
export type GroundTruthSourcePoint = {
  north: number;
  east: number;
  lat: number;
  lon: number;
};

export type BuildTrajectoryOpts = {
  markSpeedMs: number;
  travelSpeedMs: number;
  /**
   * Optional GPS survey rows. Each is matched to the nearest fitted mark point
   * within {@link GROUND_TRUTH_MATCH_M}; fitted fill points contribute nothing.
   */
  groundTruthSource?: GroundTruthSourcePoint[];
  /**
   * When enabled, PRE/AFT travel runs are inserted at mark-group boundaries
   * (see docs/CSV_EXTENSIONS_EXECUTION_PLAN.md). Spray-off by construction.
   */
  extensions?: Partial<CsvExtensionConfig> | null;
};

export type BuildTrajectoryResult = {
  runs: TrajectoryRun[];
  groundTruth: SurveyGroundTruthPoint[];
  warnings: string[];
};

/**
 * Gaps shorter than this are treated as contiguous paint geometry: merge into one
 * mark run rather than emit a travel leg the rover would densify to a single stop.
 * Matches backend plan-trajectory rules 2/3 (0.05 m neighbour-touch tolerance).
 */
export const MARK_CONTIGUOUS_GAP_M = 0.05;

/** Match survey lat/lon rows onto fitted NED points within this distance (m). */
export const GROUND_TRUTH_MATCH_M = 0.05;

/**
 * Layers that may become mark runs. Unknown layers fail toward **not** painting
 * (finding 3) — only an explicit allowlist or is_mark:true is accepted.
 */
export const PAINTABLE_PLAN_LAYERS = new Set(["marking", "center"]);

/** Near-coincident junction: drop the duplicate vertex when concatenating. */
const JUNCTION_DEDUP_M = 1e-6;

/** Spatial hash cell size for ground-truth attachment (m). */
const GT_CELL_M = GROUND_TRUTH_MATCH_M;

function isFinitePair(n: number, e: number): boolean {
  return Number.isFinite(n) && Number.isFinite(e);
}

function distM(a: NedPair, b: NedPair): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * True when a PlanLine is allowed into a mark trajectory.
 * Fail-closed: unknown layers without is_mark:true are excluded.
 */
export function isPaintableMarkLine(line: PlanLine): boolean {
  if (line.layer === "transit" || line.layer === "extension" || line.layer === "virtual_boundary") {
    return false;
  }
  if (line.is_mark === false || line.entity?.is_mark === false) {
    return false;
  }
  if (line.layer != null && PAINTABLE_PLAN_LAYERS.has(line.layer)) {
    return true;
  }
  // Explicit paint flag only — do not paint unknown layers by default.
  if (line.is_mark === true || line.entity?.is_mark === true) {
    return true;
  }
  return false;
}

type GtIndexEntry = { runIndex: number; pointIndex: number; n: number; e: number };

function gtCellKey(n: number, e: number): string {
  return `${Math.floor(n / GT_CELL_M)}:${Math.floor(e / GT_CELL_M)}`;
}

/** Build a spatial bucket index over mark-run points for O(1)-neighbour GT matching. */
function buildMarkPointIndex(runs: TrajectoryRun[]): Map<string, GtIndexEntry[]> {
  const index = new Map<string, GtIndexEntry[]>();
  for (let ri = 0; ri < runs.length; ri++) {
    if (runs[ri].kind !== "mark") continue;
    const pts = runs[ri].points;
    for (let pi = 0; pi < pts.length; pi++) {
      const [n, e] = pts[pi];
      const key = gtCellKey(n, e);
      let bucket = index.get(key);
      if (!bucket) {
        bucket = [];
        index.set(key, bucket);
      }
      bucket.push({ runIndex: ri, pointIndex: pi, n, e });
    }
  }
  return index;
}

function nearestInIndex(
  index: Map<string, GtIndexEntry[]>,
  north: number,
  east: number,
  maxDistM: number
): GtIndexEntry | null {
  const ci = Math.floor(north / GT_CELL_M);
  const cj = Math.floor(east / GT_CELL_M);
  let best: GtIndexEntry | null = null;
  let bestD = maxDistM;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = index.get(`${ci + di}:${cj + dj}`);
      if (!bucket) continue;
      for (const entry of bucket) {
        const d = Math.hypot(entry.n - north, entry.e - east);
        if (d <= bestD) {
          bestD = d;
          best = entry;
        }
      }
    }
  }
  return best;
}

/**
 * Extract an explicit NED polyline from a mark PlanLine.
 * Prefer preview_points (authoritative fitted geometry); fall back to from→to.
 * Returns null when fewer than 2 valid points.
 */
export function planLineToNedPolyline(line: PlanLine): NedPair[] | null {
  const preview = line.entity?.preview_points;
  if (preview && preview.length >= 2) {
    const pts: NedPair[] = [];
    for (const p of preview) {
      if (p == null || !isFinitePair(p.north, p.east)) continue;
      pts.push([p.north, p.east]);
    }
    return pts.length >= 2 ? pts : null;
  }

  const fx = line.from?.x;
  const fy = line.from?.y;
  const tx = line.to?.x;
  const ty = line.to?.y;
  if (!isFinitePair(fx, fy) || !isFinitePair(tx, ty)) return null;
  // CSV PlanLine convention: x = north, y = east (see buildPlanLineForGroup).
  return [
    [fx, fy],
    [tx, ty],
  ];
}

function polylineLengthM(points: NedPair[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distM(points[i - 1], points[i]);
  }
  return len;
}

/** Length of a single trajectory run (m). */
export function trajectoryRunLengthM(run: TrajectoryRun): number {
  return polylineLengthM(run.points);
}

/** Painted / travel totals for operator UI and Phase 4 verification. */
export function trajectoryTotals(runs: TrajectoryRun[]): {
  markLengthM: number;
  travelLengthM: number;
  markRunCount: number;
  travelRunCount: number;
} {
  let markLengthM = 0;
  let travelLengthM = 0;
  let markRunCount = 0;
  let travelRunCount = 0;
  for (const run of runs) {
    const len = trajectoryRunLengthM(run);
    if (run.kind === "mark") {
      markLengthM += len;
      markRunCount += 1;
    } else {
      travelLengthM += len;
      travelRunCount += 1;
    }
  }
  return { markLengthM, travelLengthM, markRunCount, travelRunCount };
}

/**
 * Backend rule 1: no two mark runs may be adjacent.
 * Returns null when ok, otherwise a human-readable failure.
 */
export function findAdjacentMarkViolation(runs: TrajectoryRun[]): string | null {
  for (let i = 0; i < runs.length - 1; i++) {
    if (runs[i].kind === "mark" && runs[i + 1].kind === "mark") {
      return `runs[${i}] and runs[${i + 1}] are both 'mark' with no travel run between them`;
    }
  }
  return null;
}

/**
 * Backend rules 2/3: each travel leg must start where the previous mark ends and
 * end where the next mark starts (within MARK_CONTIGUOUS_GAP_M).
 */
export function findTravelTouchViolations(
  runs: TrajectoryRun[],
  tolM: number = MARK_CONTIGUOUS_GAP_M
): string[] {
  const issues: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.kind !== "travel") continue;
    const prev = runs[i - 1];
    const next = runs[i + 1];
    const travelStart = run.points[0];
    const travelEnd = run.points[run.points.length - 1];
    if (prev?.kind === "mark") {
      const markEnd = prev.points[prev.points.length - 1];
      const gap = distM(markEnd, travelStart);
      if (gap > tolM) {
        issues.push(
          `runs[${i}] travel leg does not start where runs[${i - 1}] ends (gap ${gap.toFixed(3)} m)`
        );
      }
    }
    if (next?.kind === "mark") {
      const markStart = next.points[0];
      const gap = distM(travelEnd, markStart);
      if (gap > tolM) {
        issues.push(
          `runs[${i}] travel leg does not end where runs[${i + 1}] starts (gap ${gap.toFixed(3)} m)`
        );
      }
    }
  }
  return issues;
}

type MarkPoly = {
  points: NedPair[];
  label?: string;
  /** First painted path in this group — PRE attaches here. */
  firstLine: PlanLine;
  /** Last painted path in this group — AFT attaches here. */
  lastLine: PlanLine;
};

/**
 * Merge mark polylines whose end→start gap is under MARK_CONTIGUOUS_GAP_M into
 * single contiguous mark groups. Larger gaps stay as separate groups (travel later).
 * PRE uses firstLine of a group; AFT uses lastLine.
 */
function mergeContiguousMarks(marks: MarkPoly[]): MarkPoly[] {
  if (marks.length === 0) return [];
  const groups: MarkPoly[] = [];

  for (const mark of marks) {
    if (groups.length === 0) {
      groups.push({
        points: mark.points.slice(),
        label: mark.label,
        firstLine: mark.firstLine,
        lastLine: mark.lastLine,
      });
      continue;
    }

    const prev = groups[groups.length - 1];
    const prevEnd = prev.points[prev.points.length - 1];
    const nextStart = mark.points[0];
    const gap = distM(prevEnd, nextStart);

    if (gap < MARK_CONTIGUOUS_GAP_M) {
      // Contiguous paint — merge into one mark run.
      if (gap < JUNCTION_DEDUP_M) {
        prev.points.push(...mark.points.slice(1));
      } else {
        // Keep both junction points (tiny internal segment inside one mark run).
        prev.points.push(...mark.points);
      }
      if (mark.label) {
        prev.label = prev.label ? `${prev.label} + ${mark.label}` : mark.label;
      }
      prev.lastLine = mark.lastLine;
    } else {
      groups.push({
        points: mark.points.slice(),
        label: mark.label,
        firstLine: mark.firstLine,
        lastLine: mark.lastLine,
      });
    }
  }

  return groups;
}

/** Concatenate polylines, dropping near-duplicate junction vertices. */
function joinPolylines(parts: NedPair[][]): NedPair[] {
  const out: NedPair[] = [];
  for (const part of parts) {
    for (const p of part) {
      if (out.length > 0 && distM(out[out.length - 1], p) < JUNCTION_DEDUP_M) continue;
      out.push(p);
    }
  }
  return out;
}

/**
 * Inter-group travel with optional AFT + connector + PRE as one run.
 * AFT runs from mark end along exit tangent; PRE runs into next mark start along entry.
 * Connector bridges AFT tip → PRE tip (or mark ends when extensions are off).
 */
function buildInterGroupTravel(
  fromGroup: MarkPoly,
  toGroup: MarkPoly,
  travelSpeed: number,
  ext: { preM: number; aftM: number } | null
): TrajectoryRun {
  const markEnd = fromGroup.points[fromGroup.points.length - 1];
  const markStart = toGroup.points[0];

  if (!ext) {
    return {
      kind: "travel",
      points: [markEnd, markStart],
      speed_m_s: travelSpeed,
    };
  }

  const aft = extensionEndpointsForLine(fromGroup.lastLine, "aft", ext.aftM);
  const pre = extensionEndpointsForLine(toGroup.firstLine, "pre", ext.preM);
  const midFrom = aft ? aft[aft.length - 1] : markEnd;
  const midTo = pre ? pre[0] : markStart;
  const mid: NedPair[] =
    distM(midFrom, midTo) < JUNCTION_DEDUP_M ? [midFrom] : [midFrom, midTo];

  const parts: NedPair[][] = [];
  if (aft) parts.push(aft);
  parts.push(mid);
  if (pre) parts.push(pre);

  const points = joinPolylines(parts);
  if (points.length < 2) {
    return { kind: "travel", points: [markEnd, markStart], speed_m_s: travelSpeed };
  }
  return { kind: "travel", points, speed_m_s: travelSpeed };
}

/**
 * Attach survey lat/lon onto fitted mark points.
 * Uses a spatial hash so large road surveys (thousands × thousands) stay O(n)
 * on the UI thread rather than O(n·m) (finding 1).
 */
function attachGroundTruth(
  runs: TrajectoryRun[],
  source: GroundTruthSourcePoint[] | undefined
): SurveyGroundTruthPoint[] {
  if (!source || source.length === 0) return [];

  const index = buildMarkPointIndex(runs);
  if (index.size === 0) return [];

  const out: SurveyGroundTruthPoint[] = [];
  const used = new Set<string>(); // runIndex:pointIndex

  for (const src of source) {
    if (!Number.isFinite(src.lat) || !Number.isFinite(src.lon)) continue;
    if (!isFinitePair(src.north, src.east)) continue;

    const best = nearestInIndex(index, src.north, src.east, GROUND_TRUTH_MATCH_M);
    if (!best) continue;
    const key = `${best.runIndex}:${best.pointIndex}`;
    if (used.has(key)) continue;
    used.add(key);
    out.push({
      run_index: best.runIndex,
      point_index: best.pointIndex,
      lat: src.lat,
      lon: src.lon,
    });
  }

  return out;
}

/**
 * Build ordered mark/travel runs for plan-trajectory.
 *
 * @param orderedMarkLines Mark paths already in operator order (skips removed).
 *   Transit/extension layers are ignored if present.
 * @param opts Speeds and optional ground-truth survey rows.
 */
export function buildTrajectory(
  orderedMarkLines: PlanLine[],
  opts: BuildTrajectoryOpts
): BuildTrajectoryResult {
  const warnings: string[] = [];
  const markSpeed = opts.markSpeedMs;
  const travelSpeed = opts.travelSpeedMs;

  if (!(markSpeed > 0) || !(travelSpeed > 0)) {
    warnings.push("markSpeedMs and travelSpeedMs must be positive.");
  }

  const marks: MarkPoly[] = [];
  const acceptedLines: PlanLine[] = [];
  for (const line of orderedMarkLines) {
    // Allowlist only (finding 3) — unknown layers with undefined is_mark do not paint.
    if (!isPaintableMarkLine(line)) {
      if (
        line.layer != null &&
        line.layer !== "transit" &&
        line.layer !== "extension" &&
        line.layer !== "virtual_boundary" &&
        line.is_mark !== false
      ) {
        warnings.push(
          `Skipped line "${line.label ?? line.id}": layer "${line.layer}" is not a paint allowlist entry (set is_mark:true to force).`
        );
      }
      continue;
    }

    // Geometry layer: refuse paths marked non-paintable (undrivable / validation failed).
    // Operator must Skip them in Path Order; Send UI blocks until they do or acknowledge
    // (ack only allows other paintable paths through — these are still refused here).
    if (line.entity?.geometry?.paintable === false) {
      const fitNotes = Array.isArray(line.entity?.geometry?.fit_warnings)
        ? (line.entity.geometry.fit_warnings as unknown[])
            .filter((w): w is string => typeof w === "string")
            .slice(0, 2)
            .join("; ")
        : "";
      warnings.push(
        `Refused non-paintable path "${line.label ?? line.id}"` +
          (fitNotes ? ` (${fitNotes})` : "") +
          ". Skip it in Path Order or fix the survey geometry."
      );
      continue;
    }

    const points = planLineToNedPolyline(line);
    if (!points) {
      warnings.push(`Skipped line "${line.label ?? line.id}": fewer than 2 valid NED points.`);
      continue;
    }
    marks.push({ points, label: line.label, firstLine: line, lastLine: line });
    acceptedLines.push(line);
  }

  if (marks.length === 0) {
    return {
      runs: [],
      groundTruth: [],
      warnings: warnings.length > 0 ? warnings : ["No mark lines with ≥2 NED points."],
    };
  }

  const extCfg = normalizeCsvExtensionConfig(opts.extensions);
  const runs: TrajectoryRun[] = [];

  // The extended chain is the same decomposition the map preview draws (per-edge in
  // per-line mode, whole-path otherwise), so what the operator confirmed is what the rover
  // receives. Empty when extensions are off — we then fall through to the merged-group path.
  const chain = buildExtendedMarkChain(acceptedLines, extCfg);

  if (chain.length > 0) {
    if (extCfg.enabled && !extCfg.perLine && isMissionClosedLoop(acceptedLines)) {
      warnings.push(
        "Extensions suppressed: mission is a closed loop (first≈last within 0.01 m)."
      );
    }
    // [PRE?, MARK, AFT?] per edge, plus a connector wherever consecutive edges do not
    // already touch. AFT + connector + PRE are emitted as ONE travel run so the rover never
    // sees two adjacent travel legs where it should see a single continuous drive.
    for (let i = 0; i < chain.length; i++) {
      const item = chain[i];
      const next = chain[i + 1];

      if (i === 0 && item.pre) {
        runs.push({
          kind: "travel",
          points: item.pre,
          speed_m_s: travelSpeed,
          label: "pre-ext",
        });
      }

      // When neither this edge's start got a PRE nor the previous edge's end got an AFT,
      // and the two already touch (shared/near-coincident vertex — e.g. two template edges
      // meeting at a point), no travel run gets emitted below. Extend the previous mark run
      // instead of pushing an adjacent 'mark' run, which would violate the no-adjacent-mark
      // invariant (finding: template shapes whose edges converge on a shared vertex).
      const lastRun = runs[runs.length - 1];
      const touchesPrevMark =
        i > 0 &&
        lastRun?.kind === "mark" &&
        !item.pre &&
        distM(lastRun.points[lastRun.points.length - 1], item.edge.points[0]) <=
          EXT_SEGMENT_JOIN_TOL_M;

      if (touchesPrevMark && lastRun) {
        lastRun.points = joinPolylines([lastRun.points, item.edge.points]);
        if (item.edge.parentLabel) {
          lastRun.label = lastRun.label
            ? `${lastRun.label} + ${item.edge.parentLabel}`
            : item.edge.parentLabel;
        }
      } else {
        const markRun: TrajectoryRun = {
          kind: "mark",
          points: item.edge.points,
          speed_m_s: markSpeed,
        };
        if (item.edge.parentLabel) markRun.label = item.edge.parentLabel;
        runs.push(markRun);
      }

      // Travel out of this edge and into the next one, as a single joined leg.
      const parts: NedPair[][] = [];
      if (item.aft) parts.push(item.aft);
      if (next) {
        const exit = edgeExitPoint(item);
        const entry = edgeEntryPoint(next);
        if (distM(exit, entry) > EXT_SEGMENT_JOIN_TOL_M) parts.push([exit, entry]);
        if (next.pre) parts.push(next.pre);
      }
      if (parts.length > 0) {
        const points = joinPolylines(parts);
        if (points.length >= 2) {
          runs.push({
            kind: "travel",
            points,
            speed_m_s: travelSpeed,
            label: next ? undefined : "aft-ext",
          });
        }
      }
    }
  } else {
    const groups = mergeContiguousMarks(marks);
    if (groups.length < marks.length) {
      const merged = marks.length - groups.length;
      warnings.push(
        `Merged ${merged} contiguous mark path(s) (gap < ${MARK_CONTIGUOUS_GAP_M} m) into neighbouring mark runs.`
      );
    }

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const markRun: TrajectoryRun = {
        kind: "mark",
        points: g.points,
        speed_m_s: markSpeed,
      };
      if (g.label) markRun.label = g.label;
      runs.push(markRun);

      if (i < groups.length - 1) {
        // By construction gap ≥ MARK_CONTIGUOUS_GAP_M, so travel is real and endpoints touch.
        runs.push(buildInterGroupTravel(g, groups[i + 1], travelSpeed, null));
      }
    }
  }

  const adjacent = findAdjacentMarkViolation(runs);
  if (adjacent) {
    // Should be unreachable; fail loud so we never ship a 422 payload.
    warnings.push(`INTERNAL: ${adjacent}`);
    throw new Error(`buildTrajectory invariant violated: ${adjacent}`);
  }

  const touchIssues = findTravelTouchViolations(runs);
  for (const issue of touchIssues) {
    warnings.push(issue);
  }

  const groundTruth = attachGroundTruth(runs, opts.groundTruthSource);

  return { runs, groundTruth, warnings };
}
