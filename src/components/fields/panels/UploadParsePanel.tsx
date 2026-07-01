import React, { useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { X } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan } from "../../../types/plan";
import { FIELDS_COLORS } from "../fieldsTheme";

type UploadParsePanelProps = {
  apiBaseUrl: string;
  importedPlan: ImportedPlan | null;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  onRefreshPaths: () => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  protectedResident: boolean;
};

export function UploadParsePanel({
  apiBaseUrl,
  setImportedPlan,
  onRefreshPaths,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  protectedResident,
}: UploadParsePanelProps) {
  const [pickedFile, setPickedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handlePickFile = async () => {
    if (blockProtectedWorkflowMutation("Uploading a new path")) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["*/*"],
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const ext = asset.name.split(".").pop()?.toLowerCase();
        if (ext === "dxf" || ext === "csv" || ext === "waypoints") {
          setPickedFile(asset);
        } else {
          Alert.alert("Invalid File", "Please select a .dxf, .csv, or .waypoints file.");
        }
      }
    } catch (err) {
      console.log("Error picking file:", err);
    }
  };

  const handleParseFile = async () => {
    if (blockProtectedWorkflowMutation("Parsing a new path")) return;
    if (!pickedFile || !apiBaseUrl) return;
    setIsUploading(true);
    try {
      const ext = pickedFile.name.split(".").pop()?.toLowerCase();
      const formData = new FormData();
      if (Platform.OS === "web") {
        const webFile = (pickedFile as any).file ?? await (await fetch(pickedFile.uri)).blob();
        formData.append("file", webFile, pickedFile.name);
      } else {
        formData.append("file", {
          uri: pickedFile.uri,
          name: pickedFile.name,
          type: pickedFile.mimeType || "application/octet-stream",
        } as any);
      }

      const res = ext === "dxf"
        ? await pathApi.parseDxf(apiBaseUrl, formData)
        : await pathApi.uploadPath(apiBaseUrl, formData);

      if (res.ok) {
        onInvalidateWorkflow("alignment");
        Alert.alert("Success", `${pickedFile.name} imported successfully.`);
        if (ext === "dxf") {
          setImportedPlan({ fileName: pickedFile.name, uri: pickedFile.uri, fileType: "dxf", source: "builtin" });
        }
        setPickedFile(null);
        onRefreshPaths();
      } else {
        const errorText = await res.text();
        Alert.alert("Import Failed", errorText || "Unknown error occurred");
      }
    } catch (err) {
      console.log("Error importing file:", err);
      Alert.alert("Error", "Could not connect to the rover to import the file.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Import a .dxf, .csv, or .waypoints file from device storage.
      </Text>
      {!pickedFile ? (
        <Pressable
          onPress={handlePickFile}
          disabled={protectedResident}
          style={{
            height: 44,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: protectedResident ? FIELDS_COLORS.surfaceSolid : FIELDS_COLORS.panelBorder,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 14, fontWeight: "700" }}>
            Select .dxf, .csv, .waypoints
          </Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              flex: 1,
              backgroundColor: FIELDS_COLORS.surfaceSolid,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
              {pickedFile.name}
            </Text>
          </View>
          <Pressable
            onPress={handleParseFile}
            disabled={isUploading || protectedResident}
            style={{
              height: 40,
              paddingHorizontal: 16,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: isUploading || protectedResident ? FIELDS_COLORS.textDim : FIELDS_COLORS.teal,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>
              {isUploading ? "..." : "Parse"}
            </Text>
          </Pressable>
          <Pressable onPress={() => setPickedFile(null)} style={{ padding: 4 }}>
            <X size={20} color={FIELDS_COLORS.textMuted} />
          </Pressable>
        </View>
      )}
    </View>
  );
}