/**
 * Similarity (scale + rotate + translate) reference-point snap for Align DXF Multi-Point Fit.
 *
 * Scale is always applied about the **placed primary pin** (the plan feature on the yellow
 * ref), never as a free balloon about design origin:
 *   world − primaryRef = s · R · (design − primaryDesign)
 * Soft magnet interpolates only s and R, then re-pins primary every frame.
 *
 * Break-away: free pose past release radius → free drag (no glue).
 */

import { transformVisualDxfPoint } from "./visualAlignment";
import { findNearestPointWithinRadius, type LocalMeters } from "./refPointSnap";
import {
  pinTranslationToRef,
  type SnapRefPoint,
} from "./rigidRefPointSnap";

/** Soft approach / guide line radius (metres). */
export const SIMILARITY_GUIDE_RADIUS_M = 1.5;
/** Hard snap residual after similarity (metres) — must be tight to avoid sticky grab. */
export const SIMILARITY_SNAP_RADIUS_M = 0.25;
/** Soft blend starts inside this residual (metres). */
export const SIMILARITY_SOFT_RADIUS_M = 0.75;
/** Max soft-blend alpha (light magnet — user always leads the drag). */
export const SIMILARITY_SOFT_ALPHA_MAX = 0.28;
/** Drag this far past the pin (free pose) to release any lock (metres). */
export const SIMILARITY_RELEASE_RADIUS_M = 0.85;
/** Soft angular magnet for dual-fit consideration (degrees). */
export const SIMILARITY_ANGLE_MAGNET_DEG = 12;
/** Reject absurd scales (CAD vs survey unit mismatch). */
export const MIN_SIMILARITY_SCALE = 0.01;
export const MAX_SIMILARITY_SCALE = 100;

export type SimilaritySnapLock = {
  primaryCandidateIndex: number;
  primaryRef: SnapRefPoint;
  secondaryCandidateIndex: number | null;
  secondaryRef: SnapRefPoint | null;
  scale: number;
  rotation: number;
};

export type SimilaritySnapGuide = {
  point: SnapRefPoint;
  anchor: LocalMeters;
};

export type SimilaritySnapInput = {
  itemId: string;
  newX: number;
  newY: number;
  newRotation: number;
  newScale: number;
  candidates: LocalMeters[];
  refs: SnapRefPoint[];
  originDxfNorth: number;
  originDxfEast: number;
  lock: SimilaritySnapLock | null;
  gestureStartScale: number;
  /**
   * When true, prefer reusing last lock if still near — but ALWAYS allow break-away.
   * Never freezes the plan for the whole gesture.
   */
  holdLock: boolean;
};

export type SimilaritySnapResult = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  guide: SimilaritySnapGuide | null;
  lock: SimilaritySnapLock | null;
  /** True when dual-ref residual is currently within hard snap (for commit-time attach UI). */
  attached: boolean;
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

function normalizeAngleDeltaDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(MAX_SIMILARITY_SCALE, Math.max(MIN_SIMILARITY_SCALE, s));
}

