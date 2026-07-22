/**
 * Figma-style OBB resize handles for the plan-editing sticker.
 *
 * Design-space half-extents come from item.width/height (bbox). World placement:
 *   n = (dn cos − de sin) * scale + item.y
 *   e = (dn sin + de cos) * scale + item.x
 * (same as MapViewNative bbox ring / transformVisualDxfPoint convention).
 */

export type PlanStickerPose = {
  x: number; // east
  y: number; // north
  rotation: number; // deg
  scale: number;
  /**
   * Optional independent axis scales (design north / east before rotation).
   * When omitted, both axes use `scale` (uniform). Edge-handle resize sets these.
   */
  scaleNorth?: number;
  scaleEast?: number;
  /** East extent of design-space OBB (metres). */
  width: number;
  /** North extent of design-space OBB (metres). */
  height: number;
  /**
   * Design-space centre of the OBB (PlanPoint: north/east). Defaults to 0,0 for
   * templates whose geometry is already centred. Absolute DXF plans use the
   * real bbox mid so handles/box sit on the plan, not at design origin.
   */
  designCenterNorth?: number;
  designCenterEast?: number;
};

export const MIN_AXIS_SCALE = 0.01;
export const MAX_AXIS_SCALE = 100;
/** Minimum design-space half-span after axis resize (metres). */
export const MIN_AXIS_HALF_M = 0.05;

