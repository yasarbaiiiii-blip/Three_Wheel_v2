import { describe, expect, it } from "vitest";

import { createPerfCounters, formatPerfReport, perfCount } from "./perfCounters";

describe("perfCounters", () => {
  it("counts per name and resets on flush", () => {
    const counters = createPerfCounters(1000);
    counters.count("Map.render");
    counters.count("Map.render");
    counters.count("Rover.render");
    expect(counters.flush(6000)).toEqual({
      elapsedMs: 5000,
      counts: { "Map.render": 2, "Rover.render": 1 },
    });
    expect(counters.flush(11000)).toEqual({ elapsedMs: 5000, counts: {} });
  });

  it("formats per-second rates", () => {
    expect(formatPerfReport({ elapsedMs: 5000, counts: { "Rover.render": 50, "Map.render": 0 } })).toBe(
      "[perf] 5.0s Rover.render=50 (10.0/s) Map.render=0 (0.0/s)"
    );
    expect(formatPerfReport({ elapsedMs: 5000, counts: {} })).toBe("[perf] 5.0s (no activity)");
  });

  it("is a no-op outside an opted-in dev build", () => {
    expect(() => perfCount("anything")).not.toThrow();
  });
});
