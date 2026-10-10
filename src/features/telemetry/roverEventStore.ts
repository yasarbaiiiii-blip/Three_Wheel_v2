/**
 * Rover status store: the `rover_event` Socket.IO channel (docs/contracts/backend.md section 4).
 *
 * One event family carries every status change the moment it happens:
 * `mission_state`, `operator_link`, `fcu_link`, `estop` (the gateway's) and `gateway_link`
 * (the backend's own link to the gateway). Rules enforced here, and nowhere else:
 *
 * 1. Per kind the event with the highest `seq` is the current state. An event whose `seq` is not
 *    above the last one of its kind is a duplicate (a live push can race the connect replay) and
 *    is dropped. `replay: true` copies obey the same rule: they only fill in kinds not seen yet.
 * 2. Stale is a transition. `data` = `{fresh:false}` means the source went silent: the kind is
 *    UNKNOWN, never the last value.
 * 3. `gateway_link` `{connected:false}` makes every other kind UNKNOWN (the backend does not
 *    re-emit them as stale) and drops them. The gateway's replay on reconnect brings each kind back,
 *    with new seqs; until then they stay unknown.
 * 4. The `seq` space belongs to one backend process. A socket that disconnects forgets all kinds,
 *    so a restarted backend (seq restarting at 1) is never mistaken for a stream of duplicates.
 *    While the socket is down every kind is unknown.
 *
 * Nothing here polls. REST is for commands only.
 */

import { useSyncExternalStore } from "react";
import {
  ROVER_EVENT_KINDS,
  type RoverEvent,
  type RoverEventDataByKind,
  type RoverEventKind,
  type StaleEventData,
} from "../../contract/prod/realtime";

export type RoverEventsState = {
  /** The Socket.IO connection to the backend is up. */
  socketConnected: boolean;
  /** Highest-seq event per kind, as received. Read through the selectors, never directly. */
  kinds: { [K in RoverEventKind]?: RoverEvent<K> };
  revision: number;
  /** Events rejected as malformed since the store was created (diagnostics). */
  invalidCount: number;
};

export type IngestResult = "applied" | "duplicate" | "invalid";

/** Why a kind has no value to show. */
export type UnknownReason =
  | "no_socket" // not connected to the rover's backend
  | "gateway_unknown" // connected, gateway_link not received yet
  | "gateway_down" // the backend lost its gateway: every gateway-sourced kind is unknown
  | "never" // nothing received for this kind yet
  | "stale" // the source went silent ({fresh:false})
  | "invalid"; // the event's data is not what the contract says

export type KindData<K extends RoverEventKind> = Exclude<RoverEventDataByKind[K], StaleEventData>;

export type KindView<K extends RoverEventKind> =
  | { known: true; event: RoverEvent<K>; data: KindData<K> }
  | { known: false; reason: UnknownReason };

type Listener = () => void;

const EMPTY: RoverEventsState = {
  socketConnected: false,
  kinds: {},
  revision: 0,
  invalidCount: 0,
};

let state: RoverEventsState = EMPTY;
const listeners = new Set<Listener>();