export function effectiveScaleNorth(pose: Pick<PlanStickerPose, "scale" | "scaleNorth">): number {
  const s = pose.scaleNorth ?? pose.scale;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

export function effectiveScaleEast(pose: Pick<PlanStickerPose, "scale" | "scaleEast">): number {
  const s = pose.scaleEast ?? pose.scale;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

export function isCornerHandleId(id: HandleId): boolean {
  return id === "nw" || id === "ne" || id === "se" || id === "sw";
}

export function isEdgeHandleId(id: HandleId): boolean {
  return id === "n" || id === "e" || id === "s" || id === "w";
}

/** Four edge-midpoint handles only (n/e/s/w) — Resize-mode UI. */
export function getEdgeResizeHandles(pose: PlanStickerPose): ResizeHandle[] {
  return getObbResizeHandles(pose).filter((h) => isEdgeHandleId(h.id));
}

/**
 * Map-bearing (degrees clockwise from north) for an outward arrow on an edge handle.
 * Matches Mapbox `icon-rotate` / symbol rotation convention when the map is north-up;
 * callers may add camera bearing if needed.
 */
export function edgeHandleArrowBearingDeg(handleId: HandleId, poseRotationDeg: number): number {
  const base =
    handleId === "n"
      ? 0
      : handleId === "e"
        ? 90
        : handleId === "s"
          ? 180
          : handleId === "w"
            ? 270
            : 0;
  return ((poseRotationDeg || 0) + base + 360) % 360;
}

/** World-space edge mids for hit-test / render. */
export function getEdgeHandleWorldPoints(
  pose: PlanStickerPose
): Array<ResizeHandle & WorldPoint> {
  return getEdgeResizeHandles(pose).map((h) => {
    const w = designOffsetToWorld(h.designNorth, h.designEast, pose);
    return { ...h, north: w.north, east: w.east };
  });
}

export type HandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w";

export type ResizeHandle = {
  id: HandleId;
  /** Design-space offset from plan center (north, east) before rotation/scale. */
  designNorth: number;
  designEast: number;
  /** Opposite corner/edge for uniform scale anchor. */
  oppositeId: HandleId;
};

export type WorldPoint = { north: number; east: number };

const OPPOSITE: Record<HandleId, HandleId> = {
  nw: "se",
  n: "s",
  ne: "sw",
  e: "w",
  se: "nw",
  s: "n",
  sw: "ne",
  w: "e",
};

export const MIN_RESIZE_SCALE = 0.01;
export const MAX_RESIZE_SCALE = 100;
/** Baseline hit radius in local metres (map space). Prefer {@link handleHitRadiusM} at runtime. */
export const HANDLE_HIT_RADIUS_M = 2.5;

/**
 * Finger-friendly handle hit radius in world metres.
 * Combines a screen-pixel target (mpp × px) with a fraction of the OBB so large
 * plans / zoomed-out cameras still register, without swallowing the whole map.
 */
export function handleHitRadiusM(
  metersPerPixel: number,
  pose: Pick<PlanStickerPose, "width" | "height" | "scale" | "scaleNorth" | "scaleEast">,
  pixelTarget = 40
): number {
  const mpp =
    Number.isFinite(metersPerPixel) && metersPerPixel > 0 ? metersPerPixel : 0.05;
  const halfN =
    ((Number.isFinite(pose.height) ? pose.height : 0) / 2) * effectiveScaleNorth(pose);
  const halfE =
    ((Number.isFinite(pose.width) ? pose.width : 0) / 2) * effectiveScaleEast(pose);
  const span = Math.min(
    Number.isFinite(halfN) && halfN > 0 ? halfN : Infinity,
    Number.isFinite(halfE) && halfE > 0 ? halfE : Infinity
  );
  const fromSpan = Number.isFinite(span) ? Math.min(span * 0.35, 30) : 0;
  return Math.max(HANDLE_HIT_RADIUS_M, mpp * pixelTarget, fromSpan);
}

export function designOffsetToWorld(
  designNorth: number,
  designEast: number,
  pose: PlanStickerPose
): WorldPoint {
  const sN = effectiveScaleNorth(pose);
  const sE = effectiveScaleEast(pose);
  const sn = designNorth * sN;
  const se = designEast * sE;
  const rad = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    north: sn * cos - se * sin + pose.y,
    east: sn * sin + se * cos + pose.x,
  };
}

/** Inverse of designOffsetToWorld — world → absolute design north/east. */
export function worldToDesignPoint(world: WorldPoint, pose: PlanStickerPose): {
  designNorth: number;
  designEast: number;
} {
  const sN = effectiveScaleNorth(pose);
  const sE = effectiveScaleEast(pose);
  const dn = world.north - pose.y;
  const de = world.east - pose.x;
  const rad = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Inverse rotation (scale applied in design axes before rotate).
  const sn = dn * cos + de * sin;
  const se = -dn * sin + de * cos;
  return {
    designNorth: sN > 1e-12 ? sn / sN : 0,
    designEast: sE > 1e-12 ? se / sE : 0,
  };
}

/** Eight OBB handles in absolute design coords (centre ± half extents). */
export function getObbResizeHandles(pose: PlanStickerPose): ResizeHandle[] {
  const halfN = (Number.isFinite(pose.height) ? pose.height : 0) / 2;
  const halfE = (Number.isFinite(pose.width) ? pose.width : 0) / 2;
  const cN = Number.isFinite(pose.designCenterNorth) ? (pose.designCenterNorth as number) : 0;
  const cE = Number.isFinite(pose.designCenterEast) ? (pose.designCenterEast as number) : 0;
  const defs: Array<{ id: HandleId; dn: number; de: number }> = [
    { id: "nw", dn: cN + halfN, de: cE - halfE },
    { id: "n", dn: cN + halfN, de: cE },
    { id: "ne", dn: cN + halfN, de: cE + halfE },
    { id: "e", dn: cN, de: cE + halfE },
    { id: "se", dn: cN - halfN, de: cE + halfE },
    { id: "s", dn: cN - halfN, de: cE },
    { id: "sw", dn: cN - halfN, de: cE - halfE },
    { id: "w", dn: cN, de: cE - halfE },
  ];
  return defs.map((d) => ({
    id: d.id,
    designNorth: d.dn,
    designEast: d.de,
    oppositeId: OPPOSITE[d.id],
  }));
}

/** Design-space OBB centre + extents from plan lines (legacy minX=north, minY=east). */
export function designObbFromLines(lines: { from?: { x?: number; y?: number }; to?: { x?: number; y?: number } }[]): {
  designCenterNorth: number;
  designCenterEast: number;
  width: number;
  height: number;
} {
  let minN = Infinity;
  let maxN = -Infinity;
  let minE = Infinity;
  let maxE = -Infinity;
  for (const l of lines) {
    for (const p of [l.from, l.to]) {
      if (!p) continue;
      const n = p.x;
      const e = p.y;
      if (typeof n === "number" && Number.isFinite(n)) {
        if (n < minN) minN = n;
        if (n > maxN) maxN = n;
      }
      if (typeof e === "number" && Number.isFinite(e)) {
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
      }
    }
  }
  if (!Number.isFinite(minN) || !Number.isFinite(minE)) {
    return { designCenterNorth: 0, designCenterEast: 0, width: 0, height: 0 };
  }
  return {
    designCenterNorth: (minN + maxN) / 2,
    designCenterEast: (minE + maxE) / 2,
    width: Math.max(0, maxE - minE),
    height: Math.max(0, maxN - minN),
  };
}

export function getHandleWorldPoints(
  pose: PlanStickerPose
): Array<ResizeHandle & WorldPoint> {
  return getObbResizeHandles(pose).map((h) => {
    const w = designOffsetToWorld(h.designNorth, h.designEast, pose);
    return { ...h, north: w.north, east: w.east };
  });
}

/**
 * Uniform scale about a fixed world anchor (opposite handle stays put).
 */
export function scaleAboutDesignAnchor(
  pose: PlanStickerPose,
  newScale: number,
  anchorDesignNorth: number,
  anchorDesignEast: number
): PlanStickerPose {
  const s = Math.min(
    MAX_RESIZE_SCALE,
    Math.max(MIN_RESIZE_SCALE, Number.isFinite(newScale) && newScale > 0 ? newScale : pose.scale)
  );
  const oldWorld = designOffsetToWorld(anchorDesignNorth, anchorDesignEast, pose);
  const next: PlanStickerPose = {
    ...pose,
    scale: s,
    scaleNorth: s,
    scaleEast: s,
  };
  const newWorld = designOffsetToWorld(anchorDesignNorth, anchorDesignEast, next);
  return {
    ...next,
    y: pose.y + (oldWorld.north - newWorld.north),
    x: pose.x + (oldWorld.east - newWorld.east),
  };
}

/**
 * Apply uniform scale from dragging `activeHandle` so opposite corner stays fixed.
 * `cursor` is the current drag position in the same world frame as handle world points.
 */
export function applyHandleResize(args: {
  pose: PlanStickerPose;
  activeHandle: ResizeHandle;
  oppositeHandle: ResizeHandle;
  cursor: WorldPoint;
}): PlanStickerPose {
  const { pose, activeHandle, oppositeHandle, cursor } = args;
  const anchor = designOffsetToWorld(
    oppositeHandle.designNorth,
    oppositeHandle.designEast,
    pose
  );
  const startHandle = designOffsetToWorld(
    activeHandle.designNorth,
    activeHandle.designEast,
    pose
  );
  const startDist = Math.hypot(startHandle.north - anchor.north, startHandle.east - anchor.east);
  if (!(startDist > 1e-9)) return pose;

  const curDist = Math.hypot(cursor.north - anchor.north, cursor.east - anchor.east);
  if (!(curDist > 1e-9)) return pose;

  // Ratio of distances from fixed anchor → scale multiplier relative to current pose scale
  // at gesture start the caller should pass start pose; here pose is start pose.
  const base = Math.max(effectiveScaleNorth(pose), effectiveScaleEast(pose), pose.scale, 1e-9);
  const newScale = base * (curDist / startDist);
  return scaleAboutDesignAnchor(
    pose,
    newScale,
    oppositeHandle.designNorth,
    oppositeHandle.designEast
  );
}

/**
 * Edge-handle resize: change only one design axis (width = east, height = north),
 * keep rotation and the opposite edge fixed in world.
 */
export function applyAxisResize(args: {
  pose: PlanStickerPose;
  activeHandle: ResizeHandle;
  oppositeHandle: ResizeHandle;
  cursor: WorldPoint;
}): PlanStickerPose {
  const { pose, activeHandle, oppositeHandle, cursor } = args;
  if (isCornerHandleId(activeHandle.id)) {
    return applyHandleResize(args);
  }

  const sN0 = effectiveScaleNorth(pose);
  const sE0 = effectiveScaleEast(pose);
  const rad = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // World unit vectors for design-north / design-east axes after rotation.
  const northAxis: WorldPoint = { north: cos, east: sin };
  const eastAxis: WorldPoint = { north: -sin, east: cos };

  const alongEast = activeHandle.id === "e" || activeHandle.id === "w";
  const axis = alongEast ? eastAxis : northAxis;

  const anchor = designOffsetToWorld(
    oppositeHandle.designNorth,
    oppositeHandle.designEast,
    pose
  );
  const startActive = designOffsetToWorld(
    activeHandle.designNorth,
    activeHandle.designEast,
    pose
  );

  const startSpan =
    (startActive.north - anchor.north) * axis.north +
    (startActive.east - anchor.east) * axis.east;
  const curSpan =
    (cursor.north - anchor.north) * axis.north + (cursor.east - anchor.east) * axis.east;
  if (!(Math.abs(startSpan) > 1e-9)) return pose;
  // Prevent flipping through the opposite edge.
  if (startSpan * curSpan <= 0) return pose;

  const ratio = curSpan / startSpan;
  if (!(Number.isFinite(ratio) && ratio > 0)) return pose;

  let nextSN = sN0;
  let nextSE = sE0;
  if (alongEast) {
    nextSE = Math.min(MAX_AXIS_SCALE, Math.max(MIN_AXIS_SCALE, sE0 * ratio));
  } else {
    nextSN = Math.min(MAX_AXIS_SCALE, Math.max(MIN_AXIS_SCALE, sN0 * ratio));
  }

  // Reject absurdly small world spans (0.1 m design half-extent after scale).
  const halfN = (Number.isFinite(pose.height) ? pose.height : 0) / 2;
  const halfE = (Number.isFinite(pose.width) ? pose.width : 0) / 2;
  if (halfN * nextSN < MIN_AXIS_HALF_M || halfE * nextSE < MIN_AXIS_HALF_M) {
    return pose;
  }

  const next: PlanStickerPose = {
    ...pose,
    scaleNorth: nextSN,
    scaleEast: nextSE,
    // Keep a representative uniform scale for HUD / bake fallbacks.
    scale: Math.sqrt(Math.max(nextSN, 1e-12) * Math.max(nextSE, 1e-12)),
  };

  const newAnchor = designOffsetToWorld(
    oppositeHandle.designNorth,
    oppositeHandle.designEast,
    next
  );
  return {
    ...next,
    y: pose.y + (anchor.north - newAnchor.north),
    x: pose.x + (anchor.east - newAnchor.east),
  };
}

/** Rotate pose about design OBB centre so the centre stays fixed in world. */
export function rotateAboutDesignCenter(
  pose: PlanStickerPose,
  newRotationDeg: number
): PlanStickerPose {
  const cN = Number.isFinite(pose.designCenterNorth) ? (pose.designCenterNorth as number) : 0;
  const cE = Number.isFinite(pose.designCenterEast) ? (pose.designCenterEast as number) : 0;
  const center = designOffsetToWorld(cN, cE, pose);
  const next: PlanStickerPose = { ...pose, rotation: newRotationDeg };
  const newCenter = designOffsetToWorld(cN, cE, next);
  return {
    ...next,
    y: pose.y + (center.north - newCenter.north),
    x: pose.x + (center.east - newCenter.east),
  };
}

/** World angle (deg, atan2 east/north) from design centre to a world point. */
export function angleFromDesignCenterDeg(pose: PlanStickerPose, world: WorldPoint): number {
  const cN = Number.isFinite(pose.designCenterNorth) ? (pose.designCenterNorth as number) : 0;
  const cE = Number.isFinite(pose.designCenterEast) ? (pose.designCenterEast as number) : 0;
  const center = designOffsetToWorld(cN, cE, pose);
  return (Math.atan2(world.east - center.east, world.north - center.north) * 180) / Math.PI;
}

/**
 * Rotate-affordance points just outside each corner (idle-selected only).
 * `outset` is a fraction of half-diagonal past the corner (e.g. 0.22).
 */
export function getRotateAffordanceWorldPoints(
  pose: PlanStickerPose,
  outset = 0.22
): Array<{ id: HandleId; north: number; east: number }> {
  const corners = getHandleWorldPoints(pose).filter((h) => isCornerHandleId(h.id));
  const cN = Number.isFinite(pose.designCenterNorth) ? (pose.designCenterNorth as number) : 0;
  const cE = Number.isFinite(pose.designCenterEast) ? (pose.designCenterEast as number) : 0;
  const center = designOffsetToWorld(cN, cE, pose);
  return corners.map((h) => {
    const dn = h.north - center.north;
    const de = h.east - center.east;
    return {
      id: h.id,
      north: center.north + dn * (1 + outset),
      east: center.east + de * (1 + outset),
    };
  });
}

export function findNearestHandle(
  cursor: WorldPoint,
  handles: Array<ResizeHandle & WorldPoint>,
  radiusM: number
): (ResizeHandle & WorldPoint) | null {
  let best: (ResizeHandle & WorldPoint) | null = null;
  let bestDist = radiusM;
  for (const h of handles) {
    const d = Math.hypot(cursor.north - h.north, cursor.east - h.east);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}
