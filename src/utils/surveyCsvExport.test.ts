import { describe, expect, it } from "vitest";

import { parseLocalPointCsv } from "./localPointCsv";
import { assignPathCodes, buildSurveyCsvExport, sanitizeUploadFileName } from "./surveyCsvExport";

/** Rows as the rover's csv.DictReader would see them: header + [{col: value}]. */
function readBack(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  return { header, rows };
}

/** Two features, 4 points each, far enough apart that jump-splitting would also fire. */
const GPS_TWO_FEATURES = [
  "Name,Feature,Latitude,Longitude",
  "1,road_a,13.0720000,80.2610000",
  "2,road_a,13.0720100,80.2610000",
  "3,road_a,13.0720200,80.2610000",
  "4,road_a,13.0720300,80.2610000",
  "5,road_b,13.0730000,80.2620000",
  "6,road_b,13.0730100,80.2620000",
  "7,road_b,13.0730200,80.2620000",
  "8,road_b,13.0730300,80.2620000",
].join("\n");

describe("sanitizeUploadFileName", () => {
  it("keeps a plain name and forces a .csv extension", () => {
    expect(sanitizeUploadFileName("haddows_road.csv")).toBe("haddows_road.csv");
    expect(sanitizeUploadFileName("survey.CSV")).toBe("survey.csv");
  });

  it("strips directories and unsafe characters", () => {
    expect(sanitizeUploadFileName("C:\\surveys\\Haddows Road (final).csv")).toBe(
      "Haddows_Road_final.csv"
    );
    expect(sanitizeUploadFileName("../../etc/passwd.csv")).toBe("passwd.csv");
  });

  it("falls back rather than producing a bare extension", () => {
    expect(sanitizeUploadFileName("")).toBe("survey.csv");
    expect(sanitizeUploadFileName("...")).toBe("survey.csv");
  });
});

describe("assignPathCodes", () => {
  it("gives one code per drawn path and shares it across that path's points", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "two.csv");
    const codes = assignPathCodes(parsed.points);

    expect(codes).toHaveLength(parsed.points.length);
    expect(new Set(codes).size).toBe(2);
    expect(new Set(codes.slice(0, 4)).size).toBe(1);
    expect(new Set(codes.slice(4)).size).toBe(1);
    expect(codes[0]).not.toBe(codes[4]);
  });

  it("uses a single code when the file is one continuous path", () => {
    const text = [
      "Latitude,Longitude",
      "13.072000,80.261000",
      "13.072001,80.261000",
      "13.072002,80.261000",
    ].join("\n");
    const parsed = parseLocalPointCsv(text, "one.csv");
    expect(new Set(assignPathCodes(parsed.points)).size).toBe(1);
  });

  it("keeps the operator's own feature label as the code", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "two.csv");
    const codes = assignPathCodes(parsed.points);
    expect(codes[0]).toBe("road_a");
    expect(codes[4]).toBe("road_b");
  });

  it("falls back to a positional code when the file has no grouping column", () => {
    const text = [
      "Latitude,Longitude",
      "13.072000,80.261000",
      "13.072001,80.261000",
      "13.072002,80.261000",
    ].join("\n");
    const parsed = parseLocalPointCsv(text, "plain.csv");
    expect(assignPathCodes(parsed.points)[0]).toBe("path_1");
  });

  it("keeps one code across a collinear sparse hop of the same feature", () => {
    // Same heading, ~150 m gap: mixed-density waypoint straight, not a dropout.
    // Re-joining is the correct paint (same as a 132 m 2-pt line).
    const text = [
      "Name,Feature,Latitude,Longitude",
      "1,road_a,13.072000,80.261000",
      "2,road_a,13.072010,80.261000",
      "3,road_a,13.072020,80.261000",
      "4,road_a,13.073500,80.261000",
      "5,road_a,13.073510,80.261000",
      "6,road_a,13.073520,80.261000",
    ].join("\n");
    const parsed = parseLocalPointCsv(text, "split.csv");
    const codes = assignPathCodes(parsed.points);
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toBe("road_a");
    expect(codes[3]).toBe("road_a");
  });

  it("does not re-use one code across a non-collinear jump of the same feature", () => {
    // Same label, ~150 m gap, but the second cluster heads east — unrelated feature
    // halves. Must stay two codes so the rover does not invent a diagonal.
    const text = [
      "Name,Feature,Latitude,Longitude",
      "1,road_a,13.072000,80.261000",
      "2,road_a,13.072010,80.261000",
      "3,road_a,13.072020,80.261000",
      "4,road_a,13.072020,80.262500",
      "5,road_a,13.072020,80.262510",
      "6,road_a,13.072020,80.262520",
    ].join("\n");
    const parsed = parseLocalPointCsv(text, "split_L.csv");
    const codes = assignPathCodes(parsed.points);
    expect(new Set(codes).size).toBe(2);
    expect(codes[0]).toBe("road_a");
    expect(codes[3]).toBe("road_a (2)");
  });

  it("strips commas from a label so the CSV keeps its four columns", () => {
    const text = [
      "Feature,Latitude,Longitude",
      '"Haddows Road, North",13.072000,80.261000',
      '"Haddows Road, North",13.072001,80.261000',
      '"Haddows Road, North",13.072002,80.261000',
    ].join("\n");
    const parsed = parseLocalPointCsv(text, "comma.csv");
    const exported = buildSurveyCsvExport(parsed);
    expect(assignPathCodes(parsed.points)[0]).toBe("Haddows Road North");
    for (const line of exported.text.trim().split("\n")) {
      expect(line.split(",")).toHaveLength(4);
    }
  });
});

