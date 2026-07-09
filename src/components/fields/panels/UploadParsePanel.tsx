import React, { useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
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
  /** Called when a GPS lat/lon point CSV is successfully parsed */
  onGpsPointMissionParsed?: (data: pathApi.ParsePointGpsCsvResponse) => void;
};

/** Peek at CSV header to decide GPS vs NED parse route */
function detectPointCsvKind(text: string): "gps" | "ned" | "unknown" {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = trimmed.split(",").map((c) => c.trim().toLowerCase());
    if (header[0] === "lat" && header[1] === "lon") return "gps";
    if (header[0] === "north" && header[1] === "east") return "ned";
    return "unknown";
  }
  return "unknown";
}

export function UploadParsePanel({
  apiBaseUrl,
  setImportedPlan,
  onRefreshPaths,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  protectedResident,
  onGpsPointMissionParsed,
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

      let res;
      if (ext === "dxf") {
        res = await pathApi.parseDxf(apiBaseUrl, formData);
      } else if (ext === "csv") {
        try {
          // Read the file and strip BOM if present
          let text = "";
          if (Platform.OS === "web") {
            const webFile = (pickedFile as any).file ?? (await (await fetch(pickedFile.uri)).blob());
            text = await webFile.text();
          } else {
            text = await (await fetch(pickedFile.uri)).text();
          }
          
          if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
          }

          const cleanFormData = new FormData();
          if (Platform.OS === "web") {
            const cleanBlob = new Blob([text], { type: "text/csv" });
            cleanFormData.append("file", cleanBlob as any, pickedFile.name);
          } else {
            const tempUri = FileSystem.cacheDirectory + "clean_" + pickedFile.name;
            await FileSystem.writeAsStringAsync(tempUri, text, { encoding: FileSystem.EncodingType.UTF8 });
            cleanFormData.append("file", {
              uri: tempUri,
              name: pickedFile.name,
              type: "text/csv",
            } as any);
          }

          // Detect GPS vs NED CSV and branch parse call
          const kind = detectPointCsvKind(text);
          const parseRes =
            kind === "gps"
              ? await pathApi.parsePointGpsCsv(apiBaseUrl, cleanFormData)
              : await pathApi.parsePointCsv(apiBaseUrl, cleanFormData);
          if (!parseRes.ok) {
            res = parseRes;
          } else {
            if (kind === "gps") {
              const parsed = (await parseRes.clone().json()) as pathApi.ParsePointGpsCsvResponse;
              onGpsPointMissionParsed?.(parsed);
            }
            // If validation succeeded, call uploadPath to actually save the file on the backend
            res = await pathApi.uploadPath(apiBaseUrl, cleanFormData);
          }
        } catch (e) {
          console.error("Error preprocessing CSV:", e);
          res = await pathApi.uploadPath(apiBaseUrl, formData);
        }
      } else {
        res = await pathApi.uploadPath(apiBaseUrl, formData);
      }

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