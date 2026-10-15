import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { applyEntryTransit, buildTrajectory } from "./missionTrajectory";
import { buildAppPlannedMissionPayload } from "./appPlannedMissionBuilder";
import {
  ENTRY_AHEAD_LATERAL_M,
  firstMarkPointsForEntry,
  roverAheadOfFirstMark,
  startEntryAheadWarning,
} from "./startEntryAheadWarning";

function markLine(id: string, pts: Array<[number, number]>): PlanLine {
  const points = pts.map(([north, east]) => ({ north, east }));
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: pts[0][0], y: pts[0][1] },
    to: { id: 2, x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: { closed: false, road_marking: true },
      preview_points: points,
    },
  };
}

// First mark starts at (0,0) and runs due north for 10 m.
const MARK: Array<[number, number]> = [
  [0, 0],
  [10, 0],
];
const pose = (n: number, e: number) => ({ pos_n: n, pos_e: e, gps_fix: 4, pose_age_ms: 100 });

describe("APP-02 rover ahead of the first mark", () => {
  it("warns when the rover is past the start, on the line", () => {
    const w = startEntryAheadWarning(MARK, pose(2, 0.1), null);
    expect(w).toMatch(/2\.00 m past the start/);
  });

  it("warns at the lateral limit and not beyond it", () => {
    expect(startEntryAheadWarning(MARK, pose(3, ENTRY_AHEAD_LATERAL_M), null)).not.toBeNull();
    expect(startEntryAheadWarning(MARK, pose(3, ENTRY_AHEAD_LATERAL_M + 0.01), null)).toBeNull();
  });

  it("does not warn when the rover is behind the start", () => {
    expect(startEntryAheadWarning(MARK, pose(-2, 0), null)).toBeNull();
  });

  it("does not warn when the rover is off the line", () => {
    expect(startEntryAheadWarning(MARK, pose(2, 3), null)).toBeNull();
  });

  it("does not warn when the rover is at the start (entry omitted)", () => {
    expect(startEntryAheadWarning(MARK, pose(0.02, 0), null)).toBeNull();
  });

  it("works on a diagonal first mark", () => {
    const diag: Array<[number, number]> = [[0, 0], [10, 10]];
    expect(roverAheadOfFirstMark([3, 3.2], diag).ahead).toBe(true);
    expect(roverAheadOfFirstMark([-3, -3], diag).ahead).toBe(false);
    expect(roverAheadOfFirstMark([3, 6], diag).ahead).toBe(false);
  });

  it("gives no warning without a usable pose or mark", () => {
    expect(startEntryAheadWarning(null, pose(2, 0), null)).toBeNull();
    expect(startEntryAheadWarning(MARK, null, null)).toBeNull();
    expect(startEntryAheadWarning(MARK, { pos_n: NaN, pos_e: 0 }, null)).toBeNull();
    expect(startEntryAheadWarning(MARK, { ...pose(2, 0), pose_age_ms: 60_000 }, null)).toBeNull();
    expect(startEntryAheadWarning([[0, 0]], pose(2, 0), null)).toBeNull();
  });

  it("takes the first mark from the plan, and none when a run-up leads", () => {
    const line = markLine("a", MARK);
    expect(firstMarkPointsForEntry([line], null)).toEqual(MARK);
    expect(firstMarkPointsForEntry([], null)).toBeNull();
    const withPre = firstMarkPointsForEntry([line], { enabled: true, perLine: true, preM: 1, aftM: 1 });
    expect(withPre).toBeNull();
  });

  it("the plan stays sendable and the entry goes straight to the start", () => {
    const built = buildTrajectory([markLine("a", MARK)], { markSpeedMs: 0.35, travelSpeedMs: 0.5 });
    const withEntry = applyEntryTransit(built.runs, {
      roverPose: pose(2, 0.1),
      originGps: null,
      travelSpeedMs: 0.5,
      requireEntryTransit: true,
    });
    expect(withEntry.entryTransit.error).toBeUndefined();
    expect(withEntry.entryTransit.included).toBe(true);
    expect(withEntry.runs[0].points).toHaveLength(2); // rover, first tip: no staging point
    expect(() =>
      buildAppPlannedMissionPayload({ runs: withEntry.runs, anchor: [13.07, 80.26] })
    ).not.toThrow();
  });
});
