import { describe, it, expect } from "vitest";
import {
  applyRigidPlanSnap,
  bestSecondaryRotationDeg,
  pinTranslationToRef,
  REF_POINT_SNAP_RADIUS_M,
  type RigidSnapLock,
  type SnapRefPoint,
} from "./rigidRefPointSnap";
import type { LocalMeters } from "./refPointSnap";

const candidates: LocalMeters[] = [
  { north: 0, east: 0 }, // SW corner / center-ish origin of a 10×10 square
  { north: 0, east: 10 },
  { north: 10, east: 10 },
  { north: 10, east: 0 },
  { north: 5, east: 5 }, // center
];

function ref(north: number, east: number, lat = north, lon = east): SnapRefPoint {
  return { north, east, lat, lon };
}

describe("pinTranslationToRef", () => {
  it("translates so free candidate lands on ref", () => {
    const free = { north: 1, east: 2 };
    const target = { north: 4, east: 6 };
    const { x, y } = pinTranslationToRef(10, 20, free, target);
    // free + (dy, dx) = target in (north,east); item.y=north, item.x=east
    expect(y + free.north).toBeCloseTo(target.north + 20 - free.north + free.north, 9);
    // pin: x = newX + (ref.east - free.east) = 10 + (6-2) = 14
    // y = newY + (ref.north - free.north) = 20 + (4-1) = 23
    expect(x).toBeCloseTo(14, 9);
    expect(y).toBeCloseTo(23, 9);
  });
});

describe("applyRigidPlanSnap", () => {
  it("passes through non plan-editing stickers", () => {
    const out = applyRigidPlanSnap({
      itemId: "visual-alignment-group",
      newX: 1,
      newY: 2,
      newRotation: 15,
      newScale: 1.2,
      candidates,
      refs: [ref(0, 0)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
    });
    expect(out.x).toBe(1);
    expect(out.y).toBe(2);
    expect(out.scale).toBe(1.2);
    expect(out.lock).toBeNull();
  });

  it("freezes scale to gesture start (never scale-to-fit)", () => {
    const out = applyRigidPlanSnap({
      itemId: "plan-editing-group",
      newX: 0,
      newY: 0,
      newRotation: 0,
      newScale: 1.5,
      candidates,
      refs: [ref(100, 100)], // far — no snap
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
    });
    expect(out.scale).toBe(1);
  });

  it("acquires primary lock when a corner is within snap radius", () => {
    // Place sticker so candidate (0,0) is near ref (0.1, 0) — dist 0.1 < 0.3
    const out = applyRigidPlanSnap({
      itemId: "plan-editing-group",
      newX: 0.1,
      newY: 0,
      newRotation: 0,
      newScale: 1,
      candidates,
      refs: [ref(0, 0, 1, 2)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
    });
    expect(out.lock).not.toBeNull();
    expect(out.lock!.candidateIndex).toBe(0);
    // Pinned: candidate (0,0) at transform is (y,x)=(newY,newX) → should end on ref (0,0)
    // placed = (0*cos-0*sin)+y = newY, (0*sin+0*cos)+x = newX → free was (0.1 north? wait)
    // north' = newY, east' = newX → free = {north:0, east:0.1} if newX=0.1,newY=0
    // pin to ref(0,0): x = 0.1 + (0-0.1)=0, y = 0+(0-0)=0
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it("holds lock through large rotation about center (pivot pin)", () => {
    const lock: RigidSnapLock = {
      candidateIndex: 1, // (0, 10) — 10 m east of origin
      point: ref(0, 10, 9, 9),
      scale: 1,
    };
    // Rotate 25° about sticker origin — free candidate would move ~4 m (> old 0.6 release)
    const out = applyRigidPlanSnap({
      itemId: "plan-editing-group",
      newX: 0,
      newY: 0,
      newRotation: 25,
      newScale: 1,
      candidates,
      refs: [lock.point],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock,
      gestureStartScale: 1,
    });
    expect(out.lock).not.toBeNull();
    expect(out.lock!.candidateIndex).toBe(1);
    // Locked feature must sit on the ref after pin
    const rad = (25 * Math.PI) / 180;
    // place cand (0,10): n = (0*cos-10*sin)+y = -10*sin, e = (0*sin+10*cos)+x = 10*cos
    // after pin, free maps to ref
    // Verify by placing locked candidate at result transform
    const n =
      (0 * Math.cos(rad) - 10 * Math.sin(rad)) * out.scale + out.y;
    const e =
      (0 * Math.sin(rad) + 10 * Math.cos(rad)) * out.scale + out.x;
    expect(n).toBeCloseTo(lock.point.north, 6);
    expect(e).toBeCloseTo(lock.point.east, 6);
  });

  it("shows guide without locking when only in guide radius", () => {
    // free candidate (0,0) at (0,0); ref at (1.0, 0) — within 1.5 guide, outside 0.3 snap
    const out = applyRigidPlanSnap({
      itemId: "plan-editing-group",
      newX: 0,
      newY: 0,
      newRotation: 0,
      newScale: 1,
      candidates: [{ north: 0, east: 0 }],
      refs: [ref(0, 1.0)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
    });
    expect(out.lock).toBeNull();
    expect(out.guide).not.toBeNull();
    expect(out.guide!.point.east).toBeCloseTo(1.0, 6);
  });

  it("does not acquire when farther than snap radius", () => {
    const out = applyRigidPlanSnap({
      itemId: "plan-editing-group",
      newX: 0,
      newY: 0,
      newRotation: 0,
      newScale: 1,
      candidates: [{ north: 0, east: 0 }],
      refs: [ref(0, REF_POINT_SNAP_RADIUS_M + 0.05)],
      originDxfNorth: 0,
      originDxfEast: 0,
      lock: null,
      gestureStartScale: 1,
    });
    // 0.35 m > 0.3 snap but < 1.5 guide
    expect(out.lock).toBeNull();
    expect(out.guide).not.toBeNull();
  });
});

describe("bestSecondaryRotationDeg size gate", () => {
  it("rejects secondary when plan edge length does not match ref spacing", () => {
    // Plan edge 10 m; refs 12 m apart — must not dual-snap via scale
    const primary = ref(0, 0, 1, 1);
    const result = bestSecondaryRotationDeg({
      candidates: [
        { north: 0, east: 0 },
        { north: 0, east: 10 },
      ],
      refs: [primary, ref(0, 12, 2, 2)],
      primaryIndex: 0,
      primaryRef: primary,
      currentRotationDeg: 0,
      scale: 1,
      originDxfNorth: 0,
      originDxfEast: 0,
      pinnedX: 0,
      pinnedY: 0,
    });
    expect(result).toBeNull();
  });

  it("returns dual-fit rotation when size matches and angle is within magnet", () => {
    const primary = ref(0, 0, 1, 1);
    // Plan edge along +east 10 m; refs along +east 10 m → desired rotation 0
    const result = bestSecondaryRotationDeg({
      candidates: [
        { north: 0, east: 0 },
        { north: 0, east: 10 },
      ],
      refs: [primary, ref(0, 10, 2, 2)],
      primaryIndex: 0,
      primaryRef: primary,
      currentRotationDeg: 0,
      scale: 1,
      originDxfNorth: 0,
      originDxfEast: 0,
      pinnedX: 0,
      pinnedY: 0,
    });
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0, 5);
  });
});
