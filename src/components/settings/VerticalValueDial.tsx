import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import {
  buildDialTicks,
  decimalsForStep,
  nearestTickIndex,
  type ControllerParam,
} from "../../api/controllerParams";
import { DIAL_HEIGHT, DIAL_ITEM_H, DIAL_PAD, DIAL_VISIBLE, SETTINGS_COLORS } from "./settingsTheme";

type VerticalValueDialProps = {
  param: ControllerParam;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
};

function tickLabel(value: number, integer: boolean): string {
  if (integer) return String(Math.round(value));
  const abs = Math.abs(value);
  const decimals = abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return value.toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

function VerticalValueDialInner({ param, value, onChange, disabled = false }: VerticalValueDialProps) {
  const integer = ["int", "integer"].includes(param.type);
  const seed = typeof param.current === "number" ? param.current : typeof param.default === "number" ? param.default : value;
  const ticks = useMemo(
    () => buildDialTicks(param, seed),
    [param.min, param.max, param.type, param.name, seed]
  );
  const selected = nearestTickIndex(ticks, value);
  const scrollRef = useRef<ScrollView>(null);
  const visualRef = useRef(selected);
  const ignoreNext = useRef(false);

  const scrollToIndex = useCallback((index: number, animated: boolean) => {
    const clamped = Math.max(0, Math.min(ticks.length - 1, index));
    ignoreNext.current = true;
    scrollRef.current?.scrollTo({ y: clamped * DIAL_ITEM_H, animated });
  }, [ticks.length]);

  useEffect(() => {
    if (Math.abs(visualRef.current - selected) > 0) {
      scrollToIndex(selected, false);
      visualRef.current = selected;
    }
  }, [selected, scrollToIndex]);

  const commitIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(ticks.length - 1, index));
      visualRef.current = clamped;
      const next = ticks[clamped];
      if (next !== undefined && next !== value) onChange(next);
    },
    [onChange, ticks, value]
  );

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (disabled) return;
      if (ignoreNext.current) {
        ignoreNext.current = false;
        return;
      }
      const index = Math.round(event.nativeEvent.contentOffset.y / DIAL_ITEM_H);
      commitIndex(index);
    },
    [commitIndex, disabled]
  );

  const stepBy = useCallback(
    (delta: number) => {
      if (disabled) return;
      const next = Math.max(0, Math.min(ticks.length - 1, selected + delta));
      scrollToIndex(next, true);
      commitIndex(next);
    },
    [commitIndex, disabled, scrollToIndex, selected, ticks.length]
  );

  const stepHint = useMemo(() => {
    if (ticks.length < 2) return "";
    const gap = Math.abs(ticks[1] - ticks[0]);
    return integer ? `step ${gap}` : `step ${gap.toFixed(decimalsForStep(gap))}`;
  }, [integer, ticks]);

  return (
    <View style={[styles.wrap, disabled && styles.disabled]}>
      <Pressable
        onPress={() => stepBy(-1)}
        disabled={disabled || selected <= 0}
        hitSlop={8}
        style={({ pressed }) => [styles.chevron, pressed && styles.chevronPressed]}
      >
        <ChevronUp color={SETTINGS_COLORS.accentBrand} size={16} strokeWidth={2.4} />
      </Pressable>

      <View style={styles.well}>
        <View pointerEvents="none" style={styles.selection} />
        <ScrollView
          ref={scrollRef}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={DIAL_ITEM_H}
          snapToAlignment="start"
          decelerationRate="fast"
          scrollEnabled={!disabled}
          onMomentumScrollEnd={onMomentumEnd}
          onScrollEndDrag={onMomentumEnd}
          scrollEventThrottle={16}
          contentOffset={{ x: 0, y: selected * DIAL_ITEM_H }}
        >
          <View style={{ height: DIAL_PAD }} />
          {ticks.map((tick, index) => {
            const dist = Math.abs(index - selected);
            const active = index === selected;
            return (
              <Pressable
                key={`${tick}-${index}`}
                onPress={() => {
                  if (disabled) return;
                  scrollToIndex(index, true);
                  commitIndex(index);
                }}
                style={styles.item}
              >
                <Text
                  style={[
                    styles.itemText,
                    active && styles.itemTextActive,
                    { opacity: active ? 1 : Math.max(0.18, 1 - dist / (DIAL_VISIBLE - 1)) },
                  ]}
                >
                  {tickLabel(tick, integer)}
                </Text>
              </Pressable>
            );
          })}
          <View style={{ height: DIAL_PAD }} />
        </ScrollView>
      </View>

      <Pressable
        onPress={() => stepBy(1)}
        disabled={disabled || selected >= ticks.length - 1}
        hitSlop={8}
        style={({ pressed }) => [styles.chevron, pressed && styles.chevronPressed]}
      >
        <ChevronDown color={SETTINGS_COLORS.accentBrand} size={16} strokeWidth={2.4} />
      </Pressable>
      {stepHint ? <Text style={styles.hint}>{stepHint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 92,
    alignItems: "center",
    gap: 4,
  },
  disabled: {
    opacity: 0.45,
  },
  well: {
    height: DIAL_HEIGHT,
    width: 84,
    backgroundColor: SETTINGS_COLORS.surfaceSolid,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
    overflow: "hidden",
  },
  selection: {
    position: "absolute",
    left: 4,
    right: 4,
    top: DIAL_PAD,
    height: DIAL_ITEM_H,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.accentBorder,
    backgroundColor: SETTINGS_COLORS.accentMuted,
    zIndex: 1,
  },
  item: {
    height: DIAL_ITEM_H,
    alignItems: "center",
    justifyContent: "center",
  },
  itemText: {
    color: SETTINGS_COLORS.textMuted,
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  itemTextActive: {
    color: SETTINGS_COLORS.accentBrand,
    fontSize: 15,
    fontWeight: "800",
  },
  chevron: {
    width: 32,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronPressed: {
    opacity: 0.6,
  },
  hint: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
});

export const VerticalValueDial = memo(VerticalValueDialInner);
export default VerticalValueDial;
