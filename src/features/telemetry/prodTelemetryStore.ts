/**
 * Production Telemetry Store with Real-time Staleness Engine
 *
 * Ingests RoverTelemetrySnapshot (the periodic `telemetry` event, or one REST read for recovery).
 * Automatically ticks freshness every 250ms so stale values grey out even
 * if the socket goes silent.
 *
 * Link and mission status is NOT read from the snapshot: it comes from the `rover_event` channel
 * (roverEventStore). `gatewayConnected`, `operatorAlive`, `estop*` and the adapted `mission_state`
 * are derived from it, so a gateway that is down or a silent source reads as unknown, never as
 * the last value.
 */

import { useSyncExternalStore } from "react";
import type {
  RoverTelemetrySnapshot,
  TelemetryPacket,
  SnapshotEntry,
} from "../../contract/prod/realtime";
import {
  ArmingStateEnum,
  FIX_TYPE_NAMES,
  MISSION_STATE_NAMES,
  RPP_STATE_NAMES,
} from "../../contract/prod/realtime";
import { evaluateAgeStaleness, STALE_THRESHOLD_MS, type StalenessInfo } from "./staleness";
import {
  getRoverEventsState,
  selectEstop,
  selectFcuLink,
  selectGatewayLink,
  selectOperatorLink,
  subscribeRoverEvents,
  type RoverEventsState,
} from "./roverEventStore";
import { selectMission } from "../mission/missionLifecycle";
import { resolveRoverNedInMissionFrame, type RoverPoseForEntry } from "../../utils/missionTrajectory";
import { radToDeg, wrap360, wrapPi } from "../../contract/prod/units";
import {
  batteryPercentOrNull,
  finiteOrNull,
  positiveOrNull,
  rppBlockedReason,
} from "./telemetryDerive";
import type { TelemetrySnapshot } from "../../types/plan";

/** What the store holds itself (telemetry snapshots and their freshness). */
interface TelemetryCore {
  snapshot: RoverTelemetrySnapshot | null;
  lastReceivedAt: number | null;
  socketConnected: boolean;
  envelopeAgeMs: number;
  source: "socket" | "rest" | null;
  schemaCompatible: boolean;
  awaitingPacket: boolean;
  revision: number;
  packetRevision: number;
  observedAt: number | null;
}

/** The public view: the core plus the link status derived from `rover_event`s. */
export interface ProdTelemetryState extends TelemetryCore {
  /** The backend's link to the gateway is up (gateway_link). Unknown reads as false. */
  gatewayConnected: boolean;
  /** The tablet heartbeat reaches the gateway (operator_link). Unknown reads as false. */
  operatorAlive: boolean;
  /** The estop event is known. */
  estopKnown: boolean;
  /** Known and asserted. Never true from a stale value. */
  estopAsserted: boolean;
  estopSource: string;
}

type Listener = () => void;

let state: TelemetryCore = {
  snapshot: null,
  lastReceivedAt: null,
  socketConnected: false,
  envelopeAgeMs: Infinity,
  source: null,
  schemaCompatible: true,
  awaitingPacket: true,
  revision: 0,
  packetRevision: 0,
  observedAt: null,
};

let viewCache: { core: TelemetryCore; events: RoverEventsState; view: ProdTelemetryState } | null = null;

function buildView(core: TelemetryCore, events: RoverEventsState): ProdTelemetryState {
  const gateway = selectGatewayLink(events);
  const operator = selectOperatorLink(events);
  const estop = selectEstop(events);
  return {
    ...core,
    gatewayConnected: gateway.known && gateway.connected,
    operatorAlive: operator.known && operator.alive,
    estopKnown: estop.known,
    estopAsserted: estop.known && estop.asserted,
    estopSource: estop.known ? estop.source : "",
  };
}

function gatewayUp(): boolean {
  const gateway = selectGatewayLink();
  return gateway.known && gateway.connected;
}

function fcuConnected(): boolean | null {
  const fcu = selectFcuLink();
  return fcu.known ? fcu.healthy : null;
}

function operatorUp(): boolean {
  const operator = selectOperatorLink();
  return operator.known && operator.alive;
}

export const telemetryNow = () => performance.now();
let session = 0;
let requestId = 0;
let acceptedRestId = 0;
let socketSequence = 0;
export interface TelemetryRequest { id: number; session: number; socketSequence: number; startedAt: number }
export function beginTelemetryRequest(): TelemetryRequest {
  return { id: ++requestId, session, socketSequence, startedAt: telemetryNow() };
}
function packetAgeMs(now = telemetryNow()) {
  return state.lastReceivedAt === null ? Infinity : state.envelopeAgeMs + Math.max(0, now - state.lastReceivedAt);
}
export function getTelemetrySourceAgeMs(entry: SnapshotEntry<unknown> | null | undefined, now = telemetryNow()) {
  const age = finiteOrNull(entry?.age_s);
  const packetAge = packetAgeMs(now);
  return age !== null && age >= 0 && Number.isFinite(packetAge) ? age * 1000 + packetAge : null;
}
function usableData<T>(entry: SnapshotEntry<T> | null | undefined, now = telemetryNow()): T | null {
  const age = getTelemetrySourceAgeMs(entry, now);
  return entry?.fresh === true && age !== null && age <= STALE_THRESHOLD_MS && !state.awaitingPacket && state.schemaCompatible ? entry.data : null;
}

