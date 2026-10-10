import { describe, it, expect } from "vitest";
import {
  APP_CLIENT_NAME,
  DENSIFY_STEP_M,
  MUST_HIT_PATH_ERROR_M,
  MissionPlanValidationError,
  applyDashPattern,
  buildAppPlannedMissionFromLines,
  buildAppPlannedMissionPayload,
  collinearAwareMustHitIndices,
  computeExpectedAdmission,
  normalizeMissionAnchor,
  validateAppPlannedMissionRequest,
} from "./appPlannedMissionBuilder";
import { describeMissionPlanFailure, formatMissionPlanError } from "./appPlannedMissionErrors";
import type { NedPair, TrajectoryRun } from "./missionTrajectory";
import type { PlanLine } from "../types/plan";
import type {
  AppPlannedMissionRequest,
  AppPlannedPointTuple,
} from "../contract/prod/missionPlan";

const ANCHOR: [number, number] = [13.0827, 80.2707];

const mark = (points: NedPair[], label?: string): TrajectoryRun => ({
  kind: "mark",
  points,
  speed_m_s: 0.35,
  ...(label ? { label } : {}),
});
const travel = (points: NedPair[]): TrajectoryRun => ({ kind: "travel", points, speed_m_s: 0.5 });

/**
 * Test-side model of the backend's admission (app_plan.compile_plan): the
 * 10 mm boundary snap and the lossless densify of any step above 5 m, plus the
 * R4 merge. If the app's payload needs neither, the reports are zero.
 */
function backendAdmit(payload: AppPlannedMissionRequest) {
  const flat: AppPlannedPointTuple[] = [];
  let densified = 0;
  let maxSnap = 0;
  let mark = 0;
  let transit = 0;
  let prevEnd: AppPlannedPointTuple | null = null;
  payload.runs.forEach((run) => {
    const spray = run.type === "mark" ? 1 : 0;
    const clean = run.points.map((p) => [...p] as AppPlannedPointTuple);
    if (prevEnd) {
      const gap = Math.hypot(clean[0][0] - prevEnd[0], clean[0][1] - prevEnd[1]);
      if (gap > 0.01) throw new Error(`runs_not_contiguous ${gap}`);
      maxSnap = Math.max(maxSnap, gap);
      clean[0] = [prevEnd[0], prevEnd[1], clean[0][2]];
    }
    for (let i = 1; i < clean.length; i++) {
      const d = Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]);
      if (run.type === "mark") mark += d;
      else transit += d;
    }
    const dense: AppPlannedPointTuple[] = [clean[0]];
    for (let i = 1; i < clean.length; i++) {
      const [n0, e0] = clean[i - 1];
      const len = Math.hypot(clean[i][0] - n0, clean[i][1] - e0);
      if (len > 5.0) {
        const parts = Math.ceil(len / 5.0);
        for (let j = 1; j < parts; j++) {
          dense.push([
            n0 + ((clean[i][0] - n0) * j) / parts,
            e0 + ((clean[i][1] - e0) * j) / parts,
            spray,
          ]);
        }
        densified++;
      }
      dense.push(clean[i]);
    }
    if (prevEnd) {
      const last = flat[flat.length - 1];
      last[2] |= dense[0][2] & 2;
      flat.push(...dense.slice(1));
    } else flat.push(...dense);
    prevEnd = clean[clean.length - 1];
  });
  return { flat, densified, maxSnap, mark, transit };
}

