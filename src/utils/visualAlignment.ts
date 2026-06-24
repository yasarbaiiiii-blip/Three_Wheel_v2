/**
 * Visual alignment coordinate helpers.
 *
 * Contract (matches MapView projectedPlacedItems):
 * - line.from.x / corner.x = DXF north
 * - line.from.y / corner.y = DXF east
 * - item.x = east translation (metres, local NED)
 * - item.y = north translation (metres, local NED)
 * - item.rotation = degrees, positive = standard math CCW in north/east plane
 */

export type VisualAlignmentTransform = {
  x: number;
  y: number;
  rotation: number;
  scale?: number;
};

const EARTH_RADIUS = 6378137.0;

/** Rotate + translate a DXF point into local north/east metres (latchedOrigin frame). */
export function transformVisualDxfPoint(
  north: number,
  east: number,
  item: VisualAlignmentTransform
): { north: number; east: number } {
  const scale = item.scale ?? 1;
  const theta = (item.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    north: (north * cos - east * sin) * scale + item.y,
    east: (north * sin + east * cos) * scale + item.x,
  };
}

export function projectLocalMetersToGps(
  north: number,
  east: number,
  originLat: number,
  originLon: number
): { lat: number; lon: number } {
  const originLatRad = (originLat * Math.PI) / 180;
  const lat = originLat + (north / EARTH_RADIUS) * (180 / Math.PI);
  const lon =
    originLon + (east / (EARTH_RADIUS * Math.cos(originLatRad))) * (180 / Math.PI);
  return { lat, lon };
}

export function projectGpsToLocalMeters(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { north: number; east: number } {
  const originLatRad = (originLat * Math.PI) / 180;
  const north = (lat - originLat) * (EARTH_RADIUS * Math.PI) / 180;
  const east =
    (lon - originLon) * (EARTH_RADIUS * Math.cos(originLatRad) * Math.PI) / 180;
  return { north, east };
}

export type VisualAlignmentRefPoint = {
  dxf_x: number;
  dxf_y: number;
  lat: number;
  lon: number;
};

/** Bbox corners in DXF north/east, then preview transform → GPS ref pairs. */
export function buildVisualAlignmentRefPoints(
  corners: Array<{ x: number; y: number }>,
  item: VisualAlignmentTransform,
  originLat: number,
  originLon: number
): VisualAlignmentRefPoint[] {
  return corners.map((corner) => {
    const placed = transformVisualDxfPoint(corner.x, corner.y, item);
    const gps = projectLocalMetersToGps(placed.north, placed.east, originLat, originLon);
    return {
      // RefPoint API: dxf_y = north, dxf_x = east (see handleSelectPoint / backend swap).
      dxf_x: corner.y,
      dxf_y: corner.x,
      lat: gps.lat,
      lon: gps.lon,
    };
  });
}

export function computeLineBoundingBox(lines: Array<{ from?: { x: number; y: number }; to?: { x: number; y: number } }>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    if (line.from) {
      minX = Math.min(minX, line.from.x);
      minY = Math.min(minY, line.from.y);
      maxX = Math.max(maxX, line.from.x);
      maxY = Math.max(maxY, line.from.y);
    }
    if (line.to) {
      minX = Math.min(minX, line.to.x);
      minY = Math.min(minY, line.to.y);
      maxX = Math.max(maxX, line.to.x);
      maxY = Math.max(maxY, line.to.y);
    }
  }
  return { minX, minY, maxX, maxY };
}