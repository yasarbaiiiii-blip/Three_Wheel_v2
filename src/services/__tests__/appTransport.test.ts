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
});
