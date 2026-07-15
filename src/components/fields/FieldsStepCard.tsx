import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight, Check, Circle } from "lucide-react-native";

import { FIELDS_COLORS } from "./fieldsTheme";

type StepStatus = "pending" | "active" | "done";

type FieldsStepCardProps = {
  stepNumber: number;
  title: string;
  status: StepStatus;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  disabled?: boolean;
  /**
   * When true and expanded, the card flexes to fill the remaining space in its parent
   * column and its body scrolls internally instead of growing to full content height —
   * use for steps whose content can get long (many fields/rows). Only safe for steps
   * whose content has no VirtualizedList/FlatList of its own (nesting one inside this
   * ScrollView breaks RN's list virtualization) — leave off for those.
   */
  scrollableBody?: boolean;
};

const stepIndicatorColors = (status: StepStatus) => {
  if (status === "done") return { bg: FIELDS_COLORS.stepDone, icon: "#fff" };
  if (status === "active") return { bg: FIELDS_COLORS.stepActive, icon: "#fff" };
  return { bg: FIELDS_COLORS.stepPending, icon: FIELDS_COLORS.textDim };
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
}: FieldsStepCardProps) {
  const indicator = stepIndicatorColors(status);
  const isScrolling = expanded && scrollableBody;

  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: expanded
          ? status === "done"
            ? FIELDS_COLORS.successBorder
            : FIELDS_COLORS.stepActive
          : FIELDS_COLORS.panelBorder,
        backgroundColor: FIELDS_COLORS.cardSolid,
        overflow: "hidden",
        opacity: disabled ? 0.4 : 1,
        ...(isScrolling ? { flex: 1, minHeight: 0 } : null),
      }}
    >
      <Pressable
        onPress={disabled ? undefined : onToggle}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 10,
          backgroundColor: expanded ? "rgba(59, 130, 246, 0.08)" : FIELDS_COLORS.cardSolid,
        }}
      >
        {/* Step number / status indicator */}
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            backgroundColor: indicator.bg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {status === "done" ? (
            <Check size={14} color={indicator.icon} strokeWidth={3} />
          ) : (
            <Text
              style={{
                color: indicator.icon,
                fontSize: 12,
                fontWeight: "900",
              }}
            >
              {stepNumber}
            </Text>
          )}
        </View>

        <Text
          style={{
            flex: 1,
            color: disabled ? FIELDS_COLORS.textDim : FIELDS_COLORS.textMain,
            fontSize: 14,
            fontWeight: "800",
          }}
        >
          {title}
        </Text>

        {expanded ? (
          <ChevronDown size={16} color={FIELDS_COLORS.textMuted} />
        ) : (
          <ChevronRight size={16} color={FIELDS_COLORS.textDim} />
        )}
      </Pressable>

      {expanded ? (
        isScrolling ? (
          <ScrollView
            style={{ flex: 1, minHeight: 0, borderTopWidth: 1, borderTopColor: FIELDS_COLORS.panelBorder }}
            contentContainerStyle={{ padding: 14, gap: 12 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            nestedScrollEnabled
          >
            {children}
          </ScrollView>
        ) : (
          <View
            style={{
              padding: 14,
              gap: 12,
              borderTopWidth: 1,
              borderTopColor: FIELDS_COLORS.panelBorder,
            }}
          >
            {children}
          </View>
        )
      ) : null}
    </View>
  );
}