describe("buildSurveyCsvExport", () => {
  it("emits the named header the rover's survey parser requires", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "two.csv");
    const { header } = readBack(buildSurveyCsvExport(parsed).text);
    expect(header).toEqual(["Name", "Code", "Latitude", "Longitude"]);
  });

  it("writes the ORIGINAL lat/lon, never the locally projected metres", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "two.csv");
    const { rows } = readBack(buildSurveyCsvExport(parsed).text);

    expect(Number(rows[0].Latitude)).toBeCloseTo(13.072, 7);
    expect(Number(rows[0].Longitude)).toBeCloseTo(80.261, 7);
    expect(Number(rows[4].Latitude)).toBeCloseTo(13.073, 7);
    // The projected north of row 0 is 0 by construction (it is the anchor); if metres had
    // leaked into the file this would read 0, not a latitude.
    expect(Number(rows[0].Latitude)).not.toBe(0);
  });

  it("numbers Name so the rover's within-code numeric sort preserves file order", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "two.csv");
    const { rows } = readBack(buildSurveyCsvExport(parsed).text);
    const names = rows.map((r) => Number(r.Name));
    expect(names).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Sorting each code group by Name must reproduce the source order.
    const groupA = rows.filter((r) => r.Code === rows[0].Code);
    expect(groupA.map((r) => Number(r.Name))).toEqual([1, 2, 3, 4]);
  });

  it("carries our grouping into Code, one value per drawn path", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "two.csv");
    const exported = buildSurveyCsvExport(parsed);
    const { rows } = readBack(exported.text);

    expect(exported.numPaths).toBe(2);
    expect(rows.slice(0, 4).every((r) => r.Code === "road_a")).toBe(true);
    expect(rows.slice(4).every((r) => r.Code === "road_b")).toBe(true);
  });

  it("gives a headerless lat,lon file the header the rover needs", () => {
    // Uploaded raw, this file has no named header — the rover would fall through to its
    // legacy NED reader and read latitude 13.07 as 13 metres north.
    const text = ["13.072000,80.261000", "13.072001,80.261000", "13.072002,80.261000"].join("\n");
    const parsed = parseLocalPointCsv(text, "headerless.csv");
    const { header, rows } = readBack(buildSurveyCsvExport(parsed).text);

    expect(header).toEqual(["Name", "Code", "Latitude", "Longitude"]);
    expect(rows).toHaveLength(3);
    expect(Number(rows[0].Latitude)).toBeCloseTo(13.072, 7);
  });

  it("exports a north/east file in the grid header instead", () => {
    const text = ["north,east", "0,0", "5,0", "10,0"].join("\n");
    const parsed = parseLocalPointCsv(text, "ned.csv");
    const exported = buildSurveyCsvExport(parsed);
    const { header, rows } = readBack(exported.text);

    expect(exported.kind).toBe("ned");
    expect(header).toEqual(["Name", "Code", "Northing", "Easting"]);
    expect(rows.map((r) => Number(r.Northing))).toEqual([0, 5, 10]);
    expect(exported.previewAnchor).toBeNull();
  });

  it("reports the rover-side filename and a newline-terminated body", () => {
    const parsed = parseLocalPointCsv(GPS_TWO_FEATURES, "Haddows Road.csv");
    const exported = buildSurveyCsvExport(parsed);
    expect(exported.fileName).toBe("Haddows_Road.csv");
    expect(exported.numPoints).toBe(8);
    expect(exported.text.endsWith("\n")).toBe(true);
  });

  it("keeps enough precision to stay below RTK noise", () => {
    const text = ["Latitude,Longitude", "13.07208106,80.26195346", "13.07208206,80.26195346"].join("\n");
    const parsed = parseLocalPointCsv(text, "precise.csv");
    const { rows } = readBack(buildSurveyCsvExport(parsed).text);
    expect(rows[0].Latitude).toBe("13.07208106");
    expect(rows[0].Longitude).toBe("80.26195346");
  });

  it("emits a Mark column when any point is mark=false", () => {
    const text = [
      "lat,lon,mark",
      "13.07,80.26,1",
      "13.071,80.26,1",
      "13.072,80.26,0",
      "13.073,80.26,0",
    ].join("\n");
    const parsed = parseLocalPointCsv(text, "marked.csv");
    const { header, rows } = readBack(buildSurveyCsvExport(parsed).text);
    expect(header).toContain("Mark");
    expect(rows.some((r) => r.Mark === "0")).toBe(true);
    expect(rows.some((r) => r.Mark === "1")).toBe(true);
  });
});
