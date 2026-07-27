import { describe, expect, it } from "vitest";

import {
  buildMissionStartPayload,
  csvMissionStartBlockMessage,
} from "./missionContract";

describe("Phase 5 CSV start guard", () => {
  it("blocks path_name fallback when requireStagedMission and not verified", () => {
    expect(() =>
      buildMissionStartPayload({
        stagedMissionId: null,
        stagedVerified: false,
        fileName: "roads.csv",
        autoOrigin: false,
        requireStagedMission: true,
      })
    ).toThrow(/not staged-verified|filename start/i);
  });

  it("allows mission_id start when staged verified", () => {
    expect(
      buildMissionStartPayload({
        stagedMissionId: "stg_csv_1",
        stagedVerified: true,
        fileName: "roads.csv",
        autoOrigin: true,
        requireStagedMission: true,
      })
    ).toEqual({ mission_id: "stg_csv_1", auto_origin: false });
  });

  it("csvMissionStartBlockMessage only for unverified CSV", () => {
    expect(
      csvMissionStartBlockMessage({ isCsvMission: true, stagedVerified: false })
    ).toMatch(/not staged/i);
    expect(
      csvMissionStartBlockMessage({ isCsvMission: true, stagedVerified: true })
    ).toBeNull();
    expect(
      csvMissionStartBlockMessage({ isCsvMission: false, stagedVerified: false })
    ).toBeNull();
  });
});
