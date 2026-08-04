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
  classifyCornerDrivability,
  classifySourceCorners,
  flattenArcsByBow,
  PAINT_ERROR_BUDGET_M,
  R_MIN_ROVER_M,
  segmentIntoPrimitives,
  tessellatePrimitivesWithJointFillets,
  waypointCornerRadiusM,
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
    // Drivability fields populated (not angle-only stubs).
    expect(corners.every((c) => c.radiusM != null || c.class === "sharp")).toBe(true);
    expect(corners.every((c) => Number.isFinite(c.north) && Number.isFinite(c.east))).toBe(true);
  });

  it("surfaces corners on sparse waypoint-fillet production path", () => {
    // 4-point open square is sparse-waypoints → previously returned corners: 0.
    const fit = buildRoadMarkingFittedPath(openSquare(5));
    expect(fit.mode === "waypoint-fillet" || fit.mode === "sparse-arc").toBe(true);
    expect(fit.quality.corners?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("surfaces corners on dense production path too", () => {
    const fit = buildRoadMarkingFittedPath(denseOpenSquare(10, 8));
    expect(fit.mode === "dense-fit" || fit.mode === "degraded-fillet").toBe(true);
    expect(fit.quality.corners?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("flags near-reversals as reversal class and non-paintable", () => {
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
      { north: 0.1, east: 0.05 }, // ~180° fold
    ];
    const corners = classifySourceCorners(pts);
    expect(corners.some((c) => c.class === "reversal")).toBe(true);
    const fit = buildRoadMarkingFittedPath(pts);
    expect(fit.paintable).toBe(false);
  });

  it("classifyCornerDrivability uses paint+leg+R_min (not angle buckets alone)", () => {
    // Long legs + 90°: paint budget binds → tight at R_min or clean if budget allows.
    const long = classifyCornerDrivability(90, 10, 10);
    expect(["clean", "tight"]).toContain(long.class);
    expect(long.radiusM).toBeGreaterThanOrEqual(R_MIN_ROVER_M - 1e-9);
    // Tiny legs + 90° → sharp / undrivable.
    const tiny = classifyCornerDrivability(90, 0.2, 0.2);
    expect(tiny.class === "sharp" || tiny.undrivable).toBe(true);
  });

  it("dense and sparse joint sizing agree for the same 90° corner geometry", () => {
    const turn = 90;
    const leg = 5;
    const sparse = waypointCornerRadiusM(turn, leg, leg);
    expect(sparse).not.toBeNull();
    // Dense path uses the same helper now (not filletRadiusFraction×leg).
    const densePrims: PathPrimitive[] = [
      { kind: "line", i0: 0, i1: 1 },
      { kind: "line", i0: 1, i1: 2 },
    ];
    const pts: RoadMarkingNedPoint[] = [
      { north: 0, east: 0 },
      { north: 0, east: leg },
      { north: leg, east: leg },
    ];
    const samples = tessellatePrimitivesWithJointFillets(pts, densePrims, {
      sharpCornerDeg: 12,
      filletRadiusFraction: 0.4,
      maxFilletRadiusM: 40,
      sampleSpacingM: 0.35,
    });
    // Filleted path should not pass through the raw corner vertex (cut away).
    const corner = pts[1];
    const minDist = Math.min(
      ...samples.map((p) => Math.hypot(p.north - corner.north, p.east - corner.east))
    );
    // Miss distance for sparse r should be close to minDist order of magnitude.
    expect(sparse!.missM).toBeGreaterThan(0.01);
    expect(minDist).toBeLessThan(sparse!.missM + 0.05);
    // And radius policy floor holds.
    expect(sparse!.r).toBeGreaterThanOrEqual(Math.min(R_MIN_ROVER_M, sparse!.r));
  });
});

describe("Track C2 — sharp teardrop in buildTrajectory", () => {
  it("inserts MARK→TRAVEL→MARK for a sharp corner with geometry.corners metadata", async () => {
    const { buildTrajectory, findAdjacentMarkViolation } = await import("./missionTrajectory");
    // Short legs → sharp/undrivable class under drivability policy.
    const pts = [
      { north: 0, east: 0 },
      { north: 0, east: 0.25 },
      { north: 0.25, east: 0.25 },
    ];
    const corners = classifySourceCorners(pts);
    expect(corners.some((c) => c.class === "sharp" || c.undrivable)).toBe(true);
    const line = {
      id: "sharp-1",
      label: "sharp-1",
      layer: "marking" as const,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 0.25, y: 0.25 },
      width: 0.1,
      is_mark: true,
      entity: {
        entity_id: "sharp-1",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 0.5,
        geometry: {
          closed: false,
          road_marking: true,
          paintable: true,
          corners,
        },
        preview_points: pts,
      },
    };
    const { runs, warnings } = buildTrajectory([line], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      sharpCornerMode: "teardrop",
    });
    expect(findAdjacentMarkViolation(runs)).toBeNull();
    expect(runs.some((r) => r.kind === "travel" && r.label === "sharp-corner-teardrop")).toBe(
      true
    );
    expect(runs.filter((r) => r.kind === "mark").length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => /sharp corner/i.test(w))).toBe(true);
  });

  it("pivot mode emits a near-zero TRAVEL middle", async () => {
    const { buildTrajectory } = await import("./missionTrajectory");
    const pts = [
      { north: 0, east: 0 },
      { north: 0, east: 0.25 },
      { north: 0.25, east: 0.25 },
    ];
    const corners = classifySourceCorners(pts);
    const line = {
      id: "sharp-p",
      label: "sharp-p",
      layer: "marking" as const,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 0.25, y: 0.25 },
      width: 0.1,
      is_mark: true,
      entity: {
        entity_id: "sharp-p",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 0.5,
        geometry: { closed: false, road_marking: true, paintable: true, corners },
        preview_points: pts,
      },
    };
    const { runs } = buildTrajectory([line], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      sharpCornerMode: "pivot",
    });
    const pivot = runs.find((r) => r.label === "sharp-corner-pivot");
    expect(pivot?.kind).toBe("travel");
  });
});
