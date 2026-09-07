import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { FIELDS_COLORS, FIELDS_LAYOUT } from "./fieldsTheme";
import { usePressScale } from "./usePressScale";

type TplSession = "idle" | "picking" | "ghost";

type FieldsMapChromeProps = {
  railCollapsed: boolean;
  railWidth: number;
  tplSession: TplSession;
  anchorSelectMode?: boolean;
  onCancelPlace?: () => void;
  onConfirmPlace?: () => void;
};

function bannerCopy(props: FieldsMapChromeProps): { text: string; tone: "gold" | "ok" } | null {
  if (props.tplSession === "picking") return { text: "Tap map to place", tone: "gold" };
  if (props.tplSession === "ghost") return { text: "Place, or tap to move", tone: "gold" };
  if (props.anchorSelectMode) return { text: "Tap a start point", tone: "gold" };
  return null;
}

export function FieldsMapChrome(props: FieldsMapChromeProps) {
  const banner = bannerCopy(props);
  const placing = props.tplSession === "picking" || props.tplSession === "ghost";
  const pulse = useSharedValue(1);
  const bannerKey = banner?.text ?? "";

  useEffect(() => {
    if (!bannerKey) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(0.35, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
  }, [bannerKey, pulse]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const gutter = {
    left: FIELDS_LAYOUT.mapChromeLeft,
    right: props.railCollapsed ? 16 : props.railWidth + FIELDS_LAYOUT.railInset + 8,
  };

  return (
    <View pointerEvents="box-none" style={styles.root}>
      {banner ? (
        <View pointerEvents="none" style={[styles.bannerSlot, gutter]}>
          <View style={styles.banner}>
            <Animated.View
              style={[styles.dot, banner.tone === "ok" ? styles.dotOk : styles.dotGold, pulseStyle]}
            />
            <Text style={styles.bannerText} numberOfLines={1}>
              {banner.text}
            </Text>
          </View>
        </View>
      ) : null}

      {placing ? (
        <View pointerEvents="box-none" style={[styles.stripSlot, gutter]}>
          <View style={styles.strip}>
            <StripBtn label="Cancel" onPress={props.onCancelPlace} />
            {props.tplSession === "ghost" ? (
              <StripBtn label="Place" tone="gold" onPress={props.onConfirmPlace} />
            ) : (
              <StripBtn label="Tap map" disabled />
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function StripBtn({
  label,
  onPress,
  disabled = false,
  tone = "ghost",
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  tone?: "ghost" | "gold";
}) {
  const gold = tone === "gold";
  const { style: pressStyle, onPressIn, onPressOut } = usePressScale(0.96);
  return (
    <Animated.View style={pressStyle}>
      <Pressable
        onPress={disabled ? undefined : onPress}
        onPressIn={disabled ? undefined : onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
      >
        <View style={[styles.tool, gold && styles.toolGold, disabled && styles.toolOff]}>
          <Text style={[styles.toolText, gold && styles.toolTextGold]}>{label}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
  },
  bannerSlot: {
    position: "absolute",
    top: 16,
    alignItems: "center",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(12, 12, 16, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
    maxWidth: "100%",
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotGold: { backgroundColor: FIELDS_COLORS.accentBrand },
  dotOk: { backgroundColor: FIELDS_COLORS.success },
  bannerText: {
    color: FIELDS_COLORS.textMain,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  stripSlot: {
    position: "absolute",
    bottom: 18,
    alignItems: "center",
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: FIELDS_COLORS.hudBg,
    borderWidth: 1,
    borderColor: FIELDS_COLORS.hudBorder,
    borderRadius: 16,
    padding: 6,
    maxWidth: "100%",
  },
  tool: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  toolGold: { backgroundColor: FIELDS_COLORS.accentBrand },
  toolOff: { opacity: 0.4 },
  toolText: {
    color: FIELDS_COLORS.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  toolTextGold: { color: FIELDS_COLORS.accentText },
});
