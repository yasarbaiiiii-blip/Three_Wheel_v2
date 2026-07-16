import { describe, it, expect } from "vitest";
import { findNearestPointWithinRadius } from "./refPointSnap";

describe("findNearestPointWithinRadius", () => {
  const points = [
    { north: 0, east: 0 },
    { north: 2, east: 0 },
    { north: 2, east: 2 },
  ];

  it("returns the closest point within radius", () => {
    const target = findNearestPointWithinRadius({ north: 0.05, east: -0.05 }, points, 0.3);
    expect(target).toEqual({ north: 0, east: 0 });
  });

  it("picks the nearest of several candidates within radius", () => {
    const target = findNearestPointWithinRadius({ north: 2.05, east: 0.1 }, points, 1.5);
    expect(target).toEqual({ north: 2, east: 0 });
  });

  it("returns null when nothing is within radius", () => {
    expect(findNearestPointWithinRadius({ north: 10, east: 10 }, points, 0.3)).toBeNull();
  });

  it("returns null for an empty point list", () => {
    expect(findNearestPointWithinRadius({ north: 0, east: 0 }, [], 0.3)).toBeNull();
  });

  it("ignores non-finite current position", () => {
    expect(findNearestPointWithinRadius({ north: NaN, east: 0 }, points, 0.3)).toBeNull();
  });

  it("ignores non-finite candidate points", () => {
    const withJunk = [{ north: NaN, east: NaN }, ...points];
    const target = findNearestPointWithinRadius({ north: 0.05, east: -0.05 }, withJunk, 0.3);
    expect(target).toEqual({ north: 0, east: 0 });
  });

  it("treats radius as exclusive-at-boundary (strictly less than)", () => {
    expect(findNearestPointWithinRadius({ north: 0.3, east: 0 }, points, 0.3)).toBeNull();
    expect(findNearestPointWithinRadius({ north: 0.29, east: 0 }, points, 0.3)).toEqual({ north: 0, east: 0 });
  });
});
