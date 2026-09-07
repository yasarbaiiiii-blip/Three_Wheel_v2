import { useCallback } from "react";
import {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { FIELDS_MOTION } from "./fieldsTheme";

/** Scale the wrapped view on press. Keep layout on the inner View — not Pressable.style. */
export function usePressScale(pressedScale = 0.97) {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const onPressIn = useCallback(() => {
    scale.value = withSpring(pressedScale, FIELDS_MOTION);
  }, [pressedScale, scale]);
  const onPressOut = useCallback(() => {
    scale.value = withSpring(1, FIELDS_MOTION);
  }, [scale]);
  return { style, onPressIn, onPressOut };
}
