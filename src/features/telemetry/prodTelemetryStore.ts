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
import { radToDeg, wrap360 } from "../../contract/prod/units";
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
 * Guarantees honest staleness:
 * - When disconnected (age > 2.5s or no telemetry), connected=false and pose_age_ms reflects truth.
 * - Never shows frozen values as live.
 */
export function getAdaptedTelemetrySnapshot(now = Date.now()): TelemetrySnapshot | null {
  if (!state.snapshot || !state.lastReceivedAt) {
    return null;
  }
  const staleness = evaluateStaleness(state.lastReceivedAt, now);
  const snap = state.snapshot;
  const vs = snap.vehicle_state?.data;
  const rpp = snap.rpp?.data;
  const rtk = snap.rtk_status?.data;
  const gnss = snap.gnss_report?.data;
  const mission = snap.mission?.data;

  const speed = vs
    ? Math.sqrt(vs.velocity_north_mps * vs.velocity_north_mps + vs.velocity_east_mps * vs.velocity_east_mps)
    : null;
  const heading = vs ? wrap360(radToDeg(vs.heading_rad)) : null;

  const fixType = rtk?.fix_type ?? gnss?.fix_type ?? null;
  const fixName = fixType != null ? FIX_TYPE_NAMES[fixType] ?? `Fix ${fixType}` : "No Fix";

  return {
    pos_n: vs?.north_m ?? null,
    pos_e: vs?.east_m ?? null,
    heading_ned_deg: heading,
    speed_m_s: speed,
    measured_speed_m_s: speed,
    lat: gnss?.latitude_deg ?? null,
    lon: gnss?.longitude_deg ?? null,
    alt: gnss?.altitude_msl_m ?? null,
    gps_fix: fixType,
    gps_fix_name: fixName,
    gps_sat: rtk?.satellites_used ?? gnss?.satellites_used ?? 0,
    hrms: rtk?.horizontal_accuracy_m ?? gnss?.horizontal_accuracy_m ?? null,
    vrms: null,
    xtrack_m: rpp?.cross_track_right_m ?? null,
    rpp_state: rpp?.state ?? null,
    rpp_state_name: rpp?.state != null ? RPP_STATE_NAMES[rpp.state] ?? "UNKNOWN" : null,
    mission_state: mission?.state != null ? MISSION_STATE_NAMES[mission.state]?.toLowerCase() ?? "idle" : "idle",
    armed: vs ? vs.arming_state === ArmingStateEnum.ARMED : false,
    mode: vs ? (vs.nav_state === 14 ? "OFFBOARD" : "MANUAL") : "MANUAL",
    pose_age_ms: staleness.ageMs,
    connected: !staleness.isDisconnected,
    battery_v: null,
    battery_pct: null,
  };
}
