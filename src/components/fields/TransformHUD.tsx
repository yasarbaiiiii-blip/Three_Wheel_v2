import React from "react";
import { Text, View } from "react-native";

import { FIELDS_COLORS } from "./fieldsTheme";
import type { TransformHUDData } from "../../types/fieldsWorkflow";

type TransformHUDProps = {
  data: TransformHUDData;
  visible: boolean;
};

/**
 * Glassmorphic floating card showing real-time transform data
 * above the plan on the map during scale/drag/rotate.
 */
export function TransformHUD({ data, visible }: TransformHUDProps) {
  if (!visible) return null;

  const scalePercent = ((data.scaleMultiplier - 1) * 100).toFixed(1);
  const scaleSign = data.scaleMultiplier >= 1 ? "+" : "";
  const offsetDist = Math.hypot(data.offsetMeters.x, data.offsetMeters.y);

  return (
    <View
      style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: [{ translateX: -120 }],
        width: 240,
        backgroundColor: FIELDS_COLORS.hudBg,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: FIELDS_COLORS.hudBorder,
        padding: 12,
        gap: 6,
        // Shadow
        elevation: 12,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.5,
        shadowRadius: 12,
        zIndex: 100,
      }}
    >
      {/* Scale */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={styles.label}>Scale</Text>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.value}>
            {scaleSign}{scalePercent}% · {data.scaleMultiplier.toFixed(2)}×
          </Text>
          {data.boundingWidthM > 0 && (
            <Text style={styles.subValue}>
              {data.boundingWidthM.toFixed(1)}m × {data.boundingHeightM.toFixed(1)}m
            </Text>
          )}
        </View>
      </View>

      {/* Rotation */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={styles.label}>Rotation</Text>
        <Text style={styles.value}>{data.rotationDeg.toFixed(1)}°</Text>
      </View>

      {/* Offset */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={styles.label}>Offset</Text>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.value}>{offsetDist.toFixed(2)}m</Text>
          <Text style={styles.subValue}>
            E {data.offsetMeters.x.toFixed(2)}m · N {data.offsetMeters.y.toFixed(2)}m
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = {
  label: {
    color: FIELDS_COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600" as const,
    letterSpacing: 0.3,
  },
  value: {
    color: FIELDS_COLORS.hudText,
    fontSize: 13,
    fontWeight: "800" as const,
    fontFamily: "monospace" as const,
  },
  subValue: {
    color: FIELDS_COLORS.textDim,
    fontSize: 10,
    fontFamily: "monospace" as const,
    marginTop: 1,
  },
};
