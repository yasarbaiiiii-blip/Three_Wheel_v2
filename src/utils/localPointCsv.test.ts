import { describe, expect, it } from "vitest";
import { parseLocalPointCsv } from "./localPointCsv";

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

  it("parses north,east header", () => {
    const text = ["north,east", "0,0", "5,1"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("ned");
    expect(r.points.map((p) => [p.north_m, p.east_m])).toEqual([
      [0, 0],
      [5, 1],
    ]);
  });

  it("parses headerless NED metres", () => {
    const text = ["0,0", "2,3"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("ned");
    expect(r.num_points).toBe(2);
    expect(r.points[1]).toMatchObject({ north_m: 2, east_m: 3, mark: true });
  });

  it("parses mark column", () => {
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
});
