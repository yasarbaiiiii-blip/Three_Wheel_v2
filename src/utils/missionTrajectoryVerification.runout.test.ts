import { describe, expect, it } from "vitest";

import type { TrajectoryRun } from "./missionTrajectory";
import {
  generatedRunLengthM,
  verifyTrajectoryResponse,
} from "./missionTrajectoryVerification";

/**
 * Regression: a PAINT-ONLY mission was blocked at "Verifying densified runs…"
 * with `transit_length_m 0.100 vs our 0.000 m`.
 *
 * The engine appends a ~0.10 m TRANSIT run-out past the final MARK point on any
 * open mission ending on MARK, and the backend counts it in `transit_length_m`
 * (server/routes/path.py:2531-2535) while echoing it as `generated: true`.
 * `filterComparableRunEcho` already dropped it from the per-run check; the
 * totals check did not — so the two checks measured different paths.
 *
 * It only ever bit paint-only loads: with the client's travel total at 0,
 * relDiff's max(|a|,|b|,eps) denominator turns 0.1 vs 0 into a 100 % error
 * against a 1 % tolerance. With real transit present it is ~0.5 % and passes.
 */

/** 4.70 m of paint along north, matching curve_6_points.csv's planned length. */
const PAINT_ONLY_RUN: TrajectoryRun = {
  kind: "mark",
  points: [
    [0, 0],
    [4.7, 0],
  ],
  speed_m_s: 0.35,
};

const RUN_OUT_LEN = 0.1;

type FakeResponse = {
  mark_length_m: number;
  transit_length_m: number;
  run_echo: Array<Record<string, unknown>>;
} & Record<string, unknown>;

function response(over: Record<string, unknown> = {}): FakeResponse {
  return {
    mark_length_m: 4.7,
    transit_length_m: RUN_OUT_LEN, // engine counts the generated run-out
    run_echo: [
      { kind: "mark", num_points: 95, length_m: 4.7 },
      {
        kind: "travel",
        num_points: 2,
        length_m: RUN_OUT_LEN,
        label: "run-out",
        generated: true,
      },
    ],
    ...over,
  };
}

describe("generatedRunLengthM", () => {
  it("sums only generated:true entries", () => {
    expect(generatedRunLengthM(response().run_echo as never)).toBeCloseTo(RUN_OUT_LEN, 6);
  });

  it("is 0 when nothing is generated, and tolerates junk", () => {
    expect(generatedRunLengthM([{ kind: "mark", num_points: 2, length_m: 9 }] as never)).toBe(0);
    expect(generatedRunLengthM(undefined)).toBe(0);
    expect(generatedRunLengthM(null)).toBe(0);
  });
});

describe("verifyTrajectoryResponse — terminal run-out", () => {
  it("does NOT block a paint-only mission over the generated run-out", () => {
    const res = verifyTrajectoryResponse([PAINT_ONLY_RUN], response() as never);
    expect(res.issues.map((i) => i.code)).not.toContain("travel_total");
    expect(res.ok).toBe(true);
  });

  it("still blocks a REAL transit mismatch — the check keeps its teeth", () => {
    // 2 m of genuine transit the client never sent, on top of the run-out.
    const res = verifyTrajectoryResponse(
      [PAINT_ONLY_RUN],
      response({ transit_length_m: 2 + RUN_OUT_LEN }) as never
    );
    expect(res.issues.map((i) => i.code)).toContain("travel_total");
    expect(res.ok).toBe(false);
  });

  it("names the subtraction in the failure message, so the number is traceable", () => {
    const res = verifyTrajectoryResponse(
      [PAINT_ONLY_RUN],
      response({ transit_length_m: 2 + RUN_OUT_LEN }) as never
    );
    const msg = res.issues.find((i) => i.code === "travel_total")?.message ?? "";
    expect(msg).toContain("2.000"); // comparable value, run-out removed
    expect(msg).toContain("generated run-out");
  });

  it("leaves missions WITH real transit unchanged (0.5 % was already passing)", () => {
    const withTravel: TrajectoryRun[] = [
      PAINT_ONLY_RUN,
      { kind: "travel", points: [[4.7, 0], [24.7, 0]], speed_m_s: 0.5 },
    ];
    const res = verifyTrajectoryResponse(
      withTravel,
      response({
        transit_length_m: 20 + RUN_OUT_LEN,
        run_echo: [
          { kind: "mark", num_points: 95, length_m: 4.7 },
          { kind: "travel", num_points: 41, length_m: 20 },
          {
            kind: "travel",
            num_points: 2,
            length_m: RUN_OUT_LEN,
            label: "run-out",
            generated: true,
          },
        ],
      }) as never
    );
    expect(res.issues.map((i) => i.code)).not.toContain("travel_total");
  });
});
