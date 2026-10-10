/**
 * Mission contract v2: the rover arms itself, switches to OFFBOARD, drives and disarms. The
 * operator never arms and never changes mode for a mission. This test pins that in behaviour;
 * noOperatorArm.source.test.mts pins it in the source.
 */
import { describe, expect, it, vi } from "vitest";
import type { StartMissionResponse } from "../../contract/prod/rest";
import { pauseMissionCommand, resumeMissionCommand, startMissionCommand, stopMissionCommand } from "./missionCommands";
import { beginStartTap } from "./startTap";

describe("mission commands never arm and never set OFFBOARD", () => {
  const ok = { ok: true, code: "ok", reason: "", delivered: true, data: {} };
  const accepted: StartMissionResponse = {
    ok: true,
    accepted: true,
    execution: { mission_id: 1, request_id: "r", duplicate: false, gate_reason_code: 0 },
    data: { accepted: true, reason_code: 0, mission_id: 1, duplicate: false, gate_reason_code: 0 },
  };

  it("start, pause, resume and stop touch only their own four client methods", async () => {
    const used: string[] = [];
    const target = {
      startMission: vi.fn(async () => accepted),
      pauseMission: vi.fn(async () => ok),
      resumeMission: vi.fn(async () => ok),
      abortMission: vi.fn(async () => ok),
    };
    // Any other method (arm, setOffboard, skipPoint, ...) would be a different command: fail loudly.
    const client = new Proxy(target, {
      get(t, prop: string) {
        if (!(prop in t)) throw new Error(`mission flow called client.${prop}`);
        used.push(prop);
        return (t as Record<string, unknown>)[prop];
      },
    });
    await startMissionCommand(beginStartTap("c".repeat(64)), client);
    await pauseMissionCommand(client);
    await resumeMissionCommand(client);
    await stopMissionCommand(client);
    expect(new Set(used)).toEqual(new Set(["startMission", "pauseMission", "resumeMission", "abortMission"]));
  });
});
