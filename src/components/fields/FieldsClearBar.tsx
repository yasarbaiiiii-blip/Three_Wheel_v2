import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Trash2 } from "lucide-react-native";

import { FIELDS_COLORS, FIELDS_LAYOUT } from "./fieldsTheme";

type FieldsClearBarProps = {
  onClear: () => Promise<void>;
  busy?: boolean;
};

export function FieldsClearBar({ onClear, busy = false }: FieldsClearBarProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.titleBlock}>
          <Text style={styles.kicker}>FIELDS</Text>
          <Text style={styles.title} numberOfLines={1}>
            Mission workflow
          </Text>
        </View>

        {/* Layout on the child View, not the Pressable — see FieldsStepCard. */}
        <Pressable
          onPress={() => void onClear()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={busy ? "Clearing plan" : "Clear plan"}
          hitSlop={6}
          android_ripple={{ color: "rgba(248,113,113,0.22)", radius: FIELDS_LAYOUT.iconBtn / 2 }}
        >
          <View style={[styles.clearBtn, busy && styles.clearBtnBusy]}>
            <Trash2 size={16} color={FIELDS_COLORS.danger} strokeWidth={2.2} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: FIELDS_COLORS.navSolid,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: FIELDS_COLORS.panelBorder,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: FIELDS_LAYOUT.iconBtn,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    paddingRight: 12,
    justifyContent: "center",
  },
  kicker: {
    color: FIELDS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    marginBottom: 2,
  },
  title: {
    color: FIELDS_COLORS.textMain,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  clearBtn: {
    width: FIELDS_LAYOUT.iconBtn,
    height: FIELDS_LAYOUT.iconBtn,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    backgroundColor: FIELDS_COLORS.dangerMuted,
    borderColor: FIELDS_COLORS.dangerBorder,
  },
  clearBtnBusy: {
    opacity: 0.45,
  },
});
