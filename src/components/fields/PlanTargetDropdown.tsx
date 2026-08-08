/**
 * Shared file/layer/whole-plan target picker — used by both Anchor and Offset,
 * which need the identical "pick one AnchorTarget from a list" interaction.
 * Structure copied from AlignDxfPanel.tsx's "Alignment method" dropdown (this
 * app's existing dropdown pattern): a header showing the current selection,
 * tap to open an in-flow option list below it, tap a row to select and close.
 */
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check, ChevronDown } from "lucide-react-native";

import type { AnchorTarget, AnchorTargetOption } from "../../utils/missionLayerLines";
import { FIELDS_COLORS } from "./fieldsTheme";

export type PlanTargetDropdownProps = {
  options: AnchorTargetOption[];
  value: AnchorTarget | null;
  onChange: (target: AnchorTarget) => void;
  placeholder: string;
  /** Optional uppercase caption above the header, e.g. "Offset scope". */
  label?: string;
  disabled?: boolean;
};

const ACCENT = "#8b5cf6";

/** Distinguishes all three AnchorTarget kinds — file/layer alone can't (neither field on "universal"). */
function keyForTarget(target: AnchorTarget): string {
  if (target.kind === "universal") return "universal";
  if (target.kind === "file") return `file:${target.fileId}`;
  return `layer:${target.layerId}`;
}

export function PlanTargetDropdown({
  options,
  value,
  onChange,
  placeholder,
  label,
  disabled = false,
}: PlanTargetDropdownProps) {
  const [open, setOpen] = useState(false);
  const isDisabled = disabled || options.length === 0;
  const selected = value != null ? options.find((o) => keyForTarget(o.target) === keyForTarget(value)) : undefined;

  return (
    <View style={{ zIndex: 20 }}>
      {label ? (
        <Text
          style={{
            color: FIELDS_COLORS.textDim,
            fontSize: 10,
            fontWeight: "800",
            letterSpacing: 0.6,
            marginBottom: 6,
            textTransform: "uppercase",
          }}
        >
          {label}
        </Text>
      ) : null}

      <Pressable
        onPress={() => {
          if (isDisabled) return;
          setOpen((o) => !o);
        }}
        accessibilityRole="button"
        accessibilityLabel={label ?? "Target dropdown"}
        accessibilityState={{ disabled: isDisabled, expanded: open }}
        style={{
          minHeight: 44,
          borderRadius: 10,
          borderWidth: 1.5,
          borderColor: open ? ACCENT : FIELDS_COLORS.panelBorder,
          backgroundColor: FIELDS_COLORS.surfaceSolid,
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          opacity: isDisabled ? 0.5 : 1,
        }}
      >
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: ACCENT }} />
        <Text
          style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}
          numberOfLines={1}
        >
          {selected?.label ?? placeholder}
        </Text>
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <ChevronDown size={16} color={FIELDS_COLORS.textMuted} />
        </View>
      </Pressable>

      {open ? (
        <View
          style={{
            marginTop: 6,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            backgroundColor: FIELDS_COLORS.cardSolid,
            overflow: "hidden",
          }}
        >
          {options.map((opt, index) => {
            const optKey = keyForTarget(opt.target);
            const isSelected = value != null && optKey === keyForTarget(value);
            return (
              <Pressable
                key={optKey}
                onPress={() => {
                  setOpen(false);
                  onChange(opt.target);
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  backgroundColor: isSelected ? "rgba(59, 130, 246, 0.08)" : "transparent",
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: ACCENT,
                    opacity: isSelected ? 1 : 0.55,
                  }}
                />
                <Text
                  style={{
                    flex: 1,
                    color: isSelected ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted,
                    fontSize: 13,
                    fontWeight: isSelected ? "800" : "600",
                  }}
                  numberOfLines={1}
                >
                  {opt.label}
                </Text>
                {isSelected ? <Check size={15} color={ACCENT} strokeWidth={2.5} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
