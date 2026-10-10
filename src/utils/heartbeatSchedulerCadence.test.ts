import { afterEach, describe, expect, it, vi } from "vitest";
import { HeartbeatScheduler } from "./heartbeatScheduler";

describe("HeartbeatScheduler cadence", () => {
  afterEach(() => vi.useRealTimers());

  it("sends every 500 ms even while the previous request is still pending", async () => {
    vi.useFakeTimers();
    const sender = vi.fn(() => new Promise<boolean>(() => {})); // never settles: only the 350 ms timeout ends it
    const hb = new HeartbeatScheduler(sender);
    hb.start();
    await vi.advanceTimersByTimeAsync(5_000);
    hb.stop();
    expect(sender.mock.calls.length).toBeGreaterThanOrEqual(9);
  });
});
