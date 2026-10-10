/**
 * MapView dispatcher.
 *
 * Shared mode (default): screens render <MapView/> as before, but it only PUBLISHES its props
 * to the app-wide <SharedMapHost/>, which owns the single native Mapbox map. Standalone mode
 * (`standalone` prop, or the operator turned the shared map off in Settings): this screen
 * mounts its own private native map, exactly like the legacy behaviour.
 *
 * Eager import (not React.lazy): under Expo/Metro HMR, lazy chunks frequently desync after
 * large edits (`Requiring unknown module "N"`).
 */
import React, { useId, useLayoutEffect } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { MapViewProps } from "./mapViewTypes";
import { MapViewNative } from "./MapViewNative";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { useSharedMapEnabled } from "./sharedMap/mapPrefs";
import { publishMapSlot, releaseMapSlot } from "./sharedMap/sharedMapStore";

// Re-export the shared props type so existing `import { MapViewProps } from
// "./MapView"` style usages (if any) keep working.
export type { MapViewProps } from "./mapViewTypes";

export function MapFailedFallback() {
  return (
    <View style={styles.fallback}>
      <Text style={styles.fallbackTitle}>Map failed to load</Text>
      <Text style={styles.fallbackBody}>
        The map crashed after connect. Turn Map Off/On, or reconnect. Telemetry and
        mission controls still work without the map.
      </Text>
    </View>
  );
}

/** Publishes this screen's map props to the shared host; renders nothing itself. */
function SharedMapSlot(props: MapViewProps) {
  const owner = useId();
  const hidden = props.visible === false;

  // Every render: the host must always see the screen's latest props (lines, selection,
  // callbacks). Layout effect so the map updates in the same frame as the UI around it.
  useLayoutEffect(() => {
    if (hidden) releaseMapSlot(owner);
    else publishMapSlot(owner, props);
  });
  useLayoutEffect(() => () => releaseMapSlot(owner), [owner]);

  return null;
}

/** Legacy path: this screen owns a private native map. */
function StandaloneMap(props: MapViewProps) {
  // If the host sets visible={false}, stay unmounted (Home Map Off path).
  if (props.visible === false) return null;
  return (
    <View style={styles.fill} collapsable={false}>
      <AppErrorBoundary name="MapView" fallback={<MapFailedFallback />}>
        <MapViewNative {...props} visible />
      </AppErrorBoundary>
    </View>
  );
}

export function MapView(props: MapViewProps) {
  const sharedEnabled = useSharedMapEnabled();
  if (sharedEnabled && !props.standalone) return <SharedMapSlot {...props} />;
  return <StandaloneMap {...props} />;
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
