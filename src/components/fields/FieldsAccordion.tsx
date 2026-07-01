import React from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";

import type { AccordionStatus } from "../../types/fieldsWorkflow";
import { FIELDS_COLORS, statusPillColors } from "./fieldsTheme";

type FieldsAccordionProps = {
  id: string;
  title: string;
  status?: AccordionStatus;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
};

const statusLabel = (status: AccordionStatus) => {
  if (status === "verified") return "Verified";
  if (status === "failed") return "Failed";
  if (status === "pending") return "Pending";
  return "Idle";
};

export function FieldsAccordion({
  title,
  status = "idle",
  expanded,
  onToggle,
  children,
}: FieldsAccordionProps) {
  const pill = statusPillColors(status);

  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: expanded ? FIELDS_COLORS.accentBorder : FIELDS_COLORS.panelBorder,
        backgroundColor: FIELDS_COLORS.cardSolid,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={onToggle}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 10,
          backgroundColor: expanded ? FIELDS_COLORS.accentMuted : FIELDS_COLORS.cardSolid,
        }}
      >
        {expanded ? (
          <ChevronDown size={18} color={FIELDS_COLORS.textMain} />
        ) : (
          <ChevronRight size={18} color={FIELDS_COLORS.textMuted} />
        )}
        <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 14, fontWeight: "800" }}>
          {title}
        </Text>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            backgroundColor: pill.bg,
            borderWidth: 1,
            borderColor: pill.border,
          }}
        >
          <Text style={{ color: pill.text, fontSize: 10, fontWeight: "800", textTransform: "uppercase" }}>
            {statusLabel(status)}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View style={{ padding: 14, gap: 12, borderTopWidth: 1, borderTopColor: FIELDS_COLORS.panelBorder }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}