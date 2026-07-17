import React from "react";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { Check as CheckIcon, GripVertical } from "lucide-react-native";

import type { PlanLine } from "../../types/plan";
import {
  formatFinite,
  getLineLengthM,
  isExtensionGroupSelected,
  normalizeEntityType,
  type PathOrderRow,
} from "../../utils/pathWorkflow";
import { FIELDS_COLORS } from "./fieldsTheme";

type PathOrderUnifiedListProps = {
  rows: PathOrderRow[];
  /** New primary-only order after a drag (transit/extension positions discarded). */
  onReorderPrimaries: (next: PlanLine[]) => void;
  onPressPrimary: (line: PlanLine) => void;
  onPressTransit: (line: PlanLine) => void;
  onPressExtension: (lineIds: string[]) => void;
  selectedLineId: string | null;
  highlightLineIds?: string[] | null;
  extensionVisible: boolean;
  onToggleExtensionVisible: () => void;
  /** Spray checkbox for primary sprayable entities. */
  onToggleSpray: (lineId: string) => void;
};

function rowSelected(
  row: PathOrderRow,
  selectedLineId: string | null,
  highlightLineIds: string[] | null | undefined
): boolean {
  if (row.kind === "primary") {
    return row.line.id === selectedLineId && !(highlightLineIds && highlightLineIds.length > 0);
  }
  if (row.kind === "transit") {
    return row.line.id === selectedLineId && !(highlightLineIds && highlightLineIds.length > 0);
  }
  return isExtensionGroupSelected(row.group, selectedLineId, highlightLineIds);
}

export function PathOrderUnifiedList({
  rows,
  onReorderPrimaries,
  onPressPrimary,
  onPressTransit,
  onPressExtension,
  selectedLineId,
  highlightLineIds = null,
  extensionVisible,
  onToggleExtensionVisible,
  onToggleSpray,
}: PathOrderUnifiedListProps) {
  return (
    <DraggableFlatList
      data={rows}
      keyExtractor={(item) => item.id}
      onDragEnd={({ data }) => {
        // Only primary order is meaningful — rebuild always puts transit/extension after.
        const nextPrimaries = data
          .filter((r): r is Extract<PathOrderRow, { kind: "primary" }> => r.kind === "primary")
          .map((r) => r.line);
        onReorderPrimaries(nextPrimaries);
      }}
      // Both style + containerStyle need flex so the list fills the fixed-height shell
      // and scrolls when rows exceed the viewport (common DraggableFlatList pitfall).
      style={{ flex: 1 }}
      containerStyle={{ flex: 1 }}
      scrollEnabled
      nestedScrollEnabled
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
      // Prefer vertical pan to scroll; long-press still starts reorder on primaries.
      activationDistance={12}
      removeClippedSubviews={false}
      windowSize={8}
      maxToRenderPerBatch={14}
      initialNumToRender={14}
      renderItem={({ item, drag, isActive }: RenderItemParams<PathOrderRow>) => {
        const selected = rowSelected(item, selectedLineId, highlightLineIds);
        const bg = isActive
          ? FIELDS_COLORS.accentMuted
          : selected
          ? FIELDS_COLORS.accentMuted
          : FIELDS_COLORS.cardSolid;

        if (item.kind === "primary") {
          const entityType = normalizeEntityType(item.line.entity?.entity_type);
          const isSprayable =
            entityType === "line" || entityType === "arc" || entityType === "circle";
          return (
            <ScaleDecorator>
              <Pressable
                onLongPress={drag}
                onPress={() => onPressPrimary(item.line)}
                disabled={isActive}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 10,
                  gap: 8,
                  backgroundColor: bg,
                  borderBottomWidth: 1,
                  borderBottomColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <GripVertical size={16} color={FIELDS_COLORS.textDim} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                    {item.line.label}
                  </Text>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                    {entityType || item.line.layer}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View
                    style={{
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      backgroundColor: FIELDS_COLORS.surfaceSolid,
                      borderWidth: 1,
                      borderColor: FIELDS_COLORS.panelBorder,
                    }}
                  >
                    <Text
                      style={{
                        color: FIELDS_COLORS.textDim,
                        fontSize: 9,
                        fontWeight: "700",
                        textTransform: "uppercase",
                      }}
                    >
                      {entityType || item.line.layer}
                    </Text>
                  </View>
                  {item.line.entity && isSprayable ? (
                    <TouchableOpacity
                      onPress={() => onToggleSpray(item.line.id)}
                      activeOpacity={0.7}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        borderWidth: 1.5,
                        borderColor: item.line.entity.is_mark
                          ? FIELDS_COLORS.teal
                          : FIELDS_COLORS.textDim,
                        backgroundColor: item.line.entity.is_mark
                          ? FIELDS_COLORS.teal
                          : "transparent",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {item.line.entity.is_mark ? <CheckIcon size={14} color="#fff" /> : null}
                    </TouchableOpacity>
                  ) : null}
                </View>
              </Pressable>
            </ScaleDecorator>
          );
        }

        if (item.kind === "transit") {
          const lengthM = getLineLengthM(item.line);
          return (
            <ScaleDecorator>
              <Pressable
                // Transit is not reorderable — long-press does nothing (no drag).
                onPress={() => onPressTransit(item.line)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 10,
                  gap: 8,
                  backgroundColor: bg,
                  borderBottomWidth: 1,
                  borderBottomColor: FIELDS_COLORS.panelBorder,
                }}
              >
                {/* Spacer matches grip width so text lines up with primary labels */}
                <View style={{ width: 16 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                    Transit {item.index + 1}
                  </Text>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                    transit
                  </Text>
                </View>
                <View
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: FIELDS_COLORS.surfaceSolid,
                    borderWidth: 1,
                    borderColor: FIELDS_COLORS.panelBorder,
                  }}
                >
                  <Text
                    style={{
                      color: FIELDS_COLORS.textDim,
                      fontSize: 9,
                      fontWeight: "700",
                      textTransform: "uppercase",
                    }}
                  >
                    transit
                  </Text>
                </View>
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, minWidth: 52, textAlign: "right" }}>
                  {lengthM != null ? `${formatFinite(lengthM, 2)} m` : "n/a"}
                </Text>
              </Pressable>
            </ScaleDecorator>
          );
        }

        // extension group
        return (
          <ScaleDecorator>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                padding: 10,
                gap: 8,
                backgroundColor: bg,
                borderBottomWidth: 1,
                borderBottomColor: FIELDS_COLORS.panelBorder,
              }}
            >
              <View style={{ width: 16 }} />
              <Pressable
                onPress={() => onPressExtension(item.group.lineIds)}
                style={{ flex: 1 }}
              >
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                  {item.title}
                </Text>
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                  Pre {formatFinite(item.group.preM, 2)} m · Aft {formatFinite(item.group.aftM, 2)} m
                </Text>
              </Pressable>
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <Text
                  style={{
                    color: FIELDS_COLORS.textDim,
                    fontSize: 9,
                    fontWeight: "700",
                    textTransform: "uppercase",
                  }}
                >
                  extension
                </Text>
              </View>
              <TouchableOpacity
                onPress={onToggleExtensionVisible}
                activeOpacity={0.7}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  borderWidth: 1.5,
                  borderColor: extensionVisible ? FIELDS_COLORS.teal : FIELDS_COLORS.textDim,
                  backgroundColor: extensionVisible ? FIELDS_COLORS.teal : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {extensionVisible ? <CheckIcon size={14} color="#fff" /> : null}
              </TouchableOpacity>
            </View>
          </ScaleDecorator>
        );
      }}
    />
  );
}
