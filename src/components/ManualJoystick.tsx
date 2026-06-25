import React, { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

export type JoystickValues = {
  forward: number;
  yaw: number;
};

type ManualJoystickProps = {
  size?: number;
  knobSize?: number;
  disabled?: boolean;
  onChange: (values: JoystickValues) => void;
  onRelease?: () => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const SPRING_CONFIG = {
  damping: 22,
  stiffness: 320,
  mass: 0.35,
};

export function ManualJoystick({
  size = 168,
  knobSize = 56,
  disabled = false,
  onChange,
  onRelease,
}: ManualJoystickProps) {
  const radius = (size - knobSize) / 2;
  const knobX = useSharedValue(0);
  const knobY = useSharedValue(0);

  const emitValues = useCallback(
    (x: number, y: number) => {
      const forward = clamp(-y / radius, -1, 1);
      const yaw = clamp(x / radius, -1, 1);
      onChange({ forward, yaw });
    },
    [onChange, radius]
  );

  const resetKnob = useCallback(() => {
    onChange({ forward: 0, yaw: 0 });
    onRelease?.();
  }, [onChange, onRelease]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .minDistance(0)
        .onUpdate((event) => {
          const magnitude = Math.hypot(event.translationX, event.translationY);
          const scale = magnitude > radius && magnitude > 0 ? radius / magnitude : 1;
          const x = event.translationX * scale;
          const y = event.translationY * scale;
          knobX.value = x;
          knobY.value = y;
          runOnJS(emitValues)(x, y);
        })
        .onEnd(() => {
          knobX.value = withSpring(0, SPRING_CONFIG);
          knobY.value = withSpring(0, SPRING_CONFIG);
          runOnJS(resetKnob)();
        })
        .onFinalize(() => {
          knobX.value = withSpring(0, SPRING_CONFIG);
          knobY.value = withSpring(0, SPRING_CONFIG);
        }),
    [disabled, emitValues, knobX, knobY, radius, resetKnob]
  );

  const knobAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: knobX.value },
      { translateY: knobY.value },
    ],
  }));

  const knobBaseLeft = size / 2 - knobSize / 2;
  const knobBaseTop = size / 2 - knobSize / 2;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        borderWidth: 2,
        borderColor: disabled ? "rgba(71, 85, 105, 0.5)" : "rgba(59, 130, 246, 0.45)",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <View
        style={{
          position: "absolute",
          width: size * 0.72,
          height: size * 0.72,
          borderRadius: (size * 0.72) / 2,
          borderWidth: 1,
          borderColor: "rgba(148, 163, 184, 0.18)",
        }}
      />
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            {
              position: "absolute",
              left: knobBaseLeft,
              top: knobBaseTop,
              width: knobSize,
              height: knobSize,
              borderRadius: knobSize / 2,
              backgroundColor: disabled ? "#475569" : "#3b82f6",
              borderWidth: 3,
              borderColor: "#ffffff",
              shadowColor: "#000",
              shadowOpacity: 0.25,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 2 },
              elevation: 4,
            },
            knobAnimatedStyle,
          ]}
        />
      </GestureDetector>
    </View>
  );
}