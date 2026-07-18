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
import { StyleSheet, View } from "react-native";

import type { MapViewProps } from "./mapViewTypes";
import { MapViewNative } from "./MapViewNative";

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
      <MapViewNative {...props} visible />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
  },
});

export default MapView;
