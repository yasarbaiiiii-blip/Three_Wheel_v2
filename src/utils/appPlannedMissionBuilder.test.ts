import { describe, it, expect } from "vitest";
import {
  buildAppPlannedMissionPayload,
  buildAppPlannedMissionFromLines,
  MissionPlanValidationError,
} from "./appPlannedMissionBuilder";
import type { TrajectoryRun } from "./missionTrajectory";
import type { PlanLine } from "../types/plan";

describe("Production contract - AppPlannedMissionBuilder", () => {
  it("builds a canonical payload with frame local_ned and ordered runs", () => {
    const runs: TrajectoryRun[] = [
      {
        kind: "travel",
        points: [
          [0.0, 0.0],
          [2.0, 0.0],
        ],
        speed_m_s: 0.5,
      },
      {
        kind: "mark",
        points: [
          [2.0, 0.0],
          [10.0, 0.0],
        ],
        speed_m_s: 0.35,
      },
    ];

    const payload = buildAppPlannedMissionPayload({
      runs,
      missionName: "Test_Marking_Job",
    });

    expect(payload.frame).toBe("local_ned");
    expect(payload.client).toBe("Three_Wheel_v2");
    expect(payload.name).toBe("Test_Marking_Job");
    expect(payload.runs.length).toBe(2);

    // Run 0: Travel run
    expect(payload.runs[0].type).toBe("travel");
    // Endpoints in travel run have spray OFF (bit 0 = 0) and must-hit ON (bit 1 = 1) -> flags = 2
    expect(payload.runs[0].points[0]).toEqual([0.0, 0.0, 2]);
    expect(payload.runs[0].points[1]).toEqual([2.0, 0.0, 2]);

    // Run 1: Mark run
    expect(payload.runs[1].type).toBe("mark");
    // Endpoints in mark run have spray ON (bit 0 = 1) and must-hit ON (bit 1 = 1) -> flags = 3
    // Distance from 2.0 to 10.0 is 8.0 m > 5.0 m, so it should be subdivided with 1 intermediate point at 6.0 m
    // Intermediate point has spray ON (1) but must-hit OFF (0) -> flags = 1
    expect(payload.runs[1].points.length).toBe(3);
    expect(payload.runs[1].points[0]).toEqual([2.0, 0.0, 3]);
    expect(payload.runs[1].points[1]).toEqual([6.0, 0.0, 1]);
    expect(payload.runs[1].points[2]).toEqual([10.0, 0.0, 3]);
  });

  it("subdivides steps > 5.0m so consecutive point step is <= 5.0m", () => {
    const runs: TrajectoryRun[] = [
      {
        kind: "mark",
        points: [
          [0.0, 0.0],
          [15.0, 0.0], // 15m step -> 3 segments of 5m each
        ],
        speed_m_s: 0.35,
      },
    ];

    const payload = buildAppPlannedMissionPayload({ runs });
    const pts = payload.runs[0].points;

    expect(pts.length).toBe(4); // 0, 5, 10, 15
    expect(pts[0]).toEqual([0.0, 0.0, 3]); // start must-hit + spray
    expect(pts[1]).toEqual([5.0, 0.0, 1]); // intermediate spray only
    expect(pts[2]).toEqual([10.0, 0.0, 1]); // intermediate spray only
    expect(pts[3]).toEqual([15.0, 0.0, 3]); // end must-hit + spray

    // Verify all consecutive steps are <= 5.0m
    for (let i = 1; i < pts.length; i++) {
      const dn = pts[i][0] - pts[i - 1][0];
      const de = pts[i][1] - pts[i - 1][1];
      expect(Math.hypot(dn, de)).toBeLessThanOrEqual(5.0001);
    }
  });

  it("throws validation error for empty mission", () => {
    expect(() => buildAppPlannedMissionPayload({ runs: [] })).toThrowError(
      MissionPlanValidationError
    );
  });

  it("throws validation error for non-finite coordinates", () => {
    const runs: TrajectoryRun[] = [
      {
        kind: "mark",
        points: [
          [0.0, 0.0],
          [NaN, 5.0],
        ],
        speed_m_s: 0.35,
      },
    ];
    expect(() => buildAppPlannedMissionPayload({ runs })).toThrowError(/NON_FINITE_COORDINATE/);
  });

  it("throws validation error for out-of-bounds coordinates", () => {
    const runs: TrajectoryRun[] = [
      {
        kind: "travel",
        points: [
          [0.0, 0.0],
          [15000.0, 0.0],
        ],
        speed_m_s: 0.5,
      },
    ];
    expect(() => buildAppPlannedMissionPayload({ runs })).toThrowError(/OUT_OF_BOUNDS/);
  });

  it("builds mission from PlanLine geometry preserving order and spray", () => {
    const lines: PlanLine[] = [
      {
        id: "line_1",
        label: "Line 1",
        from: { x: 0, y: 0 },
        to: { x: 10, y: 0 },
        width: 0.15,
        is_mark: true,
        sprayEnabled: true,
      },
      {
        id: "line_2",
        label: "Line 2",
        from: { x: 10, y: 5 },
        to: { x: 20, y: 5 },
        width: 0.15,
        is_mark: true,
        sprayEnabled: true,
      },
    ];

    const payload = buildAppPlannedMissionFromLines({ lines });
    expect(payload.frame).toBe("local_ned");
    expect(payload.runs.length).toBeGreaterThanOrEqual(2);

    // Verify mark runs have spray intent bit
    const markRuns = payload.runs.filter((r) => r.type === "mark");
    expect(markRuns.length).toBe(2);
    for (const mr of markRuns) {
      for (const pt of mr.points) {
        expect(pt[2] & 1).toBe(1); // bit 0 = 1
      }
    }
  });
});
