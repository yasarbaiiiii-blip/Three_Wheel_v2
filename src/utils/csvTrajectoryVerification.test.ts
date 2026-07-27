import { describe, expect, it } from "vitest";

import type { PlanTrajectoryResponse } from "../api/planTrajectory";
import type { TrajectoryRun } from "./csvTrajectory";
import {
  filterComparableRunEcho,
  mergeStagedMustHitCheck,
  verifyMustHitSpotCheck,
  verifyTrajectoryResponse,
} from "./csvTrajectoryVerification";

const sent: TrajectoryRun[] = [
  {
    kind: "mark",
    points: [
      [0, 0],
      [10, 0],
    ],
    speed_m_s: 0.35,
    label: "A",
  },
  {
    kind: "travel",
    points: [
      [10, 0],
      [10, 20],
    ],
    speed_m_s: 0.5,
  },
  {
    kind: "mark",
    points: [
      [10, 20],
      [20, 20],
    ],
    speed_m_s: 0.35,
    label: "B",
  },
];

function okResponse(overrides: Partial<PlanTrajectoryResponse> = {}): PlanTrajectoryResponse {
  return {
    mark_length_m: 20,
    transit_length_m: 20,
    run_echo: [
      { index: 0, kind: "mark", num_points: 201, length_m: 10, label: "A" },
      { index: 1, kind: "travel", num_points: 134, length_m: 20, label: null },
      { index: 2, kind: "mark", num_points: 201, length_m: 10, label: "B" },
      {
        index: 3,
        kind: "travel",
        num_points: 1,
        length_m: 0.1,
        label: "run-out",
        generated: true,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("filterComparableRunEcho", () => {
  it("drops generated:true terminal run-out", () => {
    const echo = filterComparableRunEcho(okResponse().run_echo);
    expect(echo).toHaveLength(3);
    expect(echo.every((e) => e.generated !== true)).toBe(true);
  });
});

describe("verifyTrajectoryResponse", () => {
  it("passes when kinds and lengths match within 1%", () => {
    const result = verifyTrajectoryResponse(sent, okResponse());
    expect(result.ok).toBe(true);
    expect(result.comparableEcho).toHaveLength(3);
  });

  it("fails on missing run_echo", () => {
    const result = verifyTrajectoryResponse(sent, { warnings: [] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "missing_run_echo")).toBe(true);
  });

  it("fails on kind mismatch", () => {
    const bad = okResponse();
    bad.run_echo![1] = { ...bad.run_echo![1], kind: "mark" };
    const result = verifyTrajectoryResponse(sent, bad);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "run_kind")).toBe(true);
  });

  it("fails on length beyond 1%", () => {
    const bad = okResponse();
    bad.run_echo![0] = { ...bad.run_echo![0], length_m: 12 }; // 20% off
    const result = verifyTrajectoryResponse(sent, bad);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "run_length")).toBe(true);
  });

  it("surfaces backend warnings without alone failing structure", () => {
    const result = verifyTrajectoryResponse(
      sent,
      okResponse({ warnings: ["dense path"] })
    );
    expect(result.ok).toBe(true);
    expect(result.backendWarnings).toContain("dense path");
    expect(result.issues.some((i) => i.code === "backend_warning")).toBe(true);
  });
});

describe("must_hit spot-check (Phase 4)", () => {
  const waypoints = [
    [0, 0],
    [5, 0],
    [10, 0],
    [10, 10],
    [10, 20],
    [15, 20],
    [20, 20],
  ];

  it("passes when endpoints have must_hit true", () => {
    const mustHit = waypoints.map(() => false);
    // Mark must_hit on samples: (0,0), (10,0), (10,20), (20,20)
    for (const [n, e] of [
      [0, 0],
      [10, 0],
      [10, 20],
      [20, 20],
    ]) {
      const i = waypoints.findIndex((w) => w[0] === n && w[1] === e);
      mustHit[i] = true;
    }
    const { blocking } = verifyMustHitSpotCheck({
      sentRuns: sent,
      waypoints,
      mustHit,
    });
    expect(blocking).toHaveLength(0);
  });

  it("blocks when a sample lands on must_hit=false", () => {
    const mustHit = waypoints.map(() => true);
    mustHit[0] = false; // (0,0)
    const { blocking } = verifyMustHitSpotCheck({
      sentRuns: sent,
      waypoints,
      mustHit,
    });
    expect(blocking.some((i) => i.code === "must_hit_false")).toBe(true);
  });

  it("missing must_hit is non-blocking issue", () => {
    const { issues, blocking } = verifyMustHitSpotCheck({
      sentRuns: sent,
      waypoints,
      mustHit: undefined,
    });
    expect(blocking).toHaveLength(0);
    expect(issues.some((i) => i.code === "must_hit_missing")).toBe(true);
  });

  it("mergeStagedMustHitCheck can fail a previously ok echo result", () => {
    const prior = verifyTrajectoryResponse(sent, okResponse());
    expect(prior.ok).toBe(true);
    const merged = mergeStagedMustHitCheck(prior, {
      sentRuns: sent,
      waypoints,
      mustHit: waypoints.map(() => false),
    });
    expect(merged.ok).toBe(false);
    expect(merged.issues.some((i) => i.code === "must_hit_false")).toBe(true);
  });
});
