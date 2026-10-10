/**
 * Production Realtime (Socket.IO) Contract Types (v:1)
 *
 * All messages carry contract version v:1.
 * Transports: ["websocket"] only.
 * Handshake: auth: { token: string }.
 */

export const REALTIME_CONTRACT_VERSION = 1;

/** Telemetry source snapshot entry with freshness tracking */
export interface SnapshotEntry<T> {
  age_s: number;
  fresh: boolean;
  data: T;
}

export interface VehicleStateData {
  position_valid: boolean;
  velocity_valid: boolean;
  attitude_valid: boolean;
  north_m: number;
  east_m: number;
  down_m: number;
  velocity_north_mps: number;
  velocity_east_mps: number;
  heading_rad: number;
  yaw_rate_radps: number;
  arming_state: number;
  nav_state: number;
  failsafe: boolean;
}

export interface EstimatorHealthData {
  flags_valid: boolean;
  gnss_yaw_fusion_intended: boolean;
  gnss_yaw_fault: boolean;
  reject_yaw: boolean;
  reject_hor_pos: boolean;
  reject_hor_vel: boolean;
  inertial_dead_reckoning: boolean;
}

export interface RtkStatusData {
  fix_type: number;
  corrections_fresh: boolean;
  correction_age_s: number;
  horizontal_accuracy_m: number;
  satellites_used: number;
}

export interface GnssReportData {
  valid: boolean;
  fix_type: number;
  horizontal_accuracy_m: number;
  satellites_used: number;
  heading_rad: number;
  latitude_deg: number;
  longitude_deg: number;
  altitude_msl_m: number;
  hdop: number;
  /** Not sent by the gateway yet (docs/BACKEND_TELEMETRY_REQUESTS.md R3). */
  vertical_accuracy_m?: number | null;
  heading_accuracy_rad?: number | null;
}

export interface NtripStatusData {
  state: number;
  connected: boolean;
  streaming: boolean;
  correction_age_s: number;
  correction_rate_hz: number;
  reconnect_count: number;
  source_bytes_received: number;
  valid_rtcm_frames: number;
  chunks_handed_off: number;
  security: number;
  tls_verified: boolean;
  tls_verification_failed: boolean;
  plaintext_credentials_warning: boolean;
  last_error: string;
  fix_transitions: number;
}

export interface Px4LinkData {
  session_alive: boolean;
  handshake_ok: boolean;
  offboard_heartbeat_active: boolean;
  failing_to_zero: boolean;
  fault: number;
  stale_topics_mask: number;
  worst_topic_age_s: number;
  session_resets: number;
  timesync_valid: boolean;
  timesync_offset_us: number;
  timesync_round_trip_us: number;
  rtcm_chunks_accepted: number;
  rtcm_chunks_dropped: number;
}

export interface SafetyGateData {
  ok: boolean;
  reason_code: number;
}

export interface EmergencyStopData {
  asserted: boolean;
  source: string;
}

export interface MotionGuardData {
  reason_code: number;
  accepted: boolean;
  clamped: boolean;
  mode: number;
  speed_body_x: number;
}

export interface RppData {
  state: number;
  mission_id: number;
  run_index: number;
  cross_track_right_m: number;
  commanded_speed_mps: number;
  loop_jitter_max_us: number;
  loop_overrun_count: number;
  /**
   * Not sent by the gateway yet (docs/BACKEND_TELEMETRY_REQUESTS.md R1/R2).
   * The app reads each one only when present.
   */
  heading_error_rad?: number | null;
  tick_state?: number | null;
  rtk_reason?: number | null;
  path_travel_m?: number | null;
  commanded_yaw_rate_radps?: number | null;
  dist_to_goal_m?: number | null;
}

export interface MissionData {
  state: number;
  mission_id: number;
  run_index: number;
  point_index: number;
  reason_code: number;
  path_artifact_sha256: string;
}

export interface PointResultData {
  mission_id: number;
  point_index: number;
  result_code: number;
  north_m: number;
  east_m: number;
  error_m: number;
}

/** Matches the gateway `spray` subscription (gateway_node.cpp). */
export interface SprayData {
  fsm_state: number;
  spraying: boolean;
  desired: boolean;
  safety_ok: boolean;
  safety_reason: string;
  manual_active: boolean;
  xtrack_tripped: boolean;
  xtrack_error_m: number;
}

/** Matches the gateway `recorder` subscription (gateway_node.cpp). */
export interface RecorderData {
  state: number;
  bag_healthy: boolean;
  bytes_written: number;
  free_bytes: number;
}

/** Not sent by the gateway yet (docs/BACKEND_TELEMETRY_REQUESTS.md R4). `remaining_pct` is 0-100. */
export interface BatteryData {
  voltage_v?: number | null;
  current_a?: number | null;
  remaining_pct?: number | null;
}

