import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanLine } from "../types/plan";
import { initProdApiClient } from "../api/prodClient";
import type { AppPlannedMissionRequest } from "../contract/prod/missionPlan";
import { computeExpectedAdmission } from "./appPlannedMissionBuilder";
import {
  buildAppPlannedStartSnapshot,
  clonePlanLinesForSnapshot,
  restageAppTrajectoryWithLiveEntry,
} from "./appPlannedStartSnapshot";
import {
  ENTRY_TRANSIT_LABEL,
  buildTrajectory,
  type TrajectoryRun,
} from "./missionTrajectory";
import { projectLocalMetersToGps } from "./geoProjection";

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
    const lat = projectLocalMetersToGps(4, 0, origin[0], origin[1]).lat;
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
    const latY = projectLocalMetersToGps(8, 0, origin[0], origin[1]).lat;
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

describe("restageAppTrajectoryWithLiveEntry", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uploads the snapshot plus the live entry leg through the v2 endpoint with the anchor", async () => {
    const origin: [number, number] = [12.97, 77.59];
    const lat = projectLocalMetersToGps(4, 0, origin[0], origin[1]).lat;
    let sent: AppPlannedMissionRequest | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/missions/plan")) {
        sent = JSON.parse(String(init?.body)) as AppPlannedMissionRequest;
        const e = computeExpectedAdmission(sent);
        return new Response(
          JSON.stringify({
            ok: true,
            mission: {
              sha256: "cd".repeat(32),
              engine_id: "app_v1",
              num_points: e.numPoints,
              num_spray_points: e.numSprayPoints,
              mark_length_m: e.markLengthM,
              transit_length_m: e.transitLengthM,
              bbox_ne_m: e.bboxNeM,
              source: { num_runs: e.numRuns },
            },
            normalisation: { densified_steps: 0, max_boundary_snap_m: 0 },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected request ${String(url)}`);
    });
    initProdApiClient("http://10.0.0.9:8000", "operator-token");
    const snapshot = buildAppPlannedStartSnapshot({
      paintedLines: [markLine("a", [{ north: 0, east: 0 }, { north: 10, east: 0 }])],
      originGps: origin,
      missionName: "m1",
    });
    const res = await restageAppTrajectoryWithLiveEntry({
      snapshot,
      roverPose: { lat, lon: origin[1], gps_fix: 4, pose_age_ms: 50 },
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.entryIncluded).toBe(true);
    expect(res.missionId).toBe("cd".repeat(32));
    expect(sent!.anchor).toEqual({ lat: origin[0], lon: origin[1] });
    expect(sent!.runs.map((r) => r.type)).toEqual(["travel", "mark"]);
    expect(sent!.runs[0].points[0][0]).toBeCloseTo(4, 3);
    expect(res.admitted.transitLengthM).toBeCloseTo(4, 3);
    expect(res.admitted.markLengthM).toBeCloseTo(10, 6);
  });

  it("fails clearly when the snapshot has no paths", async () => {
    const snapshot = buildAppPlannedStartSnapshot({ paintedLines: [], originGps: [1, 1], missionName: "m" });
    const res = await restageAppTrajectoryWithLiveEntry({ snapshot, roverPose: null });
    expect(res.success).toBe(false);
  });
});
