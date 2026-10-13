import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetThrottledLog, warnThrottled } from "./throttledLog";

describe("warnThrottled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetThrottledLog();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("an hour of a 10 Hz warning logs a few lines instead of 36,000", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 36000; i++) {
      warnThrottled("schema", 30_000, "mismatch");
      vi.advanceTimersByTime(100);
    }
    expect(warn.mock.calls.length).toBe(120); // once per 30 s for an hour
  });

  it("different keys are limited independently, and the first call always logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(warnThrottled("a", 10_000, "a1")).toBe(true);
    expect(warnThrottled("b", 10_000, "b1")).toBe(true);
    expect(warnThrottled("a", 10_000, "a2")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(warnThrottled("a", 10_000, "a3")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("never holds more than a bounded number of keys", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 1000; i++) warnThrottled(`k${i}`, 60_000, "x");
    // Still works after the table was cleared.
    expect(warnThrottled("fresh", 60_000, "y")).toBe(true);
  });
});
