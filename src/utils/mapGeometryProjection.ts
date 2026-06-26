import type { DesignPreviewAnchor } from "../types/designDocument";
import type { PlanLine } from "../types/plan";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
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

export function projectPlanLineToGpsSegments(
  line: PlanLine,
  origin: MapProjectionOrigin
): [number, number][] {
  const coords: [number, number][] = [];

  if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
    for (const pt of line.entity.preview_points) {
      const gps = projectPlanNorthEastToGps(pt.north, pt.east, origin);
      coords.push([gps.lat, gps.lon]);
    }
    return coords;
  }

  if (
    line.from &&
    line.to &&
    Number.isFinite(line.from.x) &&
    Number.isFinite(line.from.y) &&
    Number.isFinite(line.to.x) &&
    Number.isFinite(line.to.y)
  ) {
    const fromGps = projectPlanNorthEastToGps(line.from.x, line.from.y, origin);
    const toGps = projectPlanNorthEastToGps(line.to.x, line.to.y, origin);
    coords.push([fromGps.lat, fromGps.lon]);
    coords.push([toGps.lat, toGps.lon]);
  }

  return coords;
}

/** Default map tile centre when no mission geometry origin is available. */
export const DEFAULT_MAP_CENTER = { lat: 0, lon: 0 };