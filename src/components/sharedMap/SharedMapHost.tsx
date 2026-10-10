/**
 * The one native map. Mounted once, under every page, for the whole session.
 *
 * Pages overlay their UI on top of it (transparent, touch-through where they have no
 * controls) and publish map props through <MapView/> → sharedMapStore. Leaving the map pages
 * (Settings, How-to…) only PARKS it — invisible, input-less, telemetry work paused — so
 * returning shows the same camera instantly instead of reloading the style.
 */
import React, { useRef } from "react";
import { StyleSheet, View } from "react-native";

import { AppErrorBoundary } from "../AppErrorBoundary";
import { MapFailedFallback } from "../MapView";
import { MapViewNative } from "../MapViewNative";
import { useSharedMapProps } from "./sharedMapStore";

export function SharedMapHost({ parked }: { parked: boolean }) {
  const props = useSharedMapProps();
  // Only Home lets the operator pick a basemap; Fields passes none. Keep the chosen style when
  // another screen takes the map, otherwise every Home → Fields hop would swap the style URL
  // and reload the basemap — the exact flash this shared map exists to remove.
  const styleRef = useRef<string | undefined>(undefined);
  if (props?.styleURL) styleRef.current = props.styleURL;
  // Nothing has asked for a map yet (e.g. first launch on a non-map page): stay unmounted,
  // the first claim mounts it. After that it is never unmounted again.
  if (!props) return null;

  return (
    <View
      style={[StyleSheet.absoluteFill, parked ? styles.parked : null]}
      pointerEvents={parked ? "none" : "box-none"}
      collapsable={false}
    >
      <AppErrorBoundary name="SharedMap" fallback={<MapFailedFallback />}>
        <MapViewNative {...props} styleURL={props.styleURL ?? styleRef.current} visible parked={parked} />
      </AppErrorBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  parked: { opacity: 0 },
});
