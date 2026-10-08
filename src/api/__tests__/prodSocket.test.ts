import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProdSocketManager } from "../prodSocket";

// Mock socket.io-client
const mockSocket = {
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
  removeAllListeners: vi.fn(),
  connected: true,
  connect: vi.fn(),
};

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => mockSocket),
}));

// Mock react-native
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

describe("ProdSocketManager", () => {
  let manager: ProdSocketManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.connected = true;
    manager = new ProdSocketManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("initializes in disconnected state", () => {
    expect(manager.getStatus()).toBe("disconnected");
  });

  it("handles 401 connect_error by stopping reconnection and setting status to unauthorized", async () => {
    const statusHistory: string[] = [];
    manager.subscribeStatus((status) => statusHistory.push(status));

    const connectPromise = manager.connect("http://localhost:8000", "bad-token");

    // Find the connect_error handler
    const connectErrorCall = mockSocket.on.mock.calls.find((call) => call[0] === "connect_error");
    expect(connectErrorCall).toBeDefined();

    const errorHandler = connectErrorCall![1];
    errorHandler(new Error("401 Unauthorized handshake failed"));

    await expect(connectPromise).rejects.toThrow("401 Unauthorized");
    expect(manager.getStatus()).toBe("unauthorized");
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it("sets disconnected immediately on disconnect event", async () => {
    const connectPromise = manager.connect("http://localhost:8000", "good-token");

    const connectCall = mockSocket.on.mock.calls.find((call) => call[0] === "connect");
    expect(connectCall).toBeDefined();
    connectCall![1](); // trigger connect
    await connectPromise;

    expect(manager.getStatus()).toBe("connected");

    const disconnectCall = mockSocket.on.mock.calls.find((call) => call[0] === "disconnect");
    expect(disconnectCall).toBeDefined();
    disconnectCall![1]("io server disconnect");

    expect(manager.getStatus()).toBe("disconnected");
  });

  it("emits heartbeat and resolves on ack", async () => {
    // Simulate connected socket
    mockSocket.emit.mockImplementation((event, data, cb) => {
      if (event === "heartbeat" && typeof cb === "function") {
        cb({ ok: true });
      }
    });

    const connectPromise = manager.connect("http://localhost:8000", "good-token");
    const connectCall = mockSocket.on.mock.calls.find((call) => call[0] === "connect");
    connectCall![1]();
    await connectPromise;

    const ack = await manager.emitHeartbeat(350);
    expect(ack.ok).toBe(true);
    expect(mockSocket.emit).toHaveBeenCalledWith("heartbeat", {}, expect.any(Function));
  });

  it("rejects heartbeat on ack timeout", async () => {
    // Simulate non-responding socket
    mockSocket.emit.mockImplementation(() => {});

    const connectPromise = manager.connect("http://localhost:8000", "good-token");
    const connectCall = mockSocket.on.mock.calls.find((call) => call[0] === "connect");
    connectCall![1]();
    await connectPromise;

    await expect(manager.emitHeartbeat(50)).rejects.toThrow("Heartbeat ack timeout");
  });
});
