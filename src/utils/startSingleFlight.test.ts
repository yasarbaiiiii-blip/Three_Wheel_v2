import { describe, expect, it, vi } from "vitest";

import { createInFlightGate } from "./inFlightGate";
import {
  restageWithDriftRecheck,
  type AppPlannedStartSnapshot,
  type RestageWithLiveEntryResult,
} from "./appPlannedStartSnapshot";
import { LIVE_ENTRY_RECHECK_MOVE_M } from "./liveEntryPose";

// APP-15: Start uploads once; the only legitimate second POST /api/missions/plan is the drift retry.

const snapshot = {
  paintedLines: [],
  extensionConfig: null,
  originGps: [13.07, 80.26] as [number, number],
  missionName: "m",
  dash: null,
  capturedAtMs: 0,
} as AppPlannedStartSnapshot;

const ok = (id: string): RestageWithLiveEntryResult => ({
  success: true,
  missionId: id,
  admitted: {} as never,
  entryIncluded: true,
});

// Local-NED pose (originGps below is real, so use lat/lon about the origin: 1 deg lat ~ 111 km)
const at = (northM: number) => ({
  lat: 13.07 + northM / 111_194.9,
  lon: 80.26,
  gps_fix: 4,
  pose_age_ms: 50,
});

describe("Start restage: second POST only on drift", () => {
  it("uploads once when the rover did not move", async () => {
    const restage = vi.fn(async () => ok("a"));
    const r = await restageWithDriftRecheck({
      snapshot,
      livePose: at(0),
      readLatestPose: () => at(0.2),
      restage,
    });
    expect(restage).toHaveBeenCalledTimes(1);
    expect(r.driftRetry).toBe(false);
  });

  it("uploads once at the drift threshold itself (not more than 1.0 m)", async () => {
    const restage = vi.fn(async () => ok("a"));
    await restageWithDriftRecheck({
      snapshot,
      livePose: at(0),
      readLatestPose: () => at(LIVE_ENTRY_RECHECK_MOVE_M - 0.01),
      restage,
    });
    expect(restage).toHaveBeenCalledTimes(1);
  });

  it("uploads once when no fresh pose is available for the recheck", async () => {
    const restage = vi.fn(async () => ok("a"));
    await restageWithDriftRecheck({ snapshot, livePose: at(0), readLatestPose: () => null, restage });
    expect(restage).toHaveBeenCalledTimes(1);
  });

  it("uploads a second time only when the rover moved more than 1.0 m, with the new pose", async () => {
    const restage = vi.fn(async (a: { roverPose: unknown }) => ok(restage.mock.calls.length === 1 ? "a" : "b"));
    const onDrift = vi.fn();
    const latest = at(LIVE_ENTRY_RECHECK_MOVE_M + 0.5);
    const r = await restageWithDriftRecheck({
      snapshot,
      livePose: at(0),
      readLatestPose: () => latest,
      onDriftRetry: onDrift,
      restage: restage as never,
    });
    expect(restage).toHaveBeenCalledTimes(2);
    expect(onDrift).toHaveBeenCalledTimes(1);
    expect(r.driftRetry).toBe(true);
    expect(r.livePose).toBe(latest);
    expect(r.restaged.success && r.restaged.missionId).toBe("b");
  });

  it("never loops: continuous drift still produces at most two uploads", async () => {
    let n = 0;
    const restage = vi.fn(async () => ok(String(++n)));
    await restageWithDriftRecheck({
      snapshot,
      livePose: at(0),
      readLatestPose: () => at(50 * (n + 1)),
      restage,
    });
    expect(restage).toHaveBeenCalledTimes(2);
  });

  it("does not recheck or re-upload after a failed first upload", async () => {
    const restage = vi.fn(async (): Promise<RestageWithLiveEntryResult> => ({ success: false, error: "x" }));
    const read = vi.fn(() => at(10));
    const r = await restageWithDriftRecheck({ snapshot, livePose: at(0), readLatestPose: read, restage });
    expect(restage).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(r.restaged.success).toBe(false);
  });
});

describe("Start single-flight gate", () => {
  // The same shape as App.startMissionOnBackend: tryEnter, await the upload, leave in finally.
  function makeStart(gate: ReturnType<typeof createInFlightGate>, post: () => Promise<void>) {
    return async () => {
      if (!gate.tryEnter()) return "busy";
      try {
        await post();
        return "started";
      } finally {
        gate.leave();
      }
    };
  }

  it("a double press posts once", async () => {
    const gate = createInFlightGate();
    let release!: () => void;
    const post = vi.fn(() => new Promise<void>((r) => (release = r)));
    const start = makeStart(gate, post);
    const first = start();
    const second = start();
    expect(await second).toBe("busy");
    release();
    expect(await first).toBe("started");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a re-render (new handler closure over the same ref'd gate) cannot pass", async () => {
    const gate = createInFlightGate();
    let release!: () => void;
    const post = vi.fn(() => new Promise<void>((r) => (release = r)));
    const first = makeStart(gate, post)();
    const afterRerender = makeStart(gate, post); // new closure, same gate
    expect(await afterRerender()).toBe("busy");
    release();
    await first;
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("releases after success and after failure so the next real press works", async () => {
    const gate = createInFlightGate();
    const boom = makeStart(gate, async () => {
      throw new Error("x");
    });
    await expect(boom()).rejects.toThrow("x");
    expect(gate.isBusy()).toBe(false);
    expect(await makeStart(gate, async () => undefined)()).toBe("started");
  });
});
