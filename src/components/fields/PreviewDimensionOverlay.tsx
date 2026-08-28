import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import type { PlanLine } from "../../types/plan";
import { FIELDS_COLORS } from "./fieldsTheme";
import {
  collectDimensionLods,
  collectPreviewSegs,
  worldToPreviewPx,
  type DimMark,
  type DimTier,
} from "./templateLinePreviewMath";

type PreviewDimensionOverlayProps = {
  lines: PlanLine[];
  size: number;
  zoomSv: SharedValue<number>;
};

function TierLayer({
  marks,
  zoomSv,
  tier,
}: {
  marks: DimMark[];
  zoomSv: SharedValue<number>;
  tier: DimTier;
}) {
  const style = useAnimatedStyle(() => {
    const z = zoomSv.value;
    const opacity =
      tier === "large"
        ? interpolate(z, [0.7, 1.0], [0.35, 1], "clamp")
        : tier === "medium"
          ? interpolate(z, [1.2, 1.85], [0, 1], "clamp")
          : interpolate(z, [2.15, 3.15], [0, 1], "clamp");
    return { opacity };
  });
  const fontSize = tier === "large" ? 11 : tier === "medium" ? 10 : 9;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      {marks.map((m, i) => (
        <View
          key={`${tier}-${i}`}
          style={{
            position: "absolute",
            left: m.x,
            top: m.y,
            marginLeft: -32,
            marginTop: -8,
            minWidth: 64,
            alignItems: "center",
          }}
        >
          <Text style={[styles.label, { fontSize }]}>{m.text}</Text>
        </View>
      ))}
    </Animated.View>
  );
}

export function PreviewDimensionOverlay({ lines, size, zoomSv }: PreviewDimensionOverlayProps) {
  const frame = useMemo(() => collectPreviewSegs(lines, false), [lines]);
  const marks = useMemo(() => collectDimensionLods(lines, false), [lines]);
  const placed = useMemo(
    () =>
      marks.map((m) => {
        const p = worldToPreviewPx(m.x, m.y, frame, size);
        return { ...m, x: p.left, y: p.top };
      }),
    [frame, marks, size]
  );

  return (
    <View pointerEvents="none" style={{ position: "absolute", width: size, height: size, left: 0, top: 0 }}>
      <TierLayer marks={placed.filter((m) => m.tier === "large")} zoomSv={zoomSv} tier="large" />
      <TierLayer marks={placed.filter((m) => m.tier === "medium")} zoomSv={zoomSv} tier="medium" />
      <TierLayer marks={placed.filter((m) => m.tier === "tiny")} zoomSv={zoomSv} tier="tiny" />
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: FIELDS_COLORS.accentBrand,
    fontWeight: "800",
    letterSpacing: 0.2,
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
