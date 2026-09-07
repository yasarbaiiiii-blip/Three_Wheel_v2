import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Check, ChevronDown } from "lucide-react-native";

import { FIELDS_COLORS, FIELDS_LAYOUT, FIELDS_MOTION } from "./fieldsTheme";

type StepStatus = "pending" | "active" | "done";

type FieldsStepCardProps = {
  stepNumber: number;
  title: string;
  status: StepStatus;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  disabled?: boolean;
  scrollableBody?: boolean;
  bodyMaxHeight?: number;
  fillAvailable?: boolean;
  /** Compact status chip to the right of the title (e.g. "12 guides"). */
  badge?: string;
  badgeVariant?: "guide" | "path";
};

const NODE: Record<StepStatus, { bg: string; fg: string; border: string }> = {
  done: {
    bg: FIELDS_COLORS.successMuted,
    fg: FIELDS_COLORS.success,
    border: FIELDS_COLORS.successBorder,
  },
  active: {
    bg: FIELDS_COLORS.accentMuted,
    fg: FIELDS_COLORS.accentBrand,
    border: FIELDS_COLORS.accentBorder,
  },
  pending: {
    bg: FIELDS_COLORS.surfaceSolid,
    fg: FIELDS_COLORS.textMuted,
    border: FIELDS_COLORS.panelBorder,
  },
};

export function FieldsStepCard({
  stepNumber,
  title,
  status,
  expanded,
  onToggle,
  children,
  disabled = false,
  scrollableBody = false,
  bodyMaxHeight = 360,
  fillAvailable = false,
  badge,
  badgeVariant = "guide",
}: FieldsStepCardProps) {
  const node = NODE[status];
  const isScrolling = expanded && scrollableBody;
  const isFilling = expanded && fillAvailable;
  const open = useSharedValue(expanded ? 1 : 0);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    open.value = withSpring(expanded ? 1 : 0, FIELDS_MOTION);
  }, [expanded, open]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(open.value, [0, 1], [0, 180])}deg` }],
  }));
  const accentStyle = useAnimatedStyle(() => ({
    opacity: open.value,
  }));

  return (
    <View
      style={[
        styles.card,
        expanded && styles.cardOpen,
        disabled && styles.cardDisabled,
        isFilling ? styles.cardFill : null,
      ]}
    >
      <Animated.View pointerEvents="none" style={[styles.accent, accentStyle]} />
      {/*
        No `style` prop on the Pressable — deliberately.

        NativeWind applies `cssInterop(Pressable, { className: "style" })`, which
        takes the style prop over for its className remap. A function style does
        not survive that, and the header silently lost `flexDirection: "row"`
        plus all padding, so number/title/chevron stacked into an unpadded
        column. Layout lives on the plain child View below (registered styles on
        a View are unaffected), and press feedback comes from android_ripple.
      */}
      <Pressable
        onPress={disabled ? undefined : onToggle}
        onPressIn={disabled ? undefined : () => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="button"
        accessibilityState={{ expanded, disabled }}
        accessibilityLabel={`${title}, ${expanded ? "collapse" : "expand"}`}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      >
        <View
          style={[
            styles.headerRow,
            expanded && styles.headerRowOpen,
            pressed && styles.headerRowPressed,
          ]}
        >
          <View
            style={[
              styles.node,
              {
                backgroundColor: node.bg,
                borderColor: expanded || status === "active" ? node.border : "transparent",
              },
            ]}
          >
            {status === "done" ? (
              <Check size={15} color={node.fg} strokeWidth={3} />
            ) : (
              <Text style={[styles.nodeText, { color: node.fg }]}>{stepNumber}</Text>
            )}
          </View>

          <Text
            style={[
              styles.title,
              {
                color: disabled
                  ? FIELDS_COLORS.textDim
                  : expanded || status === "active" || status === "done"
                  ? FIELDS_COLORS.textMain
                  : FIELDS_COLORS.textMuted,
              },
            ]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {title}
          </Text>

          {badge ? (
            <View style={[styles.badge, badgeVariant === "path" ? styles.badgePath : styles.badgeGuide]}>
              <Text
                style={[styles.badgeText, badgeVariant === "path" ? styles.badgeTextPath : styles.badgeTextGuide]}
                numberOfLines={1}
              >
                {badge}
              </Text>
            </View>
          ) : null}

          <Animated.View style={[styles.chevronSlot, chevronStyle]}>
            <ChevronDown size={18} color={FIELDS_COLORS.textMuted} strokeWidth={2.2} />
          </Animated.View>
        </View>
      </Pressable>

      {expanded ? (
        isScrolling ? (
          <ScrollView
            style={[styles.body, isFilling ? styles.bodyFill : { maxHeight: bodyMaxHeight }]}
            contentContainerStyle={styles.bodyInner}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            nestedScrollEnabled
            bounces
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.body, styles.bodyInner, isFilling ? styles.bodyFill : null]}>
            {children}
          </View>
        )
      ) : null}
    </View>
  );
}

const NODE_SIZE = 30;

const styles = StyleSheet.create({
  card: {
    borderRadius: FIELDS_LAYOUT.cardRadius,
    backgroundColor: "#16161c",
    borderWidth: 1,
    borderColor: "transparent",
    overflow: "hidden",
  },
  cardOpen: {
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "#1c1c24",
  },
  cardDisabled: {
    opacity: 0.4,
  },
  cardFill: {
    flex: 1,
    minHeight: 0,
  },
  accent: {
    position: "absolute",
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: FIELDS_COLORS.accentBrand,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    height: 50,
    paddingHorizontal: 12,
    paddingLeft: 12,
    gap: 10,
    backgroundColor: "transparent",
  },
  headerRowOpen: {
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  headerRowPressed: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  node: {
    width: NODE_SIZE,
    height: NODE_SIZE,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  nodeText: {
    fontSize: 13,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    lineHeight: 17,
    textAlign: "center",
    includeFontPadding: false,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.1,
    lineHeight: 19,
    includeFontPadding: false,
  },
  badge: {
    flexShrink: 0,
    maxWidth: 92,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeGuide: {
    backgroundColor: FIELDS_COLORS.guideCsvMuted,
    borderColor: FIELDS_COLORS.guideCsvBorder,
  },
  badgePath: {
    backgroundColor: FIELDS_COLORS.pathCsvMuted,
    borderColor: FIELDS_COLORS.pathCsvBorder,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  badgeTextGuide: { color: FIELDS_COLORS.guideCsv },
  badgeTextPath: { color: FIELDS_COLORS.pathCsv },
  chevronSlot: {
    width: 24,
    height: NODE_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  body: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.07)",
    backgroundColor: "#101014",
  },
  bodyFill: {
    flex: 1,
    minHeight: 0,
  },
  bodyInner: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 10,
  },
});
