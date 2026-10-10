import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProdSocketManager } from "../../../api/prodSocket";
import { clearProdTelemetry, getProdTelemetryState, evaluateMissionStartTelemetry } from "../prodTelemetryStore";
import { resetRoverEvents } from "../roverEventStore";
import { estopData, fcuLinkData, missionData, operatorLinkData, resetRoverSeq, roverEvent } from "../../../test/roverEvents";

const mock = vi.hoisted(() => ({handlers: {} as Record<string, (...args: any[]) => void>, resume: null as null | ((state: string) => void)}));
vi.mock("react-native", () => ({AppState: {addEventListener: (_event: string, listener: (state: string) => void) => {mock.resume=listener; return {remove:vi.fn()};}}}));
vi.mock("socket.io-client", () => ({io: () => ({connected:true, on:(event: string, fn: (...args: any[]) => void) => {mock.handlers[event]=fn;}, disconnect:vi.fn(), removeAllListeners:vi.fn(), connect:vi.fn()})}));
const packet = () => ({age_s:0, snapshot:{gateway:{schema:1, operator_alive:true, clients:1}, vehicle_state:{age_s:0, fresh:true, data:{position_valid:true, north_m:1, east_m:2}}}});

describe("socket lifecycle trust", () => {
  let manager: ProdSocketManager;
  beforeEach(() => {vi.useFakeTimers(); clearProdTelemetry(); resetRoverEvents(); resetRoverSeq(); mock.handlers={}; manager=new ProdSocketManager();});
  afterEach(() => {manager.destroy(); vi.useRealTimers();});
  async function connect() { const pending=manager.connect("http://rover:8000", "test-token"); mock.handlers.connect(); await pending; }
  // What the backend sends right after a connection: the latest event of every kind, replay:true.
  const replay = (opts: {gateway?: boolean} = {}) => {
    mock.handlers.rover_event(roverEvent("gateway_link", {connected: opts.gateway ?? true}, {replay:true}));
    mock.handlers.rover_event(roverEvent("operator_link", operatorLinkData(true), {replay:true}));
    mock.handlers.rover_event(roverEvent("fcu_link", fcuLinkData(true), {replay:true}));
    mock.handlers.rover_event(roverEvent("estop", estopData(false), {replay:true}));
    mock.handlers.rover_event(roverEvent("mission_state", missionData(), {replay:true}));
  };
  it("requires fresh telemetry after reconnect and resume, retaining real receive stamps", async () => {
    await connect(); replay(); expect(evaluateMissionStartTelemetry().ok).toBe(false);
    mock.handlers.telemetry(packet()); expect(evaluateMissionStartTelemetry().ok).toBe(true);
    const received=getProdTelemetryState().lastReceivedAt;
    mock.resume!("active"); expect(evaluateMissionStartTelemetry().ok).toBe(false);
    expect(getProdTelemetryState().lastReceivedAt).toBe(received);
    const stale=packet(); stale.snapshot.vehicle_state.fresh=false;
    mock.handlers.telemetry(stale); expect(evaluateMissionStartTelemetry().ok).toBe(false);
    mock.handlers.telemetry(packet()); expect(evaluateMissionStartTelemetry().ok).toBe(true);
    mock.handlers.disconnect("transport close"); await connect(); replay();
    expect(evaluateMissionStartTelemetry().ok).toBe(false);
  });
  it("gateway_link down makes the operator link unknown, not alive", async () => {
    await connect(); replay(); mock.handlers.telemetry(packet());
    expect(getProdTelemetryState().operatorAlive).toBe(true);
    mock.handlers.rover_event(roverEvent("gateway_link", {connected:false}));
    expect(getProdTelemetryState().gatewayConnected).toBe(false);
    expect(getProdTelemetryState().operatorAlive).toBe(false);
    expect(evaluateMissionStartTelemetry().reasons).toContain("Gateway disconnected.");
  });
  it("a dropped socket forgets every kind", async () => {
    await connect(); replay(); mock.handlers.telemetry(packet());
    expect(getProdTelemetryState().gatewayConnected).toBe(true);
    mock.handlers.disconnect("transport close");
    expect(getProdTelemetryState().gatewayConnected).toBe(false);
    expect(getProdTelemetryState().operatorAlive).toBe(false);
  });
});
