/**
 * App-Planned Mission Contract v:1 (GAP-04)
 * Matches docs/contracts/app_planned_mission_v1.md and DYX3PATH 1 format.
 */

export const APP_MISSION_FRAME = "local_ned" as const;
export const MAX_MISSION_POINTS = 50000;
export const MAX_MISSION_STEP_M = 5.0;
export const MISSION_ENVELOPE_M = 10000.0;

/** Bitmask flags for path points: flags 0..3 */
export const FLAG_SPRAY_INTENT = 0x01; // bit 0: 1 = spray ON, 0 = spray OFF
export const FLAG_MUST_HIT = 0x02; // bit 1: 1 = must-hit vertex, 0 = intermediate

export type PointFlags = number; // 0 | 1 | 2 | 3

/** [north_m, east_m, flags] */
export type AppPlannedPointTuple = [number, number, PointFlags];

export type AppPlannedRunType = "mark" | "travel";

export interface AppPlannedRun {
  type: AppPlannedRunType;
  points: AppPlannedPointTuple[];
}

export interface AppPlannedMissionRequest {
  client: string;
  client_version: string;
  name?: string;
  frame: typeof APP_MISSION_FRAME;
  origin_ne_m?: [number, number];
  runs: AppPlannedRun[];
}

export interface AppPlannedMissionResponse {
  ok: boolean;
  mission: {
    sha256: string;
    engine_id: string;
    num_points: number;
    num_spray_points: number;
    mark_length_m: number | null;
    transit_length_m: number | null;
    bbox_ne_m: [number, number, number, number] | null;
    source?: unknown;
  };
}

export interface AppPlannedMissionErrorResponse {
  ok: false;
  code: string;
  reason: string;
}