function sameRef(a: SnapRefPoint, b: SnapRefPoint): boolean {
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function softAlpha(residual: number): number {
  if (residual <= SIMILARITY_SNAP_RADIUS_M) return 1;
  if (residual >= SIMILARITY_SOFT_RADIUS_M) return 0;
  const t =
    1 -
    (residual - SIMILARITY_SNAP_RADIUS_M) /
      (SIMILARITY_SOFT_RADIUS_M - SIMILARITY_SNAP_RADIUS_M);
  return SIMILARITY_SOFT_ALPHA_MAX * Math.max(0, Math.min(1, t));
}

/**
 * Pose with primary design feature fixed on primaryRef at the given scale+rotation.
 * Growth/shrink is about that placed pin (not design origin balloon).
 */
export function poseAboutPrimaryPin(args: {
  primaryCand: LocalMeters;
  primaryRef: LocalMeters;
  rotationDeg: number;
  scale: number;
  originDxfNorth?: number;
  originDxfEast?: number;
}): { x: number; y: number; rotation: number; scale: number } {
  const originDxfNorth = args.originDxfNorth ?? 0;
  const originDxfEast = args.originDxfEast ?? 0;
  const scale = clampScale(args.scale);
  const free = placeCandidate(
    args.primaryCand,
    0,
    0,
    args.rotationDeg,
    scale,
    originDxfNorth,
    originDxfEast
  );
  const pin = pinTranslationToRef(0, 0, free, args.primaryRef);
  return {
    x: pin.x,
    y: pin.y,
    rotation: args.rotationDeg,
    scale,
  };
}

/**
 * Soft dual magnet: blend only scale + rotation toward dual, then ALWAYS re-pin primary.
 * Never lerp x/y independently of scale (that caused center-balloon scale).
 */
export function blendTowardDualAboutPrimary(args: {
  primaryCand: LocalMeters;
  primaryRef: LocalMeters;
  dualScale: number;
  dualRotationDeg: number;
  dualX: number;
  dualY: number;
  userRotationDeg: number;
  userScale: number;
  alpha: number;
  hard: boolean;
  originDxfNorth?: number;
  originDxfEast?: number;
}): { x: number; y: number; rotation: number; scale: number } {
  if (args.hard || args.alpha >= 1) {
    return {
      x: args.dualX,
      y: args.dualY,
      rotation: args.dualRotationDeg,
      scale: clampScale(args.dualScale),
    };
  }
  const scale = lerp(args.userScale, args.dualScale, args.alpha);
  const dRot = normalizeAngleDeltaDeg(args.dualRotationDeg - args.userRotationDeg);
  const rotation = args.userRotationDeg + dRot * args.alpha;
  return poseAboutPrimaryPin({
    primaryCand: args.primaryCand,
    primaryRef: args.primaryRef,
    rotationDeg: rotation,
    scale,
    originDxfNorth: args.originDxfNorth,
    originDxfEast: args.originDxfEast,
  });
}

/**
 * Exact 2-point similarity in local NE.
 * Scale/rotation from edge vectors; translation pins primary (scale about pin).
 */
export function solveTwoPointSimilarity(args: {
  primaryCand: LocalMeters;
  secondaryCand: LocalMeters;
  primaryRef: LocalMeters;
  secondaryRef: LocalMeters;
  originDxfNorth?: number;
  originDxfEast?: number;
}): { scale: number; rotationDeg: number; x: number; y: number } | null {
  const {
    primaryCand,
    secondaryCand,
    primaryRef,
    secondaryRef,
    originDxfNorth = 0,
    originDxfEast = 0,
  } = args;
  const dn0 = secondaryCand.north - primaryCand.north;
  const de0 = secondaryCand.east - primaryCand.east;
  const planDist = Math.hypot(dn0, de0);
  if (!(planDist > 1e-9)) return null;

  const refDn = secondaryRef.north - primaryRef.north;
  const refDe = secondaryRef.east - primaryRef.east;
  const refDist = Math.hypot(refDn, refDe);
  if (!(refDist > 1e-9)) return null;

  const scale = clampScale(refDist / planDist);
  const planAngle = (Math.atan2(de0, dn0) * 180) / Math.PI;
  const refAngle = (Math.atan2(refDe, refDn) * 180) / Math.PI;
  const rotationDeg = normalizeAngleDeltaDeg(refAngle - planAngle);

  const pinned = poseAboutPrimaryPin({
    primaryCand,
    primaryRef,
    rotationDeg,
    scale,
    originDxfNorth,
    originDxfEast,
  });
  return {
    scale: pinned.scale,
    rotationDeg: pinned.rotation,
    x: pinned.x,
    y: pinned.y,
  };
}

function residualAfter(
  candidates: LocalMeters[],
  x: number,
  y: number,
  rotation: number,
  scale: number,
  originDxfNorth: number,
  originDxfEast: number,
  index: number,
  ref: LocalMeters
): number {
  const p = placeCandidate(
    candidates[index],
    x,
    y,
    rotation,
    scale,
    originDxfNorth,
    originDxfEast
  );
  return Math.hypot(p.north - ref.north, p.east - ref.east);
}

/**
 * Best secondary candidate/ref pair for similarity dual-fit about a primary.
 */
export function bestSecondarySimilarity(args: {
  candidates: LocalMeters[];
  refs: SnapRefPoint[];
  primaryIndex: number;
  primaryRef: SnapRefPoint;
  originDxfNorth: number;
  originDxfEast: number;
  currentRotationDeg: number;
  preferScale: number;
}): {
  secondaryIndex: number;
  secondaryRef: SnapRefPoint;
  scale: number;
  rotation: number;
  x: number;
  y: number;
  residual: number;
} | null {
  const {
    candidates,
    refs,
    primaryIndex,
    primaryRef,
    originDxfNorth,
    originDxfEast,
    currentRotationDeg,
    preferScale,
  } = args;
  const primaryCand = candidates[primaryIndex];
  if (!primaryCand) return null;

  let best: {
    secondaryIndex: number;
    secondaryRef: SnapRefPoint;
    scale: number;
    rotation: number;
    x: number;
    y: number;
    residual: number;
    score: number;
  } | null = null;

  for (let j = 0; j < candidates.length; j++) {
    if (j === primaryIndex) continue;
    const cj = candidates[j];
    for (const refQ of refs) {
      if (sameRef(refQ, primaryRef)) continue;
      const solved = solveTwoPointSimilarity({
        primaryCand,
        secondaryCand: cj,
        primaryRef,
        secondaryRef: refQ,
        originDxfNorth,
        originDxfEast,
      });
      if (!solved) continue;

      const resP = residualAfter(
        candidates,
        solved.x,
        solved.y,
        solved.rotationDeg,
        solved.scale,
        originDxfNorth,
        originDxfEast,
        primaryIndex,
        primaryRef
      );
      const resS = residualAfter(
        candidates,
        solved.x,
        solved.y,
        solved.rotationDeg,
        solved.scale,
        originDxfNorth,
        originDxfEast,
        j,
        refQ
      );
      const residual = Math.max(resP, resS);
      if (residual > SIMILARITY_GUIDE_RADIUS_M) continue;

      const angleDelta = Math.abs(
        normalizeAngleDeltaDeg(solved.rotationDeg - currentRotationDeg)
      );
      const scaleDelta = Math.abs(Math.log(solved.scale / Math.max(preferScale, 1e-6)));
      const score = residual + angleDelta * 0.02 + scaleDelta * 0.1;

      if (!best || score < best.score) {
        best = {
          secondaryIndex: j,
          secondaryRef: refQ,
          scale: solved.scale,
          rotation: solved.rotationDeg,
          x: solved.x,
          y: solved.y,
          residual,
          score,
        };
      }
    }
  }

  if (!best) return null;
  return {
    secondaryIndex: best.secondaryIndex,
    secondaryRef: best.secondaryRef,
    scale: best.scale,
    rotation: best.rotation,
    x: best.x,
    y: best.y,
    residual: best.residual,
  };
}

function freePrimaryDistToRef(args: {
  candidates: LocalMeters[];
  primaryIndex: number;
  ref: SnapRefPoint;
  newX: number;
  newY: number;
  newRotation: number;
  scale: number;
  originDxfNorth: number;
  originDxfEast: number;
}): number {
  const cand = args.candidates[args.primaryIndex];
  if (!cand) return Infinity;
  const free = placeCandidate(
    cand,
    args.newX,
    args.newY,
    args.newRotation,
    args.scale,
    args.originDxfNorth,
    args.originDxfEast
  );
  return Math.hypot(free.north - args.ref.north, free.east - args.ref.east);
}

/**
 * Apply similarity multi-point snap for plan-editing-group.
 * Light magnet + easy break-away; scale always about the primary pin when magnetized.
 */
export function applySimilarityPlanSnap(input: SimilaritySnapInput): SimilaritySnapResult {
  const {
    itemId,
    newX,
    newY,
    newRotation,
    newScale,
    candidates,
    refs,
    originDxfNorth,
    originDxfEast,
    lock,
    gestureStartScale,
    holdLock,
  } = input;

  const baseScale =
    Number.isFinite(gestureStartScale) && gestureStartScale > 0
      ? gestureStartScale
      : Number.isFinite(newScale) && newScale > 0
        ? newScale
        : 1;

  if (itemId !== "plan-editing-group" || candidates.length === 0 || refs.length === 0) {
    return {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale: newScale,
      guide: null,
      lock: null,
      attached: false,
    };
  }

  // ── Break-away: free pose far from last pin → free this frame (no instant re-grab) ──
  let activeLock: SimilaritySnapLock | null = holdLock ? lock : null;
  if (activeLock) {
    const breakDist = freePrimaryDistToRef({
      candidates,
      primaryIndex: activeLock.primaryCandidateIndex,
      ref: activeLock.primaryRef,
      newX,
      newY,
      newRotation,
      scale: baseScale,
      originDxfNorth,
      originDxfEast,
    });
    if (breakDist > SIMILARITY_RELEASE_RADIUS_M) {
      const cand = candidates[activeLock.primaryCandidateIndex];
      return {
        x: newX,
        y: newY,
        rotation: newRotation,
        scale: baseScale,
        guide: cand
          ? {
              point: activeLock.primaryRef,
              anchor: placeCandidate(
                cand,
                newX,
                newY,
                newRotation,
                baseScale,
                originDxfNorth,
                originDxfEast
              ),
            }
          : null,
        lock: null,
        attached: false,
      };
    }
  }

  function freeFeatureDist(candidateIndex: number, refPt: SnapRefPoint): number {
    const cand = candidates[candidateIndex];
    if (!cand) return Infinity;
    const free = placeCandidate(
      cand,
      newX,
      newY,
      newRotation,
      baseScale,
      originDxfNorth,
      originDxfEast
    );
    return Math.hypot(free.north - refPt.north, free.east - refPt.east);
  }

  // ── Prefer locked dual pair while free primary is still near ──
  if (
    activeLock &&
    activeLock.secondaryCandidateIndex != null &&
    activeLock.secondaryRef &&
    candidates[activeLock.secondaryCandidateIndex]
  ) {
    const primary = candidates[activeLock.primaryCandidateIndex];
    if (primary) {
      const freeRes = freeFeatureDist(
        activeLock.primaryCandidateIndex,
        activeLock.primaryRef
      );
      if (freeRes > SIMILARITY_RELEASE_RADIUS_M) {
        return {
          x: newX,
          y: newY,
          rotation: newRotation,
          scale: baseScale,
          guide: {
            point: activeLock.primaryRef,
            anchor: placeCandidate(
              primary,
              newX,
              newY,
              newRotation,
              baseScale,
              originDxfNorth,
              originDxfEast
            ),
          },
          lock: null,
          attached: false,
        };
      }
      const solved = solveTwoPointSimilarity({
        primaryCand: primary,
        secondaryCand: candidates[activeLock.secondaryCandidateIndex],
        primaryRef: activeLock.primaryRef,
        secondaryRef: activeLock.secondaryRef,
        originDxfNorth,
        originDxfEast,
      });
      if (solved) {
        const alpha = softAlpha(freeRes);
        if (alpha <= 0) {
          return {
            x: newX,
            y: newY,
            rotation: newRotation,
            scale: baseScale,
            guide: {
              point: activeLock.primaryRef,
              anchor: placeCandidate(
                primary,
                newX,
                newY,
                newRotation,
                baseScale,
                originDxfNorth,
                originDxfEast
              ),
            },
            lock: null,
            attached: false,
          };
        }
        const hard = freeRes <= SIMILARITY_SNAP_RADIUS_M;
        const pose = blendTowardDualAboutPrimary({
          primaryCand: primary,
          primaryRef: activeLock.primaryRef,
          dualScale: solved.scale,
          dualRotationDeg: solved.rotationDeg,
          dualX: solved.x,
          dualY: solved.y,
          userRotationDeg: newRotation,
          userScale: baseScale,
          alpha,
          hard,
          originDxfNorth,
          originDxfEast,
        });
        const nextLock: SimilaritySnapLock = {
          ...activeLock,
          scale: pose.scale,
          rotation: pose.rotation,
        };
        return {
          x: pose.x,
          y: pose.y,
          rotation: pose.rotation,
          scale: pose.scale,
          guide: { point: activeLock.primaryRef, anchor: activeLock.primaryRef },
          lock: hard || alpha > 0 ? nextLock : null,
          attached: hard,
        };
      }
    }
  }

  // ── Search nearest free candidate↔ref ──
  let bestPrimary: {
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
      baseScale,
      originDxfNorth,
      originDxfEast
    );
    const nearest = findNearestPointWithinRadius(current, refs, SIMILARITY_GUIDE_RADIUS_M);
    if (!nearest) continue;
    const dist = Math.hypot(current.north - nearest.north, current.east - nearest.east);
    if (!bestPrimary || dist < bestPrimary.dist) {
      bestPrimary = { index, candidate: current, point: nearest, dist };
    }
  }

  if (!bestPrimary) {
    return {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale: baseScale,
      guide: null,
      lock: null,
      attached: false,
    };
  }

  // Dual-fit — blend s/R about primary pin (never lerp translation alone)
  if (refs.length >= 2) {
    const dual = bestSecondarySimilarity({
      candidates,
      refs,
      primaryIndex: bestPrimary.index,
      primaryRef: bestPrimary.point,
      originDxfNorth,
      originDxfEast,
      currentRotationDeg: newRotation,
      preferScale: baseScale,
    });
    if (dual) {
      const freeRes = bestPrimary.dist;
      const alpha = softAlpha(freeRes);
      if (alpha > 0) {
        const hard = freeRes <= SIMILARITY_SNAP_RADIUS_M;
        const primary = candidates[bestPrimary.index];
        const pose = blendTowardDualAboutPrimary({
          primaryCand: primary,
          primaryRef: bestPrimary.point,
          dualScale: dual.scale,
          dualRotationDeg: dual.rotation,
          dualX: dual.x,
          dualY: dual.y,
          userRotationDeg: newRotation,
          userScale: baseScale,
          alpha,
          hard,
          originDxfNorth,
          originDxfEast,
        });
        const nextLock: SimilaritySnapLock | null = hard
          ? {
              primaryCandidateIndex: bestPrimary.index,
              primaryRef: bestPrimary.point,
              secondaryCandidateIndex: dual.secondaryIndex,
              secondaryRef: dual.secondaryRef,
              scale: pose.scale,
              rotation: pose.rotation,
            }
          : null;
        return {
          x: pose.x,
          y: pose.y,
          rotation: pose.rotation,
          scale: pose.scale,
          guide: {
            point: bestPrimary.point,
            anchor: placeCandidate(
              primary,
              pose.x,
              pose.y,
              pose.rotation,
              pose.scale,
              originDxfNorth,
              originDxfEast
            ),
          },
          lock: nextLock,
          attached: hard,
        };
      }
    }
  }

  // Guide / soft primary pin (translation only at free scale — pin about contact)
  if (bestPrimary.dist > SIMILARITY_SNAP_RADIUS_M) {
    if (bestPrimary.dist <= SIMILARITY_SOFT_RADIUS_M) {
      // Soft translate only (no scale change) — re-pin primary partially via lerp of pin
      // Toward full pin about contact; scale stays user scale.
      const fullPin = poseAboutPrimaryPin({
        primaryCand: candidates[bestPrimary.index],
        primaryRef: bestPrimary.point,
        rotationDeg: newRotation,
        scale: baseScale,
        originDxfNorth,
        originDxfEast,
      });
      const alpha = softAlpha(bestPrimary.dist);
      // Soft primary: blend translation toward pin at fixed scale (scale-about-pin when fully pinned)
      return {
        x: lerp(newX, fullPin.x, alpha),
        y: lerp(newY, fullPin.y, alpha),
        rotation: newRotation,
        scale: baseScale,
        guide: { point: bestPrimary.point, anchor: bestPrimary.candidate },
        lock: null,
        attached: false,
      };
    }
    return {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale: baseScale,
      guide: { point: bestPrimary.point, anchor: bestPrimary.candidate },
      lock: null,
      attached: false,
    };
  }

  // Primary very close: hard pin at free scale (rotation free about pin)
  const pinned = poseAboutPrimaryPin({
    primaryCand: candidates[bestPrimary.index],
    primaryRef: bestPrimary.point,
    rotationDeg: newRotation,
    scale: baseScale,
    originDxfNorth,
    originDxfEast,
  });
  const nextLock: SimilaritySnapLock = {
    primaryCandidateIndex: bestPrimary.index,
    primaryRef: bestPrimary.point,
    secondaryCandidateIndex: null,
    secondaryRef: null,
    scale: baseScale,
    rotation: newRotation,
  };
  return {
    x: pinned.x,
    y: pinned.y,
    rotation: pinned.rotation,
    scale: pinned.scale,
    guide: { point: bestPrimary.point, anchor: bestPrimary.point },
    lock: nextLock,
    attached: false,
  };
}
