/**
 * `App` renders the whole UI tree, so every state change it takes is expensive. These tests count how
 * often each live-data source would make it re-render, old behaviour against the current one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { hasLiveCorrections, EMPTY_RTK_STATUS } from "../../../api/rtkStatus";
import { MissionStateEnum } from "../../../contract/prod/realtime";
import type { TelemetrySnapshot } from "../../../types/plan";
import { liveRover, missionData, pushRoverEvent } from "../../../test/roverEvents";
import { missionIsActive, selectMission } from "../../mission/missionLifecycle";
import { getRoverEventsState, subscribeRoverEvents } from "../roverEventStore";
import { rootTelemetryEqual } from "../rootTelemetry";

/** The way a useSyncExternalStore selector re-renders: only when the derived value changes. */
function countValueChanges<T>(select: () => T, drive: () => void) {
  let notifications = 0;
  let renders = 0;
  let last = select();
  const off = subscribeRoverEvents(() => {
    notifications++;
    const next = select();
    if (!Object.is(next, last)) {
      renders++;
      last = next;
    }
  });
  drive();
  off();
  return { notifications, renders };
}

describe("mission events -> App re-renders", () => {
  beforeEach(() => liveRover());

  it("200 progress events in one running mission cause 1 render (old: one per event)", () => {
    pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.IDLE }));
    const r = countValueChanges(
      () => missionIsActive(selectMission(getRoverEventsState())),
      () => {
        pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.RUNNING, mission_id: 1, point_index: 0 }));
        for (let i = 1; i < 200; i++) {
          pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.RUNNING, mission_id: 1, point_index: i }));
        }
      }
    );
    expect(r.notifications).toBe(200); // what `useRoverEvents()` in App used to re-render on
    expect(r.renders).toBe(1); // IDLE -> active, once
  });

  it("pause and resume still flip the paused flag exactly when the state changes", () => {
    const paused = () => {
      const v = selectMission(getRoverEventsState());
      return v.known && v.run.state === MissionStateEnum.PAUSED;
    };
    pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.RUNNING, mission_id: 1 }));
    const r = countValueChanges(paused, () => {
      pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.PAUSED, mission_id: 1 }));
      pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.PAUSED, mission_id: 1, point_index: 5 }));
      pushRoverEvent("mission_state", missionData({ state: MissionStateEnum.RUNNING, mission_id: 1, point_index: 6 }));
    });
    expect(r.renders).toBe(2);
  });
});

function snap(over: Partial<TelemetrySnapshot>): TelemetrySnapshot {
  return { mission_state: "running", lat: 13, lon: 80, ...over } as TelemetrySnapshot;
}

/** The previous App key: position rounded to a 0.5 m grid. */
function oldKey(s: TelemetrySnapshot | null): string {
  if (!s) return "none";
  const fix = Number.isFinite(s.lat) && Number.isFinite(s.lon);
  const n = s.pos_n == null ? "x" : String(Math.round((s.pos_n as number) * 2));
  const e = s.pos_e == null ? "x" : String(Math.round((s.pos_e as number) * 2));
  return `${s.mission_state ?? ""}|${fix}|${n}|${e}`;
}

function countRenders(stream: TelemetrySnapshot[], equal: (a: TelemetrySnapshot | null, b: TelemetrySnapshot | null) => boolean) {
  let last: TelemetrySnapshot | null = null;
  let renders = 0;
  for (const s of stream) {
    if (!equal(last, s)) {
      renders++;
      last = s;
    }
  }
  return renders;
}

describe("position -> App re-renders", () => {
  it("a parked rover with GPS jitter on a rounding line stops re-rendering the app", () => {
    // 60 s at 10 Hz, +/- 1.5 cm of noise straddling the 0.25 m rounding boundary.
    const stream: TelemetrySnapshot[] = [];
    for (let i = 0; i < 600; i++) {
      const noise = (i % 2 === 0 ? 1 : -1) * 0.015;
      stream.push(snap({ pos_n: 10.25 + noise, pos_e: 5.0 }));
    }
    const before = countRenders(stream, (a, b) => oldKey(a) === oldKey(b));
    const after = countRenders(stream, rootTelemetryEqual);
    expect(before).toBeGreaterThan(100); // old: flapped on nearly every packet
    expect(after).toBe(1);
  });

  it("a driving rover still updates about once per 0.5 m travelled", () => {
    // 60 s at 0.5 m/s, 10 Hz.
    const stream: TelemetrySnapshot[] = [];
    for (let i = 0; i < 600; i++) stream.push(snap({ pos_n: i * 0.05, pos_e: 0 }));
    const after = countRenders(stream, rootTelemetryEqual);
    expect(after).toBeGreaterThanOrEqual(55);
    expect(after).toBeLessThanOrEqual(65);
  });

  it("mission state, fix and position-known changes always render", () => {
    expect(rootTelemetryEqual(snap({ pos_n: 1, pos_e: 1 }), snap({ pos_n: 1, pos_e: 1, mission_state: "idle" }))).toBe(false);
    expect(rootTelemetryEqual(snap({ pos_n: 1, pos_e: 1 }), snap({ pos_n: 1, pos_e: 1, lat: NaN }))).toBe(false);
    expect(rootTelemetryEqual(snap({ pos_n: 1, pos_e: 1 }), snap({}))).toBe(false);
    expect(rootTelemetryEqual(snap({ pos_n: 1, pos_e: 1 }), null)).toBe(false);
    expect(rootTelemetryEqual(null, null)).toBe(true);
  });
});

describe("RTK chip -> App re-renders", () => {
  const live = (age: number) => ({
    ...EMPTY_RTK_STATUS,
    mode: "ntrip" as const,
    running: true,
    healthy: true,
    source_state: "streaming" as const,
    frames: 500,
    last_frame_age_s: age,
  });
  const oldChipKey = (s: ReturnType<typeof live>) =>
    `${s.mode}|${s.running}|${s.healthy}|${s.source_state}|${s.last_error}|${Math.round((s.last_frame_age_s ?? -1) * 2)}`;
  const newChipKey = (s: ReturnType<typeof live>) =>
    `${s.mode}|${s.running}|${s.healthy}|${s.source_state}|${s.last_error}|${hasLiveCorrections(s)}`;

  it("a ticking correction age no longer changes the key while corrections stay live", () => {
    const keys = (k: (s: ReturnType<typeof live>) => string) => {
      let last = "";
      let changes = 0;
      for (let i = 0; i < 600; i++) {
        const key = k(live(0.2 + (i % 10) * 0.1)); // age sawtooths 0.2..1.1 s, 60 s at 10 Hz
        if (key !== last) {
          changes++;
          last = key;
        }
      }
      return changes;
    };
    expect(keys(oldChipKey)).toBeGreaterThan(100);
    expect(keys(newChipKey)).toBe(1);
  });

  it("still re-renders when corrections go stale (age > 10 s)", () => {
    expect(newChipKey(live(2))).not.toBe(newChipKey(live(30)));
  });
});

