import React, { useState } from "react";
import { Alert, Modal, Pressable, Switch, Text, TextInput, View } from "react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan } from "../../../types/plan";
import type { PlacedItem } from "../../BoundaryEditor";
import { FIELDS_COLORS } from "../fieldsTheme";

type PlanEditingPanelProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  importedPlan: ImportedPlan | null;
  lines: { layer: string }[];
  onSelectPath: (name: string) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  visualAlignmentItem?: PlacedItem | null;
};

export function PlanEditingPanel({
  apiBaseUrl,
  selectedPathName,
  importedPlan,
  lines,
  onSelectPath,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  visualAlignmentItem,
}: PlanEditingPanelProps) {
  const [extModalOpen, setExtModalOpen] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");
  const [extPerLine, setExtPerLine] = useState(false);
  const [isExtSetting, setIsExtSetting] = useState(false);

  const targetPathForExtensions = selectedPathName || importedPlan?.fileName;
  const isDxfPath =
    selectedPathName?.toLowerCase().endsWith(".dxf") || importedPlan?.fileName?.toLowerCase().endsWith(".dxf");
  const hasExtensions = lines.some((line) => line.layer === "extension");

  const handleSetExtension = async () => {
    if (blockProtectedWorkflowMutation("Changing extensions")) return;
    if (!targetPathForExtensions || !apiBaseUrl) {
      Alert.alert("Error", "No path selected to save extensions to.");
      return;
    }
    setIsExtSetting(true);
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathForExtensions, {
        enabled: true,
        pre_extension_m: parseFloat(extPre) || 0,
        aft_extension_m: parseFloat(extAft) || 0,
        per_line: extPerLine,
      });
      if (res.ok) {
        onInvalidateWorkflow("spray");
        Alert.alert("Success", "Extensions saved successfully.");
        setExtModalOpen(false);
        onSelectPath(targetPathForExtensions);
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to set extensions");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsExtSetting(false);
    }
  };

  const handleDisableExtension = async () => {
    if (blockProtectedWorkflowMutation("Changing extensions")) return;
    if (!targetPathForExtensions || !apiBaseUrl) {
      Alert.alert("Error", "No path selected to disable extensions.");
      return;
    }
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathForExtensions, {
        enabled: false,
        pre_extension_m: 0.5,
        aft_extension_m: 0.5,
      });
      if (res.ok) {
        onInvalidateWorkflow("spray");
        Alert.alert("Success", "Extensions disabled.");
        onSelectPath(targetPathForExtensions);
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to disable extensions");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    }
  };

  const openExtensionModal = async () => {
    if (apiBaseUrl && targetPathForExtensions) {
      try {
        const cfg = await pathApi.getExtensions(apiBaseUrl, targetPathForExtensions);
        setExtPre(String(cfg.pre_extension_m ?? 0.5));
        setExtAft(String(cfg.aft_extension_m ?? 0.5));
        setExtPerLine(!!cfg.per_line);
      } catch {
        // keep current modal values
      }
    }
    setExtModalOpen(true);
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Configure path extensions for DXF plans. Rotation angle is shown during visual alignment.
      </Text>

      {visualAlignmentItem ? (
        <View
          style={{
            padding: 12,
            borderRadius: 10,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            gap: 6,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>Visual Alignment</Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontFamily: "monospace" }}>
            Offset: {visualAlignmentItem.x?.toFixed(2) ?? "0.00"}m E, {visualAlignmentItem.y?.toFixed(2) ?? "0.00"}m N
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontFamily: "monospace" }}>
            Rotation: {(visualAlignmentItem.rotation ?? 0).toFixed(1)}°
          </Text>
        </View>
      ) : null}

      {isDxfPath ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={openExtensionModal}
            style={{
              flex: 1,
              height: 40,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#8b5cf6",
            }}
          >
            <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Enable Extension</Text>
          </Pressable>
          {hasExtensions ? (
            <Pressable
              onPress={handleDisableExtension}
              style={{
                flex: 1,
                height: 40,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: FIELDS_COLORS.danger,
              }}
            >
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Disable Extension</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 12, fontStyle: "italic" }}>
          Extensions are available for DXF paths only.
        </Text>
      )}

      <Modal visible={extModalOpen} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: "rgba(9,9,11,0.75)", justifyContent: "center", alignItems: "center" }}>
          <View
            style={{
              width: 340,
              backgroundColor: FIELDS_COLORS.cardSolid,
              borderRadius: 16,
              padding: 20,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 18, fontWeight: "900", marginBottom: 12 }}>
              Path Extensions
            </Text>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 4 }}>File Name</Text>
              <TextInput
                style={{
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  borderRadius: 8,
                  padding: 10,
                  color: FIELDS_COLORS.textMuted,
                  fontWeight: "600",
                }}
                value={targetPathForExtensions || ""}
                editable={false}
              />
            </View>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 4 }}>Pre Extension (m)</Text>
              <TextInput
                style={{
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  borderRadius: 8,
                  padding: 10,
                  color: FIELDS_COLORS.textMain,
                }}
                value={extPre}
                onChangeText={(value) => {
                  onInvalidateWorkflow("spray");
                  setExtPre(value);
                }}
                keyboardType="numeric"
              />
            </View>
            <View style={{ marginBottom: 20 }}>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 4 }}>Aft Extension (m)</Text>
              <TextInput
                style={{
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  borderRadius: 8,
                  padding: 10,
                  color: FIELDS_COLORS.textMain,
                }}
                value={extAft}
                onChangeText={(value) => {
                  onInvalidateWorkflow("spray");
                  setExtAft(value);
                }}
                keyboardType="numeric"
              />
            </View>
            <View style={{ marginBottom: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>Per-line extensions</Text>
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  Each line gets its own run-up/run-out
                </Text>
              </View>
              <Switch
                value={extPerLine}
                onValueChange={(value) => {
                  onInvalidateWorkflow("spray");
                  setExtPerLine(value);
                }}
                trackColor={{ false: FIELDS_COLORS.panelBorder, true: "#8b5cf6" }}
              />
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={() => setExtModalOpen(false)}
                style={{
                  flex: 1,
                  height: 44,
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 14, fontWeight: "700" }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleSetExtension}
                disabled={isExtSetting}
                style={{
                  flex: 1,
                  height: 44,
                  backgroundColor: "#8b5cf6",
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: isExtSetting ? 0.7 : 1,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
                  {isExtSetting ? "Setting..." : "Set Extension"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}