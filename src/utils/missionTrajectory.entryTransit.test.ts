import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { projectGpsToLocalMeters } from "./geoProjection";
import { trajectoryRunsToPayload as toPayload } from "../api/planTrajectory";
import {
  ENTRY_TRANSIT_LABEL,
  ENTRY_TRANSIT_MAX_M,
  ENTRY_TRANSIT_SKIP_M,
  applyEntryTransit,
  buildTrajectory,
  foldEntryTransitIntoRuns,
  resolveRoverNedInMissionFrame,
  type TrajectoryRun,
} from "./missionTrajectory";

const SPEEDS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

function markLine(
  id: string,
  points: Array<{ north: number; east: number }>,
  label?: string
): PlanLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    label: label ?? id,
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
      geometry: { closed: false, road_marking: true },
      preview_points: points,
    },
  };
}

function kinds(runs: TrajectoryRun[]): string[] {
  return runs.map((r) => r.kind);
}

describe("resolveRoverNedInMissionFrame", () => {
  const origin: [number, number] = [12.97, 77.59];

  it("projects lat/lon about origin_gps (mission frame), not raw EKF NED", () => {
    const lat = origin[0] + 0.0001; // ~11.1 m north on PX4 sphere
    const lon = origin[1];
    const expected = projectGpsToLocalMeters(lat, lon, origin[0], origin[1]);
    const resolved = resolveRoverNedInMissionFrame(
      {
        // Deliberately wrong EKF NED — must be ignored when origin is set
        pos_n: 999,
        pos_e: 999,
        lat,
        lon,
        gps_fix: 4,
        pose_age_ms: 100,
      },
      origin
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe("gps_origin");
    expect(resolved.north).toBeCloseTo(expected.north, 6);
    expect(resolved.east).toBeCloseTo(expected.east, 6);
    expect(resolved.north).not.toBeCloseTo(999, 0);
  });

  it("rejects GPS path when fix is below 3", () => {
    const resolved = resolveRoverNedInMissionFrame(
      { lat: origin[0], lon: origin[1], gps_fix: 2, pose_age_ms: 50 },
      origin
    );
    expect(resolved.ok).toBe(false);
  });

  it("uses local NED only when origin_gps is absent", () => {
    const resolved = resolveRoverNedInMissionFrame(
      { pos_n: 3, pos_e: 4, lat: 12, lon: 77, gps_fix: 4 },
      null
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe("local_ned");
    expect(resolved.north).toBe(3);
    expect(resolved.east).toBe(4);
  });

  it("soft-fails on stale pose age", () => {
    const resolved = resolveRoverNedInMissionFrame(
      { lat: origin[0], lon: origin[1], gps_fix: 4, pose_age_ms: 50_000 },
      origin
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/stale/i);
  });
});

describe("foldEntryTransitIntoRuns", () => {
  it("folds into leading pre-ext travel as one run", () => {
    const runs: TrajectoryRun[] = [
      {
        kind: "travel",
        points: [
          [-0.5, 0],
          [0, 0],
        ],
        speed_m_s: 0.5,
        label: "pre-ext",
      },
      {
        kind: "mark",
        points: [
          [0, 0],
          [10, 0],
        ],
        speed_m_s: 0.35,
      },
    ];
    const { runs: next, lengthM } = foldEntryTransitIntoRuns(runs, [5, 0], 0.5);
    expect(next).toHaveLength(2);
    expect(next[0].kind).toBe("travel");
    expect(next[0].label).toBe(ENTRY_TRANSIT_LABEL);
    expect(next[0].points[0]).toEqual([5, 0]);
    expect(next[0].points[next[0].points.length - 1]).toEqual([0, 0]);
    expect(lengthM).toBeCloseTo(5.5, 6);
    expect(next[1].kind).toBe("mark");
  });

  it("prepends travel when first run is mark", () => {
    const runs: TrajectoryRun[] = [
      {
        kind: "mark",
        points: [
          [0, 0],
          [10, 0],
        ],
        speed_m_s: 0.35,
      },
    ];
    const { runs: next } = foldEntryTransitIntoRuns(runs, [-3, 0], 0.5);
    expect(kinds(next)).toEqual(["travel", "mark"]);
    expect(next[0].label).toBe(ENTRY_TRANSIT_LABEL);
    expect(next[0].points).toEqual([
      [-3, 0],
      [0, 0],
    ]);
  });
});

describe("applyEntryTransit guards", () => {
  const markRuns: TrajectoryRun[] = [
    {
      kind: "mark",
      points: [
        [0, 0],
        [10, 0],
      ],
      speed_m_s: 0.35,
    },
  ];
  const origin: [number, number] = [12.97, 77.59];

  it("skips when already at tip", () => {
    // Rover GPS ≈ origin → NED ~ (0,0) = mark start
    const result = applyEntryTransit(markRuns, {
      roverPose: {
        lat: origin[0],
        lon: origin[1],
        gps_fix: 4,
        pose_age_ms: 100,
      },
      originGps: origin,
      travelSpeedMs: 0.5,
    });
    expect(result.entryTransit.included).toBe(false);
    expect(result.entryTransit.lengthM ?? 0).toBeLessThanOrEqual(ENTRY_TRANSIT_SKIP_M + 1e-9);
    expect(result.runs).toHaveLength(1);
  });

  it("hard-errors when entry exceeds max length", () => {
    // ~1 km north of origin
    const lat = origin[0] + 0.01;
    const result = applyEntryTransit(markRuns, {
      roverPose: { lat, lon: origin[1], gps_fix: 4, pose_age_ms: 100 },
      originGps: origin,
      travelSpeedMs: 0.5,
    });
    expect(result.entryTransit.included).toBe(false);
    expect(result.entryTransit.error).toBeTruthy();
    expect(result.entryTransit.lengthM ?? 0).toBeGreaterThan(ENTRY_TRANSIT_MAX_M);
    expect(result.runs).toHaveLength(1);
  });
});

describe("buildTrajectory + entry transit", () => {
  const origin: [number, number] = [12.97, 77.59];

  it("includes leading entry-transit when rover is offset in mission frame", () => {
    // ~5.5 m north of origin
    const lat = origin[0] + 5.5 / 6_371_000 / (Math.PI / 180);
    const a = markLine("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const { runs, entryTransit } = buildTrajectory([a], {
      ...SPEEDS,
      originGps: origin,
      roverPose: { lat, lon: origin[1], gps_fix: 4, pose_age_ms: 80 },
      includeEntryTransit: true,
    });
    expect(entryTransit?.included).toBe(true);
    expect(runs[0].kind).toBe("travel");
    expect(runs[0].label).toBe(ENTRY_TRANSIT_LABEL);
    expect(kinds(runs)).toEqual(["travel", "mark"]);
    // Touch first mark
    const entryEnd = runs[0].points[runs[0].points.length - 1];
    expect(entryEnd[0]).toBeCloseTo(0, 5);
    expect(entryEnd[1]).toBeCloseTo(0, 5);
  });

  it("folds entry into pre-ext when extensions are enabled", () => {
    const lat = origin[0] + 3 / 6_371_000 / (Math.PI / 180);
    const a = markLine("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const { runs, entryTransit } = buildTrajectory([a], {
      ...SPEEDS,
      extensions: { enabled: true, preM: 0.5, aftM: 0.5 },
      originGps: origin,
      roverPose: { lat, lon: origin[1], gps_fix: 4, pose_age_ms: 80 },
      includeEntryTransit: true,
    });
    expect(entryTransit?.included).toBe(true);
    // Single leading travel (entry folded into pre), then mark, then aft
    expect(runs[0].kind).toBe("travel");
    expect(runs[0].label).toBe(ENTRY_TRANSIT_LABEL);
    expect(runs.filter((r) => r.label === "pre-ext")).toHaveLength(0);
    expect(runs[1].kind).toBe("mark");
  });

  it("travel payload keeps must_hit_indices empty", () => {
    const lat = origin[0] + 2 / 6_371_000 / (Math.PI / 180);
    const a = markLine("a", [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
    ]);
    const { runs } = buildTrajectory([a], {
      ...SPEEDS,
      originGps: origin,
      roverPose: { lat, lon: origin[1], gps_fix: 5, pose_age_ms: 50 },
      includeEntryTransit: true,
    });
    const payload = toPayload(runs);
    const entry = payload.find((r) => r.label === ENTRY_TRANSIT_LABEL);
    expect(entry).toBeTruthy();
    expect(entry!.must_hit_indices).toEqual([]);
  });

  it("does not change runs when roverPose is omitted", () => {
    const a = markLine("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const { runs, entryTransit } = buildTrajectory([a], SPEEDS);
    expect(entryTransit).toBeUndefined();
    expect(kinds(runs)).toEqual(["mark"]);
  });
});
