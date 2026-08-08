/**
 * Offset plan — whole-plan rigid shift toward an absolute compass bearing.
 * Fields Upload step, same slot as the Enable Extension card. Presentational
 * only: parent (App.tsx) owns the state and bakes the shift into `lines` on
 * Apply — see planOffset.ts for the geometry and handleApplyOffset in App.tsx.
 */
import React, { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { CompassDial } from "../CompassDial";
import { FIELDS_COLORS } from "../fieldsTheme";

export type PlanOffsetCardProps = {
  visible: boolean;
  offsetDistanceM: number;
  offsetBearingDeg: number;
  onOffsetDistanceChange: (m: number) => void;
  onOffsetBearingChange: (deg: number) => void;
  onApplyOffset: () => void;
};

export function PlanOffsetCard({
  visible,
  offsetDistanceM,
  offsetBearingDeg,
  onOffsetDistanceChange,
  onOffsetBearingChange,
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
      <View style={{ padding: 12, gap: 12 }}>
        <View>
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
            Offset Plan
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
            Drag the dial to aim, then set a distance. Local only — not saved to the rover.
          </Text>
        </View>

        <CompassDial bearingDeg={offsetBearingDeg} onBearingChange={onOffsetBearingChange} />

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
