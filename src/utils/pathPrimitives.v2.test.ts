/**
 * Track 0 + A + B harness for PATH_PRIMITIVES_V2.
 * Synthetic fixtures — real CSV goldens can be added under src/test/fixtures/.
 */
import { describe, expect, it } from "vitest";

import {
  collinearAwareMustHitIndices,
  MUST_HIT_PATH_ERROR_M,
} from "../api/planTrajectory";
import {
  PATH_PRIMITIVES_V2,
  pathPrimitivesV2TopDownSegment,
} from "../config/featureFlags";
import {
  buildRoadMarkingFittedPath,
  classifySourceCorners,
  flattenArcsByBow,
  PAINT_ERROR_BUDGET_M,
  segmentIntoPrimitives,
  type PathPrimitive,
  type RoadMarkingNedPoint,
} from "./roadMarkingCsvPath";

function linePts(n: number, spacing = 1): RoadMarkingNedPoint[] {
  return Array.from({ length: n }, (_, i) => ({ north: i * spacing, east: 0 }));
}

function quarterCircle(r: number, count: number): RoadMarkingNedPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / (count - 1)) * (Math.PI / 2);
    return { north: r * Math.sin(a), east: r * Math.cos(a) };
  });
}

/** Axis-aligned square (open, last ≠ first) — four 90° corners. */
function openSquare(side: number): RoadMarkingNedPoint[] {
  return [
    { north: 0, east: 0 },
    { north: 0, east: side },
    { north: side, east: side },
    { north: side, east: 0 },
  ];
}

/** Dense open square with intermediate stakes on each edge. */
function denseOpenSquare(side: number, perEdge: number): RoadMarkingNedPoint[] {
  const pts: RoadMarkingNedPoint[] = [];
  const edges: Array<[RoadMarkingNedPoint, RoadMarkingNedPoint]> = [
    [
      { north: 0, east: 0 },
      { north: 0, east: side },
    ],
    [
      { north: 0, east: side },
      { north: side, east: side },
    ],
    [
      { north: side, east: side },
      { north: side, east: 0 },
    ],
  ];
  for (const [a, b] of edges) {
    for (let i = 0; i < perEdge; i++) {
      const t = i / perEdge;
      pts.push({
        north: a.north + (b.north - a.north) * t,
        east: a.east + (b.east - a.east) * t,
      });
    }
  }
  pts.push({ north: side, east: 0 });
  return pts;
}

const SEG_OPTS = {
  fitToleranceM: 0.08,
  minArcPoints: 4,
  maxArcRadiusM: 5000,
} as const;

describe("PATH_PRIMITIVES_V2 policy", () => {
  it("exports paint budget and enables top-down in production default", () => {
    expect(PAINT_ERROR_BUDGET_M).toBe(0.15);
    expect(PATH_PRIMITIVES_V2).toBe("full");
    expect(pathPrimitivesV2TopDownSegment()).toBe(true);
  });
});

describe("Track A — must_hit by path error", () => {
  it("declares exactly 2 on a long straight densification", () => {
    const pts: [number, number][] = Array.from({ length: 86 }, (_, i) => [
      i * 0.35,
      0,
    ]);
    expect(collinearAwareMustHitIndices(pts)).toEqual([0, 85]);
  });

  it("thins a dense circular arc while staying within 15 mm", () => {
    const r = 10;
    const points: [number, number][] = Array.from({ length: 80 }, (_, i) => {
      const a = (i / 79) * (Math.PI / 2);
      return [r * Math.sin(a), r * Math.cos(a)] as [number, number];
    });
    const declared = collinearAwareMustHitIndices(points);
    expect(declared.length).toBeLessThan(points.length);
    expect(declared.length).toBeGreaterThan(2);
    for (let k = 0; k < declared.length - 1; k++) {
      const i0 = declared[k];
      const i1 = declared[k + 1];
      let maxD = 0;
      for (let i = i0 + 1; i < i1; i++) {
        const a = points[i0];
        const b = points[i1];
        const ab0 = b[0] - a[0];
        const ab1 = b[1] - a[1];
        const len2 = ab0 * ab0 + ab1 * ab1;
        let t =
          len2 < 1e-18
            ? 0
            : ((points[i][0] - a[0]) * ab0 + (points[i][1] - a[1]) * ab1) / len2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(
          points[i][0] - (a[0] + ab0 * t),
          points[i][1] - (a[1] + ab1 * t)
        );
        if (d > maxD) maxD = d;
      }
      expect(maxD).toBeLessThanOrEqual(MUST_HIT_PATH_ERROR_M + 1e-6);
    }
  });
});

describe("Track B — top-down segmentation", () => {
  it("classifies a long straight as a single line", () => {
    const prims = segmentIntoPrimitives(linePts(40, 0.5), SEG_OPTS);
    expect(prims.length).toBe(1);
    expect(prims[0].kind).toBe("line");
  });

  it("keeps a clean quarter-circle as arc (or few primitives)", () => {
    const prims = segmentIntoPrimitives(quarterCircle(12, 25), SEG_OPTS);
    expect(prims.some((p) => p.kind === "arc")).toBe(true);
  });

  it("does not fit a sparse square as one circle (30° corner guard)", () => {
    const prims = segmentIntoPrimitives(openSquare(4), {
      fitToleranceM: 0.05,
      minArcPoints: 4,
      maxArcRadiusM: 5000,
    });
    // 4 vertices: top-down splits at 90° corners → multiple lines, never one arc.
    expect(prims.every((p) => p.kind === "line")).toBe(true);
    expect(prims.length).toBeGreaterThanOrEqual(2);
  });

  it("dense square facets into lines not one arc", () => {
    const prims = segmentIntoPrimitives(denseOpenSquare(10, 8), SEG_OPTS);
    expect(prims.some((p) => p.kind === "arc")).toBe(false);
    expect(prims.every((p) => p.kind === "line")).toBe(true);
  });

  it("flattenArcsByBow turns flat giant-R arcs into lines", () => {
    // Nearly straight: large R, small bow.
    const pts = linePts(10, 2).map((p, i) => ({
      north: p.north,
      east: 0.001 * i * i, // tiny bow
    }));
    const fakeArc: PathPrimitive = {
      kind: "arc",
      i0: 0,
      i1: pts.length - 1,
      circle: { cn: 0, ce: -500, r: 500 },
    };
    const flat = flattenArcsByBow(pts, [fakeArc], PAINT_ERROR_BUDGET_M);
    expect(flat[0].kind).toBe("line");
  });
});

describe("Track C — corner classification", () => {
  it("labels 90° square vertices as corners (not gentle arcs)", () => {
    const corners = classifySourceCorners(openSquare(5));
    expect(corners.length).toBe(2); // open path: two interior vertices
    expect(corners.every((c) => c.turnDeg > 80)).toBe(true);
    expect(corners.every((c) => c.class === "clean" || c.class === "tight" || c.class === "sharp")).toBe(
      true
    );
  });

  it("surfaces corners on sparse waypoint-fillet production path", () => {
    // 4-point open square is sparse-waypoints → previously returned corners: 0.
    const fit = buildRoadMarkingFittedPath(openSquare(5));
    expect(fit.mode === "waypoint-fillet" || fit.mode === "sparse-arc").toBe(true);
    expect(fit.quality.corners?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("flags near-reversals as reversal class", () => {
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
      { north: 0.1, east: 0.05 }, // ~180° fold
    ];
    const corners = classifySourceCorners(pts);
    expect(corners.some((c) => c.class === "reversal")).toBe(true);
  });
});
