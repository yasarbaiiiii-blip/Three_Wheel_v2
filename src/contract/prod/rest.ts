/**
 * Production REST API Types (DYX_3WD contract)
 *
 * All routes under /api.
 * Auth: Authorization: Bearer <token>
 */

export interface PingResponse {
  status: "ok" | string;
  /** Stable rover identity (backend contract 1a); absent on older backends. */
  rover_id?: string;
  rover_name?: string;
}

export interface HealthResponse {
  backend: string;
  gateway_connected: boolean;
  telemetry_age_s: number | null;
  telemetry_fresh: boolean;
  tablet_heartbeat_age_s: number | null;
  tablet_alive: boolean;
}

export interface HeartbeatResponse {
  ok: boolean;
}

export interface EstopRequest {
  asserted: boolean;
}

export interface ArmRequest {
  arm: boolean;
}

export interface OffboardRequest {
  enable: boolean;
}

/** `POST /api/mission/abort` body. The operator's "Stop" sends `operator`. */
export type AbortReason = "operator" | "safety" | "unspecified";

export interface AbortRequest {
  reason?: AbortReason;
}

/** `POST /api/missions/{sha}/start` body. `request_id` is the idempotency key. */
export interface StartMissionRequest {
  request_id?: string;
}

/**
 * Standard downstream verdict for gateway service commands (pause, resume, abort, estop, arm, offboard).
 * `delivered`: true = the gateway answered; false = NOT delivered (nothing happened); null = unknown
 * (no reply in time: the command may or may not have run).
 */
export interface GatewayVerdictResponse {
  ok: boolean;
  code: string;
  reason: string;
  delivered: boolean | null;
  data?: Record<string, unknown>;
}

/** The mission node's answer to a start, copied from the gateway reply (`data`, untouched). */
export interface StartMissionReplyData {
  accepted: boolean;
  /** StartMission.srv REASON_*: 0 on accept. */
  reason_code: number;
  /** The execution id. */
  mission_id: number;
  /** True when `request_id` matched the most recent execution: nothing new was started. */
  duplicate: boolean;
  /** With reason 3 (SAFETY_GATE): the guard's first failing pre-arm gate. */
  gate_reason_code: number;
}

/**
 * `202 Accepted` of `POST /api/missions/{sha}/start`. An acknowledgement only: loading, placing,
 * arming and engaging then arrive as `mission_state` rover events, never by polling.
 */
export interface StartMissionResponse {
  ok: true;
  accepted: true;
  execution: {
    /** The execution id (the gateway reply's `data.mission_id`); null if absent. */
    mission_id: number | null;
    /** The id the app sent; null without one. */
    request_id: string | null;
    /** True when the rover returned the existing execution of this request_id. */
    duplicate: boolean | null;
    gate_reason_code: number | null;
  };
  data: StartMissionReplyData;
}

/** Error body of the mission store routes (upload, read, start id checks): no `delivered`. */
export interface MissionErrorResponse {
  ok: false;
  code: string;
  reason: string;
}

export interface MissionSummary {
  sha256: string;
  engine_id: string;
  num_points: number;
  num_spray_points: number;
  mark_length_m: number | null;
  transit_length_m: number | null;
  bbox_ne_m: [number, number, number, number] | null;
  source?: unknown;
}

export interface MissionsListResponse {
  missions: MissionSummary[];
}

export interface MissionDetailResponse {
  mission: MissionSummary;
}

export interface MissionPathResponse {
  sha256: string;
  frame: "local_ned" | string;
  /** Geodetic anchor the points are relative to; null for an EKF-local artifact. */
  anchor?: { lat: number; lon: number; alt: number | null } | null;
  points: [number, number, number][]; // [north_m, east_m, flags]
}

export interface TelemetryRestResponse {
  connected: boolean;
  age_s: number | null;
  snapshot: import("./realtime").RoverTelemetrySnapshot | null;
}

export interface RunSummary {
  run_id: string;
  started_at?: string;
  ended_at?: string;
  mission_sha256?: string;
  state?: string;
  [key: string]: unknown;
}

export interface RunsListResponse {
  runs: RunSummary[];
}

/** RTK status structure per docs/plans/2026-10-08_production_rtk_plan.md §17-§19 */
export interface RtkStatusReport {
  overall?: {
    worker_state: "RUNNING" | "STOPPED" | "ERROR" | string;
    healthy: boolean;
    desired?: "RUNNING" | "STOPPED" | string;
    config_revision?: number;
    uptime_s?: number;
    last_state_change?: string;
    last_state_change_reason?: string;
    last_error?: string | null;
  };
  source?: {
    selected: "NTRIP" | "LORA" | string;
    connected: boolean;
    state?: string;
    source_age_s?: number;
    bytes_received?: number;
    rtcm_frames_received?: number;
    crc_valid_frames?: number;
    crc_failures?: number;
    invalid_headers?: number;
    rtcm_rate_hz?: number;
    last_valid_frame_age_s?: number;
    reconnect_count?: number;
    profile_name?: string | null;
    caster_host?: string | null;
    port?: number | null;
    mountpoint?: string | null;
  };
  transport?: {
    selected: "USB_DIRECT" | "PX4_DDS" | string;
    state?: string;
    ready: boolean;
    frames_delivered?: number;
    bytes_delivered?: number;
    last_delivery_age_s?: number;
    delivery_failures?: number;
    reconnect_count?: number;
    device?: string | null;
  };
  receiver?: {
    fix_type_name: "RTK FIXED" | "RTK FLOAT" | "3D" | "2D" | "DGPS" | "NO FIX" | string;
    fix_type: number;
    horizontal_accuracy_m: number;
    vertical_accuracy_m?: number;
    satellites_used: number;
    hdop?: number;
    correction_age_s: number;
    freshness_s?: number;
    fix_transitions?: number;
  };
  counters?: Record<string, number>;
  events?: Array<{ timestamp: string; event: string; detail?: string }>;
}
