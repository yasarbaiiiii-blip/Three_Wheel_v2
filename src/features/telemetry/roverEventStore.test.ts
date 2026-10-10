import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeUnknown,
  getRoverEventsState,
  ingestRoverEvent,
  parseRoverEvent,
  resetRoverEvents,
  selectEstop,
  selectFcuLink,
  selectGatewayLink,
  selectKind,
  selectOperatorLink,
  setRoverSocketConnected,
  subscribeRoverEvents,
} from "./roverEventStore";
import { describeRoverLinks, linkUnknownNote } from "./roverLinkStatus";
import {
  estopData,
  fcuLinkData,
  liveRover,
  missionData,
  operatorLinkData,
  pushRoverEvent,
  resetRoverSeq,
  roverEvent,
} from "../../test/roverEvents";

beforeEach(() => {
  resetRoverEvents();
  resetRoverSeq();
});

describe("rover_event envelope", () => {
  it("accepts the backend's envelope, with a JSON string too", () => {
    const ev = roverEvent("mission_state", missionData({ state: 3 }));
    expect(parseRoverEvent(ev)?.kind).toBe("mission_state");
    expect(parseRoverEvent(JSON.stringify(ev))?.seq).toBe(ev.seq);
  });

  it("rejects what the contract does not allow", () => {
    expect(parseRoverEvent(null)).toBeNull();
    expect(parseRoverEvent("{not json")).toBeNull();
    expect(parseRoverEvent({ ...roverEvent("estop", estopData()), kind: "gateway" })).toBeNull();
    expect(parseRoverEvent({ ...roverEvent("estop", estopData()), kind: "mission_event" })).toBeNull();
    expect(parseRoverEvent({ ...roverEvent("estop", estopData()), seq: 0 })).toBeNull();
    expect(parseRoverEvent({ ...roverEvent("estop", estopData()), seq: 1.5 })).toBeNull();
    expect(parseRoverEvent({ ...roverEvent("estop", estopData()), seq: "7" })).toBeNull();
    expect(parseRoverEvent({ ...roverEvent("estop", estopData()), data: null })).toBeNull();
    expect(parseRoverEvent(roverEvent("gateway_link", { connected: "yes" }))).toBeNull();
  });

  it("counts malformed events and applies none", () => {
    setRoverSocketConnected(true);
    expect(ingestRoverEvent({ kind: "estop" })).toBe("invalid");
    expect(getRoverEventsState().invalidCount).toBe(1);
    expect(getRoverEventsState().kinds).toEqual({});
  });
});

