/**
 * Anchor point selection (re-anchor a CSV/DXF plan's start) — Fields only, shown
 * before Send so the operator can fix the start point before staging a mission.
 */
import React from "react";
import { Pressable, Text, View } from "react-native";
import { Check, Crosshair, X } from "lucide-react-native";

import type { AnchorTarget, AnchorTargetOption } from "../../../utils/missionLayerLines";
import type { AnchorCandidatePoint } from "../../mapViewTypes";
import { FIELDS_COLORS } from "../fieldsTheme";

type AnchorPanelProps = {
  anchorAvailable: boolean;
  anchorSelectMode: boolean;
  anchorTargetOptions: AnchorTargetOption[];
  anchorTarget: AnchorTarget | null;
  pendingAnchor: AnchorCandidatePoint | null;
  onAnchorPress?: () => void;
  onSelectAnchorTarget?: (target: AnchorTarget) => void;
  onConfirmAnchor?: () => void;
};

export function AnchorPanel({
  anchorAvailable,
  anchorSelectMode,
  anchorTargetOptions,
  anchorTarget,
  pendingAnchor,
  onAnchorPress,
  onSelectAnchorTarget,
  onConfirmAnchor,
}: AnchorPanelProps) {
  return (
    <View
      style={{
        borderRadius: 10,
        backgroundColor: FIELDS_COLORS.surfaceSolid,
        borderWidth: 1,
        borderColor: anchorSelectMode ? "#8b5cf6" : FIELDS_COLORS.panelBorder,
        overflow: "hidden",
        marginBottom: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          padding: 12,
          gap: 10,
        }}
      >
        {pendingAnchor ? (
          <Check size={16} color={FIELDS_COLORS.success} strokeWidth={2.4} />
        ) : (
          <Crosshair
            size={16}
            color={anchorSelectMode ? "#8b5cf6" : FIELDS_COLORS.textMuted}
            strokeWidth={2.4}
          />
        )}
        <View style={{ flex: 1 }}>
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
            Anchor point
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
            {pendingAnchor
              ? "Point selected — confirm to re-order the plan from there."
              : anchorTarget
                ? "Tap a point on the map to set the new start."
                : anchorSelectMode
                  ? "Choose which file or layer to anchor."
                  : anchorAvailable
                    ? "Change where this plan starts."
                    : "Load a plan to change its start point."}
          </Text>
        </View>

        {anchorSelectMode ? (
          <Pressable
            onPress={onAnchorPress}
            accessibilityLabel="Cancel anchor selection"
            style={{ padding: 6 }}
          >
            <X size={16} color={FIELDS_COLORS.textDim} />
          </Pressable>
        ) : (
          <Pressable
            onPress={onAnchorPress}
            disabled={!anchorAvailable}
            accessibilityRole="button"
            accessibilityState={{ disabled: !anchorAvailable }}
            style={{
              height: 32,
              paddingHorizontal: 12,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: anchorAvailable ? "#8b5cf6" : FIELDS_COLORS.pillSecondary,
              opacity: anchorAvailable ? 1 : 0.5,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Set anchor</Text>
          </Pressable>
        )}
      </View>

      {anchorSelectMode && !anchorTarget ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 6 }}>
          {anchorTargetOptions.length === 0 ? (
            <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11 }}>No plan loaded.</Text>
          ) : (
            anchorTargetOptions.map((opt) => {
              const key = opt.target.kind === "file" ? opt.target.fileId : opt.target.layerId;
              return (
                <Pressable
                  key={key}
                  onPress={() => onSelectAnchorTarget?.(opt.target)}
                  accessibilityRole="button"
                  style={{
                    height: 36,
                    paddingHorizontal: 10,
                    borderRadius: 8,
                    justifyContent: "center",
                    backgroundColor: FIELDS_COLORS.cardSolid,
                    borderWidth: 1,
                    borderColor: FIELDS_COLORS.panelBorder,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "600" }}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>
      ) : null}

      {anchorSelectMode && pendingAnchor ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <Pressable
            onPress={onConfirmAnchor}
            accessibilityRole="button"
            style={{
              height: 38,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 6,
              backgroundColor: FIELDS_COLORS.success,
            }}
          >
            <Check size={16} color="#fff" strokeWidth={2.6} />
            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>Confirm new anchor</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
