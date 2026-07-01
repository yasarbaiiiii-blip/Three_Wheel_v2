import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan, PlanLine } from "../../../types/plan";
import { isPrimaryEditableLine } from "../../../utils/pathWorkflow";
import { DraggableReorderList } from "../DraggableReorderList";
import { FIELDS_COLORS } from "../fieldsTheme";

type PathOrderPanelProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  onRefreshPaths: () => void;
  onSelectPath: (name: string) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  protectedResident: boolean;
};

export function PathOrderPanel({
  apiBaseUrl,
  selectedPathName,
  importedPlan,
  lines,
  onRefreshPaths,
  onSelectPath,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  protectedResident,
}: PathOrderPanelProps) {
  const [isReordering, setIsReordering] = useState(false);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [reorderedLines, setReorderedLines] = useState<PlanLine[]>([]);

  const primaryReorderableLines = useMemo(
    () => lines.filter(isPrimaryEditableLine),
    [lines]
  );

  useEffect(() => {
    if (!isReordering) {
      setReorderedLines(primaryReorderableLines);
    }
  }, [primaryReorderableLines, isReordering]);

  const handleSetOrder = async () => {
    if (blockProtectedWorkflowMutation("Reordering the path")) return;
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to reorder.");
      return;
    }
    setIsSavingOrder(true);
    try {
      const entity_order = reorderedLines
        .filter((line) => line.entity && line.entity.entity_id)
        .map((line) => line.entity!.entity_id);

      const res = await pathApi.saveEntityOrder(apiBaseUrl, targetPath, entity_order);
      if (res.ok) {
        onInvalidateWorkflow("spray");
        setIsReordering(false);
        onRefreshPaths();
        onSelectPath(targetPath);
      } else {
        const errJson = await res.json().catch(() => null);
        Alert.alert("Validation Error", errJson?.detail || "Failed to save the new order. The plan might be stale.");
        onRefreshPaths();
        onSelectPath(targetPath);
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsSavingOrder(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Drag to reorder primary entities. Transit and extension legs are excluded.
      </Text>

      <Pressable
        onPress={() => {
          if (blockProtectedWorkflowMutation("Reordering the path")) return;
          if (isReordering) {
            void handleSetOrder();
          } else {
            setReorderedLines(primaryReorderableLines);
            setIsReordering(true);
          }
        }}
        disabled={protectedResident || isSavingOrder}
        style={{
          height: 44,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: protectedResident
            ? FIELDS_COLORS.textDim
            : isReordering
              ? FIELDS_COLORS.success
              : "#8b5cf6",
        }}
      >
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
          {isReordering ? (isSavingOrder ? "Saving..." : "Save Order") : "Start Reorder"}
        </Text>
      </Pressable>

      {isReordering ? (
        <View style={{ height: 280, borderRadius: 10, borderWidth: 1, borderColor: FIELDS_COLORS.panelBorder, overflow: "hidden" }}>
          <DraggableReorderList
            data={reorderedLines}
            onDragEnd={(next) => {
              onInvalidateWorkflow("spray");
              setReorderedLines(next);
            }}
          />
        </View>
      ) : (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 12, fontStyle: "italic" }}>
          {primaryReorderableLines.length} primary entities available for reorder.
        </Text>
      )}
    </View>
  );
}