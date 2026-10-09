import { describe, it, expect } from "vitest";
import {
  buildAppPlannedMissionPayload,
  buildAppPlannedMissionFromLines,
  validateAppPlannedMissionRequest,
  MissionPlanValidationError,
  BOUNDARY_TOUCH_TOL_M,
} from "./appPlannedMissionBuilder";
import {
  formatMissionPlanError,
  MISSION_PLAN_ERROR_DESCRIPTIONS,
} from "./appPlannedMissionErrors";
import type { TrajectoryRun } from "./missionTrajectory";
import type { PlanLine } from "../types/plan";
import type { AppPlannedMissionRequest } from "../contract/prod/missionPlan";

describe("Production contract - AppPlannedMissionBuilder Ingest Rules R1-R5", () => {
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

    // R3 check: boundary points match exactly
    expect(payload.runs[0].points[1][0]).toBe(payload.runs[1].points[0][0]);
    expect(payload.runs[0].points[1][1]).toBe(payload.runs[1].points[0][1]);
  });

  // --------------------------------------------------------------------------
  // Rule R1: mixed_spray_in_run
  // --------------------------------------------------------------------------
  describe("R1 mixed_spray_in_run", () => {
    it("guarantees every point of mark has bit0 = 1 and travel has bit0 = 0", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "travel",
          points: [[0, 0], [1, 1], [2, 2]],
          speed_m_s: 0.5,
        },
        {
          kind: "mark",
          points: [[2, 2], [3, 3], [4, 4]],
          speed_m_s: 0.35,
        },
      ];

      const payload = buildAppPlannedMissionPayload({ runs });

      // All points in travel run must have bit0 == 0
      for (const pt of payload.runs[0].points) {
        expect(pt[2] & 1).toBe(0);
      }

      // All points in mark run must have bit0 == 1
      for (const pt of payload.runs[1].points) {
        expect(pt[2] & 1).toBe(1);
      }
    });

    it("rejects payload with mixed spray bit in mark run", () => {
      const invalidPayload: AppPlannedMissionRequest = {
        client: "test",
        client_version: "1.0",
        frame: "local_ned",
        runs: [
          {
            type: "mark",
            points: [
              [0, 0, 1],
              [1, 1, 0], // VIOLATION: spray off in mark run
            ],
          },
        ],
      };

      expect(() => validateAppPlannedMissionRequest(invalidPayload)).toThrowError(
        expect.objectContaining({ code: "mixed_spray_in_run" })
      );
    });

    it("rejects payload with mixed spray bit in travel run", () => {
      const invalidPayload: AppPlannedMissionRequest = {
        client: "test",
        client_version: "1.0",
        frame: "local_ned",
        runs: [
          {
            type: "travel",
            points: [
              [0, 0, 0],
              [1, 1, 1], // VIOLATION: spray on in travel run
            ],
          },
        ],
      };

      expect(() => validateAppPlannedMissionRequest(invalidPayload)).toThrowError(
        expect.objectContaining({ code: "mixed_spray_in_run" })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Rule R2: adjacent_runs_same_type
  // --------------------------------------------------------------------------
  describe("R2 adjacent_runs_same_type", () => {
    it("automatically merges adjacent same-type runs when building", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "mark",
          points: [[0, 0], [2, 0]],
          speed_m_s: 0.35,
        },
        {
          kind: "mark", // Adjacent mark run touching at [2, 0]
          points: [[2, 0], [4, 0]],
          speed_m_s: 0.35,
        },
      ];

      const payload = buildAppPlannedMissionPayload({ runs });
      expect(payload.runs.length).toBe(1);
      expect(payload.runs[0].type).toBe("mark");
      expect(payload.runs[0].points[0]).toEqual([0, 0, 3]);
      expect(payload.runs[0].points[payload.runs[0].points.length - 1]).toEqual([4, 0, 3]);
    });

    it("rejects unmerged adjacent same-type runs during validation", () => {
      const invalidPayload: AppPlannedMissionRequest = {
        client: "test",
        client_version: "1.0",
        frame: "local_ned",
        runs: [
          { type: "mark", points: [[0, 0, 1], [1, 0, 1]] },
          { type: "mark", points: [[1, 0, 1], [2, 0, 1]] }, // VIOLATION: adjacent mark
        ],
      };

      expect(() => validateAppPlannedMissionRequest(invalidPayload)).toThrowError(
        expect.objectContaining({ code: "adjacent_runs_same_type" })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Rule R3: runs_not_contiguous
  // --------------------------------------------------------------------------
  describe("R3 runs_not_contiguous", () => {
    it("automatically inserts connecting travel run when there is a spatial gap", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "mark",
          points: [[0, 0], [2, 0]],
          speed_m_s: 0.35,
        },
        // Gap: next run starts at [5, 5] instead of [2, 0]
        {
          kind: "mark",
          points: [[5, 5], [7, 5]],
          speed_m_s: 0.35,
        },
      ];

      const payload = buildAppPlannedMissionPayload({ runs });

      // Should have 3 runs: mark -> travel -> mark
      expect(payload.runs.length).toBe(3);
      expect(payload.runs[0].type).toBe("mark");
      expect(payload.runs[1].type).toBe("travel");
      expect(payload.runs[2].type).toBe("mark");

      // Verify gap is bridged contiguously
      expect(payload.runs[1].points[0][0]).toBe(payload.runs[0].points[payload.runs[0].points.length - 1][0]);
      expect(payload.runs[1].points[0][1]).toBe(payload.runs[0].points[payload.runs[0].points.length - 1][1]);
      expect(payload.runs[1].points[payload.runs[1].points.length - 1][0]).toBe(payload.runs[2].points[0][0]);
      expect(payload.runs[1].points[payload.runs[1].points.length - 1][1]).toBe(payload.runs[2].points[0][1]);
    });

    it("rejects non-contiguous runs during validation", () => {
      const invalidPayload: AppPlannedMissionRequest = {
        client: "test",
        client_version: "1.0",
        frame: "local_ned",
        runs: [
          { type: "mark", points: [[0, 0, 1], [1, 0, 1]] },
          { type: "travel", points: [[1.05, 0, 0], [2, 0, 0]] }, // Gap > 0.001m
        ],
      };

      expect(() => validateAppPlannedMissionRequest(invalidPayload)).toThrowError(
        expect.objectContaining({ code: "runs_not_contiguous" })
      );
    });

    it("snaps touching boundary points to 100% exact equality within 1mm", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "travel",
          points: [[0, 0], [1.0004, 2.0003]], // Within 1mm of [1.0, 2.0]
          speed_m_s: 0.5,
        },
        {
          kind: "mark",
          points: [[1.0, 2.0], [3.0, 2.0]],
          speed_m_s: 0.35,
        },
      ];

      const payload = buildAppPlannedMissionPayload({ runs });
      const run0End = payload.runs[0].points[payload.runs[0].points.length - 1];
      const run1Start = payload.runs[1].points[0];

      expect(run0End[0]).toBe(run1Start[0]);
      expect(run0End[1]).toBe(run1Start[1]);
    });
  });

  // --------------------------------------------------------------------------
  // Rule R4: Boundary point must-hit OR-ing
  // --------------------------------------------------------------------------
  describe("R4 Boundary points", () => {
    it("ORs must-hit bits across shared boundary points", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "travel",
          points: [[0, 0], [2, 0]],
          speed_m_s: 0.5,
        },
        {
          kind: "mark",
          points: [[2, 0], [4, 0]],
          speed_m_s: 0.35,
        },
      ];

      const payload = buildAppPlannedMissionPayload({ runs });
      const run0End = payload.runs[0].points[payload.runs[0].points.length - 1];
      const run1Start = payload.runs[1].points[0];

      // Must-hit bit (2) is set on both copies of boundary point
      expect((run0End[2] & 2)).toBe(2);
      expect((run1Start[2] & 2)).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Rule R5 & General Limits
  // --------------------------------------------------------------------------
  describe("R5 and general limits", () => {
    it("subdivides steps > 5.0m so all consecutive point steps are <= 5.0m", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "mark",
          points: [[0.0, 0.0], [15.0, 0.0]],
          speed_m_s: 0.35,
        },
      ];

      const payload = buildAppPlannedMissionPayload({ runs });
      const pts = payload.runs[0].points;

      expect(pts.length).toBe(4); // 0, 5, 10, 15
      for (let i = 1; i < pts.length; i++) {
        const dist = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        expect(dist).toBeLessThanOrEqual(5.0001);
      }
    });

    it("throws empty_mission for empty runs", () => {
      expect(() => buildAppPlannedMissionPayload({ runs: [] })).toThrowError(
        expect.objectContaining({ code: "empty_mission" })
      );
    });

    it("throws non_finite_coordinate for NaN coordinates", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "mark",
          points: [[0, 0], [NaN, 1]],
          speed_m_s: 0.35,
        },
      ];

      expect(() => buildAppPlannedMissionPayload({ runs })).toThrowError(
        expect.objectContaining({ code: "non_finite_coordinate" })
      );
    });

    it("throws out_of_bounds for coordinates exceeding 10,000m", () => {
      const runs: TrajectoryRun[] = [
        {
          kind: "mark",
          points: [[0, 0], [10001, 0]],
          speed_m_s: 0.35,
        },
      ];

      expect(() => buildAppPlannedMissionPayload({ runs })).toThrowError(
        expect.objectContaining({ code: "out_of_bounds" })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property-based Tests over Random Plans
  // --------------------------------------------------------------------------
  describe("Property tests over random plans", () => {
    it("guarantees R1-R3 hold for 50 arbitrarily generated plans", () => {
      for (let testIter = 0; testIter < 50; testIter++) {
        const numRuns = 2 + Math.floor(Math.random() * 8);
        const runs: TrajectoryRun[] = [];
        let currN = (Math.random() - 0.5) * 500;
        let currE = (Math.random() - 0.5) * 500;

        for (let r = 0; r < numRuns; r++) {
          const kind = Math.random() > 0.5 ? "mark" : "travel";
          const numPts = 2 + Math.floor(Math.random() * 5);
          const pts: [number, number][] = [];

          // Random chance of introducing a gap
          if (Math.random() > 0.6) {
            currN += (Math.random() - 0.5) * 20;
            currE += (Math.random() - 0.5) * 20;
          }

          pts.push([currN, currE]);
          for (let p = 1; p < numPts; p++) {
            currN += (Math.random() - 0.5) * 15;
            currE += (Math.random() - 0.5) * 15;
            pts.push([currN, currE]);
          }

          runs.push({
            kind,
            points: pts,
            speed_m_s: kind === "mark" ? 0.35 : 0.5,
          });
        }

        const payload = buildAppPlannedMissionPayload({ runs });

        // Verify R1: pure spray flags
        for (const run of payload.runs) {
          const expectedBit = run.type === "mark" ? 1 : 0;
          for (const pt of run.points) {
            expect(pt[2] & 1).toBe(expectedBit);
          }
        }

        // Verify R2: strictly alternating
        for (let i = 1; i < payload.runs.length; i++) {
          expect(payload.runs[i].type).not.toBe(payload.runs[i - 1].type);
        }

        // Verify R3: contiguous within BOUNDARY_TOUCH_TOL_M
        for (let i = 1; i < payload.runs.length; i++) {
          const prevEnd = payload.runs[i - 1].points[payload.runs[i - 1].points.length - 1];
          const currStart = payload.runs[i].points[0];
          expect(Math.abs(currStart[0] - prevEnd[0])).toBeLessThanOrEqual(BOUNDARY_TOUCH_TOL_M);
          expect(Math.abs(currStart[1] - prevEnd[1])).toBeLessThanOrEqual(BOUNDARY_TOUCH_TOL_M);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Error Mapping 422
  // --------------------------------------------------------------------------
  describe("422 Error Mapping", () => {
    it("maps all standard 422 error codes to helpful human descriptions", () => {
      expect(formatMissionPlanError("mixed_spray_in_run")).toContain("Mixed spray states");
      expect(formatMissionPlanError("adjacent_runs_same_type")).toContain("Adjacent runs have the same type");
      expect(formatMissionPlanError("runs_not_contiguous")).toContain("Gap between runs");
      expect(formatMissionPlanError("run_too_short")).toContain("fewer than 2 points");
      expect(formatMissionPlanError("step_too_large")).toContain("Step length exceeds limit");
      expect(formatMissionPlanError("unknown_error_code", "some details")).toBe("some details");
    });
  });
});
