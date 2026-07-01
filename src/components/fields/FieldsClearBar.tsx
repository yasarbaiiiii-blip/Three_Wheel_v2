import React from "react";
import { Pressable, Text, View } from "react-native";
import { Trash2 } from "lucide-react-native";

import { FIELDS_COLORS } from "./fieldsTheme";

type FieldsClearBarProps = {
  onClear: () => Promise<void>;
  busy?: boolean;
};

export function FieldsClearBar({ onClear, busy = false }: FieldsClearBarProps) {
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: FIELDS_COLORS.panelBorder,
        backgroundColor: FIELDS_COLORS.panelBg,
      }}
    >
      <Pressable
        onPress={() => void onClear()}
        disabled={busy}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          height: 40,
          borderRadius: 10,
          backgroundColor: busy ? FIELDS_COLORS.surfaceSolid : FIELDS_COLORS.dangerMuted,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.dangerBorder,
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Trash2 size={16} color={FIELDS_COLORS.danger} />
        <Text style={{ color: FIELDS_COLORS.danger, fontSize: 13, fontWeight: "800" }}>
          {busy ? "Clearing..." : "Clear Plan"}
        </Text>
      </Pressable>
    </View>
  );
}