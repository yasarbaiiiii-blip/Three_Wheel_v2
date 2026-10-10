import { beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../prodTelemetryStore";
const packet = (north = 1) => ({ connected: true, age_s: 0, snapshot: {
  gateway: {schema:1, operator_alive:true, clients:1},
  vehicle_state: {age_s:0, fresh:true, data:{position_valid:true, north_m:north, east_m:2}},
} } as any);
describe("production REST recovery", () => {
  beforeEach(() => {store.clearProdTelemetry(); store.setProdSocketConnected(true);});
  it("uses production endpoints and ingests their envelope", async () => {
    const {recoverProductionTelemetry} = await import("../telemetryRecovery");
    const client = {getTelemetry:vi.fn().mockResolvedValue(packet()), health:vi.fn().mockResolvedValue({backend:"ok"})};
    const result = await recoverProductionTelemetry(client as any);
    expect(client.getTelemetry).toHaveBeenCalledOnce(); expect(client.health).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(true); expect(store.getAdaptedTelemetrySnapshot()?.pos_n).toBe(1);
  });
  it("does not apply slow REST response after newer socket data", async () => {
    const {recoverProductionTelemetry} = await import("../telemetryRecovery");
    let resolve!: (value: any) => void;
    const client = {getTelemetry:vi.fn(() => new Promise(r => resolve = r)), health:vi.fn().mockResolvedValue({})};
    const pending = recoverProductionTelemetry(client as any);
    store.ingestTelemetryPacket(packet(5), {source:"socket"}); resolve(packet(1));
    expect((await pending).accepted).toBe(false); expect(store.getAdaptedTelemetrySnapshot()?.pos_n).toBe(5);
  });
});
