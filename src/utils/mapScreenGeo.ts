/**
 * Screen↔Geo conversion helpers for the native Mapbox map.
 *
 * Wraps the async MapView imperative methods:
 *   - getCoordinateFromView([x, y]) → [lon, lat]  (screen → geo)
 *   - getPointInView([lon, lat])    → [x, y]       (geo → screen)
 *
 * Both are passed through toMapboxCoord/fromMapboxCoord so the rest of the
 * app never has to think about [lon,lat] vs [lat,lon] ordering again.
 *
 * IMPORTANT: These functions are async because the Mapbox bridge is async.
 * For live-drag performance, cache the metersPerPixel value (derived from
 * visibleBounds) and use pixelDeltaToMetres() from mapGestureUtils.ts
 * instead — it is synchronous and much faster on the hot gesture path.
 *
 * API refs (verified against @rnmapbox/maps v10.3.1 types):
 *   MapView.getCoordinateFromView: https://rnmapbox.github.io/docs/components/MapView
 *   MapView.getPointInView:        https://rnmapbox.github.io/docs/components/MapView
 */
import type { MapView } from "@rnmapbox/maps";

import { fromMapboxCoord, toMapboxCoord } from "./mapboxCoords";
import { projectGpsToLocalMeters } from "./visualAlignment";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/** A screen point in pixels, origin = top-left. */
export type ScreenPoint = { x: number; y: number };

/** A geographic position in the app's { lat, lon } convention. */
export type GeoPoint = { lat: number; lon: number };

// ─────────────────────────────────────────────────────────────────
// screen → geo
// ─────────────────────────────────────────────────────────────────

/**
 * Convert a screen pixel position to a geographic coordinate.
 *
 * @param mapRef - ref to the Mapbox MapView instance
 * @param screen - { x, y } in pixels (origin top-left)
 * @returns { lat, lon } in degrees, or null on failure
 */
export async function screenToGeo(
  mapRef: MapView,
  screen: ScreenPoint
): Promise<GeoPoint | null> {
  try {
    // getCoordinateFromView accepts [x, y] and returns [lon, lat]
    const result = await mapRef.getCoordinateFromView([screen.x, screen.y]);
    return fromMapboxCoord(result as [number, number]);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// geo → screen
// ─────────────────────────────────────────────────────────────────

/**
 * Convert a geographic coordinate to a screen pixel position.
 *
 * @param mapRef - ref to the Mapbox MapView instance
 * @param geo - { lat, lon } in degrees
 * @returns { x, y } in pixels, or null on failure
 */
export async function geoToScreen(
  mapRef: MapView,
  geo: GeoPoint
): Promise<ScreenPoint | null> {
  try {
    // getPointInView accepts [lon, lat] and returns [x, y]
    const result = await mapRef.getPointInView(toMapboxCoord(geo.lat, geo.lon));
    return { x: result[0], y: result[1] };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// metersPerPixel (for synchronous hot-path use)
// ─────────────────────────────────────────────────────────────────

/**
 * Derive the current ground resolution (metres per screen pixel) from two
 * screen points and their corresponding geographic positions.
 *
 * Intended use: call this once per gesture-start (or on camera change) using
 * two known screen↔geo pairs, then pass the result to pixelDeltaToMetres()
 * on every gesture-move event — keeping the hot path synchronous.
 *
 * Uses the equirectangular approximation (same as the rest of the codebase)
 * for the geo→metre conversion; accurate at field scales.
 *
 * @param screenA - first screen point
 * @param geoA    - geo coordinate for screenA
 * @param screenB - second screen point (must differ from screenA)
 * @param geoB    - geo coordinate for screenB
 * @returns metres per pixel, or null if the screen points are identical
 */
export function deriveMetersPerPixel(
  screenA: ScreenPoint,
  geoA: GeoPoint,
  screenB: ScreenPoint,
  geoB: GeoPoint
): number | null {
  const screenDist = Math.hypot(screenB.x - screenA.x, screenB.y - screenA.y);
  if (screenDist === 0) return null;
  const { north: dN, east: dE } = projectGpsToLocalMeters(
    geoB.lat,
    geoB.lon,
    geoA.lat,
    geoA.lon
  );
  const geoDist = Math.hypot(dN, dE);
  return geoDist / screenDist;
}
