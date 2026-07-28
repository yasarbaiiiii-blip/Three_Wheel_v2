import { describe, expect, it } from "vitest";

import {
  anchorToAlignedRefPoints,
  hydrateStagedMissionForMap,
} from "./stagedMissionHydration";

describe("hydrateStagedMissionForMap", () => {
  it("returns geometry and anchor together for a spray-run mission", () => {
    const artifact = {
      mission_id: "stg_test_1",
      anchor: { lat: 13.072061, lon: 80.261939, rotation_deg: 0 },
      waypoints: [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
      ],
      spray_flags: [true, true, true, false],
    };

    const hydrated = hydrateStagedMissionForMap(artifact);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.lines.length).toBeGreaterThan(0);
    expect(hydrated!.alignedRefPoints).toEqual([
      { dxf_x: 0, dxf_y: 0, lat: 13.072061, lon: 80.261939 },
    ]);
    expect(hydrated!.selectedLineId).toBe(hydrated!.lines[0].id);
    // Same origin as the standalone helper — never a second code path.
    expect(hydrated!.alignedRefPoints).toEqual(
      anchorToAlignedRefPoints(artifact.anchor)
    );
  });

  it("returns null when there is nothing drawable", () => {
    expect(hydrateStagedMissionForMap({ waypoints: [], spray_flags: [] })).toBeNull();
    expect(hydrateStagedMissionForMap({ waypoints: [[0, 0]], spray_flags: [true] })).toBeNull();
    expect(hydrateStagedMissionForMap(null)).toBeNull();
    expect(hydrateStagedMissionForMap(undefined)).toBeNull();
  });

  it("falls back to point_mission_points when waypoints are empty", () => {
    const hydrated = hydrateStagedMissionForMap({
      waypoints: [],
      spray_flags: [],
      anchor: { lat: 1.2, lon: 3.4 },
      point_mission_points: [
        { north_m: 0, east_m: 0, mark: true },
        { north_m: 1, east_m: 2, mark: false },
      ],
    });
    expect(hydrated).not.toBeNull();
    expect(hydrated!.lines).toHaveLength(2);
    expect(hydrated!.alignedRefPoints).toEqual([
      { dxf_x: 0, dxf_y: 0, lat: 1.2, lon: 3.4 },
    ]);
  });

  it("explicitly returns empty alignedRefPoints for LOCAL_NED / null anchor", () => {
    const hydrated = hydrateStagedMissionForMap({
      waypoints: [
        [0, 0],
        [5, 0],
      ],
      spray_flags: [true, true],
      anchor: null,
    });
    expect(hydrated).not.toBeNull();
    expect(hydrated!.lines.length).toBeGreaterThan(0);
    expect(hydrated!.alignedRefPoints).toEqual([]);
    expect(anchorToAlignedRefPoints(null)).toEqual([]);
  });
});
