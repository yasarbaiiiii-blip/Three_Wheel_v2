/**
 * Phase 4 — client for POST /api/path/plan-trajectory.
 * App sends ordered NED runs; rover densifies + stages. No file upload.
 */

import type { SurveyGroundTruthPoint, TrajectoryRun } from "../utils/csvTrajectory";
import type { PathPlanResponse } from "./pathApi";

function apiUrl(apiBaseUrl: string, path: string) {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

export type PlanTrajectoryRunPayload = {
  kind: "mark" | "travel";
  points: [number, number][];
  speed_m_s: number;
  label?: string;
  /**
   * Indices into `points` that are SHAPE-BEARING — a point the rover's RPP
   * simplifier (Douglas-Peucker) must never delete because removing it would
   * change the driven geometry.
   *
   * Field 2026-07-29, 10 bags: on curves, marking RMS tracked how many shape
   * vertices the rover was told to protect — 37 declared kept 53 % of the path
   * and hit 1.47 cm; 0 declared kept 17 % and blew out to 5.84 cm (the rover
   * drove ~50 cm chords across the arc).
   *
   * But over-declaring is just as harmful: the app's CSV fitter densifies at
   * 0.35 m (roadMarkingCsvPath sampleLine), and declaring that COLLINEAR fill
   * must-hit forces the rover to keep a segment vertex every 0.35 m. The RPP
   * clips its pure-pursuit lookahead to the current segment end, so lookahead
   * collapsed to 0.12–0.21 m against a 0.52 m design minimum — 3–5x the
   * steering gain — and straight-line runs went marginally stable (bags
   * 2026-07-29: identical staged mission scored 1.39 cm and 8.14 cm; the bad
   * runs saturated the 0.45 rad/s yaw limit mid-line and pirouetted).
   *
   * So: declare endpoints and every point where the heading actually turns;
   * never declare collinear interpolation. See collinearAwareMustHitIndices.
   */
  must_hit_indices?: number[];
};

export type PlanTrajectoryRequest = {
  mission_name: string;
  /** Required — NED has no georeference of its own. */
  origin_gps: [number, number];
  runs: PlanTrajectoryRunPayload[];
  ground_truth?: SurveyGroundTruthPoint[];
  line_spacing?: number;
  transit_spacing?: number;
  marking_speed: number;
  transit_speed: number;
  spray_mode?: "continuous" | "dash" | "point";
  dash_on_distance_m?: number | null;
  dash_off_distance_m?: number | null;
  dash_start_state?: "on" | "off";
  point_dwell_s?: number;
  point_arrival_tolerance_m?: number;
  survey_tolerance_m?: number;
};

export type RunEchoEntry = {
  index: number;
  kind: "mark" | "travel" | string;
  num_points: number;
  length_m: number;
  label?: string | null;
  /** Terminal run-out appended by the backend — ignore in structural compare. */
  generated?: boolean;
};

/** PathPlanResponse plus plan-trajectory-only fields. */
export type PlanTrajectoryResponse = PathPlanResponse & {
  run_echo?: RunEchoEntry[];
  mark_length_m?: number;
  transit_length_m?: number;
  total_length_m?: number;
};

/**
 * Legacy heading gate (deg). Kept for tests/docs; production must-hit thinning
 * uses {@link MUST_HIT_PATH_ERROR_M} (chord / path error), not this angle.
 * Large heading jumps are still force-kept as a secondary belt (see below).
 */
export const MUST_HIT_COLLINEAR_TOL_DEG = 1.0;

/**
 * Max path error (m) for must-hit thinning vs the retained polyline chord.
 * Derived from paint budget: min(15 mm, 0.1 × PAINT_ERROR_BUDGET_M).
 * Dense curves sampled at 0.35 m routinely turn >1° per step; an angle-only
 * gate over-declares every sample and collapses pure-pursuit lookahead.
 */
export const MUST_HIT_PATH_ERROR_M = 0.015;

/** Force-keep any vertex whose instantaneous turn exceeds this (deg). */
const MUST_HIT_FORCE_TURN_DEG = 25;

function pointToSegmentDistM(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const ab0 = b[0] - a[0];
  const ab1 = b[1] - a[1];
  const len2 = ab0 * ab0 + ab1 * ab1;
  if (len2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * ab0 + (p[1] - a[1]) * ab1) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + ab0 * t), p[1] - (a[1] + ab1 * t));
}

/**
 * Endpoints plus the fewest interior points so the retained polyline stays
 * within {@link MUST_HIT_PATH_ERROR_M} of every skipped sample (Douglas–Peucker
 * style). Also force-keeps hard corners ({@link MUST_HIT_FORCE_TURN_DEG}).
 *
 * Collinear densification fill is never declared; real curves get a sparse
 * set of shape-bearing vertices so pure-pursuit lookahead is not collapsed.
 */
