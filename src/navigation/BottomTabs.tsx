import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { HomeScreen } from "../screens/HomeScreen";
import { PlanScreen } from "../screens/PlanScreen";

import type { Palette } from "../theme/colors";
import type { ImportedPlan, PlanLine } from "../types/plan";

export type TabParamList = {
  Home: {
    palette: Palette;
    onImportPress: () => void;
  };
  Plan: {
    palette: Palette;
    importedPlan: ImportedPlan | null;
    lines: PlanLine[];
    selectedLineId: string | null;
    onSelectLine: (id: string | null) => void;
  };
};

const Tab = createBottomTabNavigator<TabParamList>();

interface BottomTabsProps {
  palette: Palette;
  onImportPress: () => void;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
}

export function BottomTabs({
  palette,
  onImportPress,
  importedPlan,
  lines,
  selectedLineId,
  onSelectLine,
}: BottomTabsProps) {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: palette.panel,
          borderTopColor: palette.border,
        },
        tabBarActiveTintColor: palette.foreground,
        tabBarInactiveTintColor: palette.mutedForeground,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        initialParams={{ palette, onImportPress }}
      />
      <Tab.Screen
        name="Plan"
        component={PlanScreen}
        initialParams={{ palette, importedPlan, lines, selectedLineId, onSelectLine }}
      />
    </Tab.Navigator>
  );
}