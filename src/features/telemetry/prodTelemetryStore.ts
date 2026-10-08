/**
 * Production Telemetry Store with Real-time Staleness Engine
 *
 * Ingests RoverTelemetrySnapshot from Socket.IO or REST polling.
 * Automatically ticks freshness every 250ms so stale values grey out even
 * if the socket goes silent.
 */

import { useSyncExternalStore } from "react";
import type { RoverTelemetrySnapshot } from "../../contract/prod/realtime";
import { evaluateStaleness, type StalenessInfo } from "./staleness";
import { radToDeg, wrap360 } from "../../contract/prod/units";

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
