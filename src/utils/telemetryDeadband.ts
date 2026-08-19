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

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function recordHasPose(rec: Record<string, unknown>): boolean {
  return (
    rec.pos_n != null ||
    rec.lat != null ||
    rec.north != null ||
    rec.latitude != null ||
    rec.local_n != null ||
    rec.gps_lat != null
  );
}

function unwrapTelemetryRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  if (root.telemetry && typeof root.telemetry === "object" && !Array.isArray(root.telemetry)) {
    const inner = root.telemetry as Record<string, unknown>;
    // Only unwrap when the root itself has no pose. A live packet like
    // { pos_n, lat, telemetry: { battery } } must keep the root pose.
    if (!recordHasPose(root)) {
      return inner;
    }
  }
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data) && !("pos_n" in root) && !("lat" in root)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

/**
 * Normalize a socket/REST telemetry payload into the app snapshot shape.
 * Missing fields are omitted (not set to 0/null) so merge can keep last-known values.
 */
export function normalizeTelemetryPacket(raw: unknown): TelemetrySnapshot | null {
  const inner = unwrapTelemetryRecord(raw);
  if (!inner) return null;

  const pos_n =
    finiteNumber(inner.pos_n) ??
    finiteNumber(inner.north) ??
    finiteNumber(inner.local_n) ??
    finiteNumber(inner.n);
  const pos_e =
    finiteNumber(inner.pos_e) ??
    finiteNumber(inner.east) ??
    finiteNumber(inner.local_e) ??
    finiteNumber(inner.e);
  const lat =
    finiteNumber(inner.lat) ??
    finiteNumber(inner.latitude) ??
    finiteNumber(inner.gps_lat) ??
    finiteNumber(inner.global_lat);
  const lon =
    finiteNumber(inner.lon) ??
    finiteNumber(inner.longitude) ??
    finiteNumber(inner.gps_lon) ??
    finiteNumber(inner.global_lon);
  const alt = finiteNumber(inner.alt) ?? finiteNumber(inner.altitude) ?? finiteNumber(inner.gps_alt);
  const heading_ned_deg =
    finiteNumber(inner.heading_ned_deg) ??
    finiteNumber(inner.heading) ??
    finiteNumber(inner.yaw_deg);

  const next: TelemetrySnapshot = {};
  if (pos_n != null) next.pos_n = pos_n;
  if (pos_e != null) next.pos_e = pos_e;
  if (lat != null) next.lat = lat;
  if (lon != null) next.lon = lon;
  if (alt != null) next.alt = alt;
  if (heading_ned_deg != null) next.heading_ned_deg = heading_ned_deg;

  const assignNum = (key: keyof TelemetrySnapshot, ...aliases: unknown[]) => {
    for (const alias of aliases) {
      const value = finiteNumber(alias);
      if (value != null) {
        (next as Record<string, unknown>)[key] = value;
        return;
      }
    }
  };

  assignNum("xtrack_m", inner.xtrack_m, inner.xtrack);
  assignNum("heading_err_deg", inner.heading_err_deg);
  assignNum("lookahead_m", inner.lookahead_m);
  assignNum("speed_m_s", inner.speed_m_s, inner.speed);
  assignNum("measured_speed_m_s", inner.measured_speed_m_s);
  assignNum("kappa", inner.kappa);
  assignNum("dist_to_goal_m", inner.dist_to_goal_m, inner.dist_to_goal);
  assignNum("pose_age_ms", inner.pose_age_ms);
  assignNum("rpp_state", inner.rpp_state);
  assignNum("battery_v", inner.battery_v);
  assignNum("battery_pct", inner.battery_pct);
  assignNum("gps_fix", inner.gps_fix);
  assignNum("gps_sat", inner.gps_sat, inner.satellites);
  assignNum("hrms", inner.hrms);
  assignNum("vrms", inner.vrms);
  assignNum("along_track_speed_mps", inner.along_track_speed_mps);
  assignNum("cross_track_speed_mps", inner.cross_track_speed_mps);
  assignNum("projection_segment_index", inner.projection_segment_index);
  assignNum("joystick_last_valid_cmd_age_ms", inner.joystick_last_valid_cmd_age_ms);

  if (typeof inner.rpp_state_name === "string") next.rpp_state_name = inner.rpp_state_name;
  if (typeof inner.gps_fix_name === "string") next.gps_fix_name = inner.gps_fix_name;
  if (typeof inner.mode === "string") next.mode = inner.mode;
  if (typeof inner.mission_state === "string") next.mission_state = inner.mission_state;
  if (typeof inner.joystick_state === "string") next.joystick_state = inner.joystick_state;
  if (typeof inner.control_owner === "string") next.control_owner = inner.control_owner;

  if (typeof inner.armed === "boolean") next.armed = inner.armed;
  if (typeof inner.connected === "boolean") next.connected = inner.connected;
  if (typeof inner.joystick_active === "boolean") next.joystick_active = inner.joystick_active;
  if (typeof inner.gps_safety_ok === "boolean") next.gps_safety_ok = inner.gps_safety_ok;
  if (typeof inner.manual_resume_required === "boolean") next.manual_resume_required = inner.manual_resume_required;

  return Object.keys(next).length > 0 ? next : null;
}

function deadbandFor(key: string): number | null {
  if (key === "lat" || key === "lon") return GPS_DEADBAND_DEG;
  if (key === "pos_n" || key === "pos_e") return POSITION_DEADBAND_M;
  if (key === "heading_ned_deg" || key === "heading_err_deg") return HEADING_DEADBAND_DEG;
  if (
    key === "speed_m_s" ||
    key === "measured_speed_m_s" ||
    key === "along_track_speed_mps" ||
    key === "cross_track_speed_mps"
  ) {
    return SPEED_DEADBAND_MPS;
  }
  if (key === "xtrack_m" || key === "dist_to_goal_m") return DISTANCE_DEADBAND_M;
  return null;
}

function fieldUnchanged(key: string, prev: unknown, next: unknown): boolean {
  if (prev === next) return true;
  const eps = deadbandFor(key);
  if (eps != null) return withinDeadband(prev as number, next as number, eps);
  return false;
}

/**
 * Merge incoming telemetry. Undefined/null incoming fields do not wipe last-known values.
 * Returns `prev` when nothing meaningful changed.
 */
export function mergeTelemetrySnapshot(
  prev: TelemetrySnapshot | null,
  data: TelemetrySnapshot
): TelemetrySnapshot {
  if (!prev) return data;
  const next: TelemetrySnapshot = { ...prev };
  let changed = false;
  for (const [key, value] of Object.entries(data) as Array<[keyof TelemetrySnapshot, unknown]>) {
    if (value === undefined || value === null) continue;
    if (fieldUnchanged(String(key), next[key], value)) continue;
    (next as Record<string, unknown>)[key] = value;
    changed = true;
  }
  return changed ? next : prev;
}

export function mergeSystemHealthFromTelemetry(
  prev: SystemHealth | null,
  data: TelemetrySnapshot
): SystemHealth {
  const next: SystemHealth = {
    ros_node: prev?.ros_node ?? true,
    fcu_connected: data.connected ?? prev?.fcu_connected ?? false,
    armed: data.armed ?? prev?.armed ?? false,
    mode: data.mode ?? prev?.mode ?? "UNKNOWN",
    rpp_state: data.rpp_state ?? prev?.rpp_state ?? null,
    mission_state: data.mission_state ?? prev?.mission_state ?? "UNKNOWN",
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


