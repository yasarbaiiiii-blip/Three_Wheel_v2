import React, { useState, useEffect } from "react";
import { Alert, Platform, Pressable, TouchableOpacity, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Upload, X } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan } from "../../../types/plan";
import { FIELDS_COLORS } from "../fieldsTheme";

type UploadAndPreviewStepProps = {
  apiBaseUrl: string;
  importedPlan: ImportedPlan | null;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  onRefreshPaths: () => void;
  onSelectPath: (name: string, skipAdvance?: boolean) => void;
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

export function UploadAndPreviewStep({
  apiBaseUrl,
  importedPlan,
  setImportedPlan,
  onRefreshPaths,
  onSelectPath,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  protectedResident,
  onGpsPointMissionParsed,
}: UploadAndPreviewStepProps) {
  const [pickedFile, setPickedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [previewData, setPreviewData] = useState<pathApi.PathPreviewResponse | null>(null);

  // Extension state (inline, no modal)
  const [extEnabled, setExtEnabled] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");
  const [extPerLine, setExtPerLine] = useState(false);
  const [isExtSetting, setIsExtSetting] = useState(false);

  const targetPathName = importedPlan?.fileName ?? null;
  const isDxfPath = targetPathName?.toLowerCase().endsWith(".dxf");

  useEffect(() => {
    if (isDxfPath && targetPathName && apiBaseUrl) {
      pathApi.getExtensions(apiBaseUrl, targetPathName)
        .then(cfg => {
          setExtEnabled(cfg.enabled);
          setExtPre(String(cfg.pre_extension_m ?? 0.5));
          setExtAft(String(cfg.aft_extension_m ?? 0.5));
          setExtPerLine(!!cfg.per_line);
        })
        .catch(() => {
          // keep defaults if it fails
        });
    }
  }, [targetPathName, isDxfPath, apiBaseUrl]);

  // Auto-fetch preview whenever a path is already loaded (e.g. navigating from Click-to-Mark).
  // This covers the case where the file was uploaded externally before the user opened this step.
  useEffect(() => {
    if (!targetPathName || !apiBaseUrl) return;
    // Reset stale preview when the path changes
    setPreviewData(null);
    pathApi.getPathPreview(apiBaseUrl, targetPathName)
      .then(res => {
        if (res.ok) {
          return res.json().then((data: pathApi.PathPreviewResponse) => setPreviewData(data));
        }
      })
      .catch(() => {
        // Preview is optional — swallow errors silently
      });
  }, [targetPathName, apiBaseUrl]);

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
        const webFile = (pickedFile as any).file ?? (await (await fetch(pickedFile.uri)).blob());
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

          // In React Native, sending strings directly in FormData can be tricky.
          // Since we are fixing the BOM and sending it to the backend, let's create a new FormData.
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
        if (ext === "dxf") {
          setImportedPlan({ fileName: pickedFile.name, uri: pickedFile.uri, fileType: "dxf", source: "builtin" });
        } else {
          setImportedPlan({
            fileName: pickedFile.name,
            uri: pickedFile.uri,
            fileType: ext as "csv" | "waypoints",
            source: "imported",
          });
        }
        setPickedFile(null);
        onRefreshPaths();

        // Auto-select the just-parsed path
        onSelectPath(pickedFile.name);

        // Auto-fetch preview
        try {
          const previewRes = await pathApi.getPathPreview(apiBaseUrl, pickedFile.name);
          if (previewRes.ok) {
            const data = await previewRes.json();
            setPreviewData(data);
          }
        } catch {
          // Preview is optional, plan still loads
        }

        // Auto-fetch extension config if DXF
        if (ext === "dxf") {
          try {
            const cfg = await pathApi.getExtensions(apiBaseUrl, pickedFile.name);
            setExtEnabled(cfg.enabled);
            setExtPre(String(cfg.pre_extension_m ?? 0.5));
            setExtAft(String(cfg.aft_extension_m ?? 0.5));
            setExtPerLine(!!cfg.per_line);
          } catch {
            // keep defaults
          }
        }
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

  const handleToggleExtension = async (enabled: boolean) => {
    if (!targetPathName || !apiBaseUrl) return;
    setIsExtSetting(true);
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathName, {
        enabled,
        pre_extension_m: parseFloat(extPre) || 0.5,
        aft_extension_m: parseFloat(extAft) || 0.5,
        per_line: extPerLine,
      });
      if (res.ok) {
        setExtEnabled(enabled);
        onInvalidateWorkflow("spray");
        onSelectPath(targetPathName, true); // refresh lines
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to update extensions");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsExtSetting(false);
    }
  };

  // Once extension is applied (enabled), this same button flips into a "Disable
  // Extension" action so the operator doesn't have to scroll back up to the
  // switch — pressing it again sends enabled:false instead of re-applying.
  const handleToggleApplyExtension = async () => {
    if (!targetPathName || !apiBaseUrl) return;
    const nextEnabled = !extEnabled;
    setIsExtSetting(true);
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathName, {
        enabled: nextEnabled,
        pre_extension_m: parseFloat(extPre) || 0,
        aft_extension_m: parseFloat(extAft) || 0,
        per_line: extPerLine,
      });
      if (res.ok) {
        setExtEnabled(nextEnabled);
        onInvalidateWorkflow("spray");
        onSelectPath(targetPathName, true);
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to ${nextEnabled ? "save" : "disable"} extensions`);
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsExtSetting(false);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      {/* File Upload Section */}
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Import a .dxf, .csv, or .waypoints file. Preview appears automatically after parsing.
      </Text>

      {!pickedFile && !targetPathName ? (
        <TouchableOpacity
          onPress={handlePickFile}
          disabled={protectedResident}
          activeOpacity={0.8}
          style={{
            height: 52,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: 8,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderWidth: 1.5,
            borderColor: FIELDS_COLORS.stepActive,
            borderStyle: "dashed",
          }}
        >
          <Upload size={18} color={FIELDS_COLORS.stepActive} />
          <Text style={{ color: FIELDS_COLORS.stepActive, fontSize: 14, fontWeight: "700" }}>
            Select File
          </Text>
        </TouchableOpacity>
      ) : pickedFile ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
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
          <TouchableOpacity
            onPress={handleParseFile}
            disabled={isUploading || protectedResident}
            activeOpacity={0.85}
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
          </TouchableOpacity>
          <Pressable onPress={() => setPickedFile(null)} style={{ padding: 4 }}>
            <X size={20} color={FIELDS_COLORS.textMuted} />
          </Pressable>
        </View>
      ) : targetPathName ? (
        <View style={{ gap: 8 }}>
          {/* Current file indicator */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              padding: 10,
              borderRadius: 10,
              backgroundColor: FIELDS_COLORS.surfaceSolid,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.successBorder,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>
                LOADED
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700", marginTop: 2 }} numberOfLines={1}>
                {targetPathName}
              </Text>
              {previewData && (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {previewData.num_points ?? "?"} points · {previewData.frame ?? "DXF"}
                </Text>
              )}
            </View>
            <Pressable
              onPress={() => {
                setImportedPlan(null);
                setPreviewData(null);
                setExtEnabled(false);
              }}
              style={{ padding: 6 }}
            >
              <X size={18} color={FIELDS_COLORS.textDim} />
            </Pressable>
          </View>

          {/* Upload another */}
          <Pressable
            onPress={handlePickFile}
            disabled={protectedResident}
            style={{
              height: 36,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "transparent",
              borderWidth: 1,
              borderColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "600" }}>
              Upload Different File
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Extension Config (inline, no modal) — only for DXF */}
      {targetPathName && isDxfPath ? (
        <View
          style={{
            borderRadius: 10,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderWidth: 1,
            borderColor: extEnabled ? "#8b5cf6" : FIELDS_COLORS.panelBorder,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              padding: 12,
            }}
          >
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
                Enable Extension
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                Add run-up / run-out segments
              </Text>
            </View>
            <Switch
              value={extEnabled}
              onValueChange={handleToggleExtension}
              disabled={isExtSetting}
              trackColor={{ false: FIELDS_COLORS.panelBorder, true: "#8b5cf6" }}
              thumbColor={extEnabled ? "#ffffff" : "#94a3b8"}
            />
          </View>

          <View style={{ padding: 12, paddingTop: 0, gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>PRE (m)</Text>
                <TextInput
                  style={{
                    height: 36,
                    backgroundColor: FIELDS_COLORS.cardSolid,
                    borderWidth: 1,
                    borderColor: FIELDS_COLORS.panelBorder,
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    fontSize: 13,
                    color: FIELDS_COLORS.textMain,
                  }}
                  value={extPre}
                  onChangeText={(v) => {
                    onInvalidateWorkflow("spray");
                    setExtPre(v);
                  }}
                  keyboardType="numeric"
                />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>AFT (m)</Text>
                <TextInput
                  style={{
                    height: 36,
                    backgroundColor: FIELDS_COLORS.cardSolid,
                    borderWidth: 1,
                    borderColor: FIELDS_COLORS.panelBorder,
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    fontSize: 13,
                    color: FIELDS_COLORS.textMain,
                  }}
                  value={extAft}
                  onChangeText={(v) => {
                    onInvalidateWorkflow("spray");
                    setExtAft(v);
                  }}
                  keyboardType="numeric"
                />
              </View>
            </View>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "600" }}>Per-line</Text>
              <Switch
                value={extPerLine}
                onValueChange={(v) => {
                  onInvalidateWorkflow("spray");
                  setExtPerLine(v);
                }}
                trackColor={{ false: FIELDS_COLORS.panelBorder, true: "#8b5cf6" }}
              />
            </View>

            <Pressable
              onPress={handleToggleApplyExtension}
              disabled={isExtSetting}
              style={{
                height: 36,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: isExtSetting ? FIELDS_COLORS.textDim : extEnabled ? "#ef4444" : "#8b5cf6",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>
                {isExtSetting ? "Saving..." : extEnabled ? "Disable Extension" : "Apply Extension"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {protectedResident && (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11 }}>
          A protected mission is currently resident. Upload is blocked.
        </Text>
      )}
    </View>
  );
}
