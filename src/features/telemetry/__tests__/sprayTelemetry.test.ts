import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as store from "../prodTelemetryStore";
import { getAdaptedTelemetrySnapshot } from "../prodTelemetryStore";
import type { RoverTelemetrySnapshot, SnapshotEntry, SprayData } from "../../../contract/prod/realtime";
import type { SprayState } from "../prodTelemetryStore";
import { liveRover } from "../../../test/roverEvents";

function sprayEntry(data: Partial<SprayData> = {}, over: Partial<SnapshotEntry<SprayData>> = {}): SnapshotEntry<SprayData> {
  return {
    age_s: 0.1,
    fresh: true,
    data: {
      fsm_state: 3,
      spraying: false,
      desired: false,
      safety_ok: true,
      safety_reason: "",
      manual_active: false,
      xtrack_tripped: false,
      xtrack_error_m: 0.0,
      ...data,
    },
    ...over,
  };
}

function baseSnapshot(over: Partial<RoverTelemetrySnapshot> = {}): RoverTelemetrySnapshot {
  return {
    gateway: { schema: 1, operator_alive: true, clients: 1 },
    vehicle_state: {
      age_s: 0.1,
      fresh: true,
      data: {
        position_valid: true,
        velocity_valid: true,
        attitude_valid: true,
        north_m: 10,
        east_m: 20,
        down_m: 0,
        velocity_north_mps: 0,
        velocity_east_mps: 0,
        heading_rad: 0,
        yaw_rate_radps: 0,
        arming_state: 2,
        nav_state: 14,
        failsafe: false,
      },
    },
    estimator_health: null,
    rtk_status: null,
    gnss_report: null,
    ntrip_status: null,
    px4_link: null,
    safety_gate: null,
    emergency_stop: null,
    motion_guard: null,
    rpp: null,
    mission: null,
    last_point_result: null,
    spray: null,
    recorder: null,
    ...over,
  };
}

const ingest = (snap = baseSnapshot(), age_s = 0) =>
  store.ingestTelemetryPacket({ snapshot: snap, age_s }, { source: "socket" });

