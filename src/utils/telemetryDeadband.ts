import type { TelemetrySnapshot } from "../types/plan";
import type { SystemHealth } from "../types/appRuntime";

/** Continuous fields: skip re-render when change is within noise. */
export const GPS_DEADBAND_DEG = 0.0000002; // ~2cm at the equator
export const POSITION_DEADBAND_M = 0.02;
export const HEADING_DEADBAND_DEG = 0.3;
export const SPEED_DEADBAND_MPS = 0.02;
export const DISTANCE_DEADBAND_M = 0.05;

export function withinDeadband(
  a: number | null | undefined,
  b: number | null | undefined,
  eps: number
): boolean {
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  return Math.abs(a - b) <= eps;
}

/** Merge incoming telemetry; returns prev if nothing meaningful changed. */
export function mergeTelemetrySnapshot(
  prev: TelemetrySnapshot | null,
  data: TelemetrySnapshot
): TelemetrySnapshot {
  if (!prev) return data;
  if (
    withinDeadband(prev.pos_n, data.pos_n, POSITION_DEADBAND_M) &&
    withinDeadband(prev.pos_e, data.pos_e, POSITION_DEADBAND_M) &&
    withinDeadband(prev.lat, data.lat, GPS_DEADBAND_DEG) &&
    withinDeadband(prev.lon, data.lon, GPS_DEADBAND_DEG) &&
    withinDeadband(prev.heading_ned_deg, data.heading_ned_deg, HEADING_DEADBAND_DEG) &&
    withinDeadband(prev.xtrack_m, data.xtrack_m, DISTANCE_DEADBAND_M) &&
    withinDeadband(prev.heading_err_deg, data.heading_err_deg, HEADING_DEADBAND_DEG) &&
    withinDeadband(prev.dist_to_goal_m, data.dist_to_goal_m, DISTANCE_DEADBAND_M) &&
    withinDeadband(prev.speed_m_s, data.speed_m_s, SPEED_DEADBAND_MPS) &&
    withinDeadband(prev.measured_speed_m_s, data.measured_speed_m_s, SPEED_DEADBAND_MPS) &&
    withinDeadband(prev.along_track_speed_mps, data.along_track_speed_mps, SPEED_DEADBAND_MPS) &&
    withinDeadband(prev.cross_track_speed_mps, data.cross_track_speed_mps, SPEED_DEADBAND_MPS) &&
    prev.rpp_state === data.rpp_state &&
    prev.rpp_state_name === data.rpp_state_name &&
    prev.armed === data.armed &&
    prev.mode === data.mode &&
    prev.battery_pct === data.battery_pct &&
    prev.gps_fix === data.gps_fix &&
    prev.gps_fix_name === data.gps_fix_name &&
    prev.gps_sat === data.gps_sat &&
    prev.hrms === data.hrms &&
    prev.vrms === data.vrms &&
    prev.joystick_state === data.joystick_state &&
    prev.joystick_active === data.joystick_active &&
    prev.control_owner === data.control_owner &&
    prev.joystick_last_valid_cmd_age_ms === data.joystick_last_valid_cmd_age_ms
  ) {
    return prev;
  }
  return { ...prev, ...data };
}

export function mergeSystemHealthFromTelemetry(
  prev: SystemHealth | null,
  data: TelemetrySnapshot
): SystemHealth {
  const next: SystemHealth = {
    ros_node: true,
    fcu_connected: (data as { connected?: boolean }).connected ?? false,
    armed: data.armed ?? false,
    mode: data.mode ?? "UNKNOWN",
    rpp_state: data.rpp_state,
    mission_state: prev?.mission_state || "UNKNOWN",
  };
  if (
    prev &&
    prev.ros_node === next.ros_node &&
    prev.fcu_connected === next.fcu_connected &&
    prev.armed === next.armed &&
    prev.mode === next.mode &&
    prev.rpp_state === next.rpp_state &&
    prev.mission_state === next.mission_state
  ) {
    return prev;
  }
  return next;
}

export function rtkModeFromStatus(data: any): "idle" | "ntrip" | "lora" {
  if (!data) return "idle";
  const isRunning =
    data.running === true ||
    data.status === "running" ||
    data.state === "running" ||
    data.active === true ||
    data.success === true;
  if (!isRunning && data.running !== undefined) return "idle";
  const modeStr = (data.mode || data.type || "").toString().toLowerCase();
  if (modeStr.includes("ntrip") || modeStr === "ntrip") return "ntrip";
  if (modeStr.includes("lora") || modeStr === "lora") return "lora";
  if (isRunning) return "ntrip";
  return "idle";
}
