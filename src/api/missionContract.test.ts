import { describe, expect, it } from "vitest";

import { buildMissionStartPayload } from "./missionContract";

const STAGED = "stg_1d5be788_1784974430";

describe("buildMissionStartPayload", () => {
  it("sends mission_id ALONE for a verified staged start", () => {
    // The backend now cross-checks mission_id against the mission the controller
    // actually holds, and refuses mission_id together with path_name (422):
    // path_name would re-load from disk at LOCAL_NED and discard the surveyed
    // GPS placement the staged mission carries. So this payload must stay clean.
    const payload = buildMissionStartPayload({
      stagedMissionId: STAGED,
      stagedVerified: true,
      fileName: "curve_6_points.csv",
      autoOrigin: true,
    });
    expect(payload).toEqual({ mission_id: STAGED, auto_origin: false });
    expect(payload.path_name).toBeUndefined();
    expect(payload.mission_file).toBeUndefined();
  });

  it("forces auto_origin off for a staged start", () => {
    // A GPS_SURVEYED mission is incompatible with auto_origin — the backend
    // returns 422 — so the caller's preference must not leak through.
    const payload = buildMissionStartPayload({
      stagedMissionId: STAGED,
      stagedVerified: true,
      fileName: "x.csv",
      autoOrigin: true,
    });
    expect(payload.auto_origin).toBe(false);
  });

  it("refuses to build a verified staged start without an id", () => {
    expect(() =>
      buildMissionStartPayload({
        stagedMissionId: null,
        stagedVerified: true,
        fileName: "x.csv",
        autoOrigin: false,
      })
    ).toThrow(/mission ID/i);
  });

  it("falls back to path_name for a non-staged start, with no mission_id", () => {
    const payload = buildMissionStartPayload({
      stagedMissionId: null,
      stagedVerified: false,
      fileName: "square_2x2.dxf",
      autoOrigin: true,
    });
    expect(payload.path_name).toBe("square_2x2.dxf");
    expect(payload.auto_origin).toBe(true);
    expect(payload.mission_id).toBeUndefined();
  });

  it("never emits both mission_id and path_name", () => {
    for (const stagedVerified of [true, false]) {
      const payload = buildMissionStartPayload({
        stagedMissionId: STAGED,
        stagedVerified,
        fileName: "x.csv",
        autoOrigin: false,
      });
      expect(payload.mission_id != null && payload.path_name != null).toBe(false);
    }
  });
});
