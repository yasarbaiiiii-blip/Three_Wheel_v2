/**
 * Phase 0 "hello map" — a minimal native Mapbox map used to validate the
 * @rnmapbox/maps toolchain end-to-end (install → config plugin → native build →
 * runtime token → render). This is intentionally tiny and will be superseded by
 * the real native MapView in Phase 1.
 *
 * API references (verified against installed @rnmapbox/maps v10.3.1; see §14 of
 * docs/Mapbox-Migration-Plan.md):
 * - MapView:  https://rnmapbox.github.io/docs/components/MapView
 * - Camera:   https://rnmapbox.github.io/docs/components/Camera
 */
import React from "react";
import { StyleSheet, View } from "react-native";
import Mapbox, { MapView, Camera } from "@rnmapbox/maps";

import { MAPBOX_STYLE_URL } from "../config/mapbox";

export interface MapboxHelloMapProps {
  /** [longitude, latitude] — Mapbox/GeoJSON order. */
  center?: [number, number];
  zoomLevel?: number;
}

/** Renders a full-bleed Mapbox map centred on the given coordinate. */
export default function MapboxHelloMap({
  center = [0, 0],
  zoomLevel = 16,
}: MapboxHelloMapProps) {
  return (
    <View style={styles.container}>
      <MapView style={styles.map} styleURL={MAPBOX_STYLE_URL}>
        <Camera centerCoordinate={center} zoomLevel={zoomLevel} />
      </MapView>
    </View>
  );
}

// Ensure the default export's runtime token init path is referenced so the
// module isn't tree-shaken in unusual bundler configs.
void Mapbox;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
