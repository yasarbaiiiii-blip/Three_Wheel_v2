import React, { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Check as CheckIcon } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan, PlanLine } from "../../../types/plan";
import { isPrimaryEditableLine, normalizeEntityType } from "../../../utils/pathWorkflow";
import { FIELDS_COLORS } from "../fieldsTheme";

type SprayVerificationPanelProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
};

export function SprayVerificationPanel({
  apiBaseUrl,
  selectedPathName,
  importedPlan,
  lines,
  setLines,
  selectedLineId,
  onSelectLine,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
}: SprayVerificationPanelProps) {
  const [isSprayingSet, setIsSprayingSet] = useState(false);

  const sprayableLines = lines.filter((line) => {
    const entityType = normalizeEntityType(line.entity?.entity_type);
    return isPrimaryEditableLine(line) && (entityType === "line" || entityType === "arc" || entityType === "circle");
  });

  const handleSetSpray = async () => {
    if (blockProtectedWorkflowMutation("Changing spray overrides")) return;
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to save overrides to.");
      return;
    }
    setIsSprayingSet(true);
    try {
      const overridesMap = new Map<string, boolean>();
      lines
        .filter((line) => line.entity && line.entity.entity_id && line.layer !== "extension" && line.layer !== "transit")
        .forEach((line) => {
          overridesMap.set(line.entity!.entity_id, !!line.entity!.is_mark);
        });

      const overrides = Array.from(overridesMap.entries()).map(([entity_id, is_mark]) => ({
        entity_id,
        is_mark,
      }));

      const res = await pathApi.saveEntityOverrides(apiBaseUrl, targetPath, overrides);
      if (res.ok) {
        onInvalidateWorkflow("spray");
        Alert.alert("Success", "Spray settings saved successfully.");
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to save spray settings");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsSprayingSet(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Toggle spray for primary entities. Transit and extension legs are excluded.
      </Text>

      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
        {sprayableLines.map((line) => {
          const isSelected = selectedLineId === line.id;
          return (
            <Pressable
              key={line.id}
              onPress={() => onSelectLine(isSelected ? null : line.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                padding: 12,
                backgroundColor: isSelected ? FIELDS_COLORS.accentMuted : FIELDS_COLORS.surfaceSolid,
                borderBottomWidth: 1,
                borderBottomColor: FIELDS_COLORS.panelBorder,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 14, fontWeight: "700" }}>
                  {line.label}{" "}
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontWeight: "500", fontSize: 12 }}>
                    ({line.entity?.entity_type})
                  </Text>
                </Text>
              </View>
              {line.entity ? (
                <Pressable
                  onPress={() => {
                    onInvalidateWorkflow("spray");
                    const next = [...lines];
                    const idx = next.findIndex((entry) => entry.id === line.id);
                    if (idx !== -1 && next[idx].entity) {
                      next[idx].entity!.is_mark = !next[idx].entity!.is_mark;
                      setLines(next);
                    }
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: line.entity.is_mark ? FIELDS_COLORS.teal : FIELDS_COLORS.textDim,
                    backgroundColor: line.entity.is_mark ? FIELDS_COLORS.teal : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {line.entity.is_mark ? <CheckIcon size={14} color="#fff" /> : null}
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <Pressable
        onPress={handleSetSpray}
        disabled={isSprayingSet}
        style={{
          height: 48,
          backgroundColor: isSprayingSet ? FIELDS_COLORS.textDim : "#0ea5e9",
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
          {isSprayingSet ? "Saving..." : "Save Spray Settings"}
        </Text>
      </Pressable>
    </View>
  );
}