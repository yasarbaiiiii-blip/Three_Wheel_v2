import React, { useMemo } from "react";
import { View } from "react-native";
import { RouteProp } from "@react-navigation/native";
import { GeometryViewport } from "../components/GeometryViewport";

import type { Palette } from "../theme/colors";
import type { ImportedPlan, PlanLine } from "../types/plan";
import type { TabParamList } from "../navigation/BottomTabs";

interface PlanScreenProps {
  route: RouteProp<TabParamList, "Plan">;
}

export function PlanScreen({ route }: PlanScreenProps) {
  const { palette, importedPlan, lines, selectedLineId, onSelectLine } = route.params;

  const selectedLine = useMemo(
    () => lines.find((line) => line.id === selectedLineId) ?? null,
    [lines, selectedLineId]
  );

  return (
    <View className="flex-1">
      <GeometryViewport
        palette={palette}
        compact={false}
        importedPlan={importedPlan}
        lines={lines}
        selectedLineId={selectedLineId}
        onSelectLine={onSelectLine}
        onImportPress={() => {}}
        markingStyle="straight"
        onSelectMarkingStyle={() => {}}
        rotation={0}
        onRotationChange={() => {}}
        onDeleteSelectedLine={() => {}}
        planNotes=""
      />
    </View>
  );
}
