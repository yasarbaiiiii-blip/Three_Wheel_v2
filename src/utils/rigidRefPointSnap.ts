/**
 * Rigid (SE(2)) reference-point snap for Align DXF Multi-Point Fit plan editing.
 *
 * Product rules:
 * - Translate + rotate only — scale is frozen at the gesture-start value (never scale-to-fit).
 * - Primary lock pins a plan snap feature (corner / mid / center / quadrant) onto a ref point.
 * - While locked, rotation is free about that feature (always re-pin translation after rotate).
 * - Lock holds for the whole gesture (no unlock on rotation-induced free-candidate motion).
 * - Secondary feature may snap only when plan size already matches ref spacing (rigid residual).
 *
 * Geometry is pure local metres. Caller supplies design-space candidates + local-metre refs
 * and the sticker transform (item.x = east, item.y = north — same as transformVisualDxfPoint).
 */

import { transformVisualDxfPoint } from "./visualAlignment";
import { findNearestPointWithinRadius, type LocalMeters } from "./refPointSnap";

/** Guide line appears within this radius (metres). */
export const REF_POINT_GUIDE_RADIUS_M = 1.5;
/** Primary acquire / magnetic snap (metres). */
export const REF_POINT_SNAP_RADIUS_M = 0.3;
/** Second feature residual for dual rigid fit (metres). */
export const SECONDARY_SNAP_M = 0.3;
/** Soft angular magnet toward dual-fit orientation (degrees). */
export const ANGLE_MAGNET_DEG = 2.5;
/** Absolute floor for plan-vs-ref edge length match (metres). */
export const SIZE_TOL_ABS_M = 0.4;
/** Relative plan diagonal fraction for size match. */
export const SIZE_TOL_FRAC = 0.01;

export type SnapRefPoint = LocalMeters & { lat: number; lon: number };

/** Held primary lock for one gesture. */
export type RigidSnapLock = {
  candidateIndex: number;
  point: SnapRefPoint;
  /** Frozen scale for the gesture (never scale-to-fit). */
  scale: number;
};

export type RigidSnapGuide = {
  point: SnapRefPoint;
  anchor: LocalMeters;
};

export type RigidSnapInput = {
  itemId: string;
  newX: number;
  newY: number;
  newRotation: number;
  /** Ignored for plan-editing-group — scale is frozen. */
  newScale: number;
  /** Design-space snap features (stable for the gesture). */
  candidates: LocalMeters[];
  /** Reference points in local metres relative to the same projection origin. */
  refs: SnapRefPoint[];
  originDxfNorth: number;
  originDxfEast: number;
  lock: RigidSnapLock | null;
  /** Scale at drag begin (frozen for Multi-Point Fit). */
  gestureStartScale: number;
};

export type RigidSnapResult = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  guide: RigidSnapGuide | null;
  lock: RigidSnapLock | null;
};

function placeCandidate(
  candidate: LocalMeters,
  x: number,
  y: number,
  rotation: number,
  scale: number,
  originDxfNorth: number,
  originDxfEast: number
): LocalMeters {
  const placed = transformVisualDxfPoint(candidate.north, candidate.east, {
    x,
    y,
    rotation,
    scale,
  });
  return {
    north: placed.north - originDxfNorth,
    east: placed.east - originDxfEast,
  };
}

/** Pure translation so `freeCand` lands exactly on `ref`. */
export function pinTranslationToRef(
  newX: number,
  newY: number,
  freeCand: LocalMeters,
  ref: LocalMeters
): { x: number; y: number } {
  return {
    x: newX + (ref.east - freeCand.east),
    y: newY + (ref.north - freeCand.north),
  };
}

function sizeToleranceM(candidates: LocalMeters[]): number {
  if (candidates.length === 0) return SIZE_TOL_ABS_M;
  let minN = Infinity;
  let maxN = -Infinity;
  let minE = Infinity;
  let maxE = -Infinity;
  for (const c of candidates) {
    if (c.north < minN) minN = c.north;
    if (c.north > maxN) maxN = c.north;
    if (c.east < minE) minE = c.east;
    if (c.east > maxE) maxE = c.east;
  }
  const diagonal = Math.hypot(maxN - minN, maxE - minE);
  return Math.max(SIZE_TOL_ABS_M, diagonal * SIZE_TOL_FRAC);
}

function normalizeAngleDeltaDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Best rigid dual-fit rotation about a primary lock: aligns another candidate to another ref
 * only when plan edge length already matches ref spacing (no scale).
 * Returns null when nothing is within residual / size / angle magnet.
 */
