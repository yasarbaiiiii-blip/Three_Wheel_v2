import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const g = globalThis as unknown as { localStorage?: MemoryStorage };

async function freshStorage() {
  vi.resetModules();
  g.localStorage = new MemoryStorage();
  return import("./prodStorage");
}

describe("per-rover token storage", () => {
  beforeEach(() => {
    delete g.localStorage;
  });

  it("remembers a token per rover address until it is forgotten", async () => {
    const s = await freshStorage();
    await s.saveProdTokenFor("http://192.168.3.100:8000", "rover-one-token");
    await s.saveProdTokenFor("http://192.168.3.101:8000", "rover-two-token");

    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBe("rover-one-token");
    expect(await s.loadProdTokenFor("http://192.168.3.101:8000")).toBe("rover-two-token");
    // Same rover written differently (trailing slash, case) is the same key.
    expect(await s.loadProdTokenFor("HTTP://192.168.3.100:8000/")).toBe("rover-one-token");

    await s.saveProdTokenFor("http://192.168.3.100:8000", null);
    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBeNull();
    expect(await s.loadProdTokenFor("http://192.168.3.101:8000")).toBe("rover-two-token");
  });

  it("returns null for a rover with no saved token", async () => {
    const s = await freshStorage();
    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBeNull();
  });

  it("migrates the older single saved token to the rover it belonged to", async () => {
    const s = await freshStorage();
    await s.saveProdHost("http://192.168.3.100:8000");
    await s.saveProdToken("legacy-token");

    expect(await s.loadProdTokenFor("http://192.168.3.101:8000")).toBeNull();
    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBe("legacy-token");
    // Moved into the per-rover map and removed from the old key.
    expect(await s.loadProdToken()).toBeNull();
    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBe("legacy-token");
  });

  it("ignores a corrupt token map instead of crashing", async () => {
    const s = await freshStorage();
    g.localStorage!.setItem("rover.prod.bearerTokens.v1", "{not json");
    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBeNull();
    await s.saveProdTokenFor("http://192.168.3.100:8000", "fresh");
    expect(await s.loadProdTokenFor("http://192.168.3.100:8000")).toBe("fresh");
  });

  it("keys a token by rover id so one token works on every network", async () => {
    const s = await freshStorage();
    await s.saveProdTokenForRover("dyx3-0a1b2c3d4e", "rover-token");
    expect(await s.loadProdTokenForRover("dyx3-0a1b2c3d4e", "http://192.168.3.150:8000")).toBe("rover-token");
    expect(await s.loadProdTokenForRover("dyx3-0a1b2c3d4e", "http://192.168.2.100:8000")).toBe("rover-token");
    await s.saveProdTokenForRover("dyx3-0a1b2c3d4e", null);
    expect(await s.loadProdTokenForRover("dyx3-0a1b2c3d4e")).toBeNull();
  });

  it("migrates a host-keyed token to the rover id on first use", async () => {
    const s = await freshStorage();
    await s.saveProdTokenFor("http://192.168.3.150:8000", "old-token");
    expect(await s.loadProdTokenForRover("dyx3-x", "http://192.168.3.150:8000")).toBe("old-token");
    expect(await s.loadProdTokenForRover("dyx3-x", "http://192.168.2.100:8000")).toBe("old-token");
  });

  it("remembers the last rover and has no fixed default host", async () => {
    const s = await freshStorage();
    expect(await s.loadProdHost()).toBe("");
    expect(await s.loadLastRoverId()).toBeNull();
    await s.saveLastRoverId("dyx3-x");
    expect(await s.loadLastRoverId()).toBe("dyx3-x");
  });
});
