import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProdSocketManager } from "../../../api/prodSocket";
import { clearProdTelemetry, getProdTelemetryState, evaluateMissionStartTelemetry } from "../prodTelemetryStore";

const mock = vi.hoisted(() => ({handlers: {} as Record<string, (...args: any[]) => void>, resume: null as null | ((state: string) => void)}));
vi.mock("react-native", () => ({AppState: {addEventListener: (_event: string, listener: (state: string) => void) => {mock.resume=listener; return {remove:vi.fn()};}}}));
vi.mock("socket.io-client", () => ({io: () => ({connected:true, on:(event: string, fn: (...args: any[]) => void) => {mock.handlers[event]=fn;}, disconnect:vi.fn(), removeAllListeners:vi.fn(), connect:vi.fn()})}));
const packet = () => ({age_s:0, snapshot:{gateway:{schema:1, operator_alive:true, clients:1}, vehicle_state:{age_s:0, fresh:true, data:{position_valid:true, north_m:1, east_m:2}}}});

describe("socket lifecycle trust", () => {
  let manager: ProdSocketManager;
  beforeEach(() => {vi.useFakeTimers(); clearProdTelemetry(); mock.handlers={}; manager=new ProdSocketManager();});
  afterEach(() => {manager.destroy(); vi.useRealTimers();});
  async function connect() { const pending=manager.connect("http://rover:8000", "test-token"); mock.handlers.connect(); await pending; }
  it("requires fresh telemetry after reconnect and resume, retaining real receive stamps", async () => {
    await connect(); expect(evaluateMissionStartTelemetry().ok).toBe(false);
    mock.handlers.telemetry(packet()); expect(evaluateMissionStartTelemetry().ok).toBe(true);
    const received=getProdTelemetryState().lastReceivedAt;
    mock.resume!("active"); expect(evaluateMissionStartTelemetry().ok).toBe(false);
    expect(getProdTelemetryState().lastReceivedAt).toBe(received);
    const stale=packet(); stale.snapshot.vehicle_state.fresh=false;
    mock.handlers.telemetry(stale); expect(evaluateMissionStartTelemetry().ok).toBe(false);
    mock.handlers.telemetry(packet()); expect(evaluateMissionStartTelemetry().ok).toBe(true);
    mock.handlers.disconnect("transport close"); await connect();
    expect(evaluateMissionStartTelemetry().ok).toBe(false);
  });
  it("gateway events do not masquerade as operator heartbeat changes", async () => {
    await connect(); mock.handlers.telemetry(packet()); mock.handlers.gateway({connected:false});
    expect(getProdTelemetryState().gatewayConnected).toBe(false);
    expect(getProdTelemetryState().operatorAlive).toBe(true);
    expect(evaluateMissionStartTelemetry().reasons).toContain("Gateway disconnected.");
  });
});
