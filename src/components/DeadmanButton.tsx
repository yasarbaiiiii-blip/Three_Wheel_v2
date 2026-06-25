import React from "react";
import { Pressable, Text } from "react-native";

type DeadmanButtonProps = {
  onPress: () => void;
  onRelease: () => void;
  disabled?: boolean;
  active?: boolean;
};

export function DeadmanButton({
  onPress,
  onRelease,
  disabled = false,
  active = false,
}: DeadmanButtonProps) {
  return (
    <Pressable
      disabled={disabled}
      onPressIn={onPress}
      onPressOut={onRelease}
      style={{
        height: 44,
        borderRadius: 10,
        backgroundColor: active ? "#dc2626" : disabled ? "#334155" : "#475569",
        borderWidth: 2,
        borderColor: active ? "#fca5a5" : "#64748b",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "800", letterSpacing: 0.6 }}>
        {active ? "DRIVING — RELEASE TO STOP" : "HOLD TO DRIVE"}
      </Text>
    </Pressable>
  );
}