export function collinearAwareMustHitIndices(points: [number, number][]): number[] {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);

  const keep = new Set<number>([0, n - 1]);

  // Force-keep hard corners (independent of path-error recursion).
  for (let i = 1; i < n - 1; i++) {
    const ux = points[i][0] - points[i - 1][0];
    const uy = points[i][1] - points[i - 1][1];
    const vx = points[i + 1][0] - points[i][0];
    const vy = points[i + 1][1] - points[i][1];
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const turnDeg = Math.abs(
      (Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI
    );
    if (turnDeg > MUST_HIT_FORCE_TURN_DEG) keep.add(i);
  }

  function farthest(i0: number, i1: number): { idx: number; d: number } {
    let bestIdx = -1;
    let bestD = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointToSegmentDistM(points[i], points[i0], points[i1]);
      if (d > bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return { idx: bestIdx, d: bestD };
  }

  function simplify(i0: number, i1: number): void {
    if (i1 - i0 <= 1) return;
    const { idx, d } = farthest(i0, i1);
    if (idx < 0) return;
    if (d > MUST_HIT_PATH_ERROR_M) {
      keep.add(idx);
      simplify(i0, idx);
      simplify(idx, i1);
    }
  }

  // Recurse between sorted seeds so force-kept corners partition the chain.
  const seeds = Array.from(keep).sort((a, b) => a - b);
  for (let s = 0; s < seeds.length - 1; s++) {
    simplify(seeds[s], seeds[s + 1]);
  }

  return Array.from(keep).sort((a, b) => a - b);
}

export function trajectoryRunsToPayload(runs: TrajectoryRun[]): PlanTrajectoryRunPayload[] {
  return runs.map((r) => {
    const payload: PlanTrajectoryRunPayload = {
      kind: r.kind,
      points: r.points.map(([n, e]) => [n, e] as [number, number]),
      speed_m_s: r.speed_m_s,
    };
    if (r.label) payload.label = r.label;

    // Declare shape provenance so the rover's simplifier cannot delete a point
    // the geometry needs — without declaring the collinear 0.35 m fill that
    // the CSV fitter inserts (see must_hit_indices doc above for the field
    // evidence on both failure directions).
    //
    // Derived HERE from the final payload array on purpose: buildTrajectory
    // merges touching edges with joinPolylines, which re-indexes points. Any
    // index list carried through that merge would silently drift, and a
    // heading test is immune to re-indexing.
    //
    // TRAVEL runs are deadhead — nothing to protect. That intent must be sent
    // EXPLICITLY as [], not by omitting the field: the rover's engine reads an
    // absent declaration as "protect every source vertex" (deliberate
    // over-preserve, since under-preserving silently deletes surveyed intent).
    //
    // Field 2026-07-30, extensions run stg_f8c9737a_..._141428: omitting it
    // made every extension waypoint must-hit at 0.125 m spacing, and because
    // the RPP clips its lookahead to the current segment, the whole approach
    // ran at 0.096 m lookahead against a 0.52 m design minimum — ~6x steering
    // gain, below even the 0.12-0.21 m band that went bimodal on 2026-07-29.
    // The painted span was unaffected (the MARK run declares 2), but the
    // approach is exactly where the entry transient is set up.
    //
    // Sending [] only became meaningful with rover-side b89a7de: before that
    // the engine tested truthiness, so [] was falsy and fell through to the
    // same protect-everything fallback as omitting it.
    payload.must_hit_indices =
      r.kind === "mark" ? collinearAwareMustHitIndices(payload.points) : [];
    return payload;
  });
}

export type SprayMode = "continuous" | "dash" | "point";

/**
 * Build the plan-trajectory request body.
 * `spray_mode` defaults to continuous for road marking, but dash/point are first-class
 * options (finding 5) — not dead code paths behind a hardcode.
 */
export function buildPlanTrajectoryRequest(args: {
  missionName: string;
  originGps: [number, number];
  runs: TrajectoryRun[];
  groundTruth?: SurveyGroundTruthPoint[];
  markSpeedMs?: number;
  travelSpeedMs?: number;
  lineSpacing?: number;
  transitSpacing?: number;
  sprayMode?: SprayMode;
  dashOnDistanceM?: number | null;
  dashOffDistanceM?: number | null;
  dashStartState?: "on" | "off";
  pointDwellS?: number;
  pointArrivalToleranceM?: number;
  surveyToleranceM?: number;
}): PlanTrajectoryRequest {
  const marking_speed = args.markSpeedMs ?? 0.35;
  const transit_speed = args.travelSpeedMs ?? 0.5;
  const spray_mode: SprayMode = args.sprayMode ?? "continuous";
  const body: PlanTrajectoryRequest = {
    mission_name: args.missionName,
    origin_gps: args.originGps,
    runs: trajectoryRunsToPayload(args.runs),
    marking_speed,
    transit_speed,
    line_spacing: args.lineSpacing ?? 0.05,
    transit_spacing: args.transitSpacing ?? 0.15,
    spray_mode,
    dash_start_state: args.dashStartState ?? "on",
    point_dwell_s: args.pointDwellS ?? 1.0,
    point_arrival_tolerance_m: args.pointArrivalToleranceM ?? 0.1,
  };
  if (spray_mode === "dash") {
    body.dash_on_distance_m = args.dashOnDistanceM ?? 0.5;
    body.dash_off_distance_m = args.dashOffDistanceM ?? 0.5;
  } else {
    body.dash_on_distance_m = args.dashOnDistanceM ?? null;
    body.dash_off_distance_m = args.dashOffDistanceM ?? null;
  }
  if (args.surveyToleranceM != null) {
    body.survey_tolerance_m = args.surveyToleranceM;
  }
  if (args.groundTruth && args.groundTruth.length > 0) {
    body.ground_truth = args.groundTruth;
  }
  return body;
}

export function planTrajectory(
  apiBaseUrl: string,
  payload: PlanTrajectoryRequest
): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/path/plan-trajectory"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
}

