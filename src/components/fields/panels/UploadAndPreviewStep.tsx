import React, { useState, useEffect } from "react";
import { Alert, Platform, Pressable, TouchableOpacity, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Upload, X } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan } from "../../../types/plan";
import { parseLocalPointCsv, type LocalPointCsvResult } from "../../../utils/localPointCsv";
import { FIELDS_COLORS } from "../fieldsTheme";

type UploadAndPreviewStepProps = {
  apiBaseUrl: string;
  importedPlan: ImportedPlan | null;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  onRefreshPaths: () => void;
  /**
   * `refreshOnly=true` tells the parent this call is just re-fetching `lines` for the
   * already-loaded path (e.g. after saving extension config) — it must not advance the
   * step or toggle plan-editing/map-interaction on, unlike a genuine new path selection.
   */
  onSelectPath: (name: string, refreshOnly?: boolean) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  protectedResident: boolean;
  /**
   * Local-only CSV parse result (no backend). Parent draws map points from this.
   * Mission Select File .csv never calls parse-point-* / upload / preview.
   */
  onLocalCsvParsed?: (data: LocalPointCsvResult) => void;
  /** Clears parent local-CSV preview state when the operator dismisses LOADED. */
  onClearLocalCsv?: () => void;
  /**
   * Lets the operator import a guide-points CSV once the plan preview is up
   * (same parser as Align step).
   */
  onImportRefPointsCsv?: () => void;
  isImportingRefPointsCsv?: boolean;
  /** When set, the guide-CSV button shows this file name instead of a generic label. */
  guideCsvFileName?: string | null;
  /**
   * Pre-line marking mode. When true, a `.csv` is a SURVEY LINE file: upload it
   * to the backend and preview the planner's real waypoints (WYSIWYG), exactly
   * like a DXF — instead of the on-device point-mission parse. Default false
   * preserves the local point-CSV flow.
   */
  preLineCsvMode?: boolean;
  /**
   * Lifts the pre-line toggle to the page. FieldsPage has to know whether a .csv
   * is a pre-line SURVEY line (uploaded, staged, driven) or a LOCAL point CSV
   * (parsed on-device, never staged) — they take different steps. Without this
   * it can only see `fileType === "csv"` and cannot tell them apart.
   */
  onChangePreLineCsvMode?: (next: boolean) => void;
};

const MAX_IMPORT_ATTEMPTS = 3;
const IMPORT_RETRY_BASE_MS = 450;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Transient network / gateway failures are common on first upload over Wi‑Fi. */
function isRetryableHttpStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function mimeForUpload(fileName: string, mimeType?: string | null): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  if (ext === "csv") return "text/csv";
  if (ext === "dxf") return "application/dxf";
  if (ext === "waypoints") return "text/plain";
  return "application/octet-stream";
}

/**
 * DocumentPicker URIs (esp. content:// right after pick) can flake on the first
 * FormData upload. Copy into app cache so every attempt uses a stable file:// URI.
 */
async function resolveStableUploadAsset(
  file: DocumentPicker.DocumentPickerAsset
): Promise<{ uri: string; name: string; mimeType: string }> {
  const name = file.name || "upload.bin";
  const mimeType = mimeForUpload(name, file.mimeType);
  if (Platform.OS === "web") {
    return { uri: file.uri, name, mimeType };
  }

  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = `${FileSystem.cacheDirectory ?? ""}import_${Date.now()}_${safeName}`;
  if (!dest || !FileSystem.cacheDirectory) {
    return { uri: file.uri, name, mimeType };
  }

  try {
    const info = await FileSystem.getInfoAsync(file.uri);
    if (info.exists) {
      await FileSystem.copyAsync({ from: file.uri, to: dest });
      return { uri: dest, name, mimeType };
    }
  } catch (e) {
    console.warn("[import] stable cache copy failed; using picker uri", e);
  }
  return { uri: file.uri, name, mimeType };
}

function appendNativeFile(
  formData: FormData,
  asset: { uri: string; name: string; mimeType: string }
) {
  formData.append("file", {
    uri: asset.uri,
    name: asset.name,
    type: asset.mimeType,
  } as any);
}

/**
 * Rebuilds the request body each attempt (FormData is single-use after fetch).
 * Retries network throws and 5xx/408/429 so the operator rarely needs manual Retry.
 */