/** A single ingress for socket events and REST snapshots. Request tokens prevent races, including across sessions. */
export function ingestTelemetryPacket(packet: TelemetryPacket, options: {source: "socket" | "rest"; request?: TelemetryRequest}): boolean {
  if (options.source === "rest") {
    const r = options.request;
    if (!r || r.session !== session || r.socketSequence !== socketSequence || r.id <= acceptedRestId) return false;
    acceptedRestId = r.id;
  } else socketSequence++;
  const now = telemetryNow();
  const snapshot = packet?.snapshot ?? null;
  const schema = snapshot?.gateway?.schema;
  const schemaCompatible = schema === 1;
  if (snapshot && !schemaCompatible) console.warn("[Telemetry] gateway schema mismatch: expected numeric schema 1; Start disabled", schema);
  const age = finiteOrNull(packet?.age_s);
  state = { ...state, snapshot, lastReceivedAt: now, envelopeAgeMs: age !== null && age >= 0 ? age * 1000 : Infinity,
    source: options.source, schemaCompatible, awaitingPacket: false,
    revision: state.revision + 1,
    packetRevision: state.packetRevision + 1, observedAt: age !== null && age >= 0 ? now - age * 1000 : null };
  emit(); return true;
}

export function invalidateTelemetrySession(_reason: string) {
  session++; state = { ...state, awaitingPacket: true, revision: state.revision + 1 }; emit();
}
export function setProdSocketConnected(connected: boolean) {
  if (state.socketConnected === connected) return;
  state = { ...state, socketConnected: connected };
  invalidateTelemetrySession(connected ? "reconnect" : "disconnect");
}

export function evaluateMissionStartTelemetry(originGps?: [number, number] | null, now = telemetryNow()): {ok: boolean; reasons: string[]} {
  const reasons: string[] = [];
  if (!state.socketConnected) reasons.push("Socket disconnected.");
  if (!gatewayUp()) reasons.push("Gateway disconnected.");
  if (!operatorUp() || !getOverallStaleness(now).isLive) reasons.push("Operator heartbeat unavailable.");
  if (!state.schemaCompatible) reasons.push("Telemetry schema incompatible.");
  if (state.awaitingPacket) reasons.push("Waiting for fresh telemetry after reconnect or resume.");
  if (getOverallStaleness(now).isDisconnected) reasons.push("Telemetry disconnected or silent.");
  const pose = getAdaptedTelemetrySnapshot(now);
  const localPose = pose && Number.isFinite(pose.pos_n) && Number.isFinite(pose.pos_e);
  const gpsPose = pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon);
  const hasPose = originGps ? gpsPose : originGps === null ? localPose : localPose || gpsPose;
  if (!hasPose) reasons.push("No valid, fresh rover pose available.");
  else if (originGps) {
    const resolved = resolveRoverNedInMissionFrame(pose!, originGps);
    if (!resolved.ok) reasons.push(resolved.reason);
  }
  return { ok: reasons.length === 0, reasons };
}

export function getMissionStartTelemetryPose(originGps?: [number, number] | null): RoverPoseForEntry | null {
  if (!evaluateMissionStartTelemetry(originGps).ok) return null;
  const pose = getAdaptedTelemetrySnapshot();
  if (!pose) return null;
  return { ...pose, pose_age_ms: getTelemetrySourceAgeMs(originGps ? state.snapshot?.gnss_report : state.snapshot?.vehicle_state) };
}

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
        state = { ...state, revision: state.revision + 1 };
        emit();
      }
    }, 250);
  }
}

export function getProdTelemetryState(): ProdTelemetryState {
  const events = getRoverEventsState();
  if (viewCache && viewCache.core === state && viewCache.events === events) return viewCache.view;
  const view = buildView(state, events);
  viewCache = { core: state, events, view };
  return view;
}

export function subscribeProdTelemetry(listener: Listener): () => void {
  listeners.add(listener);
  // Link and mission status changes re-render telemetry subscribers too.
  const unsubscribeEvents = subscribeRoverEvents(listener);
  ensureTicker();
  return () => {
    listeners.delete(listener);
    unsubscribeEvents();
    if (listeners.size === 0 && tickerTimer !== null) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }
  };
}

export function applyProdTelemetrySnapshot(snapshot: RoverTelemetrySnapshot | null) {
  // Compatibility for existing callers/tests. Production transports always pass a full envelope.
  ingestTelemetryPacket({ snapshot, age_s: 0 }, { source: "socket" });
}

export function clearProdTelemetry() {
  session++;
  state = {
    snapshot: null,
    lastReceivedAt: null,
    socketConnected: false,
    envelopeAgeMs: Infinity,
    source: null,
    schemaCompatible: true,
    awaitingPacket: true,
    revision: state.revision + 1,
    packetRevision: state.packetRevision,
    observedAt: null,
  };
  emit();
}

