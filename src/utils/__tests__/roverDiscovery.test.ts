import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseHostString,
  isPrivateIpv4,
  subnetPrefixFromIp,
  probeRoverTarget,
  runWorkerPool,
  discoverRovers,
} from "../roverDiscovery";

describe("roverDiscovery utilities", () => {
  it("parseHostString handles bare IPs, full URLs, and port overrides", () => {
    expect(parseHostString("192.168.42.1")).toEqual({ host: "192.168.42.1", port: 8000 });
    expect(parseHostString("192.168.42.1:8000")).toEqual({ host: "192.168.42.1", port: 8000 });
    expect(parseHostString("http://192.168.42.1:5001")).toEqual({ host: "192.168.42.1", port: 5001 });
    expect(parseHostString("https://myrover.local:8000")).toEqual({ host: "myrover.local", port: 8000 });
    expect(parseHostString("")).toBeNull();
    expect(parseHostString("invalid:::url")).toBeNull();
  });

  it("isPrivateIpv4 correctly identifies LAN IP ranges", () => {
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateIpv4("192.168.42.5")).toBe(true);
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("10.42.0.1")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.255.254")).toBe(true);
    // Public or invalid
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("1.1.1.1")).toBe(false);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateIpv4("invalid")).toBe(false);
  });

  it("subnetPrefixFromIp extracts the /24 prefix", () => {
    expect(subnetPrefixFromIp("192.168.42.15")).toBe("192.168.42");
    expect(subnetPrefixFromIp("10.0.1.2")).toBe("10.0.1");
    expect(subnetPrefixFromIp("not-an-ip")).toBeNull();
  });
});

describe("runWorkerPool concurrency limiter", () => {
  it("limits active workers strictly to specified limit", async () => {
    let active = 0;
    let maxObservedActive = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);

    const results = await runWorkerPool(items, 5, async (item) => {
      active++;
      if (active > maxObservedActive) maxObservedActive = active;
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return item * 2;
    });

    expect(maxObservedActive).toBeLessThanOrEqual(5);
    expect(results).toHaveLength(50);
    expect(results[0]).toBe(0);
    expect(results[49]).toBe(98);
  });
});

describe("probeRoverTarget", () => {
  it("identifies production rover via /api/ping 200 ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });

    const res = await probeRoverTarget("192.168.42.1", 8000, 300, mockFetch as any);
    expect(res).not.toBeNull();
    expect(res?.generation).toBe("production");
    expect(res?.port).toBe(8000);
    expect(res?.host).toBe("192.168.42.1");
    expect(res?.url).toBe("http://192.168.42.1:8000");
  });

  it("identifies production rover when /api/ping returns 401 (auth-protected router)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: "missing bearer token" }),
    });

    const res = await probeRoverTarget("192.168.42.1", 8000, 300, mockFetch as any);
    expect(res).not.toBeNull();
    expect(res?.generation).toBe("production");
    expect(res?.port).toBe(8000);
  });

  it("identifies prototype rover via /api/health", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("Connection refused on /api/ping"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "rover_backend",
          rover_id: "proto-001",
          rover_name: "Proto Rover",
        }),
      });

    const res = await probeRoverTarget("192.168.1.102", 5001, 300, mockFetch as any);
    expect(res).not.toBeNull();
    expect(res?.generation).toBe("prototype");
    expect(res?.port).toBe(5001);
    expect(res?.name).toBe("Proto Rover");
  });

  it("returns null when host is completely unreachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const res = await probeRoverTarget("10.255.255.1", 8000, 50, mockFetch as any);
    expect(res).toBeNull();
  });
});

describe("discoverRovers multi-phase pipeline", () => {
  it("fast-path finds hot target in Phase 1 and returns immediately", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("192.168.42.1:8000/api/ping")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok" }),
        };
      }
      throw new Error("unreachable");
    });

    const rovers = await discoverRovers(
      { seedHost: "192.168.42.1:8000", includePrototype: false },
      mockFetch as any
    );

    expect(rovers).toHaveLength(1);
    expect(rovers[0].host).toBe("192.168.42.1");
    expect(rovers[0].port).toBe(8000);
    expect(rovers[0].generation).toBe("production");
  });

  it("sweeps active subnet in Phase 2 when hot targets are unreachable", async () => {
    const progressReports: Array<{ scanned: number; total: number }> = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // Suppose rover is dynamically assigned 192.168.42.175
      if (url.includes("192.168.42.175:8000/api/ping")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", rover_name: "DYX 3WD Rover #175" }),
        };
      }
      throw new Error("unreachable");
    });

    const rovers = await discoverRovers(
      {
        seedHost: "192.168.42.99:8000",
        includePrototype: false,
        concurrency: 50,
        timeoutMs: 100,
        onProgress: (scanned, total) => {
          progressReports.push({ scanned, total });
        },
      },
      mockFetch as any
    );

    expect(rovers).toHaveLength(1);
    expect(rovers[0].host).toBe("192.168.42.175");
    expect(rovers[0].port).toBe(8000);
    expect(rovers[0].name).toBe("DYX 3WD Rover #175");
    expect(progressReports.length).toBeGreaterThan(0);
    const lastProgress = progressReports[progressReports.length - 1];
    expect(lastProgress.scanned).toBe(lastProgress.total);
  });
});
