import React from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";

import { FIELDS_COLORS } from "./fieldsTheme";
import { TransformHUD } from "./TransformHUD";
import type { TransformHUDData } from "../../types/fieldsWorkflow";

type MapPlanInteractionOverlayProps = {
  visible: boolean;
  transformData: TransformHUDData;
  onConfirm: () => void;
  /** Whether any transform has been applied (shows confirm button) */
  hasTransform: boolean;
};

/**
 * Floating overlay on the map during plan placement.
 * Shows live transform HUD + confirm — direct manipulation handles drag/scale/rotate
 * (no mode-toggle icons; those were non-functional and misleading).
 */
export function MapPlanInteractionOverlay({
  visible,
  transformData,
  onConfirm,
  hasTransform,
}: MapPlanInteractionOverlayProps) {
  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
      }}
    >
      <TransformHUD data={transformData} visible={hasTransform} />

      {hasTransform && (
        <View
          style={{
            position: "absolute",
            top: 160,
            left: "50%",
            transform: [{ translateX: -28 }],
            zIndex: 101,
          }}
        >
          <Pressable
            onPress={onConfirm}
            style={({ pressed }) => ({
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: pressed
                ? FIELDS_COLORS.confirmGreen
                : FIELDS_COLORS.confirmGreenBg,
              borderWidth: 2,
              borderColor: FIELDS_COLORS.confirmGreen,
              alignItems: "center",
              justifyContent: "center",
              elevation: 8,
              shadowColor: FIELDS_COLORS.confirmGreen,
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.4,
              shadowRadius: 8,
            })}
          >
            <Check size={28} color={FIELDS_COLORS.confirmGreen} strokeWidth={3} />
          </Pressable>
          <Text
            style={{
              textAlign: "center",
              color: FIELDS_COLORS.textMuted,
              fontSize: 9,
              fontWeight: "700",
              marginTop: 4,
              letterSpacing: 0.5,
            }}
          >
            CONFIRM
          </Text>
        </View>
      )}
    </View>
  );
}
