import { describe, expect, it } from "vitest";
import {
  localCsvPointsToPlanLines,
  localCsvToMapPins,
  parseLocalPointCsv,
  sampleEvenly,
} from "./localPointCsv";
import { projectPlanNorthEastToGps } from "./mapGeometryProjection";

describe("parseLocalPointCsv", () => {
  it("parses lat,lon GPS header and anchors at first row", () => {
    const text = ["lat,lon", "13.0,80.0", "13.001,80.0"].join("\n");
    const r = parseLocalPointCsv(text, "gps.csv");
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(2);
    expect(r.anchor).toEqual({ lat: 13.0, lon: 80.0 });
    expect(r.points[0].north_m).toBeCloseTo(0, 6);
    expect(r.points[0].east_m).toBeCloseTo(0, 6);
    expect(r.points[1].north_m).toBeGreaterThan(100);
    expect(Math.abs(r.points[1].east_m)).toBeLessThan(1);
  });

  it("accepts latitude/longitude aliases in any order", () => {
    const text = ["longitude,latitude", "80.0,13.0", "80.001,13.0"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(2);
    expect(r.anchor?.lat).toBe(13.0);
    expect(r.anchor?.lon).toBe(80.0);
  });

  it("headerless numeric rows are lat,lon (same as guide CSV)", () => {
    const text = ["13.0,80.0", "13.001,80.0"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(2);
    expect(r.anchor).toEqual({ lat: 13.0, lon: 80.0 });
    expect(r.points[0].lat).toBe(13.0);
    expect(r.points[0].lon).toBe(80.0);
  });

  it("parses north,east header as NED", () => {
    const text = ["north,east", "0,0", "5,1"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("ned");
    expect(r.points.map((p) => [p.north_m, p.east_m])).toEqual([
      [0, 0],
      [5, 1],
    ]);
  });

  it("parses northing,easting headers as NED", () => {
    const text = ["northing,easting", "1,2", "3,4"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("ned");
    expect(r.points[1]).toMatchObject({ north_m: 3, east_m: 4 });
  });

  it("prefers lat/lon when survey file also has northing/easting", () => {
    const text = [
      "Name,Northing,Easting,Latitude,Longitude",
      "1,100,200,13.0,80.0",
      "2,101,201,13.001,80.0",
    ].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.anchor).toEqual({ lat: 13.0, lon: 80.0 });
  });

  it("parses mark column on NED", () => {
    const text = ["north,east,mark", "0,0,true", "1,0,false"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.points[0].mark).toBe(true);
    expect(r.points[1].mark).toBe(false);
  });

  it("rejects empty file", () => {
    expect(() => parseLocalPointCsv("")).toThrow(/empty/i);
  });

  it("rejects survey-style header without lat/lon or north/east", () => {
    const text = ["Name,Code,Elevation", "1,L1,10"].join("\n");
    expect(() => parseLocalPointCsv(text)).toThrow(/Unrecognized CSV/i);
  });

  it("strips BOM", () => {
    const text = "\uFEFFlat,lon\n13,80\n";
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(1);
  });

  it("round-trips GPS lat/lon through NED projection (map path)", () => {
    const text = ["lat,lon", "13.07208106,80.26195346", "13.08,80.27"].join("\n");
    const r = parseLocalPointCsv(text);
    const origin = {
      frame: "ALIGNED_DESIGN" as const,
      originLat: r.anchor!.lat,
      originLon: r.anchor!.lon,
      originDxfNorth: 0,
      originDxfEast: 0,
    };
    for (const p of r.points) {
      const gps = projectPlanNorthEastToGps(p.north_m, p.east_m, origin);
      expect(gps.lat).toBeCloseTo(p.lat!, 8);
      expect(gps.lon).toBeCloseTo(p.lon!, 8);
    }
  });
});

describe("localCsvPointsToPlanLines", () => {
  it("builds one polyline with all preview_points", () => {
    const r = parseLocalPointCsv(["lat,lon", "13,80", "13.001,80", "13.002,80.001"].join("\n"));
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(1);
    expect(lines[0].entity?.preview_points).toHaveLength(3);
    expect(lines[0].from.x).toBeCloseTo(r.points[0].north_m, 6);
  });
});

describe("localCsvToMapPins", () => {
  it("includes lat/lon for GPS pins (direct map draw like guide CSV)", () => {
    const r = parseLocalPointCsv(["lat,lon", "13,80", "13.001,80"].join("\n"));
    const pins = localCsvToMapPins(r);
    expect(pins).toHaveLength(2);
    expect(pins[0].lat).toBe(13);
    expect(pins[0].lon).toBe(80);
  });

  it("samples evenly when over pin cap", () => {
    const rows = ["lat,lon", ...Array.from({ length: 200 }, (_, i) => `${13 + i * 0.0001},80`)];
    const r = parseLocalPointCsv(rows.join("\n"));
    const pins = localCsvToMapPins(r, 50);
    expect(pins.length).toBe(50);
    expect(pins[0].lat).toBeCloseTo(13, 5);
    expect(pins[pins.length - 1].lat).toBeCloseTo(13 + 199 * 0.0001, 5);
  });
});

describe("sampleEvenly", () => {
  it("returns all when under cap", () => {
    expect(sampleEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});
