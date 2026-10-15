import { beforeEach, describe, expect, it, vi } from "vitest";

// APP-15 (socket half): one Socket.IO client per connect, one manager per app session.

const handlers: Record<string, (...a: unknown[]) => void> = {};
const created: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
const ioMock = vi.fn(() => {
  const sock = {
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      handlers[ev] = cb;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: true,
  };
  created.push(sock);
  return sock;
});
vi.mock("socket.io-client", () => ({ io: (...a: unknown[]) => (ioMock as any)(...a) }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: "ios" },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../../api/prodStorage", () => ({
  loadProdHost: vi.fn(async () => ""),
  loadProdTokenFor: vi.fn(async () => null),
  loadProdTokenForRover: vi.fn(async () => null),
  saveProdHost: vi.fn(async () => undefined),
  saveProdTokenFor: vi.fn(async () => undefined),
  saveProdTokenForRover: vi.fn(async () => undefined),
  saveLastRoverId: vi.fn(async () => undefined),
}));

import { AppTransportService } from "../appTransport";
import { getProdSocketManager } from "../../api/prodSocket";

async function socketReady() {
  await vi.waitFor(() => expect(handlers.connect).toBeDefined());
}

describe("single Socket.IO client", () => {
  beforeEach(() => {
    ioMock.mockClear();
    created.length = 0;
    for (const k of Object.keys(handlers)) delete handlers[k];
  });

  it("two concurrent connects to the same rover create exactly one socket", async () => {
    const t = new AppTransportService();
    const a = t.connect("http://127.0.0.1:1", "tok");
    delete handlers.connect;
    const b = t.connect("http://127.0.0.1:1", "tok");
    await socketReady();
    handlers.connect();
    await Promise.all([a, b]);
    expect(ioMock).toHaveBeenCalledTimes(1);
    t.disconnect();
  });

  it("a later connect (after the first settled) replaces the socket, never leaves two live", async () => {
    const t = new AppTransportService();
    const a = t.connect("http://127.0.0.1:1", "tok");
    await socketReady();
    handlers.connect();
    await a;
    delete handlers.connect;
    const b = t.connect("http://127.0.0.1:1", "tok");
    await socketReady();
    handlers.connect();
    await b;
    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(created[0].disconnect).toHaveBeenCalled();
    expect(created[1].disconnect).not.toHaveBeenCalled();
    t.disconnect();
  });

  it("the socket manager is a process singleton (screen changes cannot create another)", () => {
    expect(getProdSocketManager()).toBe(getProdSocketManager());
  });
});
