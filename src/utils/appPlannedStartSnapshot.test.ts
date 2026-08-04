import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildAppPlannedStartSnapshot,
  clonePlanLinesForSnapshot,
} from "./appPlannedStartSnapshot";
import {
  ENTRY_TRANSIT_LABEL,
  buildTrajectory,
  type TrajectoryRun,
} from "./missionTrajectory";

function markLine(
  id: string,
  points: Array<{ north: number; east: number }>
): PlanLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: first.north, y: first.east },
    to: { id: 2, x: last.north, y: last.east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: {},
      preview_points: points,
    },
  };
}

describe("appPlannedStartSnapshot", () => {
  it("clones painted lines so later mutation does not affect snapshot", () => {
    const line = markLine("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const snap = buildAppPlannedStartSnapshot({
      paintedLines: [line],
      originGps: [12.97, 77.59],
      missionName: "test",
      extensionConfig: { enabled: true, preM: 0.5, aftM: 0.5, perLine: false },
    });
    line.from.x = 999;
    expect(snap.paintedLines[0].from.x).toBe(0);
    expect(clonePlanLinesForSnapshot([line])[0].from.x).toBe(999);
  });

  it("Start-style build with requireEntryTransit uses live GPS about origin", () => {
    const origin: [number, number] = [12.97, 77.59];
    // ~4 m north of origin
    const lat = origin[0] + 4 / 6_371_000 / (Math.PI / 180);
    const painted = [
      markLine("a", [
        { north: 0, east: 0 },
        { north: 10, east: 0 },
      ]),
    ];
    const snap = buildAppPlannedStartSnapshot({
      paintedLines: painted,
      originGps: origin,
      missionName: "m1",
    });

    // Pose at first Start (X)
    const first = buildTrajectory(snap.paintedLines, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      originGps: snap.originGps,
      roverPose: { lat, lon: origin[1], gps_fix: 4, pose_age_ms: 50 },
      includeEntryTransit: true,
      requireEntryTransit: true,
    });
    expect(first.entryTransit?.included).toBe(true);
    expect(first.runs[0].label).toBe(ENTRY_TRANSIT_LABEL);
    expect(first.runs[0].points[0][0]).toBeGreaterThan(3);

    // Pose at second Start (Y) — different position
    const latY = origin[0] + 8 / 6_371_000 / (Math.PI / 180);
    const second = buildTrajectory(snap.paintedLines, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      originGps: snap.originGps,
      roverPose: { lat: latY, lon: origin[1], gps_fix: 4, pose_age_ms: 40 },
      includeEntryTransit: true,
      requireEntryTransit: true,
    });
    expect(second.entryTransit?.included).toBe(true);
    expect(second.runs[0].points[0][0]).toBeGreaterThan(first.runs[0].points[0][0]);
    // Marks unchanged between starts
    const markA = (runs: TrajectoryRun[]) => runs.find((r) => r.kind === "mark")!;
    expect(markA(first.runs).points).toEqual(markA(second.runs).points);
  });

  it("requireEntryTransit hard-fails without pose", () => {
    const painted = [
      markLine("a", [
        { north: 0, east: 0 },
        { north: 5, east: 0 },
      ]),
    ];
    const { entryTransit } = buildTrajectory(painted, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      originGps: [12.97, 77.59],
      roverPose: null,
      includeEntryTransit: true,
      requireEntryTransit: true,
    });
    expect(entryTransit?.error).toBeTruthy();
    expect(entryTransit?.included).toBe(false);
  });
});
