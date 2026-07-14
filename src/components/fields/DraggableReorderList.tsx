import React from "react";
import { Pressable, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { GripVertical } from "lucide-react-native";

import type { PlanLine } from "../../types/plan";
import { FIELDS_COLORS } from "./fieldsTheme";

type DraggableReorderListProps = {
  data: PlanLine[];
  onDragEnd: (next: PlanLine[]) => void;
  /** Optional render function for extra content on the right side of each item */
  renderExtraRight?: (item: PlanLine) => React.ReactNode;
};

export function DraggableReorderList({ data, onDragEnd, renderExtraRight }: DraggableReorderListProps) {
  return (
    <DraggableFlatList
      data={data}
      keyExtractor={(item) => item.id}
      onDragEnd={({ data: next }) => onDragEnd(next)}
      containerStyle={{ flex: 1 }}
      // Keep clipped subviews mounted: removeClippedSubviews=true is known to
      // break scroll/layout behavior on Reanimated-driven draggable lists.
      removeClippedSubviews={false}
      windowSize={5}
      maxToRenderPerBatch={10}
      initialNumToRender={8}
      renderItem={({ item, drag, isActive }: RenderItemParams<PlanLine>) => (
        <ScaleDecorator>
          <Pressable
            onLongPress={drag}
            disabled={isActive}
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: 10,
              gap: 8,
              backgroundColor: isActive ? FIELDS_COLORS.accentMuted : FIELDS_COLORS.cardSolid,
              borderBottomWidth: 1,
              borderBottomColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <GripVertical size={16} color={FIELDS_COLORS.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                {item.label}
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                {item.entity?.entity_type ?? item.layer}
              </Text>
            </View>
            {renderExtraRight?.(item)}
          </Pressable>
        </ScaleDecorator>
      )}
    />
  );
}