describe("APP-05: spray status by events, not REST polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.clearProdTelemetry();
    store.setProdSocketConnected(true);
    liveRover();
  });

  afterEach(() => {
    store.clearProdTelemetry();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("store and selector derive spray state from telemetry events", () => {
    it("derives active spray state when rover pushes spraying = true", () => {
      const snap = baseSnapshot({
        spray: sprayEntry({
          spraying: true,
          desired: true,
          fsm_state: 3,
          safety_ok: true,
          xtrack_error_m: 0.015,
        }),
      });
      ingest(snap);

      const state = store.selectSprayState();
      expect(state.known).toBe(true);
      expect(state.spraying).toBe(true);
      expect(state.active).toBe(true);
      expect(state.desired).toBe(true);
      expect(state.manualActive).toBe(false);
      expect(state.safetyOk).toBe(true);
      expect(state.fsmState).toBe(3);

      const adapted = getAdaptedTelemetrySnapshot();
      expect(adapted?.spraying).toBe(true);
      expect(adapted?.spray_active).toBe(true);
      expect(adapted?.spray_fsm_state).toBe(3);
    });

    it("derives manual active spray state when manual_active = true", () => {
      const snap = baseSnapshot({
        spray: sprayEntry({
          spraying: true,
          manual_active: true,
          desired: false,
          fsm_state: 3,
        }),
      });
      ingest(snap);

      const state = store.selectSprayState();
      expect(state.known).toBe(true);
      expect(state.spraying).toBe(true);
      expect(state.manualActive).toBe(true);
      expect(state.active).toBe(true);
    });

    it("derives idle spray state when spraying is off", () => {
      const snap = baseSnapshot({
        spray: sprayEntry({
          spraying: false,
          manual_active: false,
          desired: false,
          fsm_state: 1,
        }),
      });
      ingest(snap);

      const state = store.selectSprayState();
      expect(state.known).toBe(true);
      expect(state.spraying).toBe(false);
      expect(state.manualActive).toBe(false);
      expect(state.active).toBe(false);
      expect(state.fsmState).toBe(1);
    });

    it("selectSprayState works as a pure selector with an explicit snapshot", () => {
      const snap = baseSnapshot({
        spray: sprayEntry({
          spraying: true,
          desired: true,
          manual_active: false,
        }),
      });
      const state = store.selectSprayState(snap);
      expect(state.known).toBe(true);
      expect(state.spraying).toBe(true);
      expect(state.active).toBe(true);
    });
  });

  describe("staleness: stale telemetry produces unknown spray state", () => {
    it("returns unknown when snapshot has no spray source", () => {
      ingest(baseSnapshot({ spray: null }));
      const state = store.selectSprayState();
      expect(state.known).toBe(false);
      expect(state.spraying).toBe(false);
      expect(state.active).toBe(false);

      const adapted = getAdaptedTelemetrySnapshot();
      expect(adapted?.spraying).toBeNull();
      expect(adapted?.spray_active).toBeNull();
    });

    it("returns unknown when gateway marks spray fresh = false", () => {
      const snap = baseSnapshot({
        spray: sprayEntry(
          { spraying: true },
          { fresh: false }
        ),
      });
      ingest(snap);

      const state = store.selectSprayState();
      expect(state.known).toBe(false);
      expect(state.spraying).toBe(false);
      expect(state.active).toBe(false);
      expect(state.fsmState).toBeNull();

      const adapted = getAdaptedTelemetrySnapshot();
      expect(adapted?.spraying).toBeNull();
    });

    it("returns unknown when spray entry age exceeds staleness threshold", () => {
      const snap = baseSnapshot({
        spray: sprayEntry(
          { spraying: true },
          { age_s: 2.0 } // 2.0 s > 1.0 s staleness threshold
        ),
      });
      ingest(snap);

      const state = store.selectSprayState();
      expect(state.known).toBe(false);
      expect(state.spraying).toBe(false);
    });

    it("expires locally to unknown when no fresh packets arrive", () => {
      let now = 1000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const unsub = store.subscribeProdTelemetry(() => {});

      const snap = baseSnapshot({
        spray: sprayEntry({ spraying: true }),
      });
      ingest(snap);
      expect(store.selectSprayState().known).toBe(true);

      // Advance clock past STALE_THRESHOLD_MS (1000ms) + ticker step (250ms)
      now += 1250;
      vi.advanceTimersByTime(1250);

      expect(store.selectSprayState().known).toBe(false);
      expect(store.selectSprayState().spraying).toBe(false);
      unsub();
    });

    it("the hook snapshot keeps one object while the spray state is unchanged (no re-render at packet rate)", () => {
      // useSyncExternalStore re-renders when getSnapshot's result differs by Object.is (react.dev): 20 packets that
      // only move the cross-track error and the vehicle must hand React the SAME object; a real change hands a new one.
      let now = 1000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const notified: SprayState[] = [];
      const unsub = store.subscribeProdTelemetry(() => notified.push(store.getSpraySnapshot()));
      ingest(baseSnapshot({ spray: sprayEntry({ spraying: true, desired: true }) }));
      const first = store.getSpraySnapshot();
      expect(first.known && first.spraying).toBe(true);
      for (let i = 0; i < 20; i++) {
        now += 100;
        ingest(baseSnapshot({ spray: sprayEntry({ spraying: true, desired: true, xtrack_error_m: 0.001 * i }) }));
      }
      expect(notified.length).toBeGreaterThanOrEqual(20);
      expect(notified.every((s) => s === first)).toBe(true);
      ingest(baseSnapshot({ spray: sprayEntry({ spraying: false, desired: false }) }));
      const changed = store.getSpraySnapshot();
      expect(changed).not.toBe(first);
      expect(changed.spraying).toBe(false);
      // packets stop: the store's own 250 ms freshness tick turns it unknown, with no new packet
      now += 1250;
      vi.advanceTimersByTime(1250);
      expect(store.getSpraySnapshot().known).toBe(false);
      unsub();
    });

    it("the spray master reads FSM_DISABLED by name", () => {
      expect(store.SPRAY_FSM_DISABLED).toBe(6); // SprayStatus.msg uint8 FSM_DISABLED=6
    });

    it("returns unknown when the socket disconnects", () => {
      const snap = baseSnapshot({
        spray: sprayEntry({ spraying: true }),
      });
      ingest(snap);
      expect(store.selectSprayState().known).toBe(true);

      store.setProdSocketConnected(false);
      expect(store.selectSprayState().known).toBe(false);
    });
  });
});