/** Hook to consume production telemetry with automatic staleness updates */
export function useProdTelemetry() {
  return useSyncExternalStore(subscribeProdTelemetry, getProdTelemetryState, getProdTelemetryState);
}

/** Evaluates overall telemetry freshness */
export function getOverallStaleness(now = telemetryNow()): StalenessInfo {
  return evaluateAgeStaleness(state.awaitingPacket || !state.snapshot ? Infinity : packetAgeMs(now));
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

export function getDerivedVehiclePose(now = telemetryNow()): DerivedVehiclePose {
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
      staleness: evaluateAgeStaleness(Infinity),
    };
  }

  const d = usableData(vs, now);
  const adapted = getAdaptedTelemetrySnapshot(now);
  const speed = adapted?.speed_m_s ?? null;
  const headingDeg = adapted?.heading_ned_deg ?? null;
  const rate = d?.attitude_valid === true ? finiteOrNull(d.yaw_rate_radps) : null;
  const yawRateDegps = rate === null ? null : finiteOrNull(radToDeg(rate));

  // Use subsystem receive stamp if available, or fall back to snapshot stamp
  const staleness = evaluateAgeStaleness(getTelemetrySourceAgeMs(vs, now) ?? Infinity);

  return {
    northM: adapted?.pos_n ?? null,
    eastM: adapted?.pos_e ?? null,
    downM: d?.position_valid === true ? finiteOrNull(d.down_m) : null,
    headingDeg,
    yawRateDegps,
    speedMps: speed,
    armingState: d?.arming_state ?? null,
    navState: d?.nav_state ?? null,
    failsafe: d?.failsafe ?? false,
    staleness,
  };
}

/** Lower-case mission state from `mission_state` events; null while unknown (never a stale value). */
function missionStateName(): string | null {
  const view = selectMission();
  if (!view.known) return null;
  return MISSION_STATE_NAMES[view.run.state]?.toLowerCase() ?? "unknown";
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
export function getAdaptedTelemetrySnapshot(now = telemetryNow()): TelemetrySnapshot | null {
  if (!state.snapshot || state.lastReceivedAt === null) {
    return null;
  }
  const staleness = getOverallStaleness(now);
  const snap = state.snapshot;
  const vs = usableData(snap.vehicle_state, now);
  const rpp = usableData(snap.rpp, now);
  const rtk = usableData(snap.rtk_status, now);
  const gnssFresh = usableData(snap.gnss_report, now);
  const gnss = gnssFresh?.valid === true ? gnssFresh : null;
  const battery = usableData(snap.battery, now);

  const posOk = vs?.position_valid === true;
  const velOk = vs?.velocity_valid === true;
  const attOk = vs?.attitude_valid === true;

  const vn = velOk ? finiteOrNull(vs!.velocity_north_mps) : null;
  const ve = velOk ? finiteOrNull(vs!.velocity_east_mps) : null;
  const speed = vn !== null && ve !== null ? finiteOrNull(Math.hypot(vn, ve)) : null;
  const headingRad = attOk ? finiteOrNull(vs!.heading_rad) : null;
  const headingDegrees = headingRad !== null ? finiteOrNull(radToDeg(headingRad)) : null;
  const heading = headingDegrees !== null ? wrap360(headingDegrees) : null;

  const fixType = finiteOrNull(rtk?.fix_type) ?? finiteOrNull(gnss?.fix_type);
  const fixName = fixType !== null ? FIX_TYPE_NAMES[fixType] ?? `Fix ${fixType}` : "NO DATA";

  const headingErrRad = finiteOrNull(rpp?.heading_error_rad);
  const distToGo = finiteOrNull(rpp?.dist_to_goal_m);
  const blockedReason =
    rpp && rpp.state !== 0 ? rppBlockedReason(rpp.tick_state, rpp.rtk_reason) : null;

  const poseAge = getTelemetrySourceAgeMs(snap.vehicle_state, now);

  return {
    gateway_connected: gatewayUp(),
    operator_alive: operatorUp() && staleness.isLive && !state.awaitingPacket,
    vehicle_telemetry_health: state.awaitingPacket || !state.schemaCompatible || snap.vehicle_state?.data.position_valid !== true ? "UNAVAILABLE" :
      snap.vehicle_state?.fresh !== true ? "STALE" :
      evaluateAgeStaleness(getTelemetrySourceAgeMs(snap.vehicle_state, now) ?? Infinity).grade,
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
    mission_state: missionStateName(),
    armed: vs ? vs.arming_state === ArmingStateEnum.ARMED : null,
    mode: vs ? (vs.nav_state === 14 ? "OFFBOARD" : "MANUAL") : null,
    pose_age_ms: poseAge,
    connected: gatewayUp() && !state.awaitingPacket && !staleness.isDisconnected,
    // The fcu_link event, not the snapshot: unknown (null) while the gateway is down or the source is silent.
    fcu_connected: fcuConnected(),
    battery_v: finiteOrNull(battery?.voltage_v),
    battery_pct: batteryPercentOrNull(battery?.remaining_pct),
    battery_a: finiteOrNull(battery?.current_a),
  };
}
