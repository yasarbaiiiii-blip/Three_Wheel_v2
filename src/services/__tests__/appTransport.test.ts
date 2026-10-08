import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppTransportService } from "../appTransport";

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: true,
  })),
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: {
    OS: "ios",
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

describe("AppTransportService", () => {
  let service: AppTransportService;

  beforeEach(() => {
    service = new AppTransportService();
  });

  it("initializes with disconnected status", () => {
    expect(service.getStatus()).toBe("disconnected");
  });

  it("subscribes to status updates", () => {
    const statuses: string[] = [];
    const unsub = service.subscribeStatus((s) => statuses.push(s));
    expect(statuses).toContain("disconnected");
    unsub();
  });

  it("disconnects and stops scheduler cleanly", () => {
    service.disconnect();
    expect(service.getStatus()).toBe("disconnected");
    expect(service.getHeartbeatMetrics().isRunning).toBe(false);
  });

  it("dispatches estop across both socket and rest endpoints", async () => {
    const socketMgr = service.getSocketManager();
    const emitSpy = vi.spyOn(socketMgr, "emitEstop").mockResolvedValue({ ok: true, delivered: true });
    const client = service.getClient();
    const clientSpy = vi.spyOn(client, "estop").mockResolvedValue({ ok: true, verdict: "estop_asserted" } as any);

    await service.estop(true);
    expect(emitSpy).toHaveBeenCalledWith(true, 400);
    expect(clientSpy).toHaveBeenCalledWith(true);

    await service.estop(false);
    expect(emitSpy).toHaveBeenCalledWith(false, 400);
    expect(clientSpy).toHaveBeenCalledWith(false);
  });
});
