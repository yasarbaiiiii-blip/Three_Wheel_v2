import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildAppPlannedMissionPayload,
  computeExpectedAdmission,
} from "./appPlannedMissionBuilder";
import { applyEntryTransit, buildTrajectory, ENTRY_TRANSIT_LABEL } from "./missionTrajectory";

// APP-16: field 2026-10-13 "1_Aug" stored flags `2 2 3 3 3` (Run_09) and `2 0 2 3 3 3 2` (Run_08).
// DYX3PATH encodes spray per INCOMING stretch (docs/contracts/path_artifact.md), so those flags
// are an unpainted entry stretch followed by a fully painted first mark leg. These tests lock
// that: the first mark leg is painted, the entry/staging stretches are not.

const ANCHOR: [number, number] = [13.07206119, 80.2619641];
// 1_Aug mark geometry from the Run_09 artifact (north, east).
const MARK_POINTS = [
  { north: 0.0, east: 0.0 },
  { north: 2.16615694711308, east: 0.04880401333203664 },
  { north: 2.167263357473051, east: -2.33608542223022 },
  { north: 0.14492685629573498, east: -2.5096109858587394 },
];

function line(): PlanLine {
  const first = MARK_POINTS[0];
  const last = MARK_POINTS[MARK_POINTS.length - 1];
  return {
    id: "1_Aug",
    label: "1_Aug",
    layer: "marking",
    from: { id: 1, x: first.north, y: first.east },
    to: { id: 2, x: last.north, y: last.east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: "1_Aug",
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: { closed: false, road_marking: true },
      preview_points: MARK_POINTS,
    },
  };
}

function storedFor(roverNed: [number, number]) {
  const base = buildTrajectory([line()], { markSpeedMs: 0.35, travelSpeedMs: 0.5 });
  const withEntry = applyEntryTransit(base.runs, {
    roverPose: { pos_n: roverNed[0], pos_e: roverNed[1], gps_fix: 4, pose_age_ms: 100 },
    originGps: null,
    travelSpeedMs: 0.5,
    requireEntryTransit: true,
  });
  expect(withEntry.entryTransit.included).toBe(true);
  const payload = buildAppPlannedMissionPayload({ runs: withEntry.runs, anchor: ANCHOR });
  return { runs: withEntry.runs, payload, stored: computeExpectedAdmission(payload).storedPoints };
}

describe("APP-16 first mark leg keeps spray", () => {
  const poses: Array<[string, [number, number]]> = [
    ["Run_09 pose beside the start", [-0.2116, -2.5353]],
    ["rover aligned behind the start", [-3, 0]],
    ["rover far off the line", [4, 6]],
  ];

  for (const [name, pose] of poses) {
    it(`every mark run point has spray and no entry point does (${name})`, () => {
      const { runs, payload } = storedFor(pose);
      expect(runs[0].kind).toBe("travel");
      expect(runs[0].label).toBe(ENTRY_TRANSIT_LABEL);
      expect(runs[1].kind).toBe("mark");
      for (const run of payload.runs) {
        for (const p of run.points) {
          expect((p[2] & 1) !== 0).toBe(run.type === "mark");
        }
      }
      expect(payload.runs[0].type).toBe("travel");
      expect(payload.runs[1].type).toBe("mark");
    });

    it(`stored incoming-stretch flags paint the whole first mark leg (${name})`, () => {
      const { stored } = storedFor(pose);
      const startIdx = stored.findIndex((p) => p[0] === 0 && p[1] === 0);
      expect(startIdx).toBeGreaterThan(0);
      // Entry stretches (ending at or before the mark start) are unpainted ...
      for (let i = 1; i <= startIdx; i++) expect(stored[i][2] & 1).toBe(0);
      // ... the start vertex is must-hit, and every stretch after it is painted.
      expect(stored[startIdx][2] & 2).toBe(2);
      for (let i = startIdx + 1; i < stored.length; i++) expect(stored[i][2] & 1).toBe(1);
      // First mark leg is [startIdx, startIdx+1]: its owner (incoming flag) is painted.
      expect(stored[startIdx + 1][2] & 1).toBe(1);
    });
  }

  it("staging point lies on the unpainted entry run, not the mark run", () => {
    const { runs } = storedFor([-0.2116, -2.5353]);
    expect(runs[0].points.length).toBe(3); // rover, staging, first tip
    expect(runs[1].points[0]).toEqual([0, 0]);
  });
});
