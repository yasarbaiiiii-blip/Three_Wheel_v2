import { describe, expect, it } from "vitest";

import type { LoadedPathResponse } from "./missionApi";
import {
  confirmStagedMissionLoaded,
  isTransientLoadedMissionMismatch,
} from "./missionContract";

function loaded(partial: Partial<LoadedPathResponse>): LoadedPathResponse {
  return {
    loaded: true,
    mission_id: "stg_new",
    state: "idle",
    num_waypoints: 12,
    num_mark: 8,
    num_transit: 4,
    has_spray_flags: true,
    sample_coords: [],
    sample_truncated: false,
    is_staged: true,
    protected: true,
    placement_mode: "GPS_SURVEYED",
    ...partial,
  };
}

describe("isTransientLoadedMissionMismatch", () => {
  it("is transient while the previous Send mission is still reported", () => {
    expect(isTransientLoadedMissionMismatch(loaded({ mission_id: "stg_old" }), "stg_new")).toBe(
      true
    );
    expect(isTransientLoadedMissionMismatch(null, "stg_new")).toBe(true);
  });

  it("is transient when the matching id is not latched loaded yet", () => {
    expect(
      isTransientLoadedMissionMismatch(
        loaded({ loaded: false, state: "idle", mission_id: "stg_new" }),
        "stg_new"
      )
    ).toBe(true);
  });

  it("is not transient for a matching loaded mission", () => {
    expect(isTransientLoadedMissionMismatch(loaded({}), "stg_new")).toBe(false);
  });
});

describe("confirmStagedMissionLoaded", () => {
  it("returns on the first matching snapshot", async () => {
    const r = await confirmStagedMissionLoaded({
      expectedMissionId: "stg_new",
      fetchLoaded: async () => loaded({}),
      attempts: 3,
      gapMs: 1,
    });
    expect(r.verified).toBe(true);
    expect(r.loaded?.mission_id).toBe("stg_new");
  });

  it("retries while the controller still holds the previous mission", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const r = await confirmStagedMissionLoaded({
      expectedMissionId: "stg_new",
      fetchLoaded: async () => {
        n += 1;
        return n < 3 ? loaded({ mission_id: "stg_old" }) : loaded({});
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      attempts: 5,
      gapMs: 10,
    });
    expect(r.verified).toBe(true);
    expect(n).toBe(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it("stops immediately on a hard verification failure", async () => {
    let n = 0;
    const r = await confirmStagedMissionLoaded({
      expectedMissionId: "stg_new",
      fetchLoaded: async () => {
        n += 1;
        return loaded({ num_waypoints: 0 });
      },
      attempts: 5,
      gapMs: 1,
    });
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/no loaded waypoints/i);
    expect(n).toBe(1);
  });
});
