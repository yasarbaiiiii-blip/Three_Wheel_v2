import React from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { ChevronRight, Trash2 } from "lucide-react-native";

import type { FieldsRailStatus } from "../../utils/fieldsRailStatus";
import { originChipLabel } from "../../utils/fieldsRailStatus";
import { FieldsButton, FieldsIconButton } from "./FieldsButtons";
import { FIELDS_COLORS, FIELDS_LAYOUT } from "./fieldsTheme";

type FieldsStatusHeaderProps = {
  status: FieldsRailStatus;
  busy?: boolean;
  onCollapse: () => void;
  onClear: () => Promise<void>;
  onCta?: () => void;
};

export function FieldsStatusHeader({
  status,
  busy = false,
  onCollapse,
  onClear,
  onCta,
}: FieldsStatusHeaderProps) {
  const readyDone = status.readyDone >= status.readyTotal && status.readyTotal > 0;
  const originOk = status.origin !== "unanchored";
  const tickCount = Math.max(1, status.readyTotal);

  const handleClear = () => {
    if (busy) return;
    Alert.alert(
      "Clear plan",
      "Remove the current mission from the map? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            void onClear();
          },
        },
      ]
    );
  };

  const title =
    status.fileName === "No file"
      ? "Fields"
      : status.fileCount > 1
        ? `${status.fileName} +${status.fileCount - 1}`
        : status.fileName;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <FieldsIconButton onPress={onCollapse} accessibilityLabel="Hide workflow panel">
          <ChevronRight size={16} color={FIELDS_COLORS.textMuted} strokeWidth={2.4} />
        </FieldsIconButton>
        <FieldsIconButton
          onPress={handleClear}
          disabled={busy}
          tone="danger"
          accessibilityLabel={busy ? "Clearing plan" : "Clear plan"}
        >
          <Trash2 size={16} color={FIELDS_COLORS.danger} strokeWidth={2.2} />
        </FieldsIconButton>
      </View>

      <View style={styles.progressRow}>
        <View style={styles.ticks} accessibilityRole="progressbar">
          {Array.from({ length: tickCount }, (_, i) => {
            const on = i < status.readyDone;
            return (
              <View
                key={i}
                style={[
                  styles.tick,
                  on && (readyDone ? styles.tickOk : styles.tickGold),
                ]}
              />
            );
          })}
        </View>
        <Text style={[styles.frac, readyDone && styles.fracOk]}>
          {status.readyDone}/{status.readyTotal}
        </Text>
        <View style={[styles.chip, originOk ? styles.chipOn : styles.chipDim]}>
          <View style={[styles.liveDot, originOk ? styles.liveOn : styles.liveOff]} />
          <Text style={[styles.chipText, originOk ? styles.chipTextOn : styles.chipTextDim]}>
            {originChipLabel(status.origin)}
          </Text>
        </View>
      </View>

      {status.ctaId !== "none" && onCta ? (
        <View style={styles.ctaWrap}>
          <FieldsButton label={status.ctaLabel} onPress={onCta} disabled={busy} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: "transparent",
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: FIELDS_LAYOUT.iconBtn,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
    justifyContent: "center",
  },
  title: {
    color: FIELDS_COLORS.textMain,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.3,
    lineHeight: 21,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  ticks: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
  },
  tick: {
    flex: 1,
    height: 5,
    borderRadius: 99,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  tickGold: { backgroundColor: FIELDS_COLORS.accentBrand },
  tickOk: { backgroundColor: FIELDS_COLORS.success },
  frac: {
    color: FIELDS_COLORS.textDim,
    fontSize: 11,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    minWidth: 28,
    textAlign: "right",
  },
  fracOk: { color: FIELDS_COLORS.success },
  chip: {
    height: 24,
    paddingHorizontal: 9,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  chipOn: {
    backgroundColor: "rgba(52,211,153,0.12)",
    borderColor: FIELDS_COLORS.successBorder,
  },
  chipDim: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
  },
  chipText: {
    fontSize: 10,
    fontWeight: "800",
  },
  chipTextOn: { color: FIELDS_COLORS.success },
  chipTextDim: { color: FIELDS_COLORS.textDim },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  liveOn: { backgroundColor: FIELDS_COLORS.success },
  liveOff: { backgroundColor: FIELDS_COLORS.textDim },
  ctaWrap: {
    marginTop: 2,
  },
});
