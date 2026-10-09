import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HeartbeatScheduler,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_REQUEST_TIMEOUT_MS,
} from "../heartbeatScheduler";

describe("HeartbeatScheduler Fixed Cadence & Latency Decoupling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends at 500ms cadence even when requests take 1.2s of simulated latency", async () => {
    const sendTimestamps: number[] = [];

    // Simulated sender that takes 1200ms (> 500ms) to resolve
    const slowSender = vi.fn(async () => {
      sendTimestamps.push(Date.now());
      // Wait 1200ms
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    });

    const scheduler = new HeartbeatScheduler(slowSender, 500);
    scheduler.start();

    // Advance time by 2.6 seconds (expecting ~5 sends at 0, 500, 1000, 1500, 2000, 2500ms)
    for (let step = 0; step < 5; step++) {
      await vi.advanceTimersByTimeAsync(500);
    }

    scheduler.stop();

    // Verify multiple sends occurred despite individual requests taking 1.2s
    expect(sendTimestamps.length).toBeGreaterThanOrEqual(5);

    // Verify inter-send intervals are approximately 500ms
    for (let i = 1; i < sendTimestamps.length; i++) {
      const interval = sendTimestamps[i] - sendTimestamps[i - 1];
      expect(interval).toBeGreaterThanOrEqual(450);
      expect(interval).toBeLessThanOrEqual(550);
    }
  });

  it("reports JS thread blocking gap as a metric when event loop is delayed", async () => {
    const sender = vi.fn(async () => true);
    const scheduler = new HeartbeatScheduler(sender, 500);
    scheduler.start();

    // First tick at 500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(scheduler.getMetrics().totalSent).toBe(1);

    // Simulate clock/event loop lag: advance system time by 1200ms before timer executes
    vi.setSystemTime(Date.now() + 1200);
    await vi.advanceTimersByTimeAsync(500);

    const metrics = scheduler.getMetrics();
    // Actual interval between ticks was ~1700ms (1200ms lag)
    expect(metrics.threadLagMs).toBeGreaterThanOrEqual(1000);
    expect(metrics.maxThreadBlockMs).toBeGreaterThanOrEqual(1000);

    scheduler.stop();
  });

  it("enforces in-flight request timeout under 500ms (350ms)", async () => {
    // A sender that hangs indefinitely
    const hangingSender = vi.fn(() => new Promise<boolean>(() => {}));

    const scheduler = new HeartbeatScheduler(hangingSender, 500);
    scheduler.start();

    // First tick fires at 500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(scheduler.getMetrics().totalSent).toBe(1);

    // After 350ms (at 850ms), dispatchHeartbeat should time out and record error
    await vi.advanceTimersByTimeAsync(360);
    expect(scheduler.getMetrics().consecutiveErrors).toBe(1);

    // Next tick at 1000ms fires on schedule
    await vi.advanceTimersByTimeAsync(140);
    expect(scheduler.getMetrics().totalSent).toBe(2);

    scheduler.stop();
  });
});