export interface GatewayInfoData {
  operator_alive: boolean;
  clients: number;
  schema: number;
}

export interface RoverTelemetrySnapshot {
  vehicle_state: SnapshotEntry<VehicleStateData> | null;
  estimator_health: SnapshotEntry<EstimatorHealthData> | null;
  rtk_status: SnapshotEntry<RtkStatusData> | null;
  gnss_report: SnapshotEntry<GnssReportData> | null;
  ntrip_status: SnapshotEntry<NtripStatusData> | null;
  px4_link: SnapshotEntry<Px4LinkData> | null;
  safety_gate: SnapshotEntry<SafetyGateData> | null;
  emergency_stop: SnapshotEntry<EmergencyStopData> | null;
  motion_guard: SnapshotEntry<MotionGuardData> | null;
  rpp: SnapshotEntry<RppData> | null;
  mission: SnapshotEntry<MissionData> | null;
  last_point_result: SnapshotEntry<PointResultData> | null;
  spray: SnapshotEntry<SprayData> | null;
  recorder: SnapshotEntry<RecorderData> | null;
  /** Absent until the backend adds it (docs/BACKEND_TELEMETRY_REQUESTS.md R4). */
  battery?: SnapshotEntry<BatteryData> | null;
  gateway?: GatewayInfoData;
}

/** Inbound `telemetry` event from Socket.IO or GET /api/telemetry */
export interface TelemetryPacket {
  connected?: boolean;
  v?: number;
  age_s: number | null;
  snapshot: RoverTelemetrySnapshot | null;
}

/** Inbound `gateway` event */
export interface GatewayEventPacket {
  connected: boolean;
}

// -----------------------------------------------------------------------------
// ABI Enums matching dyx3_interfaces and PX4 ABI
// -----------------------------------------------------------------------------

export enum MissionStateEnum {
  IDLE = 0,
  LOADING = 1,
  READY = 2,
  RUNNING = 3,
  PAUSED = 4,
  COMPLETED = 5,
  ABORTED = 6,
  ERROR = 7,
}

export const MISSION_STATE_NAMES: Record<number, string> = {
  [MissionStateEnum.IDLE]: "IDLE",
  [MissionStateEnum.LOADING]: "LOADING",
  [MissionStateEnum.READY]: "READY",
  [MissionStateEnum.RUNNING]: "RUNNING",
  [MissionStateEnum.PAUSED]: "PAUSED",
  [MissionStateEnum.COMPLETED]: "COMPLETED",
  [MissionStateEnum.ABORTED]: "ABORTED",
  [MissionStateEnum.ERROR]: "ERROR",
};

export enum RppStateEnum {
  IDLE = 0,
  TRACKING = 1,
  STOPPING = 2,
  PIVOTING = 3,
  CREEPING = 4,
  COMPLETE = 5,
  ERROR = 6,
  LOADED = 7,
}

export const RPP_STATE_NAMES: Record<number, string> = {
  [RppStateEnum.IDLE]: "IDLE",
  [RppStateEnum.TRACKING]: "TRACKING",
  [RppStateEnum.STOPPING]: "STOPPING",
  [RppStateEnum.PIVOTING]: "PIVOTING",
  [RppStateEnum.CREEPING]: "CREEPING",
  [RppStateEnum.COMPLETE]: "COMPLETE",
  [RppStateEnum.ERROR]: "ERROR",
  [RppStateEnum.LOADED]: "LOADED",
};

export enum FixTypeEnum {
  UNKNOWN = 0,
  NONE = 1,
  FIX_2D = 2,
  FIX_3D = 3,
  RTCM_CODE_DIFF = 4,
  RTK_FLOAT = 5,
  RTK_FIXED = 6,
  EXTRAPOLATED = 8,
}

export const FIX_TYPE_NAMES: Record<number, string> = {
  [FixTypeEnum.UNKNOWN]: "UNKNOWN",
  [FixTypeEnum.NONE]: "NO FIX",
  [FixTypeEnum.FIX_2D]: "2D FIX",
  [FixTypeEnum.FIX_3D]: "3D FIX",
  [FixTypeEnum.RTCM_CODE_DIFF]: "DGPS",
  [FixTypeEnum.RTK_FLOAT]: "RTK FLOAT",
  [FixTypeEnum.RTK_FIXED]: "RTK FIXED",
  [FixTypeEnum.EXTRAPOLATED]: "EXTRAPOLATED",
};

export enum ArmingStateEnum {
  INIT = 0,
  DISARMED = 1,
  ARMED = 2,
}

export enum NavStateEnum {
  MANUAL = 0,
  ALTCTL = 1,
  POSCTL = 2,
  AUTO_MISSION = 3,
  AUTO_LOITER = 4,
  AUTO_RTL = 5,
  ACRO = 6,
  DESCEND = 8,
  TERMINATION = 9,
  OFFBOARD = 14,
  STAB = 15,
}
