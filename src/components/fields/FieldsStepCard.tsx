import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronDown, ChevronUp, Check } from "lucide-react-native";

import { FIELDS_COLORS, FIELDS_LAYOUT } from "./fieldsTheme";

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

  return (
    <View
      style={[
        styles.card,
        expanded && styles.cardOpen,
        disabled && styles.cardDisabled,
        isFilling ? styles.cardFill : null,
      ]}
    >
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
        accessibilityRole="button"
        accessibilityState={{ expanded, disabled }}
        accessibilityLabel={`${title}, ${expanded ? "collapse" : "expand"}`}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        android_ripple={{ color: "rgba(255,255,255,0.07)" }}
      >
        <View style={[styles.headerRow, expanded && styles.headerRowOpen]}>
          {/* Number badge and heading sit on one horizontal line. */}
          <View
            style={[
              styles.node,
              {
                backgroundColor: node.bg,
                borderColor: expanded ? node.border : "transparent",
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
                  : expanded || status === "active"
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

          <View style={styles.chevronSlot}>
            {expanded ? (
              <ChevronUp size={18} color={FIELDS_COLORS.textMuted} strokeWidth={2.2} />
            ) : (
              <ChevronDown size={18} color={FIELDS_COLORS.textDim} strokeWidth={2.2} />
            )}
          </View>
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

const NODE_SIZE = 32;

const styles = StyleSheet.create({
  card: {
    borderRadius: FIELDS_LAYOUT.cardRadius,
    backgroundColor: FIELDS_COLORS.cardSolid,
    borderWidth: 1,
    borderColor: FIELDS_COLORS.panelBorder,
    overflow: "hidden",
  },
  cardOpen: {
    borderColor: "rgba(244, 193, 12, 0.35)",
    backgroundColor: "#1e1e24",
  },
  cardDisabled: {
    opacity: 0.4,
  },
  cardFill: {
    flex: 1,
    minHeight: 0,
  },
  /**
   * The single header line: [pad][badge][gap][title flex][gap][chevron][pad].
   * `alignItems: "center"` is what puts the number and the heading on the same
   * baseline-ish centre line; `height` keeps every collapsed row identical.
   */
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    height: 50,
    paddingHorizontal: 14,
    gap: 11,
    backgroundColor: "transparent",
  },
  headerRowOpen: {
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  node: {
    width: NODE_SIZE,
    height: NODE_SIZE,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  nodeText: {
    fontSize: 14,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    lineHeight: 18,
    textAlign: "center",
    includeFontPadding: false,
  },
  /** Takes the row's leftover width so the chevron stays pinned right. */
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.15,
    lineHeight: 20,
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
    borderTopColor: FIELDS_COLORS.panelBorder,
    backgroundColor: FIELDS_COLORS.panelSolid,
  },
  bodyFill: {
    flex: 1,
    minHeight: 0,
  },
  bodyInner: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 10,
  },
});