describe("buildAppPlannedMissionPayload (contract v2)", () => {
  it("builds frame local_ned with the anchor, no origin_ne_m, ordered runs", () => {
    const payload = buildAppPlannedMissionPayload({
      runs: [travel([[0, 0], [2, 0]]), mark([[2, 0], [4, 0]])],
      anchor: ANCHOR,
      missionName: "Test_Marking_Job",
    });
    expect(payload.frame).toBe("local_ned");
    expect(payload.client).toBe(APP_CLIENT_NAME);
    expect(payload.name).toBe("Test_Marking_Job");
    expect(payload.anchor).toEqual({ lat: ANCHOR[0], lon: ANCHOR[1] });
    expect("origin_ne_m" in payload).toBe(false);
    expect(payload.runs.map((r) => r.type)).toEqual(["travel", "mark"]);
    expect(payload.runs[0].points).toEqual([[0, 0, 2], [2, 0, 2]]);
    expect(payload.runs[1].points).toEqual([[2, 0, 3], [4, 0, 3]]);
  });

  it("carries the anchor altitude only when given", () => {
    expect(normalizeMissionAnchor({ lat: 1, lon: 2, alt: 30 })).toEqual({ lat: 1, lon: 2, alt: 30 });
    expect(normalizeMissionAnchor({ lat: 1, lon: 2 })).toEqual({ lat: 1, lon: 2 });
  });

  describe("anchor is mandatory (never send EKF-local)", () => {
    const runs = [mark([[0, 0], [2, 0]])];
    for (const bad of [null, undefined]) {
      it(`refuses ${String(bad)} anchor with ANCHOR_REQUIRED and an operator message`, () => {
        let caught: unknown;
        try {
          buildAppPlannedMissionPayload({ runs, anchor: bad });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(MissionPlanValidationError);
        expect((caught as MissionPlanValidationError).code).toBe("ANCHOR_REQUIRED");
        expect(describeMissionPlanFailure(caught)).toMatch(/no GPS origin/i);
      });
    }
    it.each([
      [[91, 0]],
      [[0, 181]],
      [[NaN, 0]],
      [[0, Infinity]],
    ])("refuses invalid anchor %j with INVALID_ANCHOR", (anchor) => {
      expect(() => buildAppPlannedMissionPayload({ runs, anchor: anchor as [number, number] })).toThrowError(
        expect.objectContaining({ code: "INVALID_ANCHOR" })
      );
    });
    it("refuses an out-of-range altitude", () => {
      expect(() =>
        buildAppPlannedMissionPayload({ runs, anchor: { lat: 1, lon: 1, alt: 99999 } })
      ).toThrowError(expect.objectContaining({ code: "INVALID_ANCHOR" }));
    });
  });

  describe("R1 mixed_spray_in_run", () => {
    it("every mark point has bit0 = 1 and every travel point bit0 = 0", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [travel([[0, 0], [1, 1], [2, 2]]), mark([[2, 2], [3, 3], [4, 4]])],
        anchor: ANCHOR,
      });
      for (const pt of payload.runs[0].points) expect(pt[2] & 1).toBe(0);
      for (const pt of payload.runs[1].points) expect(pt[2] & 1).toBe(1);
    });

    it("validation rejects a spray-off point in a mark run and a spray-on point in a travel run", () => {
      const base = { client: "t", client_version: "1", frame: "local_ned" as const, anchor: { lat: 1, lon: 1 } };
      expect(() =>
        validateAppPlannedMissionRequest({ ...base, runs: [{ type: "mark", points: [[0, 0, 1], [1, 1, 0]] }] })
      ).toThrowError(expect.objectContaining({ code: "mixed_spray_in_run" }));
      expect(() =>
        validateAppPlannedMissionRequest({ ...base, runs: [{ type: "travel", points: [[0, 0, 0], [1, 1, 1]] }] })
      ).toThrowError(expect.objectContaining({ code: "mixed_spray_in_run" }));
    });
  });

  describe("R2 adjacent_runs_same_type", () => {
    it("merges adjacent same-type runs when building", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [mark([[0, 0], [2, 0]]), mark([[2, 0], [4, 0]])],
        anchor: ANCHOR,
      });
      expect(payload.runs.length).toBe(1);
      expect(payload.runs[0].points[0]).toEqual([0, 0, 3]);
      expect(payload.runs[0].points.at(-1)).toEqual([4, 0, 3]);
    });

    it("validation rejects unmerged adjacent same-type runs", () => {
      expect(() =>
        validateAppPlannedMissionRequest({
          client: "t",
          client_version: "1",
          frame: "local_ned",
          anchor: { lat: 1, lon: 1 },
          runs: [
            { type: "mark", points: [[0, 0, 1], [1, 0, 1]] },
            { type: "mark", points: [[1, 0, 1], [2, 0, 1]] },
          ],
        })
      ).toThrowError(expect.objectContaining({ code: "adjacent_runs_same_type" }));
    });
  });

  describe("R3 contiguity and the 10 mm boundary rule", () => {
    it("bridges a real gap with an explicit travel run", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [mark([[0, 0], [2, 0]]), mark([[5, 5], [7, 5]])],
        anchor: ANCHOR,
      });
      expect(payload.runs.map((r) => r.type)).toEqual(["mark", "travel", "mark"]);
      expect(payload.runs[1].points[0].slice(0, 2)).toEqual([2, 0]);
      expect(payload.runs[1].points.at(-1)!.slice(0, 2)).toEqual([5, 5]);
    });

    it("snaps a gap of 9 mm onto the previous end exactly (no travel run, nothing left for the backend)", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [travel([[0, 0], [1.0, 2.0]]), mark([[1.009, 2.0], [3.0, 2.0]])],
        anchor: ANCHOR,
      });
      expect(payload.runs.length).toBe(2);
      expect(payload.runs[1].points[0].slice(0, 2)).toEqual([1.0, 2.0]);
      expect(backendAdmit(payload).maxSnap).toBe(0);
    });

    it("a gap over 10 mm is bridged by a travel run, not snapped", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [mark([[0, 0], [1.0, 0]]), mark([[1.011, 0], [3.0, 0]])],
        anchor: ANCHOR,
      });
      expect(payload.runs.map((r) => r.type)).toEqual(["mark", "travel", "mark"]);
    });

    it("validation rejects a gap between runs", () => {
      expect(() =>
        validateAppPlannedMissionRequest({
          client: "t",
          client_version: "1",
          frame: "local_ned",
          anchor: { lat: 1, lon: 1 },
          runs: [
            { type: "mark", points: [[0, 0, 1], [1, 0, 1]] },
            { type: "travel", points: [[1.005, 0, 0], [2, 0, 0]] },
          ],
        })
      ).toThrowError(expect.objectContaining({ code: "runs_not_contiguous" }));
    });
  });

  describe("R4 boundary must-hit", () => {
    it("both copies of the shared boundary point carry must-hit", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [travel([[0, 0], [2, 0]]), mark([[2, 0], [4, 0]])],
        anchor: ANCHOR,
      });
      expect(payload.runs[0].points.at(-1)![2] & 2).toBe(2);
      expect(payload.runs[1].points[0][2] & 2).toBe(2);
    });
  });

  describe("densify to 5 m so admission changes nothing", () => {
    it("splits steps over 5 m into equal collinear sub-steps without must-hit", () => {
      const payload = buildAppPlannedMissionPayload({ runs: [mark([[0, 0], [15, 0]])], anchor: ANCHOR });
      const pts = payload.runs[0].points;
      expect(pts.length).toBe(5);
      expect(pts[0]).toEqual([0, 0, 3]);
      expect(pts.at(-1)).toEqual([15, 0, 3]);
      for (const interior of pts.slice(1, -1)) {
        expect(interior[2]).toBe(1);
        expect(interior[1]).toBe(0);
      }
      for (let i = 1; i < pts.length; i++) {
        expect(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(DENSIFY_STEP_M);
      }
    });

    it("a 4.9 m step is left alone; 5 m and 10 m split so no sub-step can measure above 5.0", () => {
      expect(buildAppPlannedMissionPayload({ runs: [mark([[0, 0], [4.9, 0]])], anchor: ANCHOR }).runs[0].points.length).toBe(2);
      const five = buildAppPlannedMissionPayload({ runs: [mark([[0, 0], [5, 0]])], anchor: ANCHOR });
      expect(five.runs[0].points.length).toBe(3);
      expect(backendAdmit(five).densified).toBe(0);
      const ten = buildAppPlannedMissionPayload({ runs: [mark([[0, 0], [10, 0]])], anchor: ANCHOR });
      expect(ten.runs[0].points.length).toBeGreaterThan(3);
      expect(backendAdmit(ten).densified).toBe(0);
    });

    it("validation rejects a step the backend would re-densify", () => {
      expect(() =>
        validateAppPlannedMissionRequest({
          client: "t",
          client_version: "1",
          frame: "local_ned",
          anchor: { lat: 1, lon: 1 },
          runs: [{ type: "mark", points: [[0, 0, 3], [5.01, 0, 3]] }],
        })
      ).toThrowError(expect.objectContaining({ code: "STEP_NOT_DENSIFIED" }));
    });
  });

  describe("limits and non-silent failures", () => {
    it("EMPTY_MISSION for no runs", () => {
      expect(() => buildAppPlannedMissionPayload({ runs: [], anchor: ANCHOR })).toThrowError(
        expect.objectContaining({ code: "EMPTY_MISSION" })
      );
    });
    it("NON_FINITE_COORDINATE for NaN", () => {
      expect(() =>
        buildAppPlannedMissionPayload({ runs: [mark([[0, 0], [NaN, 1]])], anchor: ANCHOR })
      ).toThrowError(expect.objectContaining({ code: "NON_FINITE_COORDINATE" }));
    });
    it("OUT_OF_BOUNDS beyond 10,000 m", () => {
      expect(() =>
        buildAppPlannedMissionPayload({ runs: [mark([[0, 0], [10001, 0]])], anchor: ANCHOR })
      ).toThrowError(expect.objectContaining({ code: "OUT_OF_BOUNDS" }));
    });
    it("RUN_TOO_SHORT for a one-point run instead of dropping it", () => {
      expect(() =>
        buildAppPlannedMissionPayload({ runs: [mark([[0, 0]])], anchor: ANCHOR })
      ).toThrowError(expect.objectContaining({ code: "RUN_TOO_SHORT" }));
    });
    it("POINTS_LIMIT_EXCEEDED above 50,000 submitted points", () => {
      const pts: NedPair[] = Array.from({ length: 50_001 }, (_, i) => [i * 0.01, 0]);
      expect(() => buildAppPlannedMissionPayload({ runs: [mark(pts)], anchor: ANCHOR })).toThrowError(
        expect.objectContaining({ code: "POINTS_LIMIT_EXCEEDED" })
      );
    });
    it("truncates a name longer than the backend's 128 characters", () => {
      const payload = buildAppPlannedMissionPayload({
        runs: [mark([[0, 0], [1, 0]])],
        anchor: ANCHOR,
        missionName: "x".repeat(300),
      });
      expect(payload.name!.length).toBe(128);
    });
  });

  describe("payload is exactly what the backend stores (random plans, seeded)", () => {
    function lcg(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
    }

    it("R1-R4 hold and admission reports zero for 60 generated plans", () => {
      const rnd = lcg(12345);
      for (let iter = 0; iter < 60; iter++) {
        const numRuns = 2 + Math.floor(rnd() * 8);
        const runs: TrajectoryRun[] = [];
        let n = (rnd() - 0.5) * 500;
        let e = (rnd() - 0.5) * 500;
        for (let r = 0; r < numRuns; r++) {
          const kind = rnd() > 0.5 ? "mark" : "travel";
          const pts: NedPair[] = [];
          const gapRoll = rnd();
          if (gapRoll > 0.7) {
            n += (rnd() - 0.5) * 20;
            e += (rnd() - 0.5) * 20;
          } else if (gapRoll > 0.5) {
            n += (rnd() - 0.5) * 0.02; // sub-10 mm to 10 mm class gaps
          }
          pts.push([n, e]);
          const count = 2 + Math.floor(rnd() * 5);
          for (let p = 1; p < count; p++) {
            n += (rnd() - 0.5) * 30;
            e += (rnd() - 0.5) * 30;
            pts.push([n, e]);
          }
          runs.push({ kind, points: pts, speed_m_s: 0.4 });
        }
        const payload = buildAppPlannedMissionPayload({ runs, anchor: ANCHOR });

        for (const run of payload.runs) {
          const bit = run.type === "mark" ? 1 : 0;
          for (const pt of run.points) expect(pt[2] & 1).toBe(bit);
        }
        for (let i = 1; i < payload.runs.length; i++) {
          expect(payload.runs[i].type).not.toBe(payload.runs[i - 1].type);
          const prevEnd = payload.runs[i - 1].points.at(-1)!;
          expect(payload.runs[i].points[0][0]).toBe(prevEnd[0]);
          expect(payload.runs[i].points[0][1]).toBe(prevEnd[1]);
        }
        const admitted = backendAdmit(payload);
        expect(admitted.densified).toBe(0);
        expect(admitted.maxSnap).toBe(0);
        const expected = computeExpectedAdmission(payload);
        expect(admitted.flat).toEqual(expected.storedPoints);
        expect(expected.markLengthM).toBeCloseTo(admitted.mark, 9);
        expect(expected.transitLengthM).toBeCloseTo(admitted.transit, 9);
      }
    });
  });

  it("the original geometry is preserved: every input vertex is in the payload", () => {
    const poly: NedPair[] = [[0, 0], [3, 1], [7, -2], [8, 4]];
    const payload = buildAppPlannedMissionPayload({ runs: [mark(poly)], anchor: ANCHOR });
    for (const v of poly) {
      expect(payload.runs[0].points.some((p) => p[0] === v[0] && p[1] === v[1])).toBe(true);
    }
  });
});

