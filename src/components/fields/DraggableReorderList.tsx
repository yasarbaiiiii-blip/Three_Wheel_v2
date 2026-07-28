import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { GripVertical } from "lucide-react-native";

import type { PlanLine } from "../../types/plan";
import { FIELDS_COLORS } from "./fieldsTheme";

type DraggableReorderListProps = {
  data: PlanLine[];
  onDragEnd: (next: PlanLine[]) => void;
  /** Optional render function for extra content on the right side of each item */
  renderExtraRight?: (item: PlanLine) => React.ReactNode;
  /** Tap (not long-press) a row — separate gesture from `onLongPress={drag}`, so tap-to-select
   * and hold-to-reorder coexist without conflict. */
  onPressItem?: (item: PlanLine) => void;
  /** Highlights the currently tap-selected row's background. */
  selectedRowId?: string | null;
  /**
   * Extra rows appended below the draggable ones, in the SAME scroll region (single
   * scrollbar) but NOT reorderable — used for Extension/Transit rows, which the backend
   * places automatically rather than the user reordering.
   */
  footer?: React.ReactNode;
};

export function DraggableReorderList({
  data,
  onDragEnd,
  renderExtraRight,
  onPressItem,
  selectedRowId = null,
  footer,
}: DraggableReorderListProps) {
  return (
    <DraggableFlatList
      data={data}
      keyExtractor={(item) => item.id}
      onDragEnd={({ data: next }) => onDragEnd(next)}
      containerStyle={{ flex: 1 }}
      // Keep clipped subviews mounted: removeClippedSubviews=true is known to
      // break scroll/layout behavior on Reanimated-driven draggable lists.
      removeClippedSubviews={false}
      activationDistance={8}
      windowSize={5}
      maxToRenderPerBatch={10}
      initialNumToRender={8}
      ListFooterComponent={footer ? () => <>{footer}</> : undefined}
      renderItem={({ item, drag, isActive }: RenderItemParams<PlanLine>) => (
        <ScaleDecorator>
          <Pressable
            onLongPress={drag}
            delayLongPress={180}
            onPress={() => onPressItem?.(item)}
            disabled={isActive}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 12,
              paddingVertical: 11,
              gap: 10,
              minHeight: 48,
              backgroundColor: isActive
                ? FIELDS_COLORS.accentMuted
                : item.id === selectedRowId
                ? FIELDS_COLORS.accentMuted
                : FIELDS_COLORS.surfaceSolid,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <GripVertical size={15} color={FIELDS_COLORS.textDim} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}
                numberOfLines={1}
              >
                {item.label}
              </Text>
              <Text
                style={{ color: FIELDS_COLORS.textDim, fontSize: 11, marginTop: 2 }}
                numberOfLines={1}
              >
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