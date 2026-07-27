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

export function trajectoryRunsToPayload(runs: TrajectoryRun[]): PlanTrajectoryRunPayload[] {
  return runs.map((r) => {
    const payload: PlanTrajectoryRunPayload = {
      kind: r.kind,
      points: r.points.map(([n, e]) => [n, e] as [number, number]),
      speed_m_s: r.speed_m_s,
    };
    if (r.label) payload.label = r.label;
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

