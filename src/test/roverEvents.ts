/**
 * Test helpers for the `rover_event` channel: build events with the backend's envelope and bring the
 * store into the state a connected tablet is in after the connect replay.
 */

import type {
  EstopEventData,
  FcuLinkEventData,
  MissionData,
  OperatorLinkEventData,
  RoverEvent,
  RoverEventDataByKind,
  RoverEventKind,
} from "../contract/prod/realtime";
import { ingestRoverEvent, resetRoverEvents, setRoverSocketConnected } from "../features/telemetry/roverEventStore";

let nextSeq = 1;

/** Start a fresh seq space (a new backend process). */
export function resetRoverSeq(): void {
  nextSeq = 1;
}

export function roverEvent<K extends RoverEventKind>(
  kind: K,
  data: RoverEventDataByKind[K] | Record<string, unknown>,
  over: Partial<Omit<RoverEvent<K>, "kind" | "data">> = {}
): RoverEvent<K> {
  return {
    kind,
    seq: over.seq ?? nextSeq++,
    gateway_seq: kind === "gateway_link" ? null : (over.gateway_seq ?? 1),
    t_mono_s: kind === "gateway_link" ? null : (over.t_mono_s ?? 100),
    t_wall_ms: over.t_wall_ms ?? 1_700_000_000_000,
    coalesced: over.coalesced ?? 0,
    replay: over.replay ?? false,
    data: data as RoverEventDataByKind[K],
  };
}

export function missionData(over: Partial<MissionData> = {}): MissionData & { fresh: true; stamp_s: number } {
  return {
    state: 0,
    mission_id: 0,
    run_index: 0,
    point_index: 0,
    reason_code: 0,
    path_artifact_sha256: "",
    source_artifact_sha256: "",
    request_id: "",
    reason_detail: "",
    gate_reason_code: 0,
    waiting_on: 0,
    state_entered: 0,
    ...over,
    fresh: true,
    stamp_s: 1000,
  };
}

export const operatorLinkData = (alive = true): OperatorLinkEventData => ({
  alive,
  age_s: 0.1,
  cause: alive ? "heartbeat" : "timeout",
});

export const fcuLinkData = (healthy = true): FcuLinkEventData => ({
  fresh: true,
  session_alive: healthy,
  handshake_ok: healthy,
  fault: 0,
  session_resets: 0,
});

export const estopData = (asserted = false): EstopEventData => ({
  fresh: true,
  asserted,
  source: asserted ? "tablet" : "",
});

export type LiveRover = {
  gateway?: boolean;
  operatorAlive?: boolean;
  fcuHealthy?: boolean;
  estop?: boolean;
  mission?: Partial<MissionData>;
};

/**
 * What the tablet holds after connecting: socket up, the backend's replay of every kind.
 * Returns the number of events ingested.
 */
export function liveRover(opts: LiveRover = {}): void {
  resetRoverEvents();
  resetRoverSeq();
  setRoverSocketConnected(true);
  ingestRoverEvent(roverEvent("gateway_link", { connected: opts.gateway ?? true }, { replay: true }));
  ingestRoverEvent(roverEvent("operator_link", operatorLinkData(opts.operatorAlive ?? true), { replay: true }));
  ingestRoverEvent(roverEvent("fcu_link", fcuLinkData(opts.fcuHealthy ?? true), { replay: true }));
  ingestRoverEvent(roverEvent("estop", estopData(opts.estop ?? false), { replay: true }));
  ingestRoverEvent(roverEvent("mission_state", missionData(opts.mission ?? {}), { replay: true }));
}

/** Push one live event after the replay. */
export function pushRoverEvent<K extends RoverEventKind>(
  kind: K,
  data: RoverEventDataByKind[K] | Record<string, unknown>,
  over: Partial<Omit<RoverEvent<K>, "kind" | "data">> = {}
) {
  return ingestRoverEvent(roverEvent(kind, data, over));
}