describe("per kind, the highest seq wins", () => {
  beforeEach(() => liveRover());

  it("applies a newer event and replaces the older one", () => {
    expect(pushRoverEvent("mission_state", missionData({ state: 3 }))).toBe("applied");
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(3);
  });

  it("drops a duplicate (same seq) and an older event of the same kind", () => {
    const first = roverEvent("mission_state", missionData({ state: 3 }));
    expect(ingestRoverEvent(first)).toBe("applied");
    expect(ingestRoverEvent(first)).toBe("duplicate");
    const older = roverEvent("mission_state", missionData({ state: 1 }), { seq: first.seq - 1 });
    expect(ingestRoverEvent(older)).toBe("duplicate");
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(3);
  });

  it("orders each kind on its own: a low seq of one kind does not lose to a high seq of another", () => {
    // seq spaces are shared across kinds, but the comparison is per kind.
    const mission = roverEvent("mission_state", missionData({ state: 3 }), { seq: 500 });
    const estop = roverEvent("estop", estopData(true), { seq: 300 });
    expect(ingestRoverEvent(mission)).toBe("applied");
    expect(ingestRoverEvent(estop)).toBe("applied");
    expect(selectEstop()).toEqual({ known: true, asserted: true, source: "tablet" });
  });

  it("out-of-order arrival converges on the highest seq", () => {
    const e1 = roverEvent("mission_state", missionData({ state: 1 }), { seq: 201 });
    const e2 = roverEvent("mission_state", missionData({ state: 9 }), { seq: 202 });
    const e3 = roverEvent("mission_state", missionData({ state: 3 }), { seq: 203 });
    for (const e of [e3, e1, e2]) ingestRoverEvent(e);
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(3);
    expect(v.known && v.event.seq).toBe(203);
  });

  it("notifies subscribers only when something changed", () => {
    const listener = vi.fn();
    const off = subscribeRoverEvents(listener);
    const ev = roverEvent("mission_state", missionData({ state: 3 }));
    ingestRoverEvent(ev);
    expect(listener).toHaveBeenCalledTimes(1);
    ingestRoverEvent(ev);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("replay on connect", () => {
  it("fills every kind from the replay, marked replay", () => {
    liveRover({ mission: { state: 3, mission_id: 7 } });
    const v = selectKind("mission_state");
    expect(v.known && v.event.replay).toBe(true);
    expect(v.known && v.data.mission_id).toBe(7);
    expect(selectGatewayLink().known).toBe(true);
  });

  it("a replay that races a newer live event does not roll the state back", () => {
    setRoverSocketConnected(true);
    ingestRoverEvent(roverEvent("gateway_link", { connected: true }, { seq: 1, replay: true }));
    // live push (seq 12) arrives before the replayed copy of the older state (seq 10)
    ingestRoverEvent(roverEvent("mission_state", missionData({ state: 3 }), { seq: 12 }));
    expect(ingestRoverEvent(roverEvent("mission_state", missionData({ state: 1 }), { seq: 10, replay: true }))).toBe("duplicate");
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(3);
  });

  it("a connection forgets everything, so a restarted backend (seq from 1) is not read as duplicates", () => {
    liveRover();
    pushRoverEvent("mission_state", missionData({ state: 3 }), { seq: 900 });
    // The backend restarts: the socket drops and reconnects, the new process counts from 1 again.
    setRoverSocketConnected(false);
    setRoverSocketConnected(true);
    expect(ingestRoverEvent(roverEvent("gateway_link", { connected: true }, { seq: 1, replay: true }))).toBe("applied");
    expect(ingestRoverEvent(roverEvent("mission_state", missionData({ state: 2 }), { seq: 2, replay: true }))).toBe("applied");
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(2);
  });
});

describe("unknown is never the last value", () => {
  it("stale is a transition: {fresh:false} makes the kind unknown", () => {
    liveRover({ operatorAlive: true });
    expect(selectOperatorLink()).toMatchObject({ known: true, alive: true });
    pushRoverEvent("operator_link", { fresh: false });
    expect(selectOperatorLink()).toEqual({ known: false, reason: "stale" });
    pushRoverEvent("operator_link", operatorLinkData(true));
    expect(selectOperatorLink()).toMatchObject({ known: true, alive: true });
  });

  it("gateway_link down marks every other kind unknown", () => {
    liveRover({ mission: { state: 3 } });
    expect(selectKind("mission_state").known).toBe(true);
    pushRoverEvent("gateway_link", { connected: false });
    expect(selectGatewayLink()).toMatchObject({ known: true, connected: false });
    expect(selectKind("mission_state")).toEqual({ known: false, reason: "gateway_down" });
    expect(selectOperatorLink()).toEqual({ known: false, reason: "gateway_down" });
    expect(selectFcuLink()).toEqual({ known: false, reason: "gateway_down" });
    expect(selectEstop()).toEqual({ known: false, reason: "gateway_down" });
  });

  it("the kinds come back only from the gateway's replay, never from values held before the outage", () => {
    liveRover({ mission: { state: 3 } });
    pushRoverEvent("gateway_link", { connected: false });
    pushRoverEvent("gateway_link", { connected: true });
    // the link is up again, but the old mission/operator/fcu/estop values are gone until replayed
    expect(selectKind("mission_state")).toEqual({ known: false, reason: "never" });
    expect(selectEstop()).toEqual({ known: false, reason: "never" });
    pushRoverEvent("mission_state", missionData({ state: 4 }), { replay: true });
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(4);
    expect(selectOperatorLink()).toEqual({ known: false, reason: "never" });
  });

  it("before gateway_link is known, nothing else is", () => {
    setRoverSocketConnected(true);
    ingestRoverEvent(roverEvent("mission_state", missionData({ state: 3 })));
    expect(selectKind("mission_state")).toEqual({ known: false, reason: "gateway_unknown" });
    expect(selectGatewayLink()).toEqual({ known: false, reason: "never" });
  });

  it("with the socket down everything is unknown, gateway_link included", () => {
    liveRover();
    setRoverSocketConnected(false);
    expect(selectGatewayLink()).toEqual({ known: false, reason: "no_socket" });
    expect(selectKind("mission_state")).toEqual({ known: false, reason: "no_socket" });
    // events that arrive on a socket the store thinks is down are held but never shown
    ingestRoverEvent(roverEvent("estop", estopData(true)));
    expect(selectEstop()).toEqual({ known: false, reason: "no_socket" });
  });

  it("a kind that was never reported is unknown, not clear", () => {
    setRoverSocketConnected(true);
    ingestRoverEvent(roverEvent("gateway_link", { connected: true }));
    expect(selectEstop()).toEqual({ known: false, reason: "never" });
  });
});

describe("link strip", () => {
  it("shows ok / bad / unknown per chip", () => {
    liveRover({ operatorAlive: true, fcuHealthy: false, estop: true });
    const byKey = Object.fromEntries(describeRoverLinks(getRoverEventsState()).map((c) => [c.key, c]));
    expect(byKey.gateway).toMatchObject({ value: "ONLINE", tone: "ok" });
    expect(byKey.operator).toMatchObject({ value: "ALIVE", tone: "ok" });
    expect(byKey.fcu).toMatchObject({ value: "NOT CONNECTED", tone: "bad" });
    expect(byKey.estop).toMatchObject({ value: "ASSERTED", tone: "bad" });
    expect(linkUnknownNote(getRoverEventsState())).toBeNull();
  });

  it("with the gateway down only the gateway chip is known, the rest read UNKNOWN", () => {
    liveRover();
    pushRoverEvent("gateway_link", { connected: false });
    const chips = describeRoverLinks(getRoverEventsState());
    expect(chips.find((c) => c.key === "gateway")).toMatchObject({ value: "CONTROLLER OFFLINE", tone: "bad" });
    for (const key of ["operator", "fcu", "estop"] as const) {
      expect(chips.find((c) => c.key === key)).toMatchObject({ value: "UNKNOWN", tone: "unknown" });
    }
    expect(linkUnknownNote(getRoverEventsState())).toBe(describeUnknown("gateway_down"));
  });

  it("with no socket the whole strip is unknown", () => {
    liveRover();
    setRoverSocketConnected(false);
    const chips = describeRoverLinks(getRoverEventsState());
    expect(chips.every((c) => c.tone === "unknown")).toBe(true);
    expect(linkUnknownNote(getRoverEventsState())).toBe(describeUnknown("no_socket"));
  });

  it("FCU chip says connected only for a fresh, handshaken session", () => {
    liveRover({ fcuHealthy: true });
    expect(selectFcuLink()).toMatchObject({ known: true, healthy: true });
    pushRoverEvent("fcu_link", { ...fcuLinkData(true), handshake_ok: false });
    expect(selectFcuLink()).toMatchObject({ known: true, healthy: false });
  });
});
