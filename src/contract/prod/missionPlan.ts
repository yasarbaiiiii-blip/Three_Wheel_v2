/**
 * App-planned mission contract v2 (`POST /api/missions/plan`).
 * Mirrors docs/contracts/app_planned_mission.md and the rover's `DYX3PATH 1` artifact.
 *
 * The tablet is the single geometry author. The backend only admits the
 * trajectory: validation, a lossless 5 m densify and a 10 mm boundary snap.
 * The rover places the trajectory with the anchor.
 */

/** Points are metres north/east of the anchor (WGS84 local tangent plane). */
export const APP_MISSION_FRAME = "local_ned" as const;
/** Submitted points accepted per mission. */
export const MAX_MISSION_POINTS = 50_000;
/** Points stored after the backend densify. */
export const MAX_STORED_POINTS = 200_000;
/** Longest step between consecutive points the backend stores untouched. */
export const MAX_MISSION_STEP_M = 5.0;
/** Coordinate envelope, metres from the anchor, per axis. */
export const MISSION_ENVELOPE_M = 10_000.0;
/** Largest gap the backend snaps between runs; larger gaps need a travel run. */
export const BOUNDARY_SNAP_M = 0.01;
/** Largest |alt| the backend accepts on the anchor (m). */
export const ANCHOR_ALT_LIMIT_M = 10_000.0;

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

/** WGS84 position of the trajectory's local origin. `alt` is ellipsoid height (m). */
export interface MissionAnchor {
  lat: number;
  lon: number;
  alt?: number;
}

export interface AppPlannedMissionRequest {
  client: string;
  client_version: string;
  name?: string;
  frame: typeof APP_MISSION_FRAME;
  anchor: MissionAnchor;
  runs: AppPlannedRun[];
}

export interface AppPlannedMissionSummary {
  sha256: string;
  engine_id: string;
  num_points: number;
  num_spray_points: number;
  mark_length_m: number | null;
  transit_length_m: number | null;
  bbox_ne_m: [number, number, number, number] | null;
  source?: {
    type?: string;
    client?: string;
    client_version?: string;
    name?: string;
    num_runs?: number;
  } | null;
}

/** What admission changed. Zero / 0.0 means the trajectory was stored exactly as submitted. */
export interface AppPlannedNormalisation {
  densified_steps: number;
  max_boundary_snap_m: number;
}

export interface AppPlannedMissionResponse {
  ok: boolean;
  mission: AppPlannedMissionSummary;
  normalisation: AppPlannedNormalisation;
}

export interface AppPlannedMissionErrorResponse {
  ok: false;
  code: string;
  reason: string;
}
