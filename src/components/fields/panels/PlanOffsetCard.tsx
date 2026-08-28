/**
 * Offset plan — either a whole-plan rigid shift toward an absolute compass
 * bearing, or an inner/outer buffer of the marks. Fields Upload step, same
 * slot as the Enable Extension card. Presentational only: parent (App.tsx)
 * owns the state and bakes into `lines` on Apply.
 */
import React, { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import type { AnchorTarget, AnchorTargetOption } from "../../../utils/missionLayerLines";
import type { PlanBufferDirection, PlanOffsetMode } from "../../../utils/planOffset";
import { CompassDial } from "../CompassDial";
import { PlanTargetDropdown } from "../PlanTargetDropdown";
import { FIELDS_COLORS } from "../fieldsTheme";

export type PlanOffsetCardProps = {
  visible: boolean;
  offsetMode: PlanOffsetMode;
  onOffsetModeChange: (mode: PlanOffsetMode) => void;
  offsetBufferDirection: PlanBufferDirection;
  onOffsetBufferDirectionChange: (direction: PlanBufferDirection) => void;
  offsetDistanceM: number;
  offsetBearingDeg: number;
  onOffsetDistanceChange: (m: number) => void;
  onOffsetBearingChange: (deg: number) => void;
  onApplyOffset: () => void;
  offsetTargetOptions: AnchorTargetOption[];
  offsetTarget: AnchorTarget | null;
  onOffsetTargetChange: (target: AnchorTarget) => void;
  offsetResetAvailable: boolean;
  onResetOffset: () => void;
  /** Fired true/false as the operator starts/stops dragging the dial — drives the live map ghost. */
  onOffsetDragStateChange?: (dragging: boolean) => void;
};

export function PlanOffsetCard({
  visible,
  offsetMode,
  onOffsetModeChange,
  offsetBufferDirection,
  onOffsetBufferDirectionChange,
  offsetDistanceM,
  offsetBearingDeg,
  onOffsetDistanceChange,
  onOffsetBearingChange,
  onApplyOffset,
  offsetTargetOptions,
  offsetTarget,
  onOffsetTargetChange,
  offsetResetAvailable,
  onResetOffset,
  onOffsetDragStateChange,
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
            {offsetMode === "buffer"
              ? "Expand or shrink the marks by a distance. Local only — not saved to the rover."
              : "Pick a scope and distance, then drag the dial to aim. Local only — not saved to the rover."}
          </Text>
        </View>

        <View style={{ flexDirection: "row", backgroundColor: FIELDS_COLORS.cardSolid, borderRadius: 6, padding: 3 }}>
          <Pressable
            onPress={() => onOffsetModeChange("shift")}
            style={{ flex: 1, paddingVertical: 6, alignItems: "center", backgroundColor: offsetMode === "shift" ? FIELDS_COLORS.pillSecondary : "transparent", borderRadius: 4 }}
          >
            <Text style={{ fontSize: 12, fontWeight: "700", color: offsetMode === "shift" ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted }}>Direction (360)</Text>
          </Pressable>
          <Pressable
            onPress={() => onOffsetModeChange("buffer")}
            style={{ flex: 1, paddingVertical: 6, alignItems: "center", backgroundColor: offsetMode === "buffer" ? FIELDS_COLORS.pillSecondary : "transparent", borderRadius: 4 }}
          >
            <Text style={{ fontSize: 12, fontWeight: "700", color: offsetMode === "buffer" ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted }}>In / Out (Buffer)</Text>
          </Pressable>
        </View>

        {offsetMode === "buffer" && (
          <View style={{ flexDirection: "row", backgroundColor: FIELDS_COLORS.cardSolid, borderRadius: 6, padding: 3 }}>
            <Pressable
              onPress={() => onOffsetBufferDirectionChange("out")}
              style={{ flex: 1, paddingVertical: 6, alignItems: "center", backgroundColor: offsetBufferDirection === "out" ? FIELDS_COLORS.pillSecondary : "transparent", borderRadius: 4 }}
            >
              <Text style={{ fontSize: 12, fontWeight: "700", color: offsetBufferDirection === "out" ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted }}>Out</Text>
            </Pressable>
            <Pressable
              onPress={() => onOffsetBufferDirectionChange("in")}
              style={{ flex: 1, paddingVertical: 6, alignItems: "center", backgroundColor: offsetBufferDirection === "in" ? FIELDS_COLORS.pillSecondary : "transparent", borderRadius: 4 }}
            >
              <Text style={{ fontSize: 12, fontWeight: "700", color: offsetBufferDirection === "in" ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted }}>In</Text>
            </Pressable>
          </View>
        )}

        <PlanTargetDropdown
          options={offsetTargetOptions}
          value={offsetTarget}
          onChange={onOffsetTargetChange}
          placeholder="Whole Plan"
          label="Offset scope"
        />

        <View style={{ gap: 3 }}>
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

        {offsetMode === "shift" && (
          <CompassDial
            bearingDeg={offsetBearingDeg}
            onBearingChange={onOffsetBearingChange}
            onDragStateChange={onOffsetDragStateChange}
          />
        )}

        <Pressable
          onPress={onApplyOffset}
          disabled={!armed}
          accessibilityRole="button"
          accessibilityState={{ disabled: !armed }}
          style={{
            height: 36,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: armed ? "#8b5cf6" : FIELDS_COLORS.pillSecondary,
            opacity: armed ? 1 : 0.5,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Apply Offset</Text>
        </Pressable>

        <Pressable
          onPress={onResetOffset}
          disabled={!offsetResetAvailable}
          accessibilityRole="button"
          accessibilityState={{ disabled: !offsetResetAvailable }}
          style={{
            height: 36,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: offsetResetAvailable ? FIELDS_COLORS.panelBorder : "transparent",
            backgroundColor: offsetResetAvailable ? FIELDS_COLORS.surfaceSolid : FIELDS_COLORS.pillSecondary,
            opacity: offsetResetAvailable ? 1 : 0.5,
          }}
        >
          <Text
            style={{
              color: offsetResetAvailable ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted,
              fontSize: 12,
              fontWeight: "700",
            }}
          >
            Reset to Before Offset
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