export function bestSecondaryRotationDeg(args: {
  candidates: LocalMeters[];
  refs: SnapRefPoint[];
  primaryIndex: number;
  primaryRef: SnapRefPoint;
  currentRotationDeg: number;
  scale: number;
  originDxfNorth: number;
  originDxfEast: number;
  /** Temporary x/y after primary pin at currentRotation — only used if we need residual check after. */
  pinnedX: number;
  pinnedY: number;
}): number | null {
  const {
    candidates,
    refs,
    primaryIndex,
    primaryRef,
    currentRotationDeg,
    scale,
    originDxfNorth,
    originDxfEast,
    pinnedX,
    pinnedY,
  } = args;

  const primaryCand = candidates[primaryIndex];
  if (!primaryCand) return null;

  const sizeTol = sizeToleranceM(candidates);
  let best: { rotation: number; residual: number } | null = null;

  for (let j = 0; j < candidates.length; j++) {
    if (j === primaryIndex) continue;
    const cj = candidates[j];
    const planDist = Math.hypot(cj.north - primaryCand.north, cj.east - primaryCand.east) * scale;
    if (!(planDist > 1e-6)) continue;

    for (const refQ of refs) {
      // Same physical ref as primary — skip
      if (
        Math.abs(refQ.lat - primaryRef.lat) < 1e-9 &&
        Math.abs(refQ.lon - primaryRef.lon) < 1e-9
      ) {
        continue;
      }
      const refDist = Math.hypot(refQ.north - primaryRef.north, refQ.east - primaryRef.east);
      if (Math.abs(planDist - refDist) > sizeTol) continue;

      // transformVisualDxfPoint relative vector at rotation R:
      //   dn = (dn0 cos − de0 sin)*s, de = (dn0 sin + de0 cos)*s
      // ⇒ atan2(de, dn) = atan2(de0, dn0) + R  (positive scale).
      // Want that equal to the ref edge angle ⇒ R = refAngle − planAngle.
      const dn0 = cj.north - primaryCand.north;
      const de0 = cj.east - primaryCand.east;
      const planAngleNe = (Math.atan2(de0, dn0) * 180) / Math.PI;
      const refDn = refQ.north - primaryRef.north;
      const refDe = refQ.east - primaryRef.east;
      const refAngleNe = (Math.atan2(refDe, refDn) * 180) / Math.PI;
      const R = normalizeAngleDeltaDeg(refAngleNe - planAngleNe);

      // Re-pin primary at R, then measure residual of secondary candidate to refQ.
      const freePrimary = placeCandidate(
        primaryCand,
        pinnedX,
        pinnedY,
        R,
        scale,
        originDxfNorth,
        originDxfEast
      );
      const rePin = pinTranslationToRef(pinnedX, pinnedY, freePrimary, primaryRef);
      const placedJ = placeCandidate(cj, rePin.x, rePin.y, R, scale, originDxfNorth, originDxfEast);
      const residual = Math.hypot(placedJ.north - refQ.north, placedJ.east - refQ.east);
      if (residual > SECONDARY_SNAP_M) continue;

      if (!best || residual < best.residual) {
        best = { rotation: R, residual };
      }
    }
  }

  if (!best) return null;

  // Soft magnet: only pull when user is already close to the dual-fit angle
  const delta = Math.abs(normalizeAngleDeltaDeg(best.rotation - currentRotationDeg));
  if (delta > ANGLE_MAGNET_DEG) return null;
  return best.rotation;
}

/**
 * Apply rigid multi-point snap for the plan-editing sticker.
 * Non plan-editing items pass through; scale is always frozen for plan-editing-group.
 */
export function applyRigidPlanSnap(input: RigidSnapInput): RigidSnapResult {
  const {
    itemId,
    newX,
    newY,
    newRotation,
    candidates,
    refs,
    originDxfNorth,
    originDxfEast,
    lock,
    gestureStartScale,
  } = input;

  // Freeze scale for Multi-Point Fit — ignore pinch scale-to-fit entirely.
  const scale =
    Number.isFinite(gestureStartScale) && gestureStartScale > 0 ? gestureStartScale : 1;

  if (
    itemId !== "plan-editing-group" ||
    candidates.length === 0 ||
    refs.length === 0
  ) {
    return {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale: input.newScale,
      guide: null,
      lock: null,
    };
  }

  // ── Primary lock held for whole gesture: always re-pin, never unlock on rotate ──
  if (lock && lock.candidateIndex >= 0 && lock.candidateIndex < candidates.length) {
    const cand = candidates[lock.candidateIndex];
    const free = placeCandidate(cand, newX, newY, newRotation, scale, originDxfNorth, originDxfEast);
    let pin = pinTranslationToRef(newX, newY, free, lock.point);
    let rotation = newRotation;

    const secondaryRot = bestSecondaryRotationDeg({
      candidates,
      refs,
      primaryIndex: lock.candidateIndex,
      primaryRef: lock.point,
      currentRotationDeg: newRotation,
      scale,
      originDxfNorth,
      originDxfEast,
      pinnedX: pin.x,
      pinnedY: pin.y,
    });
    if (secondaryRot != null) {
      rotation = secondaryRot;
      const free2 = placeCandidate(cand, newX, newY, rotation, scale, originDxfNorth, originDxfEast);
      pin = pinTranslationToRef(newX, newY, free2, lock.point);
    }

    return {
      x: pin.x,
      y: pin.y,
      rotation,
      scale,
      guide: { point: lock.point, anchor: lock.point },
      lock: { ...lock, scale },
    };
  }

  // ── No lock: search nearest candidate↔ref pair ──
  let best: {
    index: number;
    candidate: LocalMeters;
    point: SnapRefPoint;
    dist: number;
  } | null = null;

  for (let index = 0; index < candidates.length; index++) {
    const current = placeCandidate(
      candidates[index],
      newX,
      newY,
      newRotation,
      scale,
      originDxfNorth,
      originDxfEast
    );
    const nearest = findNearestPointWithinRadius(current, refs, REF_POINT_GUIDE_RADIUS_M);
    if (!nearest) continue;
    const dist = Math.hypot(current.north - nearest.north, current.east - nearest.east);
    if (!best || dist < best.dist) {
      best = { index, candidate: current, point: nearest, dist };
    }
  }

  if (!best) {
    return { x: newX, y: newY, rotation: newRotation, scale, guide: null, lock: null };
  }

  if (best.dist > REF_POINT_SNAP_RADIUS_M) {
    return {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale,
      guide: { point: best.point, anchor: best.candidate },
      lock: null,
    };
  }

  // Acquire primary lock and pin
  const nextLock: RigidSnapLock = {
    candidateIndex: best.index,
    point: best.point,
    scale,
  };
  const pin = pinTranslationToRef(newX, newY, best.candidate, best.point);
  return {
    x: pin.x,
    y: pin.y,
    rotation: newRotation,
    scale,
    guide: { point: best.point, anchor: best.point },
    lock: nextLock,
  };
}
