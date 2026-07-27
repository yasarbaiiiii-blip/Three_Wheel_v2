/**
 * MapView dispatcher — native Mapbox (`MapViewNative`).
 *
 * Eager import (not React.lazy): under Expo/Metro HMR, lazy chunks frequently
 * desync after large edits (`Requiring unknown module "N"`), and the lazy
 * factory then resolves to `undefined` →
 * "Element type is invalid. Received a promise that resolves to: undefined."
 * MapView is already only mounted when the map is visible, so deferring the
 * native module further is not worth the intermittent crash.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import type { MapViewProps } from "./mapViewTypes";
import { MapViewNative } from "./MapViewNative";
import { AppErrorBoundary } from "./AppErrorBoundary";

// Re-export the shared props type so existing `import { MapViewProps } from
// "./MapView"` style usages (if any) keep working.
export type { MapViewProps } from "./mapViewTypes";

export function MapView(props: MapViewProps) {
  // If the host sets visible={false}, stay unmounted (Home Map Off path).
  if (props.visible === false) {
    return null;
  }

  return (
    <View style={styles.fill} collapsable={false}>
      <AppErrorBoundary
        name="MapView"
        fallback={
          <View style={styles.fallback}>
            <Text style={styles.fallbackTitle}>Map failed to load</Text>
            <Text style={styles.fallbackBody}>
              The map crashed after connect. Turn Map Off/On, or reconnect. Telemetry and
              mission controls still work without the map.
            </Text>
          </View>
        }
      >
        <MapViewNative {...props} visible />
      </AppErrorBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0f172a",
    gap: 8,
  },
  fallbackTitle: { color: "#f8fafc", fontSize: 15, fontWeight: "800" },
  fallbackBody: { color: "#94a3b8", fontSize: 12, textAlign: "center", lineHeight: 18 },
});

export default MapView;
