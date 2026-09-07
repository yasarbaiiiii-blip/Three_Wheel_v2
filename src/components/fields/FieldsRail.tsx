import React, { useEffect } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { ChevronLeft } from "lucide-react-native";

import { FIELDS_COLORS, FIELDS_LAYOUT, FIELDS_MOTION } from "./fieldsTheme";
import { usePressScale } from "./usePressScale";

type FieldsRailProps = {
  collapsed: boolean;
  onExpand: () => void;
  children: React.ReactNode;
};

export function railPixelWidth(windowWidth: number): number {
  const capped = Math.round(windowWidth * FIELDS_LAYOUT.railMaxPct);
  return Math.max(280, Math.min(FIELDS_LAYOUT.railWidth, capped));
}

/**
 * Right workflow rail. Stays mounted while collapsed so Path Order / Align
 * local state (drafts, list scroll) is not thrown away.
 */
export function FieldsRail({ collapsed, onExpand, children }: FieldsRailProps) {
  const { width: windowWidth } = useWindowDimensions();
  const width = railPixelWidth(windowWidth);
  const progress = useSharedValue(collapsed ? 0 : 1);
  const { style: tabPress, onPressIn, onPressOut } = usePressScale(0.94);

  useEffect(() => {
    progress.value = withSpring(collapsed ? 0 : 1, FIELDS_MOTION);
  }, [collapsed, progress]);

  const railStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(progress.value, [0, 1], [width + FIELDS_LAYOUT.railInset + 8, 0]),
      },
    ],
  }));

  const tabStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.45, 1], [1, 0, 0]),
    transform: [{ translateX: interpolate(progress.value, [0, 1], [0, 28]) }],
  }));

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.layer]}>
      <Animated.View
        pointerEvents={collapsed ? "none" : "auto"}
        style={[styles.rail, { width }, railStyle]}
      >
        {children}
      </Animated.View>

      <Animated.View
        pointerEvents={collapsed ? "auto" : "none"}
        style={[styles.tabWrap, tabStyle]}
      >
        <Animated.View style={tabPress}>
          <Pressable
            onPress={onExpand}
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            accessibilityRole="button"
            accessibilityLabel="Show workflow panel"
            hitSlop={8}
            android_ripple={{ color: "rgba(255,255,255,0.12)" }}
          >
            <View style={styles.tab}>
              <ChevronLeft size={16} color={FIELDS_COLORS.accentBrand} strokeWidth={2.6} />
            </View>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    zIndex: 60,
  },
  rail: {
    position: "absolute",
    right: FIELDS_LAYOUT.railInset,
    top: FIELDS_LAYOUT.railInset,
    bottom: FIELDS_LAYOUT.railInset,
    backgroundColor: "#09090b",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
    elevation: 18,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.48,
    shadowRadius: 24,
  },
  tabWrap: {
    position: "absolute",
    right: 0,
    top: "50%",
    marginTop: -50,
  },
  tab: {
    width: 34,
    height: 100,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    backgroundColor: "#09090b",
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    elevation: 10,
    shadowColor: "#000",
    shadowOffset: { width: -4, height: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
  },
});
