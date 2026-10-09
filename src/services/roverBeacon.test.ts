import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { BEACON_FRESH_MS, parseDyx3Beacon, roverBeaconListener } from "./roverBeacon";

const beacon = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "dyx3_beacon", v: 1, rover_id: "dyx3-0a1b2c3d4e", rover_name: "DYX 3WD 01", ip: "192.168.3.150", port: 8000, ...over });

describe("parseDyx3Beacon", () => {
  it("uses the datagram source address as the rover address", () => {
    const r = parseDyx3Beacon(beacon(), "192.168.2.100", 1000);
    expect(r).toEqual({
      roverId: "dyx3-0a1b2c3d4e",
      roverName: "DYX 3WD 01",
      ip: "192.168.2.100",
      port: 8000,
      host: "http://192.168.2.100:8000",
      lastSeen: 1000,
    });
  });

  it("falls back to the payload ip when the source is unusable", () => {
    expect(parseDyx3Beacon(beacon(), "", 1)?.host).toBe("http://192.168.3.150:8000");
  });

  it("rejects 4WD beacons, wrong versions, bad ids and bad ports", () => {
    expect(parseDyx3Beacon(beacon({ type: "rover_beacon" }), "192.168.3.150", 1)).toBeNull();
    expect(parseDyx3Beacon(beacon({ v: 2 }), "192.168.3.150", 1)).toBeNull();
    expect(parseDyx3Beacon(beacon({ rover_id: "bad id;" }), "192.168.3.150", 1)).toBeNull();
    expect(parseDyx3Beacon(beacon({ port: 70000 }), "192.168.3.150", 1)).toBeNull();
    expect(parseDyx3Beacon("not json", "192.168.3.150", 1)).toBeNull();
  });
});

describe("roverBeaconListener", () => {
  it("tracks one rover by id as it moves between networks and drops it when beacons stop", () => {
    const now = Date.now();
    roverBeaconListener.ingest(beacon(), "192.168.3.150", now);
    expect(roverBeaconListener.find("dyx3-0a1b2c3d4e")?.host).toBe("http://192.168.3.150:8000");
    roverBeaconListener.ingest(beacon(), "192.168.2.100", now + 500);
    expect(roverBeaconListener.list(now + 600)).toHaveLength(1);
    expect(roverBeaconListener.findByHost("http://192.168.2.100:8000/")?.roverId).toBe("dyx3-0a1b2c3d4e");
    expect(roverBeaconListener.list(now + 500 + BEACON_FRESH_MS + 1)).toHaveLength(0);
  });
});
