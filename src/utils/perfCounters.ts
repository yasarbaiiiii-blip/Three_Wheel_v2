/**
 * Dev-only work counters: how often the map, rover, pages and expensive helpers run.
 *
 * Off unless the bundle is a dev build AND was started with EXPO_PUBLIC_PERF_COUNTERS=1
 * (Expo inlines EXPO_PUBLIC_* at build time). When off, `perfCount` returns immediately and
 * no timer exists. When on, one line every 5 s lists each counter with its per-second rate,
 * e.g. `[perf] 5.0s MapViewNative.render=0 (0.0/s) RoverLayer.render=50 (10.0/s)`.
 *
 * Usage: call `perfCount("Name.render")` in a component body or `perfCount("cache.hit")` in a
 * helper. The acceptance targets live in docs/PERFORMANCE_ROBUSTNESS_BENCH.md.
 */
const REPORT_INTERVAL_MS = 5000;

export type PerfReport = {
  elapsedMs: number;
  counts: Record<string, number>;
};

export type PerfCounters = {
  count: (name: string) => void;
  /** Snapshot and reset; `now` is injectable for tests. */
  flush: (now?: number) => PerfReport;
};

export function createPerfCounters(startedAt = Date.now()): PerfCounters {
  let counts = new Map<string, number>();
  let windowStart = startedAt;
  return {
    count(name) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    },
    flush(now = Date.now()) {
      const report: PerfReport = {
        elapsedMs: Math.max(0, now - windowStart),
        counts: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      };
      counts = new Map();
      windowStart = now;
      return report;
    },
  };
}

export function formatPerfReport(report: PerfReport): string {
  const seconds = report.elapsedMs / 1000;
  const parts = Object.entries(report.counts).map(([name, n]) => {
    const rate = seconds > 0 ? n / seconds : 0;
    return `${name}=${n} (${rate.toFixed(1)}/s)`;
  });
  return `[perf] ${seconds.toFixed(1)}s ${parts.length > 0 ? parts.join(" ") : "(no activity)"}`;
}

const ENABLED =
  typeof __DEV__ !== "undefined" && __DEV__ && process.env.EXPO_PUBLIC_PERF_COUNTERS === "1";

let shared: PerfCounters | null = null;

export function perfCount(name: string): void {
  if (!ENABLED) return;
  if (!shared) {
    shared = createPerfCounters();
    const counters = shared;
    setInterval(() => console.log(formatPerfReport(counters.flush())), REPORT_INTERVAL_MS);
  }
  shared.count(name);
}
