/**
 * MapView dispatcher — native Mapbox (`MapViewNative`).
 *
 * `USE_NATIVE_MAPBOX` is the rollout flag in featureFlags (currently always native).
 * Lazy-load keeps the heavy @rnmapbox/maps module off the critical path; the
 * wrapper fills its parent so the map is never laid out at 0×0 while loading.
 */
import React, { Suspense } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import type { MapViewProps } from "./mapViewTypes";

// Re-export the shared props type so existing `import { MapViewProps } from
// "./MapView"` style usages (if any) keep working.
export type { MapViewProps } from "./mapViewTypes";

const MapViewNativeLazy = React.lazy(() => import("./MapViewNative"));

export function MapView(props: MapViewProps) {
  // If the host sets visible={false}, stay unmounted (Home Map Off path).
  if (props.visible === false) {
    return null;
  }

  return (
    <View style={styles.fill} collapsable={false}>
      <Suspense
        fallback={
          <View style={styles.fallback}>
            <ActivityIndicator color="#94a3b8" />
          </View>
        }
      >
        <MapViewNativeLazy {...props} visible />
      </Suspense>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
  },
});

export default MapView;