describe("computeExpectedAdmission", () => {
  it("merges the shared boundary point once (R4) and measures lengths from the payload", () => {
    const payload = buildAppPlannedMissionPayload({
      runs: [travel([[0, 0], [1.5, 2]]), mark([[1.5, 2], [1.5, 6.5]])],
      anchor: ANCHOR,
    });
    const exp = computeExpectedAdmission(payload);
    expect(exp.numRuns).toBe(2);
    expect(exp.numPoints).toBe(3);
    expect(exp.numSprayPoints).toBe(1); // the boundary point keeps the travel run spray bit (off)
    expect(exp.transitLengthM).toBeCloseTo(2.5, 12);
    expect(exp.markLengthM).toBeCloseTo(4.5, 12);
    expect(exp.bboxNeM).toEqual([0, 0, 1.5, 6.5]);
    expect(exp.storedPoints[1]).toEqual([1.5, 2, 2]);
  });
});

describe("must-hit rules (Douglas-Peucker 15 mm, turns over 25 deg, endpoints, never collinear fill)", () => {
  const straightFilled: NedPair[] = Array.from({ length: 8 }, (_, i) => [i * 0.348, 0]);

  it("collinear densification fill is NOT declared, only the endpoints", () => {
    expect(collinearAwareMustHitIndices(straightFilled)).toEqual([0, 7]);
  });

  it("a real corner is declared", () => {
    expect(
      collinearAwareMustHitIndices([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]])
    ).toEqual([0, 2, 4]);
  });

  it("gentle curves keep a sparse must-hit set within the path-error budget", () => {
    const points: NedPair[] = [];
    let heading = 0;
    let n = 0;
    let e = 0;
    for (let i = 0; i < 20; i++) {
      points.push([n, e]);
      n += Math.cos(heading) * 0.35;
      e += Math.sin(heading) * 0.35;
      heading += (0.6 * Math.PI) / 180;
    }
    const declared = collinearAwareMustHitIndices(points);
    expect(declared[0]).toBe(0);
    expect(declared.at(-1)).toBe(points.length - 1);
    expect(declared.length).toBeGreaterThan(2);
    expect(declared.length).toBeLessThan(points.length);
    // Every skipped sample is within the budget of the retained polyline.
    for (let k = 0; k < declared.length - 1; k++) {
      const a = points[declared[k]];
      const b = points[declared[k + 1]];
      for (let i = declared[k] + 1; i < declared[k + 1]; i++) {
        const abN = b[0] - a[0];
        const abE = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((points[i][0] - a[0]) * abN + (points[i][1] - a[1]) * abE) / (abN * abN + abE * abE)));
        const d = Math.hypot(points[i][0] - (a[0] + abN * t), points[i][1] - (a[1] + abE * t));
        expect(d).toBeLessThanOrEqual(MUST_HIT_PATH_ERROR_M + 1e-6);
      }
    }
  });

  it("small heading changes under the budget are not declared", () => {
    for (const deg of [0.99, 1.5]) {
      const rad = (deg * Math.PI) / 180;
      expect(collinearAwareMustHitIndices([[0, 0], [1, 0], [1 + Math.cos(rad), Math.sin(rad)]])).toEqual([0, 2]);
    }
  });

  it("duplicate points do not crash; two-point runs declare both endpoints", () => {
    expect(collinearAwareMustHitIndices([[0, 0], [1, 0], [1, 0], [2, 0]])).toEqual([0, 3]);
    expect(collinearAwareMustHitIndices([[0, 0], [2.437, 0]])).toEqual([0, 1]);
  });

  it("does not overflow the stack on a 40,000-point spiral", () => {
    const pts: NedPair[] = Array.from({ length: 40_000 }, (_, i) => {
      const a = i * 0.01;
      return [Math.cos(a) * (1 + a * 0.01), Math.sin(a) * (1 + a * 0.01)];
    });
    expect(() => collinearAwareMustHitIndices(pts)).not.toThrow();
  });

  it("MARK payloads declare endpoints and corners; travel declares only its endpoints", () => {
    const payload = buildAppPlannedMissionPayload({
      runs: [
        travel([[-0.5, 0], [-0.375, 0], [-0.25, 0], [-0.125, 0], [0, 0]]),
        mark([[0, 0], [1, 0], [2, 0.5]]),
        travel([[2, 0.5], [2.1, 0.5], [2.2, 0.5], [2.3, 0.5]]),
      ],
      anchor: ANCHOR,
    });
    const flags = payload.runs.map((r) => r.points.map((p) => p[2] & 2));
    expect(flags[0]).toEqual([2, 0, 0, 0, 2]); // extension leg: ends only (2026-07-30 lookahead evidence)
    expect(flags[1]).toEqual([2, 2, 2]); // 55 degree... corner at index 1 plus both ends
    expect(flags[2]).toEqual([2, 0, 0, 2]);
  });

  it("a sharp corner is a plain must-hit vertex: no pivot leg, no extra runs, no fillet", () => {
    const square: NedPair[] = [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]];
    const payload = buildAppPlannedMissionPayload({ runs: [mark(square)], anchor: ANCHOR });
    expect(payload.runs.length).toBe(1);
    const verts = payload.runs[0].points.filter((p) => (p[2] & 2) !== 0).map((p) => [p[0], p[1]]);
    expect(verts).toEqual(square);
  });
});

describe("dashed lines are alternating mark/travel runs", () => {
  it("cuts a straight mark run into ON/OFF pieces at exact positions", () => {
    const runs = applyDashPattern([mark([[0, 0], [10, 0]])], { onM: 2, offM: 1 });
    expect(runs.map((r) => r.kind)).toEqual(["mark", "travel", "mark", "travel", "mark", "travel", "mark"]);
    expect(runs.map((r) => r.points[0][0])).toEqual([0, 2, 3, 5, 6, 8, 9]);
    expect(runs.at(-1)!.points.at(-1)).toEqual([10, 0]);
  });

  it("ends in an OFF piece when the run ends inside a gap, and starts each run with a dash", () => {
    const out = applyDashPattern([mark([[0, 0], [2.5, 0]]), mark([[10, 0], [11, 0]])], { onM: 2, offM: 1 });
    expect(out.map((r) => r.kind)).toEqual(["mark", "travel", "mark"]);
    expect(out[2].points[0]).toEqual([10, 0]);
  });

  it("keeps original corners inside the pieces", () => {
    const out = applyDashPattern([mark([[0, 0], [0, 3], [3, 3]])], { onM: 4, offM: 1 });
    expect(out[0].kind).toBe("mark");
    expect(out[0].points).toEqual([[0, 0], [0, 3], [1, 3]]);
    expect(out[1].kind).toBe("travel");
  });

  it("leaves travel runs alone and rejects bad patterns", () => {
    const t = travel([[0, 0], [5, 0]]);
    expect(applyDashPattern([t], { onM: 1, offM: 1 })).toEqual([t]);
    expect(() => applyDashPattern([t], { onM: 0, offM: 1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_DASH" })
    );
  });

  it("builds a payload of strictly alternating, contiguous runs with correct spray bits", () => {
    const payload = buildAppPlannedMissionPayload({
      runs: [travel([[-3, 0], [0, 0]]), mark([[0, 0], [10, 0]]), travel([[10, 0], [12, 0]])],
      anchor: ANCHOR,
      dash: { onM: 2, offM: 1 },
    });
    const types = payload.runs.map((r) => r.type);
    for (let i = 1; i < types.length; i++) expect(types[i]).not.toBe(types[i - 1]);
    // The trailing OFF piece merges with the following travel run.
    expect(types.at(-1)).toBe("travel");
    const admitted = backendAdmit(payload);
    expect(admitted.maxSnap).toBe(0);
    expect(admitted.mark).toBeCloseTo(2 + 2 + 2 + 1, 9); // dashes 0-2, 3-5, 6-8, 9-10
  });
});

describe("buildAppPlannedMissionFromLines", () => {
  const line = (id: string, n0: number, e0: number, n1: number, e1: number): PlanLine => ({
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: n0, y: e0 },
    to: { id: 2, x: n1, y: e1 },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: Math.hypot(n1 - n0, e1 - e0),
      geometry: {},
      preview_points: [
        { north: n0, east: e0 },
        { north: n1, east: e1 },
      ],
    },
  });

  it("builds from plan lines with the anchor and bridges the gap with travel", () => {
    const payload = buildAppPlannedMissionFromLines({
      lines: [line("a", 0, 0, 0, 10), line("b", 5, 10, 5, 0)],
      anchor: ANCHOR,
      missionName: "two_lines",
    });
    expect(payload.anchor.lat).toBe(ANCHOR[0]);
    expect(payload.runs.map((r) => r.type)).toEqual(["mark", "travel", "mark"]);
    validateAppPlannedMissionRequest(payload);
  });

  it("refuses without an anchor", () => {
    expect(() =>
      buildAppPlannedMissionFromLines({ lines: [line("a", 0, 0, 0, 10)], anchor: null })
    ).toThrowError(expect.objectContaining({ code: "ANCHOR_REQUIRED" }));
  });
});

describe("operator messages", () => {
  it("maps every v2 backend error code to a helpful description", () => {
    for (const code of [
      "INVALID_PAYLOAD",
      "INVALID_FRAME",
      "ANCHOR_REQUIRED",
      "INVALID_ANCHOR",
      "ORIGIN_WITH_ANCHOR",
      "INVALID_RUN_TYPE",
      "INVALID_FLAGS",
      "NON_FINITE_COORDINATE",
      "OUT_OF_BOUNDS",
      "EMPTY_MISSION",
      "RUN_TOO_SHORT",
      "POINTS_LIMIT_EXCEEDED",
      "mixed_spray_in_run",
      "adjacent_runs_same_type",
      "runs_not_contiguous",
    ]) {
      const text = formatMissionPlanError(code, "backend detail");
      expect(text.length).toBeGreaterThan("backend detail".length + 10);
      expect(text).toContain("backend detail");
    }
    expect(formatMissionPlanError("ANCHOR_REQUIRED")).toMatch(/no GPS origin/i);
    expect(formatMissionPlanError("OUT_OF_BOUNDS")).toMatch(/10 km/);
    expect(formatMissionPlanError("runs_not_contiguous")).toMatch(/10 mm/);
    expect(formatMissionPlanError("unknown_error_code", "some details")).toBe("some details");
  });
});