async function fetchWithImportRetry(
  label: string,
  build: () => Promise<Response>,
  maxAttempts = MAX_IMPORT_ATTEMPTS
): Promise<Response> {
  let lastRes: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await build();
      if (res.ok) return res;
      lastRes = res;
      if (!isRetryableHttpStatus(res.status) || attempt === maxAttempts) {
        return res;
      }
      console.warn(
        `[import] ${label} attempt ${attempt}/${maxAttempts} status=${res.status} — retrying`
      );
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) throw e;
      console.warn(
        `[import] ${label} attempt ${attempt}/${maxAttempts} network error — retrying`,
        e
      );
    }
    await sleep(IMPORT_RETRY_BASE_MS * attempt);
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error(`${label} failed`);
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
  onLocalCsvParsed,
  onClearLocalCsv,
  onImportRefPointsCsv,
  isImportingRefPointsCsv = false,
  guideCsvFileName = null,
  preLineCsvMode: preLineCsvModeDefault = false,
  onChangePreLineCsvMode,
}: UploadAndPreviewStepProps) {
  // Pre-line marking: treat a .csv as a survey LINE (upload → backend /preview),
  // not an on-device point mission. Operator-toggled; seeded from the prop.
  const [preLineCsvModeLocal, setPreLineCsvModeLocal] = useState<boolean>(preLineCsvModeDefault);
  // Controlled when the page supplies a value + handler, uncontrolled otherwise
  // (keeps every existing call site working unchanged).
  const isControlled = onChangePreLineCsvMode != null;
  const preLineCsvMode = isControlled ? preLineCsvModeDefault : preLineCsvModeLocal;
  const setPreLineCsvMode = (next: boolean) => {
    if (isControlled) onChangePreLineCsvMode!(next);
    else setPreLineCsvModeLocal(next);
  };
  const [pickedFile, setPickedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<pathApi.PathPreviewResponse | null>(null);
  /** Local CSV summary for LOADED chip (never from /preview). */
  const [localCsvSummary, setLocalCsvSummary] = useState<{
    num_points: number;
    kind: string;
    frame: string;
  } | null>(null);

  // Extension state (inline, no modal)
  const [extEnabled, setExtEnabled] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");
  const [extPerLine, setExtPerLine] = useState(false);
  const [isExtSetting, setIsExtSetting] = useState(false);

  const targetPathName = importedPlan?.fileName ?? null;
  const isDxfPath = targetPathName?.toLowerCase().endsWith(".dxf");
  // A pre-line CSV is a backend path (previewed via /preview), so it must NOT be
  // treated as a local-only CSV that suppresses the backend preview.
  const isLocalCsvPath =
    !preLineCsvMode &&
    (importedPlan?.fileType === "csv" || !!targetPathName?.toLowerCase().endsWith(".csv"));

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

  // Backend path preview for DXF / waypoints only — never for local CSV.
  useEffect(() => {
    if (!targetPathName || !apiBaseUrl || isLocalCsvPath) return;
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
  }, [targetPathName, apiBaseUrl, isLocalCsvPath]);

  /**
   * CSV: parse entirely on-device — no parse-point-*, upload, or /preview.
   * DXF / waypoints: upload + backend map preview (unchanged).
   */
  const importAndPreviewFile = async (file: DocumentPicker.DocumentPickerAsset) => {
    if (blockProtectedWorkflowMutation("Parsing a new path")) return;

    const ext = file.name.split(".").pop()?.toLowerCase();

    // CSV is local-only and does not require a rover connection — UNLESS pre-line
    // mode is on, where a .csv is a survey LINE file that goes to the backend
    // (falls through to the upload + /preview branch below, like a DXF).
    if (ext === "csv" && !preLineCsvMode) {
      setPickedFile(file);
      setImportError(null);
      setIsUploading(true);
      try {
        const stable = await resolveStableUploadAsset(file);
        let text = "";
        if (Platform.OS === "web") {
          const webFile = (file as any).file ?? (await (await fetch(file.uri)).blob());
          text = await webFile.text();
        } else {
          text = await FileSystem.readAsStringAsync(stable.uri, {
            encoding: FileSystem.EncodingType.UTF8,
          });
        }

        const parsed = parseLocalPointCsv(text, file.name);
        onInvalidateWorkflow("alignment");
        onLocalCsvParsed?.(parsed);
        setImportedPlan({
          fileName: file.name,
          uri: stable.uri,
          fileType: "csv",
          source: "imported",
        });
        setLocalCsvSummary({
          num_points: parsed.num_points,
          kind: parsed.kind,
          frame: parsed.point_source_frame,
        });
        setPreviewData(null);
        setPickedFile(null);
        setImportError(null);

        if (parsed.warnings.length > 0) {
          console.warn("[import][csv] row warnings:", parsed.warnings);
        }
      } catch (err) {
        console.log("Error importing CSV locally:", err);
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Could not parse the CSV file.";
        setImportError(msg);
        Alert.alert("Import Failed", msg);
      } finally {
        setIsUploading(false);
      }
      return;
    }

    if (!apiBaseUrl) {
      Alert.alert("Not connected", "Connect to the rover before importing a file.");
      return;
    }

    setPickedFile(file);
    setImportError(null);
    setIsUploading(true);
    try {
      const stable = await resolveStableUploadAsset(file);

      const buildNativeFormData = () => {
        const formData = new FormData();
        appendNativeFile(formData, stable);
        return formData;
      };

      const buildWebFormData = async () => {
        const formData = new FormData();
        const webFile = (file as any).file ?? (await (await fetch(file.uri)).blob());
        formData.append("file", webFile, file.name);
        return formData;
      };

      let res: Response;
      if (ext === "dxf") {
        res = await fetchWithImportRetry("parse-dxf", async () => {
          const formData =
            Platform.OS === "web" ? await buildWebFormData() : buildNativeFormData();
          return pathApi.parseDxf(apiBaseUrl, formData);
        });
      } else {
        res = await fetchWithImportRetry("upload-path", async () => {
          const formData =
            Platform.OS === "web" ? await buildWebFormData() : buildNativeFormData();
          return pathApi.uploadPath(apiBaseUrl, formData);
        });
      }

      if (res.ok) {
        onInvalidateWorkflow("alignment");
        onClearLocalCsv?.();
        setLocalCsvSummary(null);
        if (ext === "dxf") {
          setImportedPlan({
            fileName: file.name,
            uri: stable.uri,
            fileType: "dxf",
            source: "builtin",
          });
        } else {
          setImportedPlan({
            fileName: file.name,
            uri: stable.uri,
            fileType: (ext as "csv" | "waypoints") || "csv",
            source: "imported",
          });
        }
        setPickedFile(null);
        setImportError(null);
        onRefreshPaths();

        // Map geometry preview (entities + /plan overlay) — backend paths only.
        onSelectPath(file.name);

        try {
          const previewRes = await pathApi.getPathPreview(apiBaseUrl, file.name);
          if (previewRes.ok) {
            const data = await previewRes.json();
            setPreviewData(data);
          }
        } catch {
          // Preview summary is optional; map lines still load via onSelectPath.
        }

        if (ext === "dxf") {
          try {
            const cfg = await pathApi.getExtensions(apiBaseUrl, file.name);
            setExtEnabled(cfg.enabled);
            setExtPre(String(cfg.pre_extension_m ?? 0.5));
            setExtAft(String(cfg.aft_extension_m ?? 0.5));
            setExtPerLine(!!cfg.per_line);
          } catch {
            // keep defaults
          }
        }
      } else {
        const errorText = (await res.text()) || `Import failed (${res.status})`;
        setImportError(errorText);
        Alert.alert("Import Failed", errorText);
      }
    } catch (err) {
      console.log("Error importing file:", err);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not connect to the rover to import the file.";
      setImportError(msg);
      Alert.alert("Error", msg);
    } finally {
      setIsUploading(false);
    }
  };

  const handlePickFile = async () => {
    if (blockProtectedWorkflowMutation("Uploading a new path")) return;
    if (isUploading) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["*/*"],
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const ext = asset.name.split(".").pop()?.toLowerCase();
        if (ext === "dxf" || ext === "csv" || ext === "waypoints") {
          // Parse + map preview immediately — no separate Parse step.
          await importAndPreviewFile(asset);
        } else {
          Alert.alert("Invalid File", "Please select a .dxf, .csv, or .waypoints file.");
        }
      }
    } catch (err) {
      console.log("Error picking file:", err);
    }
  };

  const handleRetryImport = async () => {
    if (!pickedFile || isUploading) return;
    await importAndPreviewFile(pickedFile);
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
        onSelectPath(targetPathName, true); // refreshOnly — re-fetch lines, stay out of edit mode
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
        onSelectPath(targetPathName, true); // refreshOnly — re-fetch lines, stay out of edit mode
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
        Import a .dxf, .csv, or .waypoints file. DXF/waypoints use the rover.
        {preLineCsvMode
          ? " Pre-line: a CSV is a survey line — uploaded and previewed on the rover."
          : " CSV is parsed on-device and drawn locally (not uploaded)."}
      </Text>

      {/* Pre-line CSV mode: route a survey-line CSV through the backend planner
          (WYSIWYG /preview) instead of the on-device point-mission parse. */}
      {!targetPathName ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            padding: 12,
          }}
        >
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
              Pre-line CSV (survey line)
            </Text>
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
              Upload a lat/lon survey CSV and preview the marking line on the rover
            </Text>
          </View>
          <Switch
            value={preLineCsvMode}
            onValueChange={setPreLineCsvMode}
            disabled={protectedResident || isUploading}
            trackColor={{ false: FIELDS_COLORS.panelBorder, true: "#8b5cf6" }}
            thumbColor={preLineCsvMode ? "#ffffff" : "#94a3b8"}
          />
        </View>
      ) : null}

      {!pickedFile && !targetPathName ? (
        <TouchableOpacity
          onPress={handlePickFile}
          disabled={protectedResident || isUploading}
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
            opacity: protectedResident || isUploading ? 0.6 : 1,
          }}
        >
          <Upload size={18} color={FIELDS_COLORS.stepActive} />
          <Text style={{ color: FIELDS_COLORS.stepActive, fontSize: 14, fontWeight: "700" }}>
            {isUploading ? "Loading preview…" : "Select File"}
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
            {isUploading ? (
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                Uploading and loading map preview…
              </Text>
            ) : (
              <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11, marginTop: 2 }} numberOfLines={2}>
                {importError
                  ? `Import failed — ${importError}`
                  : "Import failed — retry or clear"}
              </Text>
            )}
          </View>
          {!isUploading ? (
            <TouchableOpacity
              onPress={handleRetryImport}
              disabled={protectedResident}
              activeOpacity={0.85}
              style={{
                height: 40,
                paddingHorizontal: 14,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: protectedResident ? FIELDS_COLORS.textDim : FIELDS_COLORS.teal,
              }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>Retry</Text>
            </TouchableOpacity>
          ) : null}
          <Pressable
            onPress={() => {
              if (isUploading) return;
              setPickedFile(null);
              setImportError(null);
            }}
            disabled={isUploading}
            style={{ padding: 4, opacity: isUploading ? 0.4 : 1 }}
          >
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
              {localCsvSummary ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {localCsvSummary.num_points} points · local {localCsvSummary.kind.toUpperCase()} ·{" "}
                  {localCsvSummary.frame}
                </Text>
              ) : previewData ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {previewData.num_points ?? "?"} points · {previewData.frame ?? "DXF"}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={() => {
                setImportedPlan(null);
                setPreviewData(null);
                setLocalCsvSummary(null);
                setExtEnabled(false);
                onClearLocalCsv?.();
              }}
              style={{ padding: 6 }}
            >
              <X size={18} color={FIELDS_COLORS.textDim} />
            </Pressable>
          </View>

          {/* Upload another — also auto-parses on pick */}
          <Pressable
            onPress={handlePickFile}
            disabled={protectedResident || isUploading}
            style={{
              height: 36,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "transparent",
              borderWidth: 1,
              borderColor: FIELDS_COLORS.panelBorder,
              opacity: protectedResident || isUploading ? 0.5 : 1,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "600" }}>
              {isUploading ? "Loading preview…" : "Upload Different File"}
            </Text>
          </Pressable>

          {/* Guide-points CSV — label becomes the uploaded file name after import */}
          {onImportRefPointsCsv ? (
            <Pressable
              onPress={onImportRefPointsCsv}
              disabled={protectedResident || isImportingRefPointsCsv}
              style={{
                height: 36,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 12,
                backgroundColor: guideCsvFileName ? FIELDS_COLORS.surfaceSolid : FIELDS_COLORS.teal,
                borderWidth: guideCsvFileName ? 1 : 0,
                borderColor: FIELDS_COLORS.teal,
                opacity: protectedResident || isImportingRefPointsCsv ? 0.5 : 1,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: guideCsvFileName ? FIELDS_COLORS.teal : "#fff",
                  fontSize: 12,
                  fontWeight: "800",
                }}
              >
                {isImportingRefPointsCsv
                  ? "Importing…"
                  : guideCsvFileName
                    ? guideCsvFileName
                    : "Import guide CSV"}
              </Text>
            </Pressable>
          ) : null}
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
