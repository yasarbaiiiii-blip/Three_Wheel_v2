import React from "react";
import { View, Text, Pressable } from "react-native";
import { FileUp } from "lucide-react-native";
import { RouteProp } from "@react-navigation/native";

import type { Palette } from "../theme/colors";
import type { TabParamList } from "../navigation/BottomTabs";

interface HomeScreenProps {
  route: RouteProp<TabParamList, "Home">;
}

export function HomeScreen({ route }: HomeScreenProps) {
  const { palette, onImportPress } = route.params;

  return (
    <View className="flex-1 items-center justify-center px-8" style={{ gap: 16 }}>
      <View
        className="items-center justify-center rounded-full"
        style={{
          width: 72,
          height: 72,
          backgroundColor: palette.muted,
        }}
      >
        <FileUp size={28} color={palette.mutedForeground} />
      </View>
      <Text className="text-xl font-semibold" style={{ color: palette.foreground }}>
        Welcome to Field Marker
      </Text>
      <Text
        className="text-center text-sm"
        style={{ color: palette.mutedForeground, maxWidth: 360 }}
      >
        This app helps you visualize and adjust spraying plans for your equipment
      </Text>
      <Pressable
        onPress={onImportPress}
        className="h-12 flex-row items-center justify-center rounded-md px-5"
        style={{ backgroundColor: palette.foreground, gap: 8 }}
      >
        <FileUp size={18} color={palette.background} />
        <Text className="text-sm font-semibold" style={{ color: palette.background }}>
          Load Field Plan
        </Text>
      </Pressable>
    </View>
  );
}