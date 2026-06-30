import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, StatusBar } from "react-native";
import * as NavigationBar from "expo-navigation-bar";
import { isEdgeToEdge } from "react-native-is-edge-to-edge";

async function safelyRun(task: () => Promise<void>) {
  try {
    await task();
  } catch (error) {
    console.warn("[ImmersiveMode] Unable to update system UI", error);
  }
}

async function setAndroidNavigationBarHidden(hidden: boolean) {
  if (Platform.OS !== "android") return;

  if (hidden) {
    const edgeToEdgeEnabled = isEdgeToEdge();

    if (!edgeToEdgeEnabled) {
      await safelyRun(() => NavigationBar.setBehaviorAsync("overlay-swipe"));
      await safelyRun(() => NavigationBar.setBackgroundColorAsync("#000000"));
    }

    await safelyRun(() => NavigationBar.setButtonStyleAsync("light"));
    await safelyRun(() => NavigationBar.setVisibilityAsync("hidden"));
    return;
  }

  await safelyRun(() => NavigationBar.setVisibilityAsync("visible"));

  if (!isEdgeToEdge()) {
    await safelyRun(() => NavigationBar.setBehaviorAsync("inset-touch"));
    await safelyRun(() => NavigationBar.setBackgroundColorAsync("#000000"));
  }
}

export function useImmersiveMode(enabledByDefault = true) {
  const [isImmersiveMode, setIsImmersiveMode] = useState(enabledByDefault);

  const applyImmersiveMode = useCallback(async (enabled: boolean) => {
    StatusBar.setHidden(enabled, "fade");
    await setAndroidNavigationBarHidden(enabled);
  }, []);

  const setImmersiveMode = useCallback((enabled: boolean) => {
    setIsImmersiveMode(enabled);
  }, []);

  const toggleImmersiveMode = useCallback(() => {
    setIsImmersiveMode((current) => !current);
  }, []);

  useEffect(() => {
    void applyImmersiveMode(isImmersiveMode);
  }, [applyImmersiveMode, isImmersiveMode]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void applyImmersiveMode(isImmersiveMode);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [applyImmersiveMode, isImmersiveMode]);

  useEffect(() => {
    return () => {
      StatusBar.setHidden(false, "fade");
      void setAndroidNavigationBarHidden(false);
    };
  }, []);

  return {
    isImmersiveMode,
    setImmersiveMode,
    toggleImmersiveMode,
  };
}
