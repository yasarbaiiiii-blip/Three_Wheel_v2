import React, { useCallback } from "react";
import { Dimensions, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import AnimatedReanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

const FLOATING_ESTOP_SIZE = 74;
const FLOATING_ESTOP_MARGIN = 18;

export function FloatingEStop({
  visible,
  onEStop,
}: {
  visible: boolean;
  onEStop: () => Promise<void>;
}) {
  const screen = Dimensions.get("window");
  const translateX = useSharedValue(screen.width - FLOATING_ESTOP_SIZE - FLOATING_ESTOP_MARGIN);
  const translateY = useSharedValue(screen.height * 0.55);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const triggerEStop = useCallback(() => {
    void onEStop();
  }, [onEStop]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  const panGesture = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((event) => {
      translateX.value = startX.value + event.translationX;
      translateY.value = startY.value + event.translationY;
    })
    .onEnd(() => {
      const maxX = screen.width - FLOATING_ESTOP_SIZE - FLOATING_ESTOP_MARGIN;
      const maxY = screen.height - FLOATING_ESTOP_SIZE - FLOATING_ESTOP_MARGIN;
      const snapX = translateX.value > screen.width / 2 ? maxX : FLOATING_ESTOP_MARGIN;
      const clampedY = Math.max(FLOATING_ESTOP_MARGIN, Math.min(translateY.value, maxY));
      translateX.value = withSpring(snapX, { damping: 20, stiffness: 200 });
      translateY.value = withSpring(clampedY, { damping: 20, stiffness: 200 });
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(260)
    .onEnd((_event, success) => {
      if (success) runOnJS(triggerEStop)();
    });

  const composedGesture = Gesture.Exclusive(doubleTapGesture, panGesture);

  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 99999,
        elevation: 100,
      }}
    >
      <GestureDetector gesture={composedGesture}>
        <AnimatedReanimated.View
          pointerEvents="auto"
          style={[
            {
              position: "absolute",
              width: FLOATING_ESTOP_SIZE,
              height: FLOATING_ESTOP_SIZE,
              borderRadius: FLOATING_ESTOP_SIZE / 2,
              backgroundColor: "#dc2626",
              borderWidth: 3,
              borderColor: "#fee2e2",
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.28,
              shadowRadius: 14,
              elevation: 100,
            },
            animatedStyle,
          ]}
        >
          <Text
            style={{
              color: "#ffffff",
              fontSize: 11,
              fontWeight: "900",
              textAlign: "center",
              lineHeight: 13,
            }}
          >
            E-STOP
          </Text>
          <Text style={{ color: "#fecaca", fontSize: 8, fontWeight: "800", marginTop: 2 }}>2 TAP</Text>
        </AnimatedReanimated.View>
      </GestureDetector>
    </View>
  );
}

export default FloatingEStop;
