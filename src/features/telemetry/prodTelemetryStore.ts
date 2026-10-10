/**
 * Production Telemetry Store with Real-time Staleness Engine
 *
 * Ingests RoverTelemetrySnapshot from Socket.IO or REST polling.
 * Automatically ticks freshness every 250ms so stale values grey out even
 * if the socket goes silent.
 */

import { useSyncExternalStore } from "react";
import type {
  RoverTelemetrySnapshot,
} from "../../contract/prod/realtime";
import {
  ArmingStateEnum,
  FIX_TYPE_NAMES,
  MISSION_STATE_NAMES,
  RPP_STATE_NAMES,
} from "../../contract/prod/realtime";
import { evaluateStaleness, type StalenessInfo } from "./staleness";
import { radToDeg, wrap360, wrapPi } from "../../contract/prod/units";
import {
  batteryPercentOrNull,
  entryAgeMs,
  finiteOrNull,
  positiveOrNull,
  rppBlockedReason,
  usableData,
} from "./telemetryDerive";
import type { TelemetrySnapshot } from "../../types/plan";

export interface ProdTelemetryState {
  snapshot: RoverTelemetrySnapshot | null;
  lastReceivedAt: number | null;
  gatewayConnected: boolean;
  estopAsserted: boolean;
  estopSource: string;
}

type Listener = () => void;

let state: ProdTelemetryState = {
  snapshot: null,
  lastReceivedAt: null,
  gatewayConnected: false,
  estopAsserted: false,
  estopSource: "",
};

const listeners = new Set<Listener>();
let tickerTimer: ReturnType<typeof setInterval> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function ensureTicker() {
  if (tickerTimer === null && typeof setInterval !== "undefined") {
    tickerTimer = setInterval(() => {
      // Re-render subscribers so age and staleness update
      if (listeners.size > 0 && state.lastReceivedAt !== null) {
        emit();
      }
    }, 250);
  }
}

export function getProdTelemetryState(): ProdTelemetryState {
  return state;
}

export function subscribeProdTelemetry(listener: Listener): () => void {
  listeners.add(listener);
  ensureTicker();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && tickerTimer !== null) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }
  };
}

export function applyProdTelemetrySnapshot(
  snapshot: RoverTelemetrySnapshot | null,
  gatewayConnected?: boolean
) {
  const now = Date.now();
  const estop = snapshot?.emergency_stop?.data;
  state = {
    snapshot,
    lastReceivedAt: snapshot ? now : state.lastReceivedAt,
    gatewayConnected: gatewayConnected ?? (snapshot?.gateway?.operator_alive ?? state.gatewayConnected),
    estopAsserted: estop ? Boolean(estop.asserted) : state.estopAsserted,
    estopSource: estop?.source || state.estopSource,
  };
  emit();
}

export function setProdGatewayConnected(connected: boolean) {
  if (state.gatewayConnected === connected) return;
  state = { ...state, gatewayConnected: connected };
  emit();
}

export function clearProdTelemetry() {
  state = {
    snapshot: null,
    lastReceivedAt: null,
    gatewayConnected: false,
    estopAsserted: false,
    estopSource: "",
  };
  emit();
}

/** Hook to consume production telemetry with automatic staleness updates */
export function useProdTelemetry() {
  return useSyncExternalStore(subscribeProdTelemetry, getProdTelemetryState, getProdTelemetryState);
}

/** Evaluates overall telemetry freshness */
export function getOverallStaleness(now = Date.now()): StalenessInfo {
  return evaluateStaleness(state.lastReceivedAt, now);
}

/** Extracted and unit-converted live vehicle state */
export interface DerivedVehiclePose {
  northM: number | null;
  eastM: number | null;
  downM: number | null;
  headingDeg: number | null;
  yawRateDegps: number | null;
  speedMps: number | null;
  armingState: number | null;
  navState: number | null;
  failsafe: boolean;
  staleness: StalenessInfo;
}

export function getDerivedVehiclePose(now = Date.now()): DerivedVehiclePose {
  const vs = state.snapshot?.vehicle_state;
  if (!vs || !vs.data) {
    return {
      northM: null,
      eastM: null,
      downM: null,
      headingDeg: null,
      yawRateDegps: null,
      speedMps: null,
      armingState: null,
      navState: null,
      failsafe: false,
      staleness: evaluateStaleness(null, now),
    };
  }

  const d = vs.data;
  const speed = Math.sqrt(d.velocity_north_mps * d.velocity_north_mps + d.velocity_east_mps * d.velocity_east_mps);
  const headingDeg = wrap360(radToDeg(d.heading_rad));
  const yawRateDegps = radToDeg(d.yaw_rate_radps);

  // Use subsystem receive stamp if available, or fall back to snapshot stamp
  const staleness = evaluateStaleness(state.lastReceivedAt, now);

  return {
    northM: d.north_m,
    eastM: d.east_m,
    downM: d.down_m,
    headingDeg,
    yawRateDegps,
    speedMps: speed,
    armingState: d.arming_state,
    navState: d.nav_state,
    failsafe: d.failsafe,
    staleness,
  };
}