function commit(next: RoverEventsState) {
  state = next;
  listeners.forEach((l) => {
    try {
      l();
    } catch (err) {
      console.warn("[RoverEvents] listener error:", err);
    }
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Validate the envelope; the `data` of each kind is validated where it is read. */
export function parseRoverEvent(raw: unknown): RoverEvent | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (typeof kind !== "string" || !(ROVER_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  const seq = value.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (!isRecord(value.data)) return null;
  if (kind === "gateway_link" && typeof value.data.connected !== "boolean") return null;
  return {
    kind: kind as RoverEventKind,
    seq,
    gateway_seq: finiteOrNull(value.gateway_seq),
    t_mono_s: finiteOrNull(value.t_mono_s),
    t_wall_ms: finiteOrNull(value.t_wall_ms),
    coalesced: finiteOrNull(value.coalesced) ?? 0,
    replay: value.replay === true,
    data: value.data,
  } as unknown as RoverEvent;
}

/** Feed one `rover_event`. Per kind, only a strictly higher `seq` replaces the stored event. */
export function ingestRoverEvent(raw: unknown): IngestResult {
  const event = parseRoverEvent(raw);
  if (!event) {
    state = { ...state, invalidCount: state.invalidCount + 1 };
    return "invalid";
  }
  const current = state.kinds[event.kind];
  if (current && event.seq <= current.seq) return "duplicate";
  // The gateway link going down invalidates every other kind. They are dropped, not just hidden, so they
  // cannot reappear as "live" when the link comes back before the gateway has replayed them.
  const gatewayDown =
    event.kind === "gateway_link" && (event.data as { connected?: unknown }).connected === false;
  commit({
    ...state,
    kinds: gatewayDown
      ? { gateway_link: event as RoverEvent<"gateway_link"> }
      : { ...state.kinds, [event.kind]: event },
    revision: state.revision + 1,
  });
  return "applied";
}

/**
 * The socket came up or went down. Either way the kinds are forgotten: after a disconnect
 * nothing is known, after a connect the backend replays the latest event of every kind.
 */
export function setRoverSocketConnected(connected: boolean) {
  commit({
    socketConnected: connected,
    kinds: {},
    revision: state.revision + 1,
    invalidCount: state.invalidCount,
  });
}

/** Forget everything (sign-out, tests). */
export function resetRoverEvents() {
  commit({ ...EMPTY, revision: state.revision + 1 });
}

export function getRoverEventsState(): RoverEventsState {
  return state;
}

export function subscribeRoverEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRoverEvents(): RoverEventsState {
  return useSyncExternalStore(subscribeRoverEvents, getRoverEventsState, getRoverEventsState);
}

// ---- selectors (pure: take a state, so tests and components share them) --------------------

export type GatewayLinkView =
  | { known: true; connected: boolean; event: RoverEvent<"gateway_link"> }
  | { known: false; reason: "no_socket" | "never" };

/** The backend's link to the gateway. Unknown only while the socket is down or before the first replay. */
export function selectGatewayLink(s: RoverEventsState = state): GatewayLinkView {
  if (!s.socketConnected) return { known: false, reason: "no_socket" };
  const event = s.kinds.gateway_link;
  if (!event) return { known: false, reason: "never" };
  return { known: true, connected: event.data.connected === true, event };
}

function isStale(data: unknown): boolean {
  return isRecord(data) && data.fresh === false;
}

/** A gateway-sourced kind. Unknown when the socket or the gateway is down, never seen, or stale. */
export function selectKind<K extends Exclude<RoverEventKind, "gateway_link">>(
  kind: K,
  s: RoverEventsState = state
): KindView<K> {
  if (!s.socketConnected) return { known: false, reason: "no_socket" };
  const link = s.kinds.gateway_link;
  if (!link) return { known: false, reason: "gateway_unknown" };
  if (link.data.connected !== true) return { known: false, reason: "gateway_down" };
  const event = s.kinds[kind] as RoverEvent<K> | undefined;
  if (!event) return { known: false, reason: "never" };
  if (isStale(event.data)) return { known: false, reason: "stale" };
  return { known: true, event, data: event.data as KindData<K> };
}

export type EstopView =
  | { known: true; asserted: boolean; source: string }
  | { known: false; reason: UnknownReason };

export function selectEstop(s: RoverEventsState = state): EstopView {
  const v = selectKind("estop", s);
  if (!v.known) return v;
  if (typeof v.data.asserted !== "boolean") return { known: false, reason: "invalid" };
  return { known: true, asserted: v.data.asserted, source: typeof v.data.source === "string" ? v.data.source : "" };
}

export type OperatorLinkView =
  | { known: true; alive: boolean; cause: string }
  | { known: false; reason: UnknownReason };

export function selectOperatorLink(s: RoverEventsState = state): OperatorLinkView {
  const v = selectKind("operator_link", s);
  if (!v.known) return v;
  if (typeof v.data.alive !== "boolean") return { known: false, reason: "invalid" };
  return { known: true, alive: v.data.alive, cause: typeof v.data.cause === "string" ? v.data.cause : "" };
}

export type FcuLinkView =
  | { known: true; healthy: boolean; fault: number }
  | { known: false; reason: UnknownReason };

export function selectFcuLink(s: RoverEventsState = state): FcuLinkView {
  const v = selectKind("fcu_link", s);
  if (!v.known) return v;
  const d = v.data;
  return {
    known: true,
    healthy: d.fresh === true && d.session_alive === true && d.handshake_ok === true,
    fault: typeof d.fault === "number" ? d.fault : 0,
  };
}

/** Plain-language text for an unknown kind (operator-facing). */
export function describeUnknown(reason: UnknownReason): string {
  switch (reason) {
    case "no_socket":
      return "No link to the rover";
    case "gateway_unknown":
      return "Waiting for the rover's status";
    case "gateway_down":
      return "Rover controller offline";
    case "stale":
      return "Status not updating";
    case "invalid":
      return "Status unreadable";
    default:
      return "No status yet";
  }
}
