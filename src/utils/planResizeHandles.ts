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
  width: number;
  height: number;
};

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
/** Hit radius in local metres (map space) — calibrated loosely; caller may use screen px. */
export const HANDLE_HIT_RADIUS_M = 2.5;

export function designOffsetToWorld(
  designNorth: number,
  designEast: number,
  pose: PlanStickerPose
): WorldPoint {
  const scale = pose.scale > 0 ? pose.scale : 1;
  const rad = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    north: (designNorth * cos - designEast * sin) * scale + pose.y,
    east: (designNorth * sin + designEast * cos) * scale + pose.x,
  };
}

/** Eight OBB handles in design offsets (half-height = N, half-width = E). */
export function getObbResizeHandles(pose: PlanStickerPose): ResizeHandle[] {
  const halfN = (Number.isFinite(pose.height) ? pose.height : 0) / 2;
  const halfE = (Number.isFinite(pose.width) ? pose.width : 0) / 2;
  const defs: Array<{ id: HandleId; dn: number; de: number }> = [
    { id: "nw", dn: halfN, de: -halfE },
    { id: "n", dn: halfN, de: 0 },
    { id: "ne", dn: halfN, de: halfE },
    { id: "e", dn: 0, de: halfE },
    { id: "se", dn: -halfN, de: halfE },
    { id: "s", dn: -halfN, de: 0 },
    { id: "sw", dn: -halfN, de: -halfE },
    { id: "w", dn: 0, de: -halfE },
  ];
  return defs.map((d) => ({
    id: d.id,
    designNorth: d.dn,
    designEast: d.de,
    oppositeId: OPPOSITE[d.id],
  }));
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
  const rad = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const nRot = (anchorDesignNorth * cos - anchorDesignEast * sin) * s;
  const eRot = (anchorDesignNorth * sin + anchorDesignEast * cos) * s;
  return {
    ...pose,
    scale: s,
    y: oldWorld.north - nRot,
    x: oldWorld.east - eRot,
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
  const newScale = pose.scale * (curDist / startDist);
  return scaleAboutDesignAnchor(
    pose,
    newScale,
    oppositeHandle.designNorth,
    oppositeHandle.designEast
  );
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
