import { describe, it, expect } from "vitest";
import {
  pickNiceGridSpacing,
  computeGridBounds,
  buildGridLineSegments,
  snapPointToGrid,
  snapRotationDeg,
  findSnapTarget,
} from "./alignmentGrid";

describe("pickNiceGridSpacing", () => {
  it("picks 1/2/5 x 10^n spacings", () => {
    expect(pickNiceGridSpacing(8, 8)).toBeCloseTo(1, 6);
    expect(pickNiceGridSpacing(16, 8)).toBeCloseTo(2, 6);
    expect(pickNiceGridSpacing(40, 8)).toBeCloseTo(5, 6);
    expect(pickNiceGridSpacing(80, 8)).toBeCloseTo(10, 6);
  });

  it("scales down for small spans (e.g. a 2m square)", () => {
    const spacing = pickNiceGridSpacing(2, 8);
    expect(spacing).toBeLessThanOrEqual(0.5);
    expect(spacing).toBeGreaterThan(0);
  });

  it("falls back to 1 for non-finite or non-positive spans", () => {
    expect(pickNiceGridSpacing(0)).toBe(1);
    expect(pickNiceGridSpacing(-5)).toBe(1);
    expect(pickNiceGridSpacing(NaN)).toBe(1);
  });
});

describe("computeGridBounds", () => {
  it("returns null for an empty or all-non-finite point list", () => {
    expect(computeGridBounds([])).toBeNull();
    expect(computeGridBounds([{ north: NaN, east: NaN }])).toBeNull();
  });

  it("expands the bounding box beyond the points so the plan can be placed outside them", () => {
    const points = [
      { north: 0, east: 0 },
      { north: 2, east: 0 },
      { north: 2, east: 2 },
      { north: 0, east: 2 },
    ];
    const bounds = computeGridBounds(points);
    expect(bounds).not.toBeNull();
    expect(bounds!.minNorth).toBeLessThan(0);
    expect(bounds!.maxNorth).toBeGreaterThan(2);
    expect(bounds!.minEast).toBeLessThan(0);
    expect(bounds!.maxEast).toBeGreaterThan(2);
    expect(bounds!.spacing).toBeGreaterThan(0);
  });

  it("handles a single point (zero span) without collapsing to a degenerate grid", () => {
    const bounds = computeGridBounds([{ north: 5, east: 5 }]);
    expect(bounds).not.toBeNull();
    expect(bounds!.maxNorth).toBeGreaterThan(bounds!.minNorth);
    expect(bounds!.maxEast).toBeGreaterThan(bounds!.minEast);
  });
});

describe("buildGridLineSegments", () => {
  it("builds a finite, non-empty set of line segments within bounds", () => {
    const bounds = computeGridBounds([
      { north: 0, east: 0 },
      { north: 2, east: 2 },
    ])!;
    const segments = buildGridLineSegments(bounds);
    expect(segments.length).toBeGreaterThan(0);
    for (const [a, b] of segments) {
      expect(a.north).toBeGreaterThanOrEqual(bounds.minNorth - 1e-6);
      expect(a.north).toBeLessThanOrEqual(bounds.maxNorth + 1e-6);
      expect(b.east).toBeGreaterThanOrEqual(bounds.minEast - 1e-6);
      expect(b.east).toBeLessThanOrEqual(bounds.maxEast + 1e-6);
    }
  });

  it("never produces a pathologically huge number of segments", () => {
    const segments = buildGridLineSegments({ minNorth: -1000, maxNorth: 1000, minEast: -1000, maxEast: 1000, spacing: 0.01 });
    expect(segments.length).toBeLessThanOrEqual(400);
  });

  it("returns an empty array for invalid spacing", () => {
    expect(buildGridLineSegments({ minNorth: 0, maxNorth: 1, minEast: 0, maxEast: 1, spacing: 0 })).toEqual([]);
  });
});

describe("snapPointToGrid", () => {
  it("quantizes to the nearest grid intersection", () => {
    const snapped = snapPointToGrid({ north: 1.23, east: 2.71 }, 0.5);
    expect(snapped.north).toBeCloseTo(1.0, 6);
    expect(snapped.east).toBeCloseTo(2.5, 6);
  });
});

describe("snapRotationDeg", () => {
  it("snaps to the nearest increment", () => {
    expect(snapRotationDeg(7, 15)).toBe(0);
    expect(snapRotationDeg(8, 15)).toBe(15);
    expect(snapRotationDeg(92, 15)).toBe(90);
    expect(snapRotationDeg(-92, 15)).toBe(-90);
  });

  it("is a no-op for invalid increments", () => {
    expect(snapRotationDeg(37, 0)).toBe(37);
    expect(snapRotationDeg(37, -5)).toBe(37);
  });
});

describe("findSnapTarget", () => {
  const points = [
    { north: 0, east: 0 },
    { north: 2, east: 2 },
  ];
  const bounds = computeGridBounds(points)!;

  it("prefers an explicit reference point within radius over the grid", () => {
    const target = findSnapTarget({ north: 0.05, east: -0.05 }, points, bounds, 0.3);
    expect(target).toEqual({ north: 0, east: 0 });
  });

  it("falls back to grid snap when no point is within radius", () => {
    const target = findSnapTarget({ north: 1.1, east: 1.15 }, points, bounds, 0.1);
    expect(target).not.toBeNull();
    expect(target!.north).toBeCloseTo(Math.round(1.1 / bounds.spacing) * bounds.spacing, 6);
  });

  it("returns null when nothing is close and there is no grid", () => {
    const target = findSnapTarget({ north: 1.1, east: 1.15 }, points, null, 0.1);
    expect(target).toBeNull();
  });

  it("ignores non-finite current position", () => {
    expect(findSnapTarget({ north: NaN, east: 0 }, points, bounds, 0.3)).toBeNull();
  });
});
