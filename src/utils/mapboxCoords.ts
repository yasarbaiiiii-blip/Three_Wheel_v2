/**
 * The single, canonical place where the app's geographic convention
 * `{ lat, lon }` is converted to/from the Mapbox / GeoJSON position order.
 *
 * Background: the projection utilities (`projectPlanNorthEastToGps`,
 * `projectLocalMetersToGps`) return `{ lat, lon }`; the previous Leaflet map
 * consumed `[lat, lon]` tuples; Mapbox and GeoJSON require `[longitude, latitude]`.
 * To avoid ad-hoc swaps scattered across the renderer, ALL coordinate-order
 * conversions go through these two helpers.
 */

/**
 * Convert the app's `{ lat, lon }` (degrees) into a Mapbox/GeoJSON position
 * tuple `[longitude, latitude]`. This is the ONLY place the order is swapped
 * when building geometry for the map.
 */
export function toMapboxCoord(lat: number, lon: number): [number, number] {
  return [lon, lat];
}

/**
 * Inverse of {@link toMapboxCoord}: a Mapbox/GeoJSON `[lon, lat]` position back
 * to `{ lat, lon }`.
 */
export function fromMapboxCoord([lon, lat]: [number, number]): {
  lat: number;
  lon: number;
} {
  // GeoJSON/Mapbox positions are ordered [longitude, latitude], so destructuring
  // the incoming tuple as [lon, lat] is correct. We then return { lat, lon } to
  // match the app's own convention — the FIELD ORDER inside the returned object
  // is irrelevant (objects are keyed by name), so this is not a swap bug.
  return { lat, lon };
}
