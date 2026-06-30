import React, { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Navigation } from "lucide-react-native";

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
  size = 180,
  knobSize = 65,
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
      let yaw = clamp(x / radius, -1, 1);

      // Suppress yaw when drag is within 10° of vertical to prevent
      // accidental steering from small horizontal finger drift.
      const STEER_LOCK_RAD = (10 * Math.PI) / 180;
      if (Math.atan2(Math.abs(x), Math.abs(y)) < STEER_LOCK_RAD) {
        yaw = 0;
      }

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

  // Modern UI Colors
  const baseRingColor = disabled ? "rgba(255,255,255,0.05)" : "rgba(59, 130, 246, 0.15)";
  const innerRingColor = disabled ? "rgba(255,255,255,0.02)" : "rgba(59, 130, 246, 0.08)";
  const knobColor = disabled ? "#475569" : "#3b82f6";

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: "rgba(9, 9, 11, 0.8)",
        borderWidth: 2,
        borderColor: disabled ? "rgba(255,255,255,0.1)" : "rgba(59, 130, 246, 0.4)",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.6 : 1,
        shadowColor: "#000",
        shadowOpacity: 0.5,
        shadowRadius: 15,
        shadowOffset: { width: 0, height: 10 },
        elevation: 8,
      }}
    >
      {/* Outer Glow / Guide Ring */}
      <View
        style={{
          position: "absolute",
          width: size * 0.85,
          height: size * 0.85,
          borderRadius: (size * 0.85) / 2,
          backgroundColor: baseRingColor,
        }}
      />
      {/* Inner Target Ring */}
      <View
        style={{
          position: "absolute",
          width: size * 0.45,
          height: size * 0.45,
          borderRadius: (size * 0.45) / 2,
          borderWidth: 1,
          borderColor: disabled ? "rgba(255,255,255,0.1)" : "rgba(59, 130, 246, 0.3)",
          backgroundColor: innerRingColor,
        }}
      />

      {/* Axis markers */}
      <View style={{ position: "absolute", width: 2, height: size * 0.9, backgroundColor: "rgba(255,255,255,0.05)" }} />
      <View style={{ position: "absolute", height: 2, width: size * 0.9, backgroundColor: "rgba(255,255,255,0.05)" }} />

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
              backgroundColor: knobColor,
              borderWidth: 4,
              borderColor: "#ffffff",
              shadowColor: "#000",
              shadowOpacity: 0.4,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 },
              elevation: 8,
              alignItems: "center",
              justifyContent: "center",
            },
            knobAnimatedStyle,
          ]}
        >
          {/* Knob Icon */}
          <View style={{ transform: [{ rotate: "45deg" }] }}>
            <Navigation color="#ffffff" size={24} fill="#ffffff" />
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}