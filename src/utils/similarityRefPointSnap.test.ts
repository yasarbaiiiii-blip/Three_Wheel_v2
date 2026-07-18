import { describe, it, expect } from "vitest";
import {
  applySimilarityPlanSnap,
  solveTwoPointSimilarity,
  bestSecondarySimilarity,
  poseAboutPrimaryPin,
  blendTowardDualAboutPrimary,
  SIMILARITY_SNAP_RADIUS_M,
  SIMILARITY_RELEASE_RADIUS_M,
} from "./similarityRefPointSnap";
import { transformVisualDxfPoint } from "./visualAlignment";
import type { LocalMeters } from "./refPointSnap";
import type { SnapRefPoint } from "./rigidRefPointSnap";

const square: LocalMeters[] = [
  { north: 0, east: 0 },
  { north: 0, east: 10 },
  { north: 10, east: 10 },
  { north: 10, east: 0 },
];

function ref(north: number, east: number, lat = north, lon = east): SnapRefPoint {
  return { north, east, lat, lon };
}

function place(
  cand: LocalMeters,
  x: number,
  y: number,
  rotation: number,
  scale: number
): LocalMeters {
  const p = transformVisualDxfPoint(cand.north, cand.east, { x, y, rotation, scale });
  return { north: p.north, east: p.east };
}

describe("poseAboutPrimaryPin", () => {
  it("keeps primary on the ref when scale changes", () => {
    const primary = { north: 2, east: 3 };
    const primaryRef = { north: 10, east: 20 };
    const a = poseAboutPrimaryPin({
      primaryCand: primary,
      primaryRef,
      rotationDeg: 0,
      scale: 1,
    });
    const b = poseAboutPrimaryPin({
      primaryCand: primary,
      primaryRef,
      rotationDeg: 0,
      scale: 1.5,
    });
    const pa = place(primary, a.x, a.y, a.rotation, a.scale);
    const pb = place(primary, b.x, b.y, b.rotation, b.scale);
    expect(pa.north).toBeCloseTo(primaryRef.north, 9);
    expect(pa.east).toBeCloseTo(primaryRef.east, 9);
    expect(pb.north).toBeCloseTo(primaryRef.north, 9);
    expect(pb.east).toBeCloseTo(primaryRef.east, 9);
  });

  it("expands a far point away from the pin when scale increases", () => {
    const primary = { north: 0, east: 0 };
    const far = { north: 0, east: 10 };
    const primaryRef = { north: 0, east: 0 };
    const s1 = poseAboutPrimaryPin({
      primaryCand: primary,
      primaryRef,
      rotationDeg: 0,
      scale: 1,
    });
    const s2 = poseAboutPrimaryPin({
      primaryCand: primary,
      primaryRef,
      rotationDeg: 0,
      scale: 2,
    });
    const f1 = place(far, s1.x, s1.y, s1.rotation, s1.scale);
    const f2 = place(far, s2.x, s2.y, s2.rotation, s2.scale);
    // Far point moves from 10m east to 20m east — radial from pin, not center balloon
    expect(f1.east).toBeCloseTo(10, 6);
    expect(f2.east).toBeCloseTo(20, 6);
    expect(f1.north).toBeCloseTo(0, 6);
    expect(f2.north).toBeCloseTo(0, 6);
  });
});

describe("blendTowardDualAboutPrimary", () => {
  it("keeps primary pinned during soft scale blend", () => {
    const primary = { north: 0, east: 0 };
    const primaryRef = { north: 5, east: 5 };
    const dual = solveTwoPointSimilarity({
      primaryCand: primary,
      secondaryCand: { north: 0, east: 10 },
      primaryRef,
      secondaryRef: { north: 5, east: 17 }, // 12 m edge → scale 1.2
    })!;
    const soft = blendTowardDualAboutPrimary({
      primaryCand: primary,
      primaryRef,
      dualScale: dual.scale,
      dualRotationDeg: dual.rotationDeg,
      dualX: dual.x,
      dualY: dual.y,
      userRotationDeg: 0,
      userScale: 1,
      alpha: 0.5,
      hard: false,
    });
    const p = place(primary, soft.x, soft.y, soft.rotation, soft.scale);
    expect(p.north).toBeCloseTo(primaryRef.north, 6);
    expect(p.east).toBeCloseTo(primaryRef.east, 6);
    expect(soft.scale).toBeGreaterThan(1);
    expect(soft.scale).toBeLessThan(dual.scale);
  });
});

describe("solveTwoPointSimilarity", () => {
  it("scales a 10 m edge onto a 12 m ref edge", () => {
    const solved = solveTwoPointSimilarity({
      primaryCand: { north: 0, east: 0 },
      secondaryCand: { north: 0, east: 10 },
      primaryRef: { north: 0, east: 0 },
      secondaryRef: { north: 0, east: 12 },
    });
    expect(solved).not.toBeNull();
    expect(solved!.scale).toBeCloseTo(1.2, 6);
    expect(solved!.rotationDeg).toBeCloseTo(0, 5);
    const p = place({ north: 0, east: 0 }, solved!.x, solved!.y, solved!.rotationDeg, solved!.scale);
    expect(p.north).toBeCloseTo(0, 9);
    expect(p.east).toBeCloseTo(0, 9);
  });

  it("rotates and scales to match angled refs", () => {
    const solved = solveTwoPointSimilarity({
      primaryCand: { north: 0, east: 0 },
      secondaryCand: { north: 0, east: 10 },
      primaryRef: { north: 0, east: 0 },
      secondaryRef: { north: 20, east: 0 },
    });
    expect(solved).not.toBeNull();
    expect(solved!.scale).toBeCloseTo(2, 6);
    expect(Math.abs(solved!.rotationDeg)).toBeCloseTo(90, 4);
  });
});

describe("applySimilarityPlanSnap", () => {
  it("passes through non plan-editing stickers", () => {
    const out = applySimilarityPlanSnap({
      itemId: "visual-alignment-group",
      newX: 1,
      newY: 2,
      newRotation: 15,
      newScale: 1.2,
      candidates: square,
      refs: [ref(0, 0)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
      holdLock: false,
    });
    expect(out.scale).toBe(1.2);
    expect(out.attached).toBe(false);
  });

  it("scale-to-fits when two refs match a plan edge (attach) and pins primary", () => {
    const out = applySimilarityPlanSnap({
      itemId: "plan-editing-group",
      newX: 0.05,
      newY: 0,
      newRotation: 0,
      newScale: 1,
      candidates: square,
      refs: [ref(0, 0, 1, 1), ref(0, 12, 2, 2)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
      holdLock: false,
    });
    expect(out.attached).toBe(true);
    expect(out.scale).toBeCloseTo(1.2, 5);
    expect(out.lock).not.toBeNull();
    const p = place(square[0], out.x, out.y, out.rotation, out.scale);
    expect(p.north).toBeCloseTo(0, 5);
    expect(p.east).toBeCloseTo(0, 5);
  });

  it("primary-only pin without attach when single ref is very close", () => {
    const out = applySimilarityPlanSnap({
      itemId: "plan-editing-group",
      newX: 0.1,
      newY: 0,
      newRotation: 0,
      newScale: 1,
      candidates: [{ north: 0, east: 0 }],
      refs: [ref(0, 0, 1, 2)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
      holdLock: false,
    });
    expect(out.lock).not.toBeNull();
    expect(out.attached).toBe(false);
    expect(out.scale).toBe(1);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(0, 5);
  });

  it("breaks away when free pose is past release radius", () => {
    const lock = {
      primaryCandidateIndex: 0,
      primaryRef: ref(0, 0, 1, 1),
      secondaryCandidateIndex: 1 as number | null,
      secondaryRef: ref(0, 12, 2, 2) as SnapRefPoint | null,
      scale: 1.2,
      rotation: 0,
    };
    const far = SIMILARITY_RELEASE_RADIUS_M + 1.5;
    const out = applySimilarityPlanSnap({
      itemId: "plan-editing-group",
      newX: far,
      newY: 0,
      newRotation: 0,
      newScale: 1,
      candidates: square,
      refs: [lock.primaryRef, lock.secondaryRef!],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock,
      gestureStartScale: 1,
      holdLock: true,
    });
    expect(out.attached).toBe(false);
    expect(out.lock).toBeNull();
    expect(out.x).toBeCloseTo(far, 5);
  });

  it("soft-blends (does not hard-lock) when only moderately near dual fit", () => {
    const out = applySimilarityPlanSnap({
      itemId: "plan-editing-group",
      newX: 0.5,
      newY: 0.5,
      newRotation: 15,
      newScale: 1,
      candidates: square,
      refs: [ref(0, 0, 1, 1), ref(0, 12, 2, 2)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
      holdLock: false,
    });
    if (!out.attached) {
      expect(out.lock).toBeNull();
    }
  });
});

describe("bestSecondarySimilarity", () => {
  it("finds scale for mismatched edge lengths", () => {
    const result = bestSecondarySimilarity({
      candidates: [
        { north: 0, east: 0 },
        { north: 0, east: 10 },
      ],
      refs: [ref(0, 0, 1, 1), ref(0, 15, 2, 2)],
      primaryIndex: 0,
      primaryRef: ref(0, 0, 1, 1),
      originDxfNorth: 0,
      originDxfEast: 0,
      currentRotationDeg: 0,
      preferScale: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.scale).toBeCloseTo(1.5, 5);
    expect(result!.residual).toBeLessThanOrEqual(SIMILARITY_SNAP_RADIUS_M);
  });
});
