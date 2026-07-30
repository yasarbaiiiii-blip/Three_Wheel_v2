import { describe, expect, it } from "vitest";

import type { PlanTrajectoryResponse } from "../api/planTrajectory";
import type { TrajectoryRun } from "./csvTrajectory";
import {
  filterComparableRunEcho,
  mergeStagedMustHitCheck,
  sentVertexSpotSamples,
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

describe("spot-check samples MARK runs only (extensions, 2026-07-30)", () => {
  // TRAVEL runs are now sent with must_hit_indices: [] so the rover thins them
  // — omitting the field made the engine protect every extension waypoint at
  // 0.125 m and truncated the approach lookahead to 0.096 m. The spot-check
  // must therefore stop asserting must_hit=true on travel endpoints, or every
  // extensions mission would be blocked at load.
  const preExt: TrajectoryRun = {
    kind: "travel",
    points: [
      [-0.5, 0],
      [0, 0],
    ],
    speed_m_s: 0.5,
  };
  const line: TrajectoryRun = {
    kind: "mark",
    points: [
      [0, 0],
      [3, 0],
    ],
    speed_m_s: 0.35,
  };
  const aftExt: TrajectoryRun = {
    kind: "travel",
    points: [
      [3, 0],
      [3.5, 0],
    ],
    speed_m_s: 0.5,
  };
  const runs = [preExt, line, aftExt];
  // Staged geometry: extension tips are NOT must-hit; the mark endpoints are.
  const waypoints = [
    [-0.5, 0],
    [0, 0],
    [3, 0],
    [3.5, 0],
  ];
  const mustHit = [false, true, true, false];

  it("does not sample extension tips", () => {
    const samples = sentVertexSpotSamples(runs);
    const keys = samples.map((p) => `${p[0]},${p[1]}`);
    expect(keys).toContain("0,0");
    expect(keys).toContain("3,0");
    expect(keys).not.toContain("-0.5,0");
    expect(keys).not.toContain("3.5,0");
  });

  it("an extensions mission passes instead of being blocked at load", () => {
    const { blocking } = verifyMustHitSpotCheck({ sentRuns: runs, waypoints, mustHit });
    expect(blocking).toHaveLength(0);
  });

  it("still catches a MARK vertex the rover failed to protect", () => {
    const broken = [false, false, true, false]; // mark start lost its flag
    const { blocking } = verifyMustHitSpotCheck({
      sentRuns: runs,
      waypoints,
      mustHit: broken,
    });
    expect(blocking.some((i) => i.code === "must_hit_false")).toBe(true);
  });
});

describe("coincident junction waypoints (field block 2026-07-30)", () => {
  // The engine emits the shared mark↔travel vertex ONCE PER RUN — its dedup
  // only collapses coincident points that agree on spray state. So a mark END
  // is followed immediately by a travel START at the identical coordinate,
  // and only the mark copy carries must_hit. Verified against the real
  // path_engine for a 0.5 m pre + 3.069 m mark + 0.5 m aft mission:
  //   mark START -> waypoints [(4,false),(5,true)]
  //   mark END   -> waypoints [(67,true),(68,false)]
  // The old `d <= bestD` tie-break took the LAST, so the mark END resolved to
  // the false copy: exactly 1 failure, blocking every extensions mission.
  const runs: TrajectoryRun[] = [
    { kind: "travel", points: [[-0.5, 0], [0, 0]], speed_m_s: 0.5 },
    { kind: "mark", points: [[0, 0], [3.069, 0]], speed_m_s: 0.35 },
    { kind: "travel", points: [[3.069, 0], [3.569, 0]], speed_m_s: 0.5 },
  ];
  //            0            1           2            3            4
  const waypoints = [[-0.5, 0], [0, 0], [0, 0], [3.069, 0], [3.069, 0], [3.569, 0]];
  //                  travel    travel   mark     mark        travel      travel
  const mustHit = [false, false, true, true, false, false];

  it("accepts the junction when the MARK copy carries the flag", () => {
    const { blocking } = verifyMustHitSpotCheck({ sentRuns: runs, waypoints, mustHit });
    expect(blocking).toHaveLength(0);
  });

  it("still fails when NO copy of the junction is must-hit", () => {
    const none = [false, false, false, false, false, false];
    const { blocking } = verifyMustHitSpotCheck({
      sentRuns: runs,
      waypoints,
      mustHit: none,
    });
    expect(blocking.some((i) => i.code === "must_hit_false")).toBe(true);
  });

  it("a genuinely distant sample is still reported unmatched, not silently passed", () => {
    const far: TrajectoryRun[] = [
      { kind: "mark", points: [[50, 50], [60, 50]], speed_m_s: 0.35 },
    ];
    const { blocking } = verifyMustHitSpotCheck({
      sentRuns: far,
      waypoints,
      mustHit: waypoints.map(() => true),
    });
    expect(blocking.some((i) => i.code === "must_hit_unmatched")).toBe(true);
  });
});
