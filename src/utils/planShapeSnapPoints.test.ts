import { describe, it, expect } from "vitest";
import { computeShapeSnapPoints, type LocalMeters } from "./planShapeSnapPoints";
import type { PlanLine } from "../types/plan";

let nextId = 1;

function segLine(from: LocalMeters, to: LocalMeters): PlanLine {
  const id = `seg-${nextId++}`;
  return {
    id,
    label: id,
    layer: "boundary",
    from: { id: nextId++, x: from.north, y: from.east },
    to: { id: nextId++, x: to.north, y: to.east },
    width: 0.1,
  };
}

/** Straight-segment outline of a closed polygon given its vertices in order. */
function polygonLines(vertices: LocalMeters[]): PlanLine[] {
  const lines: PlanLine[] = [];
  for (let i = 0; i < vertices.length; i++) {
    lines.push(segLine(vertices[i], vertices[(i + 1) % vertices.length]));
  }
  return lines;
}

/** Many-segment tessellated ellipse/circle outline (no DxfEntity trickery needed — the plain
 *  from/to point cloud alone is enough to exercise the ellipse-fit path). */
function ellipseLines(centerNorth: number, centerEast: number, radiusNorth: number, radiusEast: number, steps = 64): PlanLine[] {
  const vertices: LocalMeters[] = [];
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    vertices.push({
      north: centerNorth + radiusNorth * Math.cos(angle),
      east: centerEast + radiusEast * Math.sin(angle),
    });
  }
  return polygonLines(vertices);
}

function hasPointClose(points: LocalMeters[], target: LocalMeters, tolerance = 1e-6): boolean {
  return points.some((p) => Math.abs(p.north - target.north) < tolerance && Math.abs(p.east - target.east) < tolerance);
}

describe("computeShapeSnapPoints", () => {
  it("returns [] for an empty plan", () => {
    expect(computeShapeSnapPoints([])).toEqual([]);
  });

  it("returns a single point for a fully degenerate (coincident) plan", () => {
    const lines = [segLine({ north: 3, east: 4 }, { north: 3, east: 4 })];
    const points = computeShapeSnapPoints(lines);
    expect(points).toEqual([{ north: 3, east: 4 }]);
  });

  it("gives a rectangle 9 points: 4 corners + 4 edge-midpoints + 1 center", () => {
    const lines = polygonLines([
      { north: 0, east: 0 },
      { north: 0, east: 4 },
      { north: 3, east: 4 },
      { north: 3, east: 0 },
    ]);
    const points = computeShapeSnapPoints(lines);
    expect(points.length).toBe(9);
    for (const corner of [{ north: 0, east: 0 }, { north: 0, east: 4 }, { north: 3, east: 4 }, { north: 3, east: 0 }]) {
      expect(hasPointClose(points, corner)).toBe(true);
    }
    for (const mid of [{ north: 0, east: 2 }, { north: 1.5, east: 4 }, { north: 3, east: 2 }, { north: 1.5, east: 0 }]) {
      expect(hasPointClose(points, mid)).toBe(true);
    }
    expect(hasPointClose(points, { north: 1.5, east: 2 })).toBe(true);
  });

  it("gives a square 9 points too (same rule as rectangle)", () => {
    const lines = polygonLines([
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ]);
    expect(computeShapeSnapPoints(lines).length).toBe(9);
  });

  it("gives a triangle 7 points: 3 corners + 3 edge-midpoints + 1 center", () => {
    const lines = polygonLines([
      { north: 0, east: 0 },
      { north: 4, east: 0 },
      { north: 0, east: 3 },
    ]);
    const points = computeShapeSnapPoints(lines);
    expect(points.length).toBe(7);
    for (const corner of [{ north: 0, east: 0 }, { north: 4, east: 0 }, { north: 0, east: 3 }]) {
      expect(hasPointClose(points, corner)).toBe(true);
    }
  });

  it("gives a pentagon 11 points: 5 corners + 5 edge-midpoints + 1 center", () => {
    const vertices: LocalMeters[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (2 * Math.PI * i) / 5;
      vertices.push({ north: 10 * Math.cos(angle), east: 10 * Math.sin(angle) });
    }
    const lines = polygonLines(vertices);
    expect(computeShapeSnapPoints(lines).length).toBe(11);
  });

  it("does NOT misclassify a low-vertex polygon (hexagon) as a circle", () => {
    const vertices: LocalMeters[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (2 * Math.PI * i) / 6;
      vertices.push({ north: 5 * Math.cos(angle), east: 5 * Math.sin(angle) });
    }
    const lines = polygonLines(vertices);
    // 6 corners + 6 edge-midpoints + 1 center = 13, NOT the 5-point circle set.
    expect(computeShapeSnapPoints(lines).length).toBe(13);
  });

  it("gives a circle 5 points: center + 4 quadrants", () => {
    const lines = ellipseLines(0, 0, 5, 5);
    const points = computeShapeSnapPoints(lines);
    expect(points.length).toBe(5);
    expect(hasPointClose(points, { north: 0, east: 0 }, 1e-3)).toBe(true);
    for (const quadrant of [{ north: 5, east: 0 }, { north: -5, east: 0 }, { north: 0, east: 5 }, { north: 0, east: -5 }]) {
      expect(hasPointClose(points, quadrant, 1e-3)).toBe(true);
    }
  });

  it("gives an oval (unequal radii) 5 points: center + 4 quadrants at its own radii", () => {
    const lines = ellipseLines(10, -20, 5, 2);
    const points = computeShapeSnapPoints(lines);
    expect(points.length).toBe(5);
    expect(hasPointClose(points, { north: 10, east: -20 }, 1e-3)).toBe(true);
    for (const quadrant of [
      { north: 15, east: -20 },
      { north: 5, east: -20 },
      { north: 10, east: -18 },
      { north: 10, east: -22 },
    ]) {
      expect(hasPointClose(points, quadrant, 1e-3)).toBe(true);
    }
  });

  it("is robust to a complex multi-segment spray path: interior zigzag noise doesn't change the rectangle's hull", () => {
    const boundary = polygonLines([
      { north: 0, east: 0 },
      { north: 0, east: 10 },
      { north: 6, east: 10 },
      { north: 6, east: 0 },
    ]);
    // Simulate a multi-pass spray path: many short segments strictly inside the boundary.
    const interior: PlanLine[] = [];
    let prev: LocalMeters = { north: 1, east: 1 };
    for (let i = 0; i < 60; i++) {
      const next: LocalMeters = {
        north: 1 + ((i * 37) % 4), // stays within (0,6)
        east: 1 + ((i * 53) % 8), // stays within (0,10)
      };
      interior.push(segLine(prev, next));
      prev = next;
    }
    const points = computeShapeSnapPoints([...boundary, ...interior]);
    // Still exactly the rectangle's 9-point set — interior clutter must not add candidates.
    expect(points.length).toBe(9);
    for (const corner of [{ north: 0, east: 0 }, { north: 0, east: 10 }, { north: 6, east: 10 }, { north: 6, east: 0 }]) {
      expect(hasPointClose(points, corner)).toBe(true);
    }
  });

  it("collapses a straight-line (2-point) plan to endpoints + midpoint, not a duplicated edge", () => {
    const lines = [segLine({ north: 0, east: 0 }, { north: 4, east: 0 })];
    const points = computeShapeSnapPoints(lines);
    expect(points.length).toBe(3);
    expect(hasPointClose(points, { north: 0, east: 0 })).toBe(true);
    expect(hasPointClose(points, { north: 4, east: 0 })).toBe(true);
    expect(hasPointClose(points, { north: 2, east: 0 })).toBe(true);
  });
});