/**
 * Adapts the production RoverTelemetrySnapshot into the UI TelemetrySnapshot shape
 * consumed by Home, Map, HUD, and path planning screens.
 *
 * Guarantees honest staleness (gateway contract: a stale or missing source is unknown,
 * never the last value):
 * - Each value comes only from a section the gateway marks fresh; otherwise it is null ("—" in the UI).
 * - Accuracy values of 0 are the "unknown" sentinel and become null.
 * - pose_age_ms is the age of the vehicle pose, not of the last packet.
 * - fcu_connected means the PX4 link is alive; `connected` only means telemetry is arriving.
 * - Fields the gateway does not send yet (battery, vrms, heading error, distance to goal)
 *   stay null instead of showing a fake 0. See docs/BACKEND_TELEMETRY_REQUESTS.md.
 */
export function getAdaptedTelemetrySnapshot(now = Date.now()): TelemetrySnapshot | null {
  if (!state.snapshot || !state.lastReceivedAt) {
    return null;
  }
  const staleness = evaluateStaleness(state.lastReceivedAt, now);
  const snap = state.snapshot;
  const vs = usableData(snap.vehicle_state);
  const vsRaw = snap.vehicle_state?.data;
  const rpp = usableData(snap.rpp);
  const rtk = usableData(snap.rtk_status);
  const gnssFresh = usableData(snap.gnss_report);
  const gnss = gnssFresh && gnssFresh.valid !== false ? gnssFresh : null;
  const link = usableData(snap.px4_link);
  const battery = usableData(snap.battery);
  const mission = snap.mission?.data;

  const posOk = vs !== null && vs.position_valid !== false;
  const velOk = vs !== null && vs.velocity_valid !== false;
  const attOk = vs !== null && vs.attitude_valid !== false;

  const vn = velOk ? finiteOrNull(vs!.velocity_north_mps) : null;
  const ve = velOk ? finiteOrNull(vs!.velocity_east_mps) : null;
  const speed = vn !== null && ve !== null ? Math.sqrt(vn * vn + ve * ve) : null;
  const headingRad = attOk ? finiteOrNull(vs!.heading_rad) : null;
  const heading = headingRad !== null ? wrap360(radToDeg(headingRad)) : null;

  const fixType = finiteOrNull(rtk?.fix_type) ?? finiteOrNull(gnss?.fix_type);
  const fixName = fixType !== null ? FIX_TYPE_NAMES[fixType] ?? `Fix ${fixType}` : "NO DATA";

  const headingErrRad = finiteOrNull(rpp?.heading_error_rad);
  const distToGo = finiteOrNull(rpp?.dist_to_goal_m);
  const blockedReason =
    rpp && rpp.state !== 0 ? rppBlockedReason(rpp.tick_state, rpp.rtk_reason) : null;

  const poseAge = entryAgeMs(snap.vehicle_state, staleness.ageMs);

  return {
    pos_n: posOk ? finiteOrNull(vs!.north_m) : null,
    pos_e: posOk ? finiteOrNull(vs!.east_m) : null,
    heading_ned_deg: heading,
    speed_m_s: speed,
    measured_speed_m_s: speed,
    lat: finiteOrNull(gnss?.latitude_deg),
    lon: finiteOrNull(gnss?.longitude_deg),
    alt: finiteOrNull(gnss?.altitude_msl_m),
    gps_fix: fixType,
    gps_fix_name: fixName,
    gps_sat: finiteOrNull(rtk?.satellites_used) ?? finiteOrNull(gnss?.satellites_used),
    hrms: positiveOrNull(rtk?.horizontal_accuracy_m) ?? positiveOrNull(gnss?.horizontal_accuracy_m),
    vrms: positiveOrNull(gnss?.vertical_accuracy_m),
    xtrack_m: finiteOrNull(rpp?.cross_track_right_m),
    heading_err_deg: headingErrRad !== null ? radToDeg(wrapPi(headingErrRad)) : null,
    dist_to_goal_m: distToGo !== null && distToGo >= 0 ? distToGo : null,
    rpp_state: finiteOrNull(rpp?.state),
    rpp_state_name: rpp ? RPP_STATE_NAMES[rpp.state] ?? "UNKNOWN" : null,
    rpp_blocked_reason: blockedReason,
    mission_state: mission?.state != null ? MISSION_STATE_NAMES[mission.state]?.toLowerCase() ?? "idle" : "idle",
    armed: vsRaw ? vsRaw.arming_state === ArmingStateEnum.ARMED : false,
    mode: vsRaw ? (vsRaw.nav_state === 14 ? "OFFBOARD" : "MANUAL") : "MANUAL",
    pose_age_ms: poseAge,
    connected: !staleness.isDisconnected,
    fcu_connected:
      !staleness.isDisconnected && link !== null && link.session_alive === true && link.handshake_ok === true,
    battery_v: finiteOrNull(battery?.voltage_v),
    battery_pct: batteryPercentOrNull(battery?.remaining_pct),
    battery_a: finiteOrNull(battery?.current_a),
  };
}
