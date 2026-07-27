import { describe, expect, it } from "vitest";

import { buildPlanTrajectoryRequest } from "./planTrajectory";

const base = {
  missionName: "test",
  originGps: [13.0, 80.0] as [number, number],
  runs: [
    {
      kind: "mark" as const,
      points: [
        [0, 0],
        [1, 0],
      ] as [number, number][],
      speed_m_s: 0.35,
    },
  ],
};

describe("buildPlanTrajectoryRequest spray_mode (finding 5)", () => {
  it("defaults to continuous", () => {
    const body = buildPlanTrajectoryRequest(base);
    expect(body.spray_mode).toBe("continuous");
    expect(body.dash_on_distance_m).toBeNull();
    expect(body.dash_off_distance_m).toBeNull();
  });

  it("carries dash distances when sprayMode is dash", () => {
    const body = buildPlanTrajectoryRequest({
      ...base,
      sprayMode: "dash",
      dashOnDistanceM: 0.3,
      dashOffDistanceM: 0.7,
    });
    expect(body.spray_mode).toBe("dash");
    expect(body.dash_on_distance_m).toBe(0.3);
    expect(body.dash_off_distance_m).toBe(0.7);
  });

  it("accepts point mode", () => {
    const body = buildPlanTrajectoryRequest({
      ...base,
      sprayMode: "point",
      pointDwellS: 2,
    });
    expect(body.spray_mode).toBe("point");
    expect(body.point_dwell_s).toBe(2);
  });
});
