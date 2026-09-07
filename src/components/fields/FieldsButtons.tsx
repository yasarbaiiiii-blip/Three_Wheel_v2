import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { FIELDS_COLORS, FIELDS_LAYOUT } from "./fieldsTheme";
import { usePressScale } from "./usePressScale";

/**
 * Layout lives on the inner View, not the Pressable — NativeWind's cssInterop
 * steals Pressable.style and drops function/array styles (see FieldsStepCard).
 */

type Tone = "gold" | "ghost" | "danger" | "success";

type FieldsButtonProps = {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: Tone;
  compact?: boolean;
  flex?: boolean;
  accessibilityLabel?: string;
};

const TONE: Record<Tone, { bg: string; fg: string; border: string }> = {
  gold: {
    bg: FIELDS_COLORS.accentBrand,
    fg: FIELDS_COLORS.accentText,
    border: FIELDS_COLORS.accentBorder,
  },
  ghost: {
    bg: FIELDS_COLORS.surfaceSolid,
    fg: FIELDS_COLORS.textMain,
    border: FIELDS_COLORS.panelBorder,
  },
  danger: {
    bg: FIELDS_COLORS.dangerMuted,
    fg: FIELDS_COLORS.danger,
    border: FIELDS_COLORS.dangerBorder,
  },
  success: {
    bg: FIELDS_COLORS.successMuted,
    fg: FIELDS_COLORS.success,
    border: FIELDS_COLORS.successBorder,
  },
};

export function FieldsButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  tone = "gold",
  compact = false,
  flex = false,
  accessibilityLabel,
}: FieldsButtonProps) {
  const t = TONE[tone];
  const blocked = disabled || busy;
  const { style: pressStyle, onPressIn, onPressOut } = usePressScale(0.97);
  return (
    <Animated.View style={[flex ? styles.btnFlex : styles.btnBlock, pressStyle]}>
      <Pressable
        onPress={blocked ? undefined : onPress}
        onPressIn={blocked ? undefined : onPressIn}
        onPressOut={onPressOut}
        disabled={blocked}
        accessibilityRole="button"
        accessibilityState={{ disabled: blocked, busy }}
        accessibilityLabel={accessibilityLabel ?? label}
        android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      >
        <View
          style={[
            styles.btn,
            compact && styles.btnCompact,
            { backgroundColor: t.bg, borderColor: t.border },
            blocked && styles.btnDisabled,
          ]}
        >
          <Text style={[styles.btnLabel, { color: t.fg }]} numberOfLines={1}>
            {busy ? "Working…" : label}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

type IconBtnProps = {
  onPress?: () => void;
  disabled?: boolean;
  tone?: "ghost" | "danger" | "gold";
  accessibilityLabel: string;
  children: React.ReactNode;
};

export function FieldsIconButton({
  onPress,
  disabled = false,
  tone = "ghost",
  accessibilityLabel,
  children,
}: IconBtnProps) {
  const t = TONE[tone];
  const { style: pressStyle, onPressIn, onPressOut } = usePressScale(0.92);
  return (
    <Animated.View style={pressStyle}>
      <Pressable
        onPress={disabled ? undefined : onPress}
        onPressIn={disabled ? undefined : onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        hitSlop={6}
        android_ripple={{ color: "rgba(255,255,255,0.1)", radius: FIELDS_LAYOUT.iconBtn / 2 }}
      >
        <View
          style={[
            styles.icon,
            { backgroundColor: t.bg, borderColor: t.border },
            disabled && styles.btnDisabled,
          ]}
        >
          {children}
        </View>
      </Pressable>
    </Animated.View>
  );
}

type SegmentOption<T extends string> = { id: T; label: string };

export function FieldsSegmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.seg}>
      {options.map((opt) => {
        const on = opt.id === value;
        return (
          <View key={opt.id} style={styles.segFlex}>
            <Pressable
              onPress={disabled ? undefined : () => onChange(opt.id)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled }}
              accessibilityLabel={opt.label}
              android_ripple={{ color: "rgba(255,255,255,0.10)" }}
            >
              <View style={[styles.segItem, on && styles.segItemOn]}>
                <Text style={[styles.segLabel, on && styles.segLabelOn]} numberOfLines={1}>
                  {opt.label}
                </Text>
              </View>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: FIELDS_LAYOUT.btnHeight,
    borderRadius: FIELDS_LAYOUT.btnRadius,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    width: "100%",
  },
  btnCompact: {
    height: 40,
  },
  btnBlock: {
    alignSelf: "stretch",
  },
  btnFlex: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  segFlex: {
    flex: 1,
    minWidth: 0,
  },
  btnDisabled: {
    opacity: 0.45,
  },
  btnLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  icon: {
    width: FIELDS_LAYOUT.iconBtn,
    height: FIELDS_LAYOUT.iconBtn,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  seg: {
    flexDirection: "row",
    backgroundColor: "#101014",
    borderRadius: 999,
    padding: 3,
    gap: 3,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  segItem: {
    height: 34,
    width: "100%",
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  segItemOn: {
    backgroundColor: FIELDS_COLORS.accentBrand,
  },
  segLabel: {
    color: FIELDS_COLORS.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  segLabelOn: {
    color: FIELDS_COLORS.accentText,
  },
});
