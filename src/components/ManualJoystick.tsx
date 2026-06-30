import React, { useCallback, useMemo } from "react";
import { View, StyleSheet } from "react-native";
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

const ACCENT = "#f4c10c";
const SPRING_CONFIG = { damping: 26, stiffness: 300, mass: 0.35 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ManualJoystick({
  size = 168,
  knobSize = 52,
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

  return (
    <View style={[styles.wrapper, { width: size, height: size, opacity: disabled ? 0.5 : 1 }]}>
      <View
        style={[
          styles.base,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <View
          style={[
            styles.travelRing,
            {
              width: size * 0.72,
              height: size * 0.72,
              borderRadius: (size * 0.72) / 2,
              borderColor: disabled ? "rgba(255,255,255,0.08)" : "rgba(244, 193, 12, 0.22)",
            },
          ]}
        />

        <View style={[styles.axisV, { height: size * 0.55 }]} />
        <View style={[styles.axisH, { width: size * 0.55 }]} />

        <GestureDetector gesture={panGesture}>
          <Animated.View
            style={[
              styles.knob,
              {
                left: knobBaseLeft,
                top: knobBaseTop,
                width: knobSize,
                height: knobSize,
                borderRadius: knobSize / 2,
                backgroundColor: disabled ? "#52525b" : ACCENT,
              },
              knobAnimatedStyle,
            ]}
          >
            <View
              style={[
                styles.knobInner,
                {
                  width: knobSize * 0.36,
                  height: knobSize * 0.36,
                  borderRadius: knobSize * 0.18,
                },
              ]}
            />
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  base: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  travelRing: {
    position: "absolute",
    borderWidth: 1,
  },
  axisV: {
    position: "absolute",
    width: 1,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  axisH: {
    position: "absolute",
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  knob: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.9)",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  knobInner: {
    backgroundColor: "rgba(255, 255, 255, 0.35)",
  },
});