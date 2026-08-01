import { describe, expect, it } from "vitest";

import { isExtendablePathName } from "./csvFlowKind";
import {
  classifyPreviewSegment,
  planLinesFromPreviewWaypoints,
  TERMINAL_RUNOUT_MAX_M,
  trailingSprayOffIsAftExtension,
} from "./previewWaypointLayers";

describe("isExtendablePathName", () => {
  it("admits DXF always", () => {
    expect(isExtendablePathName("field.dxf", false)).toBe(true);
    expect(isExtendablePathName("field.dxf", true)).toBe(true);
  });

  it("admits a CSV only in pre-line mode", () => {
    expect(isExtendablePathName("curve.csv", true)).toBe(true);
    expect(isExtendablePathName("curve.csv", false)).toBe(false);
  });

  it("refuses waypoints / empty", () => {
    expect(isExtendablePathName("m.waypoints", true)).toBe(false);
    expect(isExtendablePathName(null, true)).toBe(false);
  });
});

describe("classifyPreviewSegment / planLinesFromPreviewWaypoints", () => {
  it("labels leading spray-OFF as pre and trailing long OFF as aft", () => {
    // PRE 0.5 m + MARK 1 m + AFT 0.5 m
    const pts = [
      { north: -0.5, east: 0, spray: false },
      { north: 0, east: 0, spray: true },
      { north: 1, east: 0, spray: true },
      { north: 1.5, east: 0, spray: false },
    ];
    expect(trailingSprayOffIsAftExtension(pts)).toBe(true);
    const lines = planLinesFromPreviewWaypoints(pts);
    expect(lines.map((l) => l.layer)).toEqual([
      "extension",
      "marking",
      "extension",
    ]);
    expect(lines[0].segmentRole).toBe("pre");
    expect(lines[0].id).toMatch(/^ext-pre-/);
    expect(lines[2].segmentRole).toBe("aft");
    expect(lines[2].id).toMatch(/^ext-aft-/);
  });

  it("keeps the short terminal run-out stub as transit, not aft", () => {
    // MARK only + 0.1 m stub (extensions OFF)
    const pts = [
      { north: 0, east: 0, spray: true },
      { north: 1, east: 0, spray: true },
      { north: 1.1, east: 0, spray: false },
    ];
    expect(runLen(pts, 1, 2)).toBeLessThanOrEqual(TERMINAL_RUNOUT_MAX_M);
    expect(trailingSprayOffIsAftExtension(pts)).toBe(false);
    const lines = planLinesFromPreviewWaypoints(pts);
    expect(lines.map((l) => l.layer)).toEqual(["marking", "transit"]);
  });

  it("labels interior spray-OFF between marks as transit", () => {
    const pts = [
      { north: 0, east: 0, spray: true },
      { north: 1, east: 0, spray: true },
      { north: 1, east: 2, spray: false }, // travel midpoint / start
      { north: 2, east: 2, spray: false },
      { north: 2, east: 2, spray: true },
      { north: 3, east: 2, spray: true },
    ];
    const lines = planLinesFromPreviewWaypoints(pts);
    expect(lines.map((l) => l.layer)).toEqual([
      "marking",
      "marking", // last mark → first travel (from still ON at junction)
      "transit",
      "transit", // into next mark start
      "marking",
    ]);
  });

  it("preserves must_hit on endpoints", () => {
    const pts = [
      { north: 0, east: 0, spray: true, must_hit: true },
      { north: 1, east: 0, spray: true, must_hit: false },
    ];
    const lines = planLinesFromPreviewWaypoints(pts);
    expect(lines[0].from.mustHit).toBe(true);
    expect(lines[0].to.mustHit).toBe(false);
  });

  it("classifyPreviewSegment: all-false path is transit", () => {
    const cls = classifyPreviewSegment([false, false, false], 0, false);
    expect(cls.layer).toBe("transit");
  });
});

function runLen(
  pts: { north: number; east: number }[],
  from: number,
  to: number
): number {
  let len = 0;
  for (let i = from; i < to; i++) {
    len += Math.hypot(
      pts[i + 1].north - pts[i].north,
      pts[i + 1].east - pts[i].east
    );
  }
  return len;
}
