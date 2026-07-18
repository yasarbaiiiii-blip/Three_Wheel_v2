import type { DesignPreviewAnchor } from "../types/designDocument";
import type { PlanLine } from "../types/plan";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
import {
  getCurveGeometry,
  getPlanLineRenderPoints,
  isCircleLikeLine,
  isCurveEntity,
  MAP_CIRCLE_STEPS,
  sampleCurveEntityPoints,
} from "./curveGeometry";
import { projectLocalMetersToGps } from "./visualAlignment";

export type MapProjectionOrigin = {
  frame: MapGeometryFrame;
  originLat: number;
  originLon: number;
  /** DXF/local north subtracted before projection (PlanLine.from.x). */
  originDxfNorth: number;
  /** DXF/local east subtracted before projection (PlanLine.from.y). */
  originDxfEast: number;
};

export type ResolveMapGeometryFrameInput = {
  mode: "fields" | "templates";
  previewAnchor?: DesignPreviewAnchor | null;
  alignedRefPoints: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  stagedVerified: boolean;
  autoOriginReference: AutoOriginReference | null;
  autoOriginEnabled: boolean;
};

function isValidGps(lat: unknown, lon: unknown): lat is number {
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function isValidAlignedRefPoint(
  point: { dxf_x: number; dxf_y: number; lat: number; lon: number } | undefined
): point is { dxf_x: number; dxf_y: number; lat: number; lon: number } {
  return (
    point != null &&
    Number.isFinite(point.dxf_x) &&
    Number.isFinite(point.dxf_y) &&
    isValidGps(point.lat, point.lon)
  );
}

export function resolveMapGeometryFrame(input: ResolveMapGeometryFrameInput): MapGeometryFrame {
  if (input.mode === "templates" && input.previewAnchor) {
    return "RAW_DESIGN";
  }

  if (isValidAlignedRefPoint(input.alignedRefPoints[0])) {
    return input.stagedVerified ? "SURVEYED_LOCAL" : "ALIGNED_DESIGN";
  }

  if (
    input.autoOriginEnabled &&
    input.autoOriginReference &&
    Number.isFinite(input.autoOriginReference.latitude) &&
    Number.isFinite(input.autoOriginReference.longitude)
  ) {
    return "AUTO_ORIGIN_RAW";
  }

  return "NONE";
}

export function resolveMapProjectionOrigin(
  frame: MapGeometryFrame,
  input: ResolveMapGeometryFrameInput
): MapProjectionOrigin | null {
  if (frame === "RAW_DESIGN" && input.previewAnchor) {
    if (!isValidGps(input.previewAnchor.lat, input.previewAnchor.lon)) {
      return null;
    }
    return {
      frame,
      originLat: input.previewAnchor.lat,
      originLon: input.previewAnchor.lon,
      originDxfNorth: 0,
      originDxfEast: 0,
    };
  }

  if ((frame === "ALIGNED_DESIGN" || frame === "SURVEYED_LOCAL") && isValidAlignedRefPoint(input.alignedRefPoints[0])) {
    const ref = input.alignedRefPoints[0];
    return {
      frame,
      originLat: ref.lat,
      originLon: ref.lon,
      originDxfNorth: ref.dxf_y,
      originDxfEast: ref.dxf_x,
    };
  }

  if (frame === "AUTO_ORIGIN_RAW" && input.autoOriginReference) {
    const ref = input.autoOriginReference;
    return {
      frame,
      originLat: ref.latitude,
      originLon: ref.longitude,
      originDxfNorth: ref.planStartNorth,
      originDxfEast: ref.planStartEast,
    };
  }

  return null;
}

/** GPS + DXF origin used by visual/plan-editing stickers (matches MapProjectionOrigin fields). */
export type PlanManipulationAnchor = {
  originLat: number;
  originLon: number;
  originDxfNorth: number;
  originDxfEast: number;
};

export type ResolvePreviewProjectionOriginInput = ResolveMapGeometryFrameInput & {
  /**
   * Sticky anchor while a sticker is active / just after bake. When set, it wins so the
   * map does not fall through to a re-derived fallback that "chases" baked geometry.
   */
  visualAlignmentAnchor?: PlanManipulationAnchor | null;
  /**
   * Optional precomputed frame from the parent (App mapGeometryFrame). When provided,
   * preferred over re-deriving from mode so fields-frame stays stable when MapView is
   * temporarily switched to "templates" for sticker editing.
   */
  forcedFrame?: MapGeometryFrame | null;
  /** Latched first-seen rover/floating GPS (MapViewNative stableFallbackOrigin). */
  stableFallbackOrigin?: { lat: number; lon: number } | null;
  /** Templates floating origin fallback. */
  templatesFloatingOrigin?: { lat: number; lon: number } | null;
  /**
   * Plan lines used only for the fields/manipulation fallback originDxf
   * (`firstLine.from − 2 m`). Prefer raw design lines (mapSourceLines), not auto-origin-shifted.
   */
  lines?: PlanLine[] | null;
  /** When lines are empty during sticker mode, fall back to the sticker's lines. */
  placedItemLines?: PlanLine[] | null;
};

/**
 * Single source of truth for map projection origin — used by MapViewNative AND by
 * startPlanEditing / startVisualAlignment so entering Move/Rotate never rebuilds a
 * different frame than the one currently drawing the plan (no visible jump).
 *
 * Priority (matches historical MapViewNative behaviour):
 * 1. visualAlignmentAnchor (sticky)
 * 2. resolveMapProjectionOrigin(frame) — aligned refs, auto-origin, preview anchor
 * 3. templates floating origin (templates mode only, non-manipulation)
 * 4. fields / plan-manipulation fallback: latched GPS + firstLine − 2 m
 */
export function resolvePreviewProjectionOrigin(
  input: ResolvePreviewProjectionOriginInput
): MapProjectionOrigin | null {
  if (input.visualAlignmentAnchor) {
    const a = input.visualAlignmentAnchor;
    if (
      isValidGps(a.originLat, a.originLon) &&
      Number.isFinite(a.originDxfNorth) &&
      Number.isFinite(a.originDxfEast)
    ) {
      return {
        frame: "RAW_DESIGN",
        originLat: a.originLat,
        originLon: a.originLon,
        originDxfNorth: a.originDxfNorth,
        originDxfEast: a.originDxfEast,
      };
    }
  }

  const frame = input.forcedFrame ?? resolveMapGeometryFrame(input);
  const resolved = resolveMapProjectionOrigin(frame, input);
  if (resolved) return resolved;

  const isPlanManipulation = (input.placedItemLines?.length ?? 0) > 0;
  if (input.mode === "templates" && !isPlanManipulation && input.templatesFloatingOrigin) {
    const t = input.templatesFloatingOrigin;
    if (isValidGps(t.lat, t.lon)) {
      return {
        frame: "RAW_DESIGN",
        originLat: t.lat,
        originLon: t.lon,
        originDxfNorth: 0,
        originDxfEast: 0,
      };
    }
  }

  const planLines =
    input.lines && input.lines.length > 0
      ? input.lines
      : input.placedItemLines && input.placedItemLines.length > 0
        ? input.placedItemLines
        : [];

  if ((input.mode === "fields" || isPlanManipulation) && planLines.length > 0) {
    const fallback =
      (input.stableFallbackOrigin && isValidGps(input.stableFallbackOrigin.lat, input.stableFallbackOrigin.lon)
        ? input.stableFallbackOrigin
        : null) ||
      (input.templatesFloatingOrigin && isValidGps(input.templatesFloatingOrigin.lat, input.templatesFloatingOrigin.lon)
        ? input.templatesFloatingOrigin
        : null) ||
      { lat: 0, lon: 0 };
    const firstLine = planLines[0];
    const startN = firstLine?.from?.x ?? 0;
    const startE = firstLine?.from?.y ?? 0;
    // Offset local origin by 2 m so the plan sits slightly off the rover icon.
    return {
      frame: "RAW_DESIGN",
      originLat: fallback.lat,
      originLon: fallback.lon,
      originDxfNorth: startN - 2,
      originDxfEast: startE - 2,
    };
  }

  return null;
}

/**
 * Build the sticky visual-alignment / plan-editing anchor that keeps the sticker at the
 * same map position as the current fields preview. Always use mode "fields" with the
 * pre-sticker line set so this matches what the user was looking at before Move/Rotate.
 */
export function buildPlanManipulationAnchor(
  input: Omit<ResolvePreviewProjectionOriginInput, "visualAlignmentAnchor" | "mode"> & {
    /** Optional already-latched anchor to keep stable across re-entry. */
    existingAnchor?: PlanManipulationAnchor | null;
  }
): PlanManipulationAnchor {
  if (input.existingAnchor) {
    const a = input.existingAnchor;
    if (
      isValidGps(a.originLat, a.originLon) &&
      Number.isFinite(a.originDxfNorth) &&
      Number.isFinite(a.originDxfEast)
    ) {
      return {
        originLat: a.originLat,
        originLon: a.originLon,
        originDxfNorth: a.originDxfNorth,
        originDxfEast: a.originDxfEast,
      };
    }
  }

  const origin = resolvePreviewProjectionOrigin({
    ...input,
    mode: "fields",
    visualAlignmentAnchor: null,
  });

  if (origin) {
    return {
      originLat: origin.originLat,
      originLon: origin.originLon,
      originDxfNorth: origin.originDxfNorth,
      originDxfEast: origin.originDxfEast,
    };
  }

  // Last resort (empty plan) — Null Island + zero DXF, same as map defaults.
  return {
    originLat: 0,
    originLon: 0,
    originDxfNorth: 0,
    originDxfEast: 0,
  };
}

export function projectPlanNorthEastToGps(
  north: number,
  east: number,
  origin: MapProjectionOrigin
): { lat: number; lon: number } {
  return projectLocalMetersToGps(
    north - origin.originDxfNorth,
    east - origin.originDxfEast,
    origin.originLat,
    origin.originLon
  );
}

function projectCurveSamplesToGps(
  line: PlanLine,
  origin: MapProjectionOrigin
): [number, number][] {
  const samples = sampleCurveEntityPoints(line, MAP_CIRCLE_STEPS, true);
  if (samples.length < 2) return [];
  return samples.map((pt) => {
    const gps = projectPlanNorthEastToGps(pt.north, pt.east, origin);
    return [gps.lat, gps.lon] as [number, number];
  });
}

export function projectPlanLineToGpsSegments(
  line: PlanLine,
  origin: MapProjectionOrigin
): [number, number][] {
  const isCurve = isCircleLikeLine(line) || isCurveEntity(line);

  if (isCurve) {
    const curve = getCurveGeometry(line);
    if (curve) {
      // Use the same angle-respecting NED samples as the SVG preview. This keeps
      // CIRCLE/ARC rendering consistent across the canvas and native Mapbox
      // previews, including the exact start/end angles and closure point.
      const sampled = projectCurveSamplesToGps(line, origin);
      if (sampled.length >= 2) return sampled;
    }
  }

  const renderPoints = getPlanLineRenderPoints(line, true);
  if (renderPoints.length < 2) {
    return [];
  }

  return renderPoints.map((pt) => {
    const gps = projectPlanNorthEastToGps(pt.north, pt.east, origin);
    return [gps.lat, gps.lon] as [number, number];
  });
}

/** Default map tile centre when no mission geometry origin is available. */
export const DEFAULT_MAP_CENTER = { lat: 0, lon: 0 };
