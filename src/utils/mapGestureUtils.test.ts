import { describe, it, expect } from "vitest";
import {
  pixelDeltaToMetres,
  calculateCentroid,
  rotateAroundCentroid,
  scaleAroundCentroid,
  clampToIndent,
  snapDistanceCheck,
  type Point2D,
  type BoundingRect,
} from "./mapGestureUtils";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/** Tolerance for floating-point comparisons (sub-millimetre). */
const TOLERANCE = 0.001;

function expectClose(actual: number, expected: number, tol = TOLERANCE) {
  expect(Math.abs(actual - expected)).toBeLessThan(tol);
}

function expectPointClose(
  actual: Point2D,
  expected: Point2D,
  tol = TOLERANCE
) {
  expectClose(actual.north, expected.north, tol);
  expectClose(actual.east, expected.east, tol);
}

// ─────────────────────────────────────────────────────────────────
// 1. pixelDeltaToMetres
// ─────────────────────────────────────────────────────────────────

describe("pixelDeltaToMetres", () => {
  it("converts pure east movement (dx > 0, dy = 0)", () => {
    const r = pixelDeltaToMetres(10, 0, 0.5);
    expectClose(r.eastDelta, 5);
    expectClose(r.northDelta, 0);
  });

  it("converts pure south movement (dx = 0, dy > 0) → negative north", () => {
    const r = pixelDeltaToMetres(0, 8, 1);
    expectClose(r.northDelta, -8);
    expectClose(r.eastDelta, 0);
  });

  it("converts north-east diagonal", () => {
    const r = pixelDeltaToMetres(3, -4, 2); // dy negative = screen up = north
    expectClose(r.eastDelta, 6);
    expectClose(r.northDelta, 8);
  });

  it("returns zero delta for zero pixel movement", () => {
    const r = pixelDeltaToMetres(0, 0, 100);
    expectClose(r.eastDelta, 0);
    expectClose(r.northDelta, 0);
  });

  it("scales linearly with metersPerPixel", () => {
    const a = pixelDeltaToMetres(5, 0, 1);
    const b = pixelDeltaToMetres(5, 0, 2);
    expectClose(b.eastDelta, a.eastDelta * 2);
  });

  it("handles negative pixel deltas (westward drag)", () => {
    const r = pixelDeltaToMetres(-7, 0, 1);
    expectClose(r.eastDelta, -7);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. calculateCentroid
// ─────────────────────────────────────────────────────────────────

describe("calculateCentroid", () => {
  it("returns origin for an empty array", () => {
    expectPointClose(calculateCentroid([]), { north: 0, east: 0 });
  });

  it("returns the point itself for a single point", () => {
    expectPointClose(calculateCentroid([{ north: 5, east: 10 }]), {
      north: 5,
      east: 10,
    });
  });

  it("returns the midpoint for two symmetric points", () => {
    const pts: Point2D[] = [
      { north: -5, east: 0 },
      { north: 5, east: 0 },
    ];
    expectPointClose(calculateCentroid(pts), { north: 0, east: 0 });
  });

  it("handles all negative coordinates", () => {
    const pts: Point2D[] = [
      { north: -10, east: -20 },
      { north: -6, east: -10 },
    ];
    expectPointClose(calculateCentroid(pts), { north: -8, east: -15 });
  });

  it("computes correct centroid for four points", () => {
    const pts: Point2D[] = [
      { north: 0, east: 0 },
      { north: 0, east: 10 },
      { north: 10, east: 10 },
      { north: 10, east: 0 },
    ];
    expectPointClose(calculateCentroid(pts), { north: 5, east: 5 });
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. rotateAroundCentroid
// ─────────────────────────────────────────────────────────────────

describe("rotateAroundCentroid", () => {
  const centroid: Point2D = { north: 0, east: 0 };

  it("zero rotation returns original points unchanged", () => {
    const pts: Point2D[] = [{ north: 5, east: 3 }];
    expectPointClose(rotateAroundCentroid(pts, centroid, 0)[0], pts[0]);
  });

  it("90° CW rotation: north point becomes east point", () => {
    // north=5, east=0 rotated 90° CW around origin → north=0, east=5
    const result = rotateAroundCentroid(
      [{ north: 5, east: 0 }],
      centroid,
      90
    );
    expectPointClose(result[0], { north: 0, east: 5 });
  });

  it("180° rotation inverts point through centroid", () => {
    const result = rotateAroundCentroid(
      [{ north: 3, east: 4 }],
      centroid,
      180
    );
    expectPointClose(result[0], { north: -3, east: -4 });
  });

  it("360° rotation is a no-op", () => {
    const pt = { north: 7, east: -2 };
    const result = rotateAroundCentroid([pt], centroid, 360);
    expectPointClose(result[0], pt);
  });

  it("rotates around a non-origin centroid", () => {
    const c: Point2D = { north: 5, east: 5 };
    const pt: Point2D = { north: 10, east: 5 }; // 5 N of centroid
    // 90° CW around c: north→east, so result should be { north: 5, east: 10 }
    const result = rotateAroundCentroid([pt], c, 90);
    expectPointClose(result[0], { north: 5, east: 10 });
  });

  it("does not mutate the input array", () => {
    const pts: Point2D[] = [{ north: 1, east: 2 }];
    rotateAroundCentroid(pts, centroid, 45);
    expect(pts[0].north).toBe(1);
    expect(pts[0].east).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. scaleAroundCentroid
// ─────────────────────────────────────────────────────────────────

describe("scaleAroundCentroid", () => {
  const centroid: Point2D = { north: 0, east: 0 };

  it("scale 1.0 is a no-op", () => {
    const pt = { north: 4, east: 6 };
    expectPointClose(scaleAroundCentroid([pt], centroid, 1)[0], pt);
  });

  it("scale 2.0 doubles distance from centroid", () => {
    const result = scaleAroundCentroid(
      [{ north: 5, east: 0 }],
      centroid,
      2
    );
    expectPointClose(result[0], { north: 10, east: 0 });
  });

  it("scale 0.5 halves distance from centroid", () => {
    const result = scaleAroundCentroid(
      [{ north: 0, east: 8 }],
      centroid,
      0.5
    );
    expectPointClose(result[0], { north: 0, east: 4 });
  });

  it("scales around a non-origin centroid", () => {
    const c: Point2D = { north: 5, east: 5 };
    const pt: Point2D = { north: 10, east: 5 }; // 5 N from centroid
    const result = scaleAroundCentroid([pt], c, 2);
    expectPointClose(result[0], { north: 15, east: 5 }); // 10 N from centroid
  });

  it("does not mutate the input array", () => {
    const pts: Point2D[] = [{ north: 3, east: 3 }];
    scaleAroundCentroid(pts, centroid, 3);
    expect(pts[0].north).toBe(3);
    expect(pts[0].east).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. clampToIndent
// ─────────────────────────────────────────────────────────────────

describe("clampToIndent", () => {
  const indent: BoundingRect = {
    leftEast: 0,
    rightEast: 100,
    bottomNorth: 0,
    topNorth: 100,
  };

  it("leaves a point already inside the indent unchanged", () => {
    const r = clampToIndent(50, 50, 5, 5, indent);
    expect(r.east).toBe(50);
    expect(r.north).toBe(50);
  });

  it("clamps east beyond right edge", () => {
    const r = clampToIndent(98, 50, 5, 5, indent);
    expect(r.east).toBe(95); // rightEast(100) - halfWidth(5)
  });

  it("clamps east below left edge", () => {
    const r = clampToIndent(2, 50, 5, 5, indent);
    expect(r.east).toBe(5); // leftEast(0) + halfWidth(5)
  });

  it("clamps north beyond top edge", () => {
    const r = clampToIndent(50, 98, 5, 5, indent);
    expect(r.north).toBe(95); // topNorth(100) - halfHeight(5)
  });

  it("clamps north below bottom edge", () => {
    const r = clampToIndent(50, 2, 5, 5, indent);
    expect(r.north).toBe(5); // bottomNorth(0) + halfHeight(5)
  });

  it("clamps a corner (both axes beyond bounds)", () => {
    const r = clampToIndent(105, 105, 5, 5, indent);
    expect(r.east).toBe(95);
    expect(r.north).toBe(95);
  });

  it("handles item larger than indent (clamped to centre of region)", () => {
    // halfWidth 60 > 50 available, so both edges clamp to the same point
    const r = clampToIndent(50, 50, 60, 60, indent);
    // leftEast + halfWidth > rightEast - halfWidth → both clamp to the respective edge
    // left: 0+60=60, right: 100-60=40 → max(60, min(50, 40)) = 60 — left wins
    expect(r.east).toBe(60);
    expect(r.north).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. snapDistanceCheck
// ─────────────────────────────────────────────────────────────────

describe("snapDistanceCheck", () => {
  const rover: Point2D = { north: 10, east: 20 };

  it("returns target when point is exactly at target (distance = 0)", () => {
    const result = snapDistanceCheck(rover, rover);
    expect(result).toEqual(rover);
  });

  it("returns target when distance < threshold (default 3 m)", () => {
    const point: Point2D = { north: 11, east: 20 }; // 1 m north
    expect(snapDistanceCheck(point, rover)).toEqual(rover);
  });

  it("returns target when distance equals threshold exactly", () => {
    const point: Point2D = { north: 13, east: 20 }; // exactly 3 m
    expect(snapDistanceCheck(point, rover)).toEqual(rover);
  });

  it("returns null when distance > threshold", () => {
    const point: Point2D = { north: 14, east: 20 }; // 4 m > 3 m
    expect(snapDistanceCheck(point, rover)).toBeNull();
  });

  it("respects a custom threshold", () => {
    const point: Point2D = { north: 10, east: 24 }; // 4 m east
    expect(snapDistanceCheck(point, rover, 5)).toEqual(rover);
    expect(snapDistanceCheck(point, rover, 3)).toBeNull();
  });

  it("works with negative coordinates", () => {
    const neg: Point2D = { north: -5, east: -5 };
    const near: Point2D = { north: -5, east: -4 }; // 1 m away
    expect(snapDistanceCheck(near, neg)).toEqual(neg);
  });

  it("handles diagonal distances correctly", () => {
    // 3-4-5 right triangle → distance = 5 m > 3 m default
    const point: Point2D = { north: 13, east: 24 }; // +3N, +4E from rover
    expect(snapDistanceCheck(point, rover)).toBeNull();
    // same triangle, threshold = 6 → within
    expect(snapDistanceCheck(point, rover, 6)).toEqual(rover);
  });
});
