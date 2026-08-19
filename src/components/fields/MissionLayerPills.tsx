/**
 * Compact mission-layer visibility pills for the map tools strip.
 */

import React from "react";
import { Pressable, Text, View } from "react-native";

import type { MissionLayer } from "../../types/missionLayers";
import { nonEmptyMissionLayers } from "../../utils/missionLayerAssignment";

const COLORS = {
  panelSolid: "#18181b",
  panelBorder: "#2e2e34",
  textMain: "#f8fafc",
  textMuted: "#94a3b8",
  accentBrand: "#f4c10c",
  accentText: "#1c1c1c",
  accentMuted: "#2e2a18",
  accentBorder: "#6b5a12",
  success: "#10b981",
  surfaceSolid: "#252529",
};

export function MissionLayerPills({
  layers,
  onToggle,
}: {
  layers: MissionLayer[];
  onToggle: (layerId: string) => void;
}) {
  const items = nonEmptyMissionLayers(layers);
  if (items.length === 0) return null;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        backgroundColor: "rgba(18, 18, 22, 0.88)",
        borderRadius: 999,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.08)",
        alignSelf: "flex-start",
        maxWidth: 360,
      }}
    >
      <Text
        style={{
          color: COLORS.textMuted,
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 0.6,
          textTransform: "uppercase",
          marginRight: 2,
        }}
      >
        M-Layers
      </Text>
      {items.map((layer) => {
        const on = layer.visible;
        return (
          <Pressable
            key={layer.id}
            onPress={() => onToggle(layer.id)}
            accessibilityRole="button"
            accessibilityLabel={`Mission Layer ${layer.number}${on ? " visible" : " hidden"}`}
            style={{
              minWidth: 30,
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 4,
              backgroundColor: on ? COLORS.accentMuted : COLORS.surfaceSolid,
              borderWidth: 1,
              borderColor: on ? COLORS.accentBorder : COLORS.panelBorder,
              opacity: on ? 1 : 0.55,
            }}
          >
            <Text
              style={{
                color: on ? COLORS.accentBrand : COLORS.textMuted,
                fontWeight: "900",
                fontSize: 12,
              }}
            >
              {layer.number}
            </Text>
            {layer.finished ? (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: COLORS.success,
                }}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
