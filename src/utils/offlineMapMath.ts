/**
 * Pure maths for sizing an offline map download (no native imports → unit-testable).
 *
 * Mapbox caps an account's offline tile count (default 6000 in the SDK); a pack that exceeds
 * it fails part-way through. So pick the zoom range from the area BEFORE downloading.
 */

/** [[neLon, neLat], [swLon, swLat]] — the order Mapbox's visible-bounds API returns. */
export type MapBounds = [[number, number], [number, number]];

/** Web-mercator latitude limit. */
const MAX_LAT = 85.0511;

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

export function isValidBounds(b: MapBounds | null | undefined): b is MapBounds {
  if (!b) return false;
  const [[neLon, neLat], [swLon, swLat]] = b;
  return (
    [neLon, neLat, swLon, swLat].every(Number.isFinite) &&
    neLat > swLat &&
    neLon > swLon &&
    neLat <= 90 &&
    swLat >= -90 &&
    neLon <= 180 &&
    swLon >= -180
  );
}

/** Tiles needed to cover `bounds` at one zoom level. */
export function tilesAtZoom(b: MapBounds, z: number): number {
  const [[neLon, neLat], [swLon, swLat]] = b;
  const x0 = lonToTileX(swLon, z);
  const x1 = lonToTileX(neLon, z);
  const y0 = latToTileY(neLat, z); // north edge → smaller y
  const y1 = latToTileY(swLat, z);
  return (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
}

/** Total tiles for zoom levels minZoom..maxZoom inclusive. */
export function estimateTileCount(b: MapBounds, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += tilesAtZoom(b, z);
  return total;
}

export type ZoomPlan = { minZoom: number; maxZoom: number; tiles: number; capped: boolean };

/**
 * Highest detail that still fits the tile budget.
 * Starts at `wantMaxZoom` (imagery sharp enough to place a path) and backs off one level at a
 * time; `minZoom` stays low so panning out a little still has a basemap.
 */
export function planZoomRange(
  b: MapBounds,
  opts: { minZoom?: number; wantMaxZoom?: number; tileBudget?: number } = {}
): ZoomPlan {
  const minZoom = opts.minZoom ?? 12;
  const wantMax = opts.wantMaxZoom ?? 19;
  const budget = opts.tileBudget ?? 5500;
  let maxZoom = wantMax;
  let tiles = estimateTileCount(b, minZoom, maxZoom);
  while (tiles > budget && maxZoom > minZoom) {
    maxZoom -= 1;
    tiles = estimateTileCount(b, minZoom, maxZoom);
  }
  return { minZoom, maxZoom, tiles, capped: maxZoom < wantMax };
}

/**
 * Grow bounds by `marginFrac` of their span on each side, so the area just beyond the screen
 * the operator was looking at is available offline too.
 */
export function padBounds(b: MapBounds, marginFrac = 0.25): MapBounds {
  const [[neLon, neLat], [swLon, swLat]] = b;
  const dLon = (neLon - swLon) * marginFrac;
  const dLat = (neLat - swLat) * marginFrac;
  return [
    [Math.min(180, neLon + dLon), Math.min(MAX_LAT, neLat + dLat)],
    [Math.max(-180, swLon - dLon), Math.max(-MAX_LAT, swLat - dLat)],
  ];
}
