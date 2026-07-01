import React from "react";
import { Pressable, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { GripVertical } from "lucide-react-native";

import type { PlanLine } from "../../types/plan";
import { FIELDS_COLORS } from "./fieldsTheme";

type DraggableReorderListProps = {
  data: PlanLine[];
  onDragEnd: (next: PlanLine[]) => void;
};

export function DraggableReorderList({ data, onDragEnd }: DraggableReorderListProps) {
  return (
    <DraggableFlatList
      data={data}
      keyExtractor={(item) => item.id}
      onDragEnd={({ data: next }) => onDragEnd(next)}
      containerStyle={{ flex: 1 }}
      renderItem={({ item, drag, isActive }: RenderItemParams<PlanLine>) => (
        <ScaleDecorator>
          <Pressable
            onLongPress={drag}
            disabled={isActive}
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: 12,
              gap: 10,
              backgroundColor: isActive ? FIELDS_COLORS.accentMuted : FIELDS_COLORS.cardSolid,
              borderBottomWidth: 1,
              borderBottomColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <GripVertical size={18} color={FIELDS_COLORS.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>
                {item.label}
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                {item.entity?.entity_type ?? item.layer}
              </Text>
            </View>
          </Pressable>
        </ScaleDecorator>
      )}
    />
  );
}