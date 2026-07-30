import { describe, expect, it } from "vitest";

import {
  collinearAwareMustHitIndices,
  MUST_HIT_COLLINEAR_TOL_DEG,
  trajectoryRunsToPayload,
} from "./planTrajectory";
import type { TrajectoryRun } from "../utils/missionTrajectory";

/**
 * Field 2026-07-29 — must-hit declarations cut both ways:
 *
 * - Under-declaring loses shape: 0 declared on a curve kept 17 % of the path
 *   and blew out to 5.84 cm RMS (rover drove ~50 cm chords).
 * - Over-declaring loses stability: the CSV fitter densifies straight lines at
 *   0.35 m, and declaring that collinear fill must-hit forced a rover segment
 *   vertex every 0.35 m. The RPP clips lookahead to the segment end, so
 *   lookahead collapsed to 0.12–0.21 m (design minimum 0.52 m) and identical
 *   staged missions scored anywhere from 1.39 to 8.14 cm RMS — the bad runs
 *   saturated the yaw-rate limit mid-line.
 *
 * The contract pinned here: declare endpoints and real turns, never collinear
 * interpolation.
 */

const cornerRun: TrajectoryRun = {
  kind: "mark",
  points: [
    [0, 0],
    [1, 0],
    [2, 0.5],
  ],
  speed_m_s: 0.35,
};

const travelRun: TrajectoryRun = {
  kind: "travel",
  points: [
    [2, 0.5],
    [5, 0.5],
  ],
  speed_m_s: 0.5,
};

/** The 2026-07-29 failure shape: a 2-point survey line densified to 8 points. */
const straightFilledRun: TrajectoryRun = {
  kind: "mark",
  points: Array.from({ length: 8 }, (_, i) => [i * 0.348, 0] as [number, number]),
  speed_m_s: 0.35,
};

describe("collinearAwareMustHitIndices", () => {
  it("collinear densification fill is NOT declared — only the endpoints", () => {
    expect(collinearAwareMustHitIndices(straightFilledRun.points)).toEqual([0, 7]);
  });

  it("a real corner is declared", () => {
    // 90-degree corner at index 2.
    const points: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
    ];
    expect(collinearAwareMustHitIndices(points)).toEqual([0, 2, 4]);
  });

  it("gentle curves accumulate turn from the last declared point", () => {
    // 0.6 deg per step — each step is below the tolerance, but the turn
    // accumulates, so interior points must still be declared (this is what
    // protects arcs from being chorded).
    const points: [number, number][] = [];
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
    expect(declared[declared.length - 1]).toBe(points.length - 1);
    expect(declared.length).toBeGreaterThan(4);
  });

  it("turns at exactly the tolerance are not declared; just above are", () => {
    const mk = (deg: number): [number, number][] => {
      const rad = (deg * Math.PI) / 180;
      return [
        [0, 0],
        [1, 0],
        [1 + Math.cos(rad), Math.sin(rad)],
      ];
    };
    expect(collinearAwareMustHitIndices(mk(MUST_HIT_COLLINEAR_TOL_DEG * 0.99))).toEqual([0, 2]);
    expect(collinearAwareMustHitIndices(mk(MUST_HIT_COLLINEAR_TOL_DEG * 1.5))).toEqual([0, 1, 2]);
  });

  it("coincident duplicate points do not crash and are not declared", () => {
    const points: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 0],
      [2, 0],
    ];
    expect(collinearAwareMustHitIndices(points)).toEqual([0, 3]);
  });

  it("two-point runs declare both endpoints", () => {
    expect(
      collinearAwareMustHitIndices([
        [0, 0],
        [2.437, 0],
      ])
    ).toEqual([0, 1]);
  });
});

describe("trajectoryRunsToPayload — must_hit provenance", () => {
  it("declares endpoints and corners of a MARK run", () => {
    const [payload] = trajectoryRunsToPayload([cornerRun]);
    expect(payload.must_hit_indices).toEqual([0, 1, 2]);
  });

  it("does NOT declare collinear fill on a straight MARK run (2026-07-29 instability)", () => {
    const [payload] = trajectoryRunsToPayload([straightFilledRun]);
    expect(payload.must_hit_indices).toEqual([0, 7]);
  });

  it("declares an EXPLICIT [] on a TRAVEL run — not undefined", () => {
    // Must be sent, not omitted: the rover engine reads an ABSENT declaration
    // as "protect every source vertex". Field 2026-07-30 — omitting it made
    // every extension waypoint must-hit at 0.125 m and truncated the approach
    // lookahead to 0.096 m (design minimum 0.52). `[]` only became meaningful
    // with rover-side b89a7de, which stopped treating it as falsy.
    const [payload] = trajectoryRunsToPayload([travelRun]);
    expect(payload.must_hit_indices).toEqual([]);
    expect(payload.must_hit_indices).not.toBeUndefined();
  });

  it("MARK run endpoints are always declared — the staged spot-check depends on it", () => {
    // verifyMustHitSpotCheck samples first/last of every sent MARK run and
    // requires must_hit=true on the staged waypoint they map to. Travel runs
    // are excluded there precisely because we now declare [] on them.
    for (const run of [cornerRun, straightFilledRun]) {
      const [payload] = trajectoryRunsToPayload([run]);
      expect(payload.must_hit_indices).toContain(0);
      expect(payload.must_hit_indices).toContain(payload.points.length - 1);
    }
  });

  it("indices always address the payload array, not the source run", () => {
    const [payload] = trajectoryRunsToPayload([cornerRun]);
    for (const i of payload.must_hit_indices ?? []) {
      expect(payload.points[i]).toBeDefined();
    }
  });

  it("mixed runs each get the right treatment", () => {
    const payloads = trajectoryRunsToPayload([cornerRun, travelRun, straightFilledRun]);
    expect(payloads.map((p) => p.must_hit_indices)).toEqual([
      [0, 1, 2],
      [],
      [0, 7],
    ]);
  });

  it("an extensions mission declares ONLY the mark vertices", () => {
    // The 2026-07-30 shape: 0.5 m pre-extension, 3 m painted line, 0.5 m aft.
    // Before this change the staged artifact came back must_hit=12 (every
    // extension point at 0.125 m); it should be 2.
    const pre: TrajectoryRun = {
      kind: "travel",
      points: [[-0.5, 0], [-0.375, 0], [-0.25, 0], [-0.125, 0], [0, 0]],
      speed_m_s: 0.5,
    };
    const mark: TrajectoryRun = { kind: "mark", points: [[0, 0], [3.069, 0]], speed_m_s: 0.35 };
    const aft: TrajectoryRun = {
      kind: "travel",
      points: [[3.069, 0], [3.194, 0], [3.319, 0], [3.444, 0], [3.569, 0]],
      speed_m_s: 0.5,
    };
    const payloads = trajectoryRunsToPayload([pre, mark, aft]);
    expect(payloads.map((p) => p.must_hit_indices)).toEqual([[], [0, 1], []]);
    const declared = payloads.reduce((n, p) => n + (p.must_hit_indices?.length ?? 0), 0);
    expect(declared).toBe(2);
  });

  it("does not disturb the existing payload fields", () => {
    const labelled: TrajectoryRun = { ...cornerRun, label: "L_1" };
    const [payload] = trajectoryRunsToPayload([labelled]);
    expect(payload.kind).toBe("mark");
    expect(payload.speed_m_s).toBe(0.35);
    expect(payload.label).toBe("L_1");
    expect(payload.points).toEqual([
      [0, 0],
      [1, 0],
      [2, 0.5],
    ]);
  });
});
