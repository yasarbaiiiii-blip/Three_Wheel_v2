/**
 * Mapbox configuration.
 *
 * The Mapbox **public** access token (prefixed `pk.`) is read from the
 * `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN` environment variable. Expo inlines any
 * `EXPO_PUBLIC_*` var into the JS bundle at build time, so this works in
 * release builds without a native secrets system. Public tokens are designed
 * to be embedded in client apps — restrict them in the Mapbox dashboard
 * (URL/bundle allowlist + rate limits). Do NOT use a secret token (`sk.`) here.
 *
 * The token is applied at runtime via `Mapbox.setAccessToken()` (see
 * `initMapbox()` below), called once during app startup.
 *
 * Set the value in a local `.env` file (see `.env.example`):
 *   EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN=pk.xxxx…
 *
 * NOTE (Android builds): as of the current Mapbox Maps SDK, the secret
 * `MAPBOX_DOWNLOADS_TOKEN` is no longer required to fetch the native SDK at
 * build time (auth was lifted from the downloads Maven repo), so this public
 * token is sufficient for both build and runtime on Android.
 */
import Mapbox from "@rnmapbox/maps";

export const MAPBOX_ACCESS_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "";

/**
 * Default basemap style. Mapbox Satellite Streets gives aerial imagery plus
 * road/label overlays — the closest equivalent to the previous Esri World
 * Imagery satellite layer, and (unlike raw third-party rasters) it supports
 * native offline region downloads in Phase 2.
 */
export const MAPBOX_STYLE_URL = "mapbox://styles/mapbox/satellite-streets-v12";

let initialized = false;

/** Apply the access token once. Safe to call multiple times. */
export function initMapbox(): void {
  if (initialized) return;
  initialized = true;
  if (!MAPBOX_ACCESS_TOKEN) {
    console.warn(
      "[mapbox] EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN is not set — Mapbox tiles will fail to load. " +
        "Copy .env.example to .env and add your public token, then rebuild."
    );
    return;
  }
  Mapbox.setAccessToken(MAPBOX_ACCESS_TOKEN);
}
