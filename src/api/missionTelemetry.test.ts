import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLoadedPath, getMissionStatus, fetchLatestTelemetryPose } from "./missionApi";
import { clearProdTelemetry, setProdSocketConnected, ingestTelemetryPacket } from "../features/telemetry/prodTelemetryStore";
import { liveRover, missionData, pushRoverEvent } from "../test/roverEvents";
const mock = vi.hoisted(() => ({getTelemetry:vi.fn(), getMissionPath:vi.fn()}));
vi.mock("./prodClient", () => ({getProdApiClient:() => mock}));
const hash="a".repeat(64);
const packet=() => ({age_s:0, snapshot:{gateway:{schema:1, operator_alive:true, clients:1},
  vehicle_state:{age_s:0, fresh:true, data:{position_valid:true, north_m:1,east_m:2}},
  mission:null,
}} as any);
describe("mission telemetry production adapter", () => {
  beforeEach(() => {clearProdTelemetry(); setProdSocketConnected(true); liveRover({mission:{state:3,path_artifact_sha256:hash}}); mock.getTelemetry.mockReset().mockResolvedValue(packet()); mock.getMissionPath.mockReset().mockResolvedValue({sha256:hash, points:[[1,2,1],[3,4,0]]});});
  it("reads mission identity and geometry through production client", async () => {
    const status=await getMissionStatus("http://rover:8000");
    expect(status.state).toBe("running"); expect(status.loaded_mission_id).toBe(hash);
    const loaded=await (await getLoadedPath("http://rover:8000")).json();
    expect(mock.getMissionPath).toHaveBeenCalledWith(hash);
    expect(loaded).toMatchObject({mission_id:hash,num_waypoints:2,num_mark:1,num_transit:1,is_staged:true});
  });
  it("REST fallback cannot bypass the socket/operator/pose gate", async () => {
    setProdSocketConnected(false);
    expect(await fetchLatestTelemetryPose("http://rover:8000",null)).toBeNull();
    setProdSocketConnected(true);
    expect(await fetchLatestTelemetryPose("http://rover:8000",null)).toMatchObject({pos_n:1,pos_e:2});
  });
  it("does not attach old path geometry after mission identity changes", async () => {
    mock.getMissionPath.mockImplementation(async () => {
      pushRoverEvent("mission_state", missionData({state:3,path_artifact_sha256:"b".repeat(64)}));
      ingestTelemetryPacket(packet(),{source:"socket"}); return {sha256:hash,points:[[1,2,1]]};
    });
    await expect(getLoadedPath("http://rover:8000")).rejects.toThrow("Mission changed");
  });
});
