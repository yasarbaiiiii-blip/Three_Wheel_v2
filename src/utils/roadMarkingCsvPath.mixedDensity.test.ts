import { describe, expect, it } from "vitest";
import {
  localCsvPointsToPlanLines,
  parseLocalPointCsv,
} from "./localPointCsv";
import {
  polylineLengthM,
  splitIntoOpenPathGroups,
  type RoadMarkingNedPoint,
} from "./roadMarkingCsvPath";
import { assignPathCodes } from "./surveyCsvExport";

/** 132.51 m 2-pt straight then a quarter-circle (Madhavaram mixed-density). */
function madhavaramMixedDensity(): RoadMarkingNedPoint[] {
  const p2North = 132.51;
  const r = 28;
  const nArc = 56;
  const pts: RoadMarkingNedPoint[] = [
    { north: 0, east: 0 },
    { north: p2North, east: 0 },
  ];
  for (let i = 1; i <= nArc; i++) {
    const t = (i / nArc) * (Math.PI / 2);
    pts.push({
      north: p2North + r * Math.sin(t),
      east: r * (1 - Math.cos(t)),
    });
  }
  return pts;
}

function asCsvPoints(pts: RoadMarkingNedPoint[]) {
  return pts.map((p, i) => ({
    north_m: p.north,
    east_m: p.east,
    mark: true,
    dwell_s: null,
    source_index: i + 1,
  }));
}

describe("mixed-density grouping (Madhavaram 132.51 m + curve)", () => {
  it("keeps a 132.51 m 2-pt straight + dense curve as one group starting at P1", () => {
    const pts = madhavaramMixedDensity();
    expect(pts.length).toBe(58);
    const groups = splitIntoOpenPathGroups(pts);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(58);
    expect(groups[0][0]).toEqual(pts[0]);
  });

  it("does not split a 2-point 132.51 m file", () => {
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 132.51, east: 0 },
    ];
    const groups = splitIntoOpenPathGroups(pts);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(2);
  });

  it("fits a plan line whose stroke starts at P1 and covers the first straight", () => {
    const pts = madhavaramMixedDensity();
    const lines = localCsvPointsToPlanLines(asCsvPoints(pts));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const mark = lines.filter((l) => l.layer === "marking");
    expect(mark.length).toBe(1);
    const preview = mark[0].entity?.preview_points ?? [];
    expect(preview.length).toBeGreaterThanOrEqual(2);
    const start = preview[0];
    expect(start).toBeDefined();
    expect(Math.hypot(start.north - pts[0].north, start.east - pts[0].east)).toBeLessThan(0.01);
    const fitLen = polylineLengthM(preview.map((p) => ({ north: p.north, east: p.east })));
    const srcLen = polylineLengthM(pts);
    expect(fitLen).toBeGreaterThan(srcLen * 0.75);
    const warnings = (mark[0].entity?.geometry?.fit_warnings as string[] | undefined) ?? [];
    expect(warnings.some((w) => /sparse straight/i.test(w))).toBe(true);
  });

  it("assigns a single export path code (Send will not drop P1 as its own path)", () => {
    const pts = madhavaramMixedDensity();
    const codes = assignPathCodes(asCsvPoints(pts));
    expect(new Set(codes).size).toBe(1);
  });

  it("still splits two dense unrelated circles ~30 m apart", () => {
    const westCircle = Array.from({ length: 50 }, (_, i) => ({
      north: 11.5 * Math.sin((i / 50) * 2 * Math.PI),
      east: 11.5 * Math.cos((i / 50) * 2 * Math.PI),
    }));
    const eastCircle = Array.from({ length: 50 }, (_, i) => ({
      north: 30 + 9 * Math.sin((i / 50) * 2 * Math.PI),
      east: 30 + 9 * Math.cos((i / 50) * 2 * Math.PI),
    }));
    const groups = splitIntoOpenPathGroups([...westCircle, ...eastCircle]);
    expect(groups.length).toBe(2);
  });
});

describe("mixed-density multi-file batch", () => {
  it("two GPS files produce two mark lines and a merged pin set", () => {
    const straight = parseLocalPointCsv(
      ["lat,lon", "13.000000,80.000000", "13.001191,80.000000"].join("\n"),
      "Aug-13-Madhavaram_2pts.csv"
    );
    const curveRows = ["lat,lon"];
    // ~58 pts along a small arc north of the second straight point.
    for (let i = 0; i < 56; i++) {
      const t = (i / 55) * 0.004;
      curveRows.push(`${(13.001191 + t).toFixed(6)},${(80.000000 + t * 0.6).toFixed(6)}`);
    }
    const curve = parseLocalPointCsv(curveRows.join("\n"), "Aug-13-Madhavaram-Straight-Curve.csv");
    const aLines = localCsvPointsToPlanLines(straight.points);
    const bLines = localCsvPointsToPlanLines(curve.points);
    expect(aLines.length).toBe(1);
    expect(bLines.length).toBeGreaterThanOrEqual(1);
    const combined = [...aLines, ...bLines];
    expect(combined.length).toBeGreaterThanOrEqual(2);
  });
});
