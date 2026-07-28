import React from "react";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { Check as CheckIcon, ChevronDown, ChevronRight, GripVertical } from "lucide-react-native";

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
  onToggleTransitDropdown: () => void;
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
  if (row.kind === "extension") {
    return isExtensionGroupSelected(row.group, selectedLineId, highlightLineIds);
  }
  return false;
}

function TypeBadge({ label }: { label: string }) {
  return (
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
        {label}
      </Text>
    </View>
  );
}

export function PathOrderUnifiedList({
  rows,
  onReorderPrimaries,
  onPressPrimary,
  onPressTransit,
  onPressExtension,
  onToggleTransitDropdown,
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
        const nextPrimaries = data
          .filter((r): r is Extract<PathOrderRow, { kind: "primary" }> => r.kind === "primary")
          .map((r) => r.line);
        onReorderPrimaries(nextPrimaries);
      }}
      style={{ flex: 1 }}
      containerStyle={{ flex: 1 }}
      scrollEnabled
      nestedScrollEnabled
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
      activationDistance={8}
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
                delayLongPress={180}
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
                  <TypeBadge label={entityType || item.line.layer} />
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

        if (item.kind === "extension") {
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
                <Pressable onPress={() => onPressExtension(item.group.lineIds)} style={{ flex: 1 }}>
                  <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                    Pre {formatFinite(item.group.preM, 2)} m · Aft {formatFinite(item.group.aftM, 2)} m
                  </Text>
                </Pressable>
                <TypeBadge label="extension" />
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
        }

        if (item.kind === "transitDropdown") {
          return (
            <ScaleDecorator>
              <Pressable
                onPress={onToggleTransitDropdown}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 10,
                  gap: 8,
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderBottomWidth: 1,
                  borderBottomColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <View style={{ width: 16, alignItems: "center" }}>
                  {item.expanded ? (
                    <ChevronDown size={14} color={FIELDS_COLORS.textMuted} />
                  ) : (
                    <ChevronRight size={14} color={FIELDS_COLORS.textMuted} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                    Transit
                  </Text>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                    {item.count} inter-shape leg{item.count === 1 ? "" : "s"}
                    {item.expanded ? " · tap to collapse" : " · tap to expand"}
                  </Text>
                </View>
                <TypeBadge label="transit" />
              </Pressable>
            </ScaleDecorator>
          );
        }

        // Expanded transit child row (indent to show hierarchy under dropdown)
        const lengthM = getLineLengthM(item.line);
        return (
          <ScaleDecorator>
            <Pressable
              onPress={() => onPressTransit(item.line)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 10,
                paddingRight: 10,
                paddingLeft: 28,
                gap: 8,
                backgroundColor: bg,
                borderBottomWidth: 1,
                borderBottomColor: FIELDS_COLORS.panelBorder,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "600" }}>
                  Transit {item.index + 1}
                </Text>
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, marginTop: 1 }}>
                  inter-shape
                </Text>
              </View>
              <Text
                style={{
                  color: FIELDS_COLORS.textMuted,
                  fontSize: 11,
                  minWidth: 52,
                  textAlign: "right",
                }}
              >
                {lengthM != null ? `${formatFinite(lengthM, 2)} m` : "n/a"}
              </Text>
            </Pressable>
          </ScaleDecorator>
        );
      }}
    />
  );
}
