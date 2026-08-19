import { describe, expect, it } from "vitest";

import {
  LIVE_ENTRY_CACHE_MAX_AGE_MS,
  LIVE_ENTRY_RECHECK_MOVE_M,
  canSkipLiveEntryRestage,
  classifyLiveEntryStartRequirement,
  entryPoseDrifted,
  isAppPlannedMissionContext,
  pickRoverPoseForEntry,
  telemetryToRoverPoseForEntry,
} from "./liveEntryPose";

describe("telemetryToRoverPoseForEntry", () => {
  it("returns null for empty / null input", () => {
    expect(telemetryToRoverPoseForEntry(null)).toBeNull();
    expect(telemetryToRoverPoseForEntry(undefined)).toBeNull();
    expect(telemetryToRoverPoseForEntry({})).toBeNull();
    expect(telemetryToRoverPoseForEntry({ lat: NaN })).toBeNull();
  });

  it("keeps finite pose fields only", () => {
    const pose = telemetryToRoverPoseForEntry({
      lat: 12.9,
      lon: 77.5,
      gps_fix: 4,
      pose_age_ms: 40,
      pos_n: 1,
      pos_e: 2,
    });
    expect(pose).toEqual({
      lat: 12.9,
      lon: 77.5,
      gps_fix: 4,
      pose_age_ms: 40,
      pos_n: 1,
      pos_e: 2,
    });
  });
});

describe("pickRoverPoseForEntry", () => {
  const cache = { lat: 1, lon: 2, gps_fix: 4, pose_age_ms: 10 };
  const rest = { lat: 3, lon: 4, gps_fix: 5, pose_age_ms: 20 };

  it("prefers a fresh socket cache over REST", () => {
    const r = pickRoverPoseForEntry({
      restPose: rest,
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

  it("uses REST when the socket cache is stale", () => {
    const now = 100_000;
    const r = pickRoverPoseForEntry({
      restPose: rest,
      cachePose: cache,
      cacheReceivedAtMs: now - LIVE_ENTRY_CACHE_MAX_AGE_MS - 1,
      nowMs: now,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("rest_latest");
      expect(r.pose.lat).toBe(3);
    }
  });

  it("falls back to fresh socket cache when REST is null", () => {
    const now = 100_000;
    const r = pickRoverPoseForEntry({
      restPose: null,
      cachePose: cache,
      cacheReceivedAtMs: now - 500,
      nowMs: now,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("socket_cache");
      expect(r.pose.lat).toBe(1);
    }
  });

  it("rejects stale socket cache", () => {
    const now = 100_000;
    const r = pickRoverPoseForEntry({
      restPose: null,
      cachePose: cache,
      cacheReceivedAtMs: now - LIVE_ENTRY_CACHE_MAX_AGE_MS - 1,
      nowMs: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/stale/i);
  });

  it("rejects cache without receive timestamp", () => {
    const r = pickRoverPoseForEntry({
      restPose: null,
      cachePose: cache,
      cacheReceivedAtMs: null,
      nowMs: Date.now(),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when both sources missing", () => {
    const r = pickRoverPoseForEntry({
      restPose: null,
      cachePose: null,
      cacheReceivedAtMs: null,
      nowMs: Date.now(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No rover pose/i);
  });
});

describe("classifyLiveEntryStartRequirement", () => {
  it("restages when snapshot exists", () => {
    expect(
      classifyLiveEntryStartRequirement({
        hasAppPlannedSnapshot: true,
        isAppPlannedMission: true,
      })
    ).toBe("restage_with_live_entry");
  });

  it("blocks app-planned without snapshot", () => {
    expect(
      classifyLiveEntryStartRequirement({
        hasAppPlannedSnapshot: false,
        isAppPlannedMission: true,
      })
    ).toBe("block_resend_required");
  });

  it("allows legacy start for non-app-planned", () => {
    expect(
      classifyLiveEntryStartRequirement({
        hasAppPlannedSnapshot: false,
        isAppPlannedMission: false,
      })
    ).toBe("legacy_start_ok");
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
  it("skips when entry is omitted and the Send mission is still loaded", () => {
    expect(
      canSkipLiveEntryRestage({
        entryIncluded: false,
        loadedVerified: true,
        loadedMissionId: "stg_1",
        stagedMissionId: "stg_1",
        layerScoped: false,
      })
    ).toBe(true);
  });

  it("restages when entry is needed, layers are scoped, or ids differ", () => {
    expect(
      canSkipLiveEntryRestage({
        entryIncluded: true,
        loadedVerified: true,
        loadedMissionId: "stg_1",
        stagedMissionId: "stg_1",
        layerScoped: false,
      })
    ).toBe(false);
    expect(
      canSkipLiveEntryRestage({
        entryIncluded: false,
        loadedVerified: true,
        loadedMissionId: "stg_1",
        stagedMissionId: "stg_1",
        layerScoped: true,
      })
    ).toBe(false);
    expect(
      canSkipLiveEntryRestage({
        entryIncluded: false,
        loadedVerified: true,
        loadedMissionId: "stg_old",
        stagedMissionId: "stg_new",
        layerScoped: false,
      })
    ).toBe(false);
    expect(
      canSkipLiveEntryRestage({
        entryIncluded: false,
        loadedVerified: false,
        loadedMissionId: "stg_1",
        stagedMissionId: "stg_1",
        layerScoped: false,
      })
    ).toBe(false);
  });
});

describe("isAppPlannedMissionContext", () => {
  it("true for any app-planned signal", () => {
    expect(
      isAppPlannedMissionContext({
        hasAppPlannedSnapshot: false,
        isCsvMission: true,
        isLocalDxfAppPlanned: false,
        hasStagedHydrationLines: false,
      })
    ).toBe(true);
    expect(
      isAppPlannedMissionContext({
        hasAppPlannedSnapshot: false,
        isCsvMission: false,
        isLocalDxfAppPlanned: false,
        hasStagedHydrationLines: true,
      })
    ).toBe(true);
  });

  it("false when none match", () => {
    expect(
      isAppPlannedMissionContext({
        hasAppPlannedSnapshot: false,
        isCsvMission: false,
        isLocalDxfAppPlanned: false,
        hasStagedHydrationLines: false,
      })
    ).toBe(false);
  });
});
