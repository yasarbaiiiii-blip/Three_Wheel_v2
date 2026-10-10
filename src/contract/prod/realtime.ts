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
  /** Gateway-derived (rover interfaces 0.16.0): ground speed and its component along the heading. */
  velocity_down_mps?: number | null;
  ground_speed_mps?: number | null;
  forward_speed_mps?: number | null;
  global_reference_valid?: boolean;
  xy_reset_counter?: number;
  /** PX4 battery_status; values are null unless battery_valid. remaining is 0..1. */
  battery_valid?: boolean;
  battery_voltage_v?: number | null;
  battery_current_a?: number | null;
  battery_remaining?: number | null;
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

/**
 * `mission` source of the telemetry snapshot and, with `fresh` / `stamp_s`, the `data` of a
 * `mission_state` rover event (dyx3_system_gateway `mission_fields`, interfaces 0.15.0).
 * The app reads mission progress only from the event; the snapshot copy is not used for it.
 */
export interface MissionData {
  /** MissionStateEnum. */
  state: number;
  /** Execution id: incremented on every accepted start. */
  mission_id: number;
  run_index: number;
  point_index: number;
  /** MissionReasonEnum; with SAFETY / RTK, `gate_reason_code` names the guard gate. */
  reason_code: number;
  /** The EXECUTION artifact (placed in the EKF frame) RPP loads. */
  path_artifact_sha256: string;
  /** The artifact the operator started (what the app uploaded). */
  source_artifact_sha256: string;
  /** The start's request_id; empty when none was given. */
  request_id: string;
  /** Human-readable cause of the current state or reason; may carry `; release: ...`. */
  reason_detail: string;
  gate_reason_code: number;
  /** MissionWaitingOnEnum: the step the lifecycle is waiting on. */
  waiting_on: number;
  /** ROS time (s) the current state was entered. */
  state_entered: number;
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
  gateway?: GatewayInfoData;
}

/** Inbound `telemetry` event from Socket.IO or GET /api/telemetry */
export interface TelemetryPacket {
  connected?: boolean;
  v?: number;
  age_s: number | null;
  snapshot: RoverTelemetrySnapshot | null;
}

// -----------------------------------------------------------------------------
// rover_event: the single status event (docs/contracts/backend.md section 4)
// -----------------------------------------------------------------------------

/** Socket.IO event name of the status channel. `telemetry` stays a separate periodic event. */
export const ROVER_EVENT = "rover_event";

export type RoverEventKind =
  | "mission_state"
  | "operator_link"
  | "fcu_link"
  | "estop"
  | "gateway_link";

export const ROVER_EVENT_KINDS: readonly RoverEventKind[] = [
  "mission_state",
  "operator_link",
  "fcu_link",
  "estop",
  "gateway_link",
];

/** Stale is a transition: a gateway-sourced kind whose source went silent arrives as exactly this. */
export interface StaleEventData {
  fresh: false;
}

export type MissionStateEventData = MissionData & { fresh: true; stamp_s: number };

export interface OperatorLinkEventData {
  alive: boolean;
  age_s: number | null;
  cause: "heartbeat" | "timeout" | "connection_closed" | "never" | string;
}

export interface FcuLinkEventData {
  fresh: boolean;
  session_alive: boolean;
  handshake_ok: boolean;
  fault: number;
  session_resets: number;
}

export interface EstopEventData {
  fresh: boolean;
  asserted: boolean;
  source: string;
}

/** The backend's own socket to the gateway. While `connected` is false every other kind is unknown. */
export interface GatewayLinkEventData {
  connected: boolean;
}

export interface RoverEventDataByKind {
  mission_state: MissionStateEventData | StaleEventData;
  operator_link: OperatorLinkEventData | StaleEventData;
  fcu_link: FcuLinkEventData | StaleEventData;
  estop: EstopEventData | StaleEventData;
  gateway_link: GatewayLinkEventData;
}

/** One `rover_event` as the backend sends it. */
export interface RoverEvent<K extends RoverEventKind = RoverEventKind> {
  kind: K;
  /** The backend's ordering number (per backend process, across all kinds). Per kind, the highest is current. */
  seq: number;
  /** The gateway's own seq; null for gateway_link. Restarts with the gateway: never used for ordering. */
  gateway_seq: number | null;
  t_mono_s: number | null;
  t_wall_ms: number | null;
  /** Transitions the gateway folded into this event (0 = none lost). */
  coalesced: number;
  /** True on the copy sent right after connecting. */
  replay: boolean;
  /** The full current value of the kind, never a delta. */
  data: RoverEventDataByKind[K];
}

// -----------------------------------------------------------------------------
// ABI Enums matching dyx3_interfaces and PX4 ABI
// -----------------------------------------------------------------------------

/** MissionState.msg STATE_* (interfaces 0.15.0; 0..7 frozen, 8..10 appended). */
export enum MissionStateEnum {
  IDLE = 0,
  LOADING = 1,
  READY = 2,
  RUNNING = 3,
  PAUSED = 4,
  COMPLETED = 5,
  ABORTED = 6,
  ERROR = 7,
  PLACING = 8,
  ARMING = 9,
  ENGAGING = 10,
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
  [MissionStateEnum.PLACING]: "PLACING",
  [MissionStateEnum.ARMING]: "ARMING",
  [MissionStateEnum.ENGAGING]: "ENGAGING",
};

/** MissionState.msg REASON_* (0..17). */
export enum MissionReasonEnum {
  NONE = 0,
  OPERATOR = 1,
  SAFETY = 2,
  RTK = 3,
  PATH_ERROR = 4,
  INTERNAL_ERROR = 5,
  EKF_RESET = 6,
  EKF_REFERENCE_INVALID = 7,
  PLACEMENT_OUT_OF_BOUNDS = 8,
  NO_PLACEMENT_FRAME = 9,
  ARM_REFUSED = 10,
  ARM_TIMEOUT = 11,
  OFFBOARD_REFUSED = 12,
  OFFBOARD_TIMEOUT = 13,
  RPP_ACK_TIMEOUT = 14,
  ESTOP = 15,
  RPP_ERROR = 16,
  RPP_STALE = 17,
}

/** MissionState.msg WAIT_*: the step the lifecycle is waiting on. */
export enum MissionWaitingOnEnum {
  NONE = 0,
  ARTIFACT = 1,
  PLACEMENT = 2,
  ARM = 3,
  OFFBOARD = 4,
  RPP_ACK = 5,
  OPERATOR = 6,
  OFFBOARD_RELEASE = 7,
  DISARM = 8,
}

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
