import { describe, expect, it } from "vitest";

import {
  detectCsvDelimiter,
  localCsvPointsToPlanLines,
  parseLocalPointCsv,
  PROJECTED_COORD_BLOCK_M,
  splitDelimitedCells,
} from "./localPointCsv";
import { getLineLengthM } from "./pathWorkflow";
import { getPlanLineRenderPoints, isCircleLikeLine } from "./curveGeometry";

describe("blank coordinate cells must never parse as zero", () => {
  // Regression: `Number("")` is 0 and finite, so blank lat/lon became a point at
  // lat 0 / lon 0 with warnings IDENTICAL to a valid file. Real trigger: an Emlid
  // export in a projected CS has Easting/Northing filled and lat/lon blank.
  it("rejects a whole file whose Latitude/Longitude are blank (projected-CS export)", () => {
    const text = [
      "Name,Easting,Northing,Longitude,Latitude",
      "P1,1199779.779,1257454.473,,",
      "P2,1199779.975,1257450.673,,",
      "P3,1199780.101,1257446.912,,",
    ].join("\n");
    expect(() => parseLocalPointCsv(text, "projected.csv")).toThrow(/empty/i);
  });

  it("drops a single blank-coordinate row and says so, instead of placing it at (0,0)", () => {
    const text = [
      "Name,Latitude,Longitude",
      "P1,13.1957205,80.2179980",
      "P2,,",
      "P3,13.1957400,80.2180100",
      "P4,13.1957500,80.2180150",
    ].join("\n");
    const r = parseLocalPointCsv(text, "onegap.csv");
    expect(r.num_points).toBe(3);
    expect(r.points.every((p) => p.lat !== 0 && p.lon !== 0)).toBe(true);
    expect(r.warnings.some((w) => /empty/i.test(w))).toBe(true);
  });

  it("still rejects non-numeric coordinates", () => {
    const text = ["north,east", "0,0", "abc,1", "5,5"].join("\n");
    const r = parseLocalPointCsv(text, "bad.csv");
    expect(r.num_points).toBe(2);
    expect(r.warnings.some((w) => /numeric/i.test(w))).toBe(true);
  });
});

describe("'#' is a comment marker only before the header", () => {
  // Regression: the `#` filter ran over the whole file, so operator-typed point
  // names like `#1` were deleted with an empty warnings array.
  it("keeps data rows whose Name starts with '#'", () => {
    const text = [
      "Name,Latitude,Longitude",
      "#1,13.1957205,80.2179980",
      "P2,13.1957275,80.2180018",
      "#3,13.1957400,80.2180100",
      "P4,13.1957500,80.2180150",
    ].join("\n");
    const r = parseLocalPointCsv(text, "hashnames.csv");
    expect(r.num_points).toBe(4);
  });

  it("still strips a leading comment block above the header", () => {
    const text = [
      "# Exported by Reach RS3, 2026-08-01",
      "# CS: WGS84",
      "Name,Latitude,Longitude",
      "P1,13.1957205,80.2179980",
      "P2,13.1957275,80.2180018",
    ].join("\n");
    const r = parseLocalPointCsv(text, "leadingcomment.csv");
    expect(r.num_points).toBe(2);
  });
});

describe("CSV parse robustness", () => {
  it("detects semicolon delimiter and decimal-comma numbers", () => {
    expect(detectCsvDelimiter("north;east")).toBe(";");
    const cells = splitDelimitedCells("1,5;2,5", ";");
    expect(cells).toEqual(["1.5", "2.5"]);
  });

  it("parses semicolon-delimited NED CSV", () => {
    const text = ["north;east", "0;0", "5;0", "5;5"].join("\n");
    const r = parseLocalPointCsv(text, "eu.csv");
    expect(r.kind).toBe("ned");
    expect(r.num_points).toBe(3);
    expect(r.points[1].east_m).toBeCloseTo(0, 5);
  });

  it("blocks projected-scale northing/easting values", () => {
    const text = ["northing,easting", "1243756,1204636", "1243761,1204636"].join("\n");
    expect(() => parseLocalPointCsv(text)).toThrow(/projected CRS|local site metres/i);
    expect(PROJECTED_COORD_BLOCK_M).toBe(10_000);
  });

  it("warns on headerless near-zero spans that look like metres-as-degrees", () => {
    const text = ["0,0", "0.05,0", "0.05,0.05", "0,0.05"].join("\n");
    const r = parseLocalPointCsv(text, "headerless.csv");
    expect(r.kind).toBe("gps");
    expect(r.warnings.some((w) => /Headerless|local metres|confirm/i.test(w))).toBe(true);
  });

  it("uses cluster median origin so a garbage first GPS row does not poison the frame", () => {
    const text = [
      "lat,lon",
      "0.0,0.0",
      "13.0700,80.2600",
      "13.0701,80.2601",
      "13.0702,80.2600",
    ].join("\n");
    const r = parseLocalPointCsv(text, "poison.csv");
    // Origin should be near the Chennai cluster, not Null Island — so NED coords stay small.
    for (const p of r.points.slice(1)) {
      expect(Math.hypot(p.north_m, p.east_m)).toBeLessThan(50_000);
    }
    expect(r.warnings.some((w) => /cluster|outlier|far from/i.test(w))).toBe(true);
  });

  it("sets measured length_m on plan lines (not 0)", () => {
    const text = ["north,east", "0,0", "0,5", "5,5"].join("\n");
    const r = parseLocalPointCsv(text);
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const line = lines[0];
    expect(line.entity?.length_m).toBeGreaterThan(1);
    expect(getLineLengthM(line)).toBeGreaterThan(1);
    expect(getLineLengthM(line)).toBeCloseTo(line.entity!.length_m, 1);
  });

  it("map render points equal preview_points for road_marking (map ≡ rover)", () => {
    const text = ["north,east", "0,0", "0,5", "5,5", "5,0"].join("\n");
    const r = parseLocalPointCsv(text);
    const lines = localCsvPointsToPlanLines(r.points);
    const line = lines[0];
    expect(line.entity?.geometry?.road_marking).toBe(true);
    expect(isCircleLikeLine(line)).toBe(false);
    const render = getPlanLineRenderPoints(line, true);
    expect(render).toEqual(line.entity!.preview_points);
  });

  it("does not treat a dense square ring as circle-like when road_marking", () => {
    const pts = Array.from({ length: 40 }, (_, i) => {
      const side = Math.floor(i / 10);
      const t = (i % 10) / 10;
      if (side === 0) return { north: 0, east: t * 4 };
      if (side === 1) return { north: t * 4, east: 4 };
      if (side === 2) return { north: 4, east: 4 - t * 4 };
      return { north: 4 - t * 4, east: 0 };
    });
    const text = ["north,east", ...pts.map((p) => `${p.north},${p.east}`)].join("\n");
    const r = parseLocalPointCsv(text);
    const lines = localCsvPointsToPlanLines(r.points);
    expect(isCircleLikeLine(lines[0])).toBe(false);
  });
});
