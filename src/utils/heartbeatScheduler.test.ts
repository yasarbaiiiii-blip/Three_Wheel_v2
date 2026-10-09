import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatScheduler } from "./heartbeatScheduler";

describe("Production contract - HeartbeatScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules heartbeats at the target 500ms interval", async () => {
    const sender = vi.fn().mockResolvedValue(true);
    const scheduler = new HeartbeatScheduler(sender, 500);

    scheduler.start();
    expect(sender).not.toHaveBeenCalled();

    // Fast-forward 500 ms
    await vi.advanceTimersByTimeAsync(500);
    expect(sender).toHaveBeenCalledTimes(1);

    // Fast-forward another 500 ms
    await vi.advanceTimersByTimeAsync(500);
    expect(sender).toHaveBeenCalledTimes(2);

    const metrics = scheduler.getMetrics();
    expect(metrics.totalSent).toBe(2);
    expect(metrics.totalAcks).toBe(2);
    expect(metrics.consecutiveErrors).toBe(0);
    expect(metrics.targetIntervalMs).toBe(500);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sender).toHaveBeenCalledTimes(2); // no more triggers
  });

  it("measures actual interval and counts errors on failed heartbeat", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const scheduler = new HeartbeatScheduler(sender, 500);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(sender).toHaveBeenCalledTimes(1);

    let metrics = scheduler.getMetrics();
    expect(metrics.consecutiveErrors).toBe(1);
    expect(metrics.totalAcks).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    metrics = scheduler.getMetrics();
    expect(metrics.consecutiveErrors).toBe(2);

    scheduler.stop();
  });

  it("notifies subscribers when metrics update", async () => {
    const sender = vi.fn().mockResolvedValue(true);
    const scheduler = new HeartbeatScheduler(sender, 500);

    const updates: number[] = [];
    scheduler.subscribe((m) => {
      updates.push(m.totalSent);
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.stop();

    expect(updates.length).toBeGreaterThan(2);
    expect(updates[updates.length - 1]).toBe(2);
  });
});
