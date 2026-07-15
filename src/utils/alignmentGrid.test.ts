import { describe, it, expect } from "vitest";
import {
  pickNiceGridSpacing,
  computeGridBounds,
  computeOrientationDeg,
  buildGridLineSegments,
  snapPointToGrid,
  snapRotationDeg,
  findSnapTarget,
} from "./alignmentGrid";

/** Rotates a local-metres point around a pivot by `deg` (bearing convention), mirroring the
 *  module-private helper — used here to build rotated fixtures and to undo the grid's
 *  rotation when asserting against grid-local bounds. */
function rotateAroundPivot(
  point: { north: number; east: number },
  pivot: { north: number; east: number },
  deg: number
): { north: number; east: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dn = point.north - pivot.north;
  const de = point.east - pivot.east;
  return { north: dn * cos - de * sin + pivot.north, east: dn * sin + de * cos + pivot.east };
}

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
    // An axis-aligned square is isotropic (no dominant PCA axis), so orientationDeg stays 0
    // and segments can be checked directly against bounds in the world frame.
    const bounds = computeGridBounds([
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ])!;
    expect(bounds.orientationDeg).toBeCloseTo(0, 6);
    const segments = buildGridLineSegments(bounds);
    expect(segments.length).toBeGreaterThan(0);
    for (const [a, b] of segments) {
      expect(a.north).toBeGreaterThanOrEqual(bounds.minNorth - 1e-6);
      expect(a.north).toBeLessThanOrEqual(bounds.maxNorth + 1e-6);
      expect(b.east).toBeGreaterThanOrEqual(bounds.minEast - 1e-6);
      expect(b.east).toBeLessThanOrEqual(bounds.maxEast + 1e-6);
    }
  });

  it("rotates segments to match the reference points' own orientation", () => {
    // Two points on a pure 45°-bearing line — the grid should rotate to follow them instead
    // of staying compass-aligned.
    const points = [
      { north: 0, east: 0 },
      { north: 2, east: 2 },
    ];
    const bounds = computeGridBounds(points)!;
    expect(bounds.orientationDeg).toBeCloseTo(45, 6);

    const segments = buildGridLineSegments(bounds);
    expect(segments.length).toBeGreaterThan(0);
    const pivot = bounds.pivot!;
    for (const [a, b] of segments) {
      // Undo the rotation — in the grid's own frame, every endpoint must fall back within
      // the (unrotated) bounds, proving the segments are a rotated copy of a normal grid
      // rather than something malformed.
      const aLocal = rotateAroundPivot(a, pivot, -bounds.orientationDeg!);
      const bLocal = rotateAroundPivot(b, pivot, -bounds.orientationDeg!);
      expect(aLocal.north).toBeGreaterThanOrEqual(bounds.minNorth - 1e-6);
      expect(aLocal.north).toBeLessThanOrEqual(bounds.maxNorth + 1e-6);
      expect(bLocal.east).toBeGreaterThanOrEqual(bounds.minEast - 1e-6);
      expect(bLocal.east).toBeLessThanOrEqual(bounds.maxEast + 1e-6);
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
  // A due-north pair keeps the grid compass-aligned (orientationDeg 0), so the grid-fallback
  // assertions below can check simple axis-aligned rounding; rotated-grid snapping has its
  // own dedicated test further down.
  const points = [
    { north: 0, east: 0 },
    { north: 2, east: 0 },
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

  it("snaps to the rotated grid, not a compass-aligned one, when the points are rotated", () => {
    const rotatedPoints = [
      { north: 0, east: 0 },
      { north: 2, east: 2 },
    ];
    const rotatedBounds = computeGridBounds(rotatedPoints)!;
    expect(rotatedBounds.orientationDeg).toBeCloseTo(45, 6);

    // Nudge a point that's already ~on the rotated grid (in its own frame) slightly off —
    // the fallback should snap it back onto the ROTATED grid line, not a nearby compass one.
    const pivot = rotatedBounds.pivot!;
    const onRotatedGridLocal = { north: rotatedBounds.spacing, east: 0 };
    const probeLocal = { north: rotatedBounds.spacing + 0.02, east: 0.02 };
    const probeWorld = rotateAroundPivot(probeLocal, pivot, rotatedBounds.orientationDeg!);

    const target = findSnapTarget(probeWorld, rotatedPoints, rotatedBounds, 0.05);
    expect(target).not.toBeNull();
    const targetLocal = rotateAroundPivot(target!, pivot, -rotatedBounds.orientationDeg!);
    expect(targetLocal.north).toBeCloseTo(onRotatedGridLocal.north, 6);
    expect(targetLocal.east).toBeCloseTo(onRotatedGridLocal.east, 6);
  });
});

describe("computeOrientationDeg", () => {
  it("returns 0 for fewer than 2 points", () => {
    expect(computeOrientationDeg([])).toBe(0);
    expect(computeOrientationDeg([{ north: 3, east: 4 }])).toBe(0);
  });

  it("returns 0 for an isotropic point cloud (e.g. an axis-aligned square)", () => {
    const square = [
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ];
    expect(computeOrientationDeg(square)).toBeCloseTo(0, 6);
  });

  it("returns the bearing of a pure north-south pair as 0", () => {
    expect(computeOrientationDeg([{ north: 0, east: 0 }, { north: 5, east: 0 }])).toBeCloseTo(0, 6);
  });

  it("returns the bearing of a pure east-west pair as ±90", () => {
    const deg = computeOrientationDeg([{ north: 0, east: 0 }, { north: 0, east: 5 }]);
    expect(Math.abs(deg)).toBeCloseTo(90, 6);
  });

  it("returns 45 for a point pair on a 45°-bearing diagonal", () => {
    expect(computeOrientationDeg([{ north: 0, east: 0 }, { north: 3, east: 3 }])).toBeCloseTo(45, 6);
  });

  it("finds a rotated rectangle's true orientation, independent of translation", () => {
    // A 4x2 rectangle rotated 30° clockwise from north, centred away from the origin.
    const angle = 30;
    const pivot = { north: 50, east: -20 };
    const localCorners = [
      { north: -2, east: -1 },
      { north: -2, east: 1 },
      { north: 2, east: 1 },
      { north: 2, east: -1 },
    ];
    const worldCorners = localCorners.map((c) => rotateAroundPivot(c, pivot, angle));
    const deg = computeOrientationDeg(worldCorners);
    // The long axis dominates variance, so the fit should recover ~30° (mod 180, since an
    // axis has no inherent "direction").
    const normalized = ((deg % 180) + 180) % 180;
    expect(normalized).toBeCloseTo(30, 6);
  });
});
