import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProdSocketManager } from "../prodSocket";
import { getRoverEventsState, resetRoverEvents, selectGatewayLink, selectKind } from "../../features/telemetry/roverEventStore";
import { missionData, resetRoverSeq, roverEvent } from "../../test/roverEvents";

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

describe("ProdSocketManager rover_event channel", () => {
  let manager: ProdSocketManager;
  const handler = (event: string) => {
    // the most recent registration: each connect() registers a fresh set of handlers
    const calls = mockSocket.on.mock.calls.filter((c) => c[0] === event);
    const call = calls[calls.length - 1];
    return call ? (call[1] as (...args: unknown[]) => void) : undefined;
  };
  const connect = async () => {
    const pending = manager.connect("http://localhost:8000", "good-token");
    handler("connect")!();
    await pending;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.connected = true;
    resetRoverEvents();
    resetRoverSeq();
    manager = new ProdSocketManager();
  });
  afterEach(() => manager.destroy());

  it("listens to telemetry and rover_event only: the superseded gateway / mission_event listeners are gone", async () => {
    await connect();
    const subscribed = mockSocket.on.mock.calls.map((c) => c[0]);
    expect(subscribed).toContain("rover_event");
    expect(subscribed).toContain("telemetry");
    expect(subscribed).not.toContain("gateway");
    expect(subscribed).not.toContain("mission_event");
  });

  it("feeds rover_event into the store: replay first, then a live push, highest seq wins", async () => {
    await connect();
    const onEvent = handler("rover_event")!;
    onEvent(roverEvent("gateway_link", { connected: true }, { replay: true }));
    onEvent(roverEvent("mission_state", missionData({ state: 1 }), { replay: true, seq: 10 }));
    onEvent(roverEvent("mission_state", missionData({ state: 3 }), { seq: 12 }));
    onEvent(roverEvent("mission_state", missionData({ state: 1 }), { replay: true, seq: 10 })); // duplicate
    const v = selectKind("mission_state");
    expect(v.known && v.data.state).toBe(3);
    expect(v.known && v.event.seq).toBe(12);
  });

  it("a malformed rover_event is ignored with a warning, not thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await connect();
    expect(() => handler("rover_event")!({ kind: "nope", seq: 1, data: {} })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(getRoverEventsState().kinds).toEqual({});
    warn.mockRestore();
  });

  it("a disconnect makes the whole rover state unknown at once", async () => {
    await connect();
    handler("rover_event")!(roverEvent("gateway_link", { connected: true }, { replay: true }));
    handler("rover_event")!(roverEvent("mission_state", missionData({ state: 3 })));
    expect(selectKind("mission_state").known).toBe(true);
    handler("disconnect")!("transport close");
    expect(selectGatewayLink()).toEqual({ known: false, reason: "no_socket" });
    expect(selectKind("mission_state")).toEqual({ known: false, reason: "no_socket" });
  });

  it("a new connection forgets the old seq space so a restarted backend is heard", async () => {
    await connect();
    handler("rover_event")!(roverEvent("gateway_link", { connected: true }, { seq: 800 }));
    handler("disconnect")!("transport close");
    await connect();
    handler("rover_event")!(roverEvent("gateway_link", { connected: true }, { seq: 1, replay: true }));
    expect(selectGatewayLink()).toMatchObject({ known: true, connected: true });
  });
});
