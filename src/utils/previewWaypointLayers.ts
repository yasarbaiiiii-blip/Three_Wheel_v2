/**
 * Classify backend /preview waypoints into plan-line layers for survey CSV
 * (and other non-entity previews).
 *
 * /preview exposes spray flags only — no extension_role. With path extensions
 * on, the merged path is PRE (spray OFF) → MARK (ON) → AFT (OFF), plus an
 * optional short terminal run-out stub when the mission ends on MARK.
 */

import type { PlanLayer, PlanLine, PlanSegmentRole } from "../types/plan";

export type PreviewWaypoint = {
  north?: unknown;
  east?: unknown;
  spray?: unknown;
  must_hit?: unknown;
};

export type PreviewSegmentClass = {
  layer: PlanLayer;
  segmentRole?: PlanSegmentRole;
  idPrefix: string;
  label: string;
};

/** Trailing spray-OFF shorter than this is the safety run-out stub, not AFT. */
export const TERMINAL_RUNOUT_MAX_M = 0.2;

function asFinite(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function sprayOn(wp: PreviewWaypoint | undefined): boolean {
  // Match App.tsx preview default: missing spray → treat as ON (mark).
  return wp?.spray !== false;
}

function runLengthM(
  pts: PreviewWaypoint[],
  fromIdx: number,
  toIdxInclusive: number
): number {
  let len = 0;
  for (let i = fromIdx; i < toIdxInclusive; i++) {
    const aN = asFinite(pts[i]?.north);
    const aE = asFinite(pts[i]?.east);
    const bN = asFinite(pts[i + 1]?.north);
    const bE = asFinite(pts[i + 1]?.east);
    if (aN == null || aE == null || bN == null || bE == null) continue;
    len += Math.hypot(bN - aN, bE - aE);
  }
  return len;
}

/**
 * Per-segment class for the edge from waypoints[i] → waypoints[i+1].
 */
export function classifyPreviewSegment(
  sprays: boolean[],
  segmentIndex: number,
  trailingIsAft: boolean
): PreviewSegmentClass {
  const i = segmentIndex;
  const firstTrue = sprays.indexOf(true);
  const lastTrue = (() => {
    for (let k = sprays.length - 1; k >= 0; k--) {
      if (sprays[k]) return k;
    }
    return -1;
  })();

  if (firstTrue < 0) {
    return {
      layer: "transit",
      segmentRole: "none",
      idPrefix: "rpp-transit",
      label: "Transit",
    };
  }

  if (i < firstTrue) {
    return {
      layer: "extension",
      segmentRole: "pre",
      idPrefix: "ext-pre",
      label: "Pre-extension",
    };
  }

  if (i >= lastTrue) {
    if (trailingIsAft) {
      return {
        layer: "extension",
        segmentRole: "aft",
        idPrefix: "ext-aft",
        label: "Aft-extension",
      };
    }
    return {
      layer: "transit",
      segmentRole: "none",
      idPrefix: "rpp-transit",
      label: "Transit",
    };
  }

  if (!sprays[i]) {
    return {
      layer: "transit",
      segmentRole: "none",
      idPrefix: "rpp-transit",
      label: "Transit",
    };
  }

  return {
    layer: "marking",
    segmentRole: undefined,
    idPrefix: "rpp-line",
    label: "Segment",
  };
}

/**
 * Whether the trailing spray-OFF run should be drawn as AFT extension (vs
 * the ~0.1 m terminal run-out stub the planner always appends).
 */
export function trailingSprayOffIsAftExtension(pts: PreviewWaypoint[]): boolean {
  const sprays = pts.map(sprayOn);
  let lastTrue = -1;
  for (let k = sprays.length - 1; k >= 0; k--) {
    if (sprays[k]) {
      lastTrue = k;
      break;
    }
  }
  if (lastTrue < 0 || lastTrue >= pts.length - 1) return false;
  return runLengthM(pts, lastTrue, pts.length - 1) > TERMINAL_RUNOUT_MAX_M;
}

/**
 * Build PlanLine segments from /preview waypoints with PRE/AFT classification.
 */
export function planLinesFromPreviewWaypoints(
  pts: PreviewWaypoint[]
): PlanLine[] {
  if (pts.length === 0) return [];
  const effectivePts = pts.length === 1 ? [pts[0], pts[0]] : pts;
  const sprays = effectivePts.map(sprayOn);
  const trailingIsAft = trailingSprayOffIsAftExtension(effectivePts);
  const lines: PlanLine[] = [];

  for (let i = 0; i < effectivePts.length - 1; i++) {
    const fromPt = effectivePts[i];
    const toPt = effectivePts[i + 1];
    const fromNorth = asFinite(fromPt?.north);
    const fromEast = asFinite(fromPt?.east);
    const toNorth = asFinite(toPt?.north);
    const toEast = asFinite(toPt?.east);
    if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) {
      continue;
    }

    const cls = classifyPreviewSegment(sprays, i, trailingIsAft);
    const line: PlanLine = {
      id: `${cls.idPrefix}-${i}`,
      label: `${cls.label} ${i + 1}`,
      layer: cls.layer,
      from: {
        id: i * 2 + 1,
        x: fromNorth,
        y: fromEast,
        mustHit: fromPt?.must_hit === true,
      },
      to: {
        id: i * 2 + 2,
        x: toNorth,
        y: toEast,
        mustHit: toPt?.must_hit === true,
      },
      width: 0.1,
    };
    if (cls.segmentRole) {
      line.segmentRole = cls.segmentRole;
    }
    lines.push(line);
  }
  return lines;
}
