/**
 * MapView dispatcher.
 *
 * Selects the map implementation based on the `USE_NATIVE_MAPBOX` feature flag:
 *   - false (default) → legacy Leaflet WebView (`MapViewLeaflet`)
 *   - true            → native Mapbox renderer (`MapViewNative`)
 *
 * Both implementations satisfy the same `MapViewProps`, so the two call sites
 * (App.tsx, TemplatesPage.tsx) never change — flipping the flag is the only
 * switch needed.
 *
 * ── HOW TO ENABLE THE NATIVE MAP FOR ON-DEVICE TESTING ──────────────────────
 *   1. Open `src/config/featureFlags.ts`
 *   2. Set `USE_NATIVE_MAPBOX = true`
 *   3. Rebuild: `cd android && ./gradlew assembleRelease` (or run a dev client)
 *   To roll back instantly, set it back to `false` and rebuild. No other code
 *   changes are required.
 *
 * Implementations are loaded with `React.lazy` so the bundle/runtime only
 * evaluates the module for the active path (the inactive implementation's
 * module code — e.g. @rnmapbox/maps + turf, or the Leaflet WebView HTML — is
 * not executed at startup).
 */
import React, { Suspense } from "react";

import type { MapViewProps } from "./mapViewTypes";
import { USE_NATIVE_MAPBOX } from "../config/featureFlags";

// Re-export the shared props type so existing `import { MapViewProps } from
// "./MapView"` style usages (if any) keep working.
export type { MapViewProps } from "./mapViewTypes";

const MapViewNativeLazy = React.lazy(() => import("./MapViewNative"));
const MapViewLeafletLazy = React.lazy(() => import("./MapViewLeaflet"));

export function MapView(props: MapViewProps) {
  const Impl = USE_NATIVE_MAPBOX ? MapViewNativeLazy : MapViewLeafletLazy;
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}

export default MapView;
