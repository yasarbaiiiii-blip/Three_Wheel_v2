/**
 * Build-time feature flags for the Mapbox migration.
 *
 * These are plain module constants (not runtime state) so flipping one is a
 * deliberate, rebuild-required change — which keeps React hook ordering stable
 * even where a flag guards an early return.
 */

/**
 * Phase 1 rollout switch for the map renderer.
 *
 *   false (DEFAULT) → legacy Leaflet WebView  (MapViewLeaflet)
 *   true            → native @rnmapbox/maps    (MapViewNative)
 *
 * ── ENABLE the native map for on-device testing ──
 *   1. Set this to `true`
 *   2. Rebuild: `cd android && ./gradlew assembleRelease`  (or run a dev client)
 *
 * ── ROLL BACK to the legacy map (instant) ──
 *   1. Set this back to `false`
 *   2. Rebuild
 *
 * No other code changes are needed — both implementations satisfy the same
 * `MapViewProps`, and `src/components/MapView.tsx` dispatches between them.
 * Keep this `false` on `main` until native parity is verified on device.
 */
export const USE_NATIVE_MAPBOX = true;

/**
 * TEMPORARY (Phase 0.1): when `true`, the app renders only `<MapboxHelloMap />`
 * full-screen for an on-device basemap smoke test. Leave `false` in normal use;
 * remove this flag and its mount once the smoke test is confirmed.
 */
export const SMOKE_TEST_MAPBOX = false;

/** Real field coordinate for the smoke test, [longitude, latitude]. */
export const SMOKE_TEST_CENTER: [number, number] = [77.5946, 12.9716]; // Bangalore
