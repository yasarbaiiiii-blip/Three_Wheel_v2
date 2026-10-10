import { describe, expect, it } from "vitest";

import {
  LIVE_ENTRY_CACHE_MAX_AGE_MS,
  LIVE_ENTRY_RECHECK_MOVE_M,
  canSkipLiveEntryRestage,
  entryPoseDrifted,
  pickRoverPoseForEntry,
} from "./liveEntryPose";

describe("pickRoverPoseForEntry", () => {
  const cache = { lat: 1, lon: 2, gps_fix: 4, pose_age_ms: 10 };

  it("uses a fresh socket cache", () => {
    const r = pickRoverPoseForEntry({
      cachePose: cache,
      cacheReceivedAtMs: Date.now(),
      nowMs: Date.now(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("socket_cache");
      expect(r.pose.lat).toBe(1);
    }
  });

  it("accepts a cache received well inside the window", () => {
    const now = 100_000;
    const r = pickRoverPoseForEntry({
      cachePose: cache,
      cacheReceivedAtMs: now - 500,
      nowMs: now,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a stale socket cache and never falls back to REST", () => {
    const now = 100_000;
    const r = pickRoverPoseForEntry({
      cachePose: cache,
      cacheReceivedAtMs: now - LIVE_ENTRY_CACHE_MAX_AGE_MS - 1,
      nowMs: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/stale/i);
  });

  it("rejects an old source even when its cache receive timestamp is recent", () => {
    const r = pickRoverPoseForEntry({cachePose:{...cache, pose_age_ms:1001}, cacheReceivedAtMs:100, nowMs:100});
    expect(r.ok).toBe(false);
  });

  it("rejects cache without receive timestamp", () => {
    const r = pickRoverPoseForEntry({
      cachePose: cache,
      cacheReceivedAtMs: null,
      nowMs: Date.now(),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when no pose exists", () => {
    const r = pickRoverPoseForEntry({
      cachePose: null,
      cacheReceivedAtMs: null,
      nowMs: Date.now(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No rover pose/i);
  });

  it("reports the eligibility reasons first", () => {
    const r = pickRoverPoseForEntry({
      cachePose: cache,
      cacheReceivedAtMs: Date.now(),
      nowMs: Date.now(),
      eligibility: { ok: false, reasons: ["Gateway disconnected."] },
    });
    expect(r).toEqual({ ok: false, error: "Gateway disconnected." });
  });
});

describe("entryPoseDrifted", () => {
  it("false under threshold", () => {
    expect(entryPoseDrifted([0, 0], [0.5, 0])).toBe(false);
    expect(entryPoseDrifted([0, 0], [LIVE_ENTRY_RECHECK_MOVE_M, 0])).toBe(false);
  });

  it("true over threshold", () => {
    expect(entryPoseDrifted([0, 0], [LIVE_ENTRY_RECHECK_MOVE_M + 0.01, 0])).toBe(true);
    expect(entryPoseDrifted([10, 10], [12, 10])).toBe(true);
  });
});

describe("canSkipLiveEntryRestage", () => {
  it("skips when entry is omitted and the Send mission is stored", () => {
    expect(
      canSkipLiveEntryRestage({ entryIncluded: false, storedVerified: true, layerScoped: false })
    ).toBe(true);
  });

  it("re-uploads when entry is needed, layers are scoped, or nothing is stored", () => {
    expect(
      canSkipLiveEntryRestage({ entryIncluded: true, storedVerified: true, layerScoped: false })
    ).toBe(false);
    expect(
      canSkipLiveEntryRestage({ entryIncluded: false, storedVerified: true, layerScoped: true })
    ).toBe(false);
    expect(
      canSkipLiveEntryRestage({ entryIncluded: false, storedVerified: false, layerScoped: false })
    ).toBe(false);
  });
});
