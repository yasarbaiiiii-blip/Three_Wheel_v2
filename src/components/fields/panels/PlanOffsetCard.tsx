/**
 * Offset plan left/right — whole-plan rigid shift, relative to the plan's own
 * start->end travel direction (AB-line / CNC-cutter-compensation convention).
 * Fields Upload step, same slot as the Enable Extension card. Presentational
 * only: parent (App.tsx) owns the state and bakes the shift into `lines` on
 * Apply — see planOffset.ts for the geometry and handleApplyOffset in App.tsx.
 */
import React, { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ArrowLeft, ArrowRight } from "lucide-react-native";

import { FIELDS_COLORS } from "../fieldsTheme";

export type PlanOffsetCardProps = {
  visible: boolean;
  offsetDistanceM: number;
  offsetDirection: "left" | "right";
  onOffsetDistanceChange: (m: number) => void;
  onOffsetDirectionChange: (d: "left" | "right") => void;
  onApplyOffset: () => void;
};

export function PlanOffsetCard({
  visible,
  offsetDistanceM,
  offsetDirection,
  onOffsetDistanceChange,
  onOffsetDirectionChange,
  onApplyOffset,
}: PlanOffsetCardProps) {
  /** Draft string mirrors offsetDistanceM (kept in sync so a post-Apply reset to 0 shows). */
  const [draft, setDraft] = useState(() => String(offsetDistanceM));

  useEffect(() => {
    setDraft(String(offsetDistanceM));
  }, [offsetDistanceM]);

  if (!visible) return null;

  const armed = offsetDistanceM > 0;

  return (
    <View
      style={{
        borderRadius: 10,
        backgroundColor: FIELDS_COLORS.surfaceSolid,
        borderWidth: 1,
        borderColor: armed ? "#8b5cf6" : FIELDS_COLORS.panelBorder,
        overflow: "hidden",
      }}
    >
      <View style={{ padding: 12, gap: 10 }}>
        <View>
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
            Offset Plan
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
            Shift the whole plan left or right of its own travel direction. Local only —
            not saved to the rover.
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => onOffsetDirectionChange("left")}
            accessibilityRole="button"
            accessibilityState={{ selected: offsetDirection === "left" }}
            style={{
              flex: 1,
              height: 36,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: offsetDirection === "left" ? "#8b5cf6" : FIELDS_COLORS.panelBorder,
              backgroundColor: offsetDirection === "left" ? "#8b5cf6" : FIELDS_COLORS.cardSolid,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <ArrowLeft size={14} color={offsetDirection === "left" ? "#fff" : FIELDS_COLORS.textMuted} />
            <Text
              style={{
                color: offsetDirection === "left" ? "#fff" : FIELDS_COLORS.textMuted,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              Left
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onOffsetDirectionChange("right")}
            accessibilityRole="button"
            accessibilityState={{ selected: offsetDirection === "right" }}
            style={{
              flex: 1,
              height: 36,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: offsetDirection === "right" ? "#8b5cf6" : FIELDS_COLORS.panelBorder,
              backgroundColor: offsetDirection === "right" ? "#8b5cf6" : FIELDS_COLORS.cardSolid,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Text
              style={{
                color: offsetDirection === "right" ? "#fff" : FIELDS_COLORS.textMuted,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              Right
            </Text>
            <ArrowRight size={14} color={offsetDirection === "right" ? "#fff" : FIELDS_COLORS.textMuted} />
          </Pressable>
        </View>

        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>
              Distance (m)
            </Text>
            <TextInput
              style={{
                height: 36,
                backgroundColor: FIELDS_COLORS.cardSolid,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
                borderRadius: 6,
                paddingHorizontal: 8,
                fontSize: 13,
                color: FIELDS_COLORS.textMain,
              }}
              value={draft}
              onChangeText={(v) => {
                setDraft(v);
                const n = parseFloat(v);
                if (!Number.isFinite(n)) return;
                onOffsetDistanceChange(n);
              }}
              onBlur={() => {
                const n = parseFloat(draft);
                const normalized = Number.isFinite(n) ? Math.max(0, n) : 0;
                onOffsetDistanceChange(normalized);
                setDraft(String(normalized));
              }}
              keyboardType="numeric"
            />
          </View>
          <Pressable
            onPress={onApplyOffset}
            disabled={!armed}
            accessibilityRole="button"
            accessibilityState={{ disabled: !armed }}
            style={{
              height: 36,
              paddingHorizontal: 14,
              borderRadius: 6,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: armed ? "#8b5cf6" : FIELDS_COLORS.pillSecondary,
              opacity: armed ? 1 : 0.5,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Apply Offset</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
