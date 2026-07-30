import React, { useState, useEffect } from "react";
import { Alert, Platform, Pressable, TouchableOpacity, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Upload, X } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import { DXF_PLANNER } from "../../../config/featureFlags";
import type { ImportedPlan } from "../../../types/plan";
import {
  CSV_EXT_AFT_FLOOR_M,
  CSV_EXT_MAX_M,
  CSV_EXT_WARN_M,
  DXF_EXTENSION_CONFIG,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "../../../utils/missionExtensions";
import { parseLocalDxf, type LocalDxfResult } from "../../../utils/dxfLocalImport";
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
  /**
   * Local-only DXF parse when DXF_PLANNER === "app". Parent sets lines + alignment.
   * No parse-dxf / entities / upload.
   */
  onLocalDxfParsed?: (data: LocalDxfResult) => void;
  /**
   * How many PRE/AFT runs the current config actually builds, and why it built none.
   * Computed by the parent (it owns `lines`) so the card can say what happened instead of
   * silently rendering nothing on geometry that has no free ends.
   */
  extensionStatus?: { count: number; hint: string | null } | null;
  /** Clears parent local-CSV preview state when the operator dismisses LOADED. */
  onClearLocalCsv?: () => void;
  /** Local CSV extension config (app state — no network). */
  csvExtensionConfig?: CsvExtensionConfig;
  onCsvExtensionConfigChange?: (next: CsvExtensionConfig) => void;
  /**
   * Parent-owned parse result. Required after CSV import because FieldsPage flips
   * isLocalCsvFlow and remounts this step — localCsvSummary state is lost on remount.
   */
  localCsvPreview?: LocalPointCsvResult | null;
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
  onLocalDxfParsed,
  onClearLocalCsv,
  csvExtensionConfig,
  onCsvExtensionConfigChange,
  localCsvPreview = null,
  extensionStatus = null,
}: UploadAndPreviewStepProps) {
  const [pickedFile, setPickedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<pathApi.PathPreviewResponse | null>(null);
  /** Local CSV summary for LOADED chip (never from /preview). */
  const [localCsvSummary, setLocalCsvSummary] = useState<{
    num_points: number;
    kind: string;
    frame: string;
    warnings: string[];
  } | null>(() =>
    localCsvPreview
      ? {
          num_points: localCsvPreview.num_points,
          kind: localCsvPreview.kind,
          frame: localCsvPreview.point_source_frame,
          warnings: localCsvPreview.warnings.slice(0, 12),
        }
      : null
  );

  // Extension state (inline, no modal) — DXF remote; CSV drafts below.
  // DXF always uses chain-ends freeness (per_line=false) — same as rover default.
  const [extEnabled, setExtEnabled] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");
  const [isExtSetting, setIsExtSetting] = useState(false);
  /** Draft strings for CSV extension inputs (commit normalized values on blur). */
  const [csvExtPreDraft, setCsvExtPreDraft] = useState(
    () => String(csvExtensionConfig?.preM ?? 0.5)
  );
  const [csvExtAftDraft, setCsvExtAftDraft] = useState(
    () => String(csvExtensionConfig?.aftM ?? 0.5)
  );

  useEffect(() => {
    if (!csvExtensionConfig) return;
    setCsvExtPreDraft(String(csvExtensionConfig.preM));
    setCsvExtAftDraft(String(csvExtensionConfig.aftM));
  }, [csvExtensionConfig?.preM, csvExtensionConfig?.aftM, csvExtensionConfig?.enabled]);

  // Re-hydrate summary when parent already holds the parse (layout remount on CSV flow).
  useEffect(() => {
    if (!localCsvPreview) return;
    setLocalCsvSummary({
      num_points: localCsvPreview.num_points,
      kind: localCsvPreview.kind,
      frame: localCsvPreview.point_source_frame,
      warnings: localCsvPreview.warnings.slice(0, 12),
    });
  }, [
    localCsvPreview?.num_points,
    localCsvPreview?.kind,
    localCsvPreview?.point_source_frame,
    localCsvPreview?.fileName,
  ]);

  // Prefer plan name; fall back to parent parse so remount after CSV flow still shows LOADED.
  const targetPathName =
    importedPlan?.fileName ?? localCsvPreview?.fileName ?? null;
  const isDxfPath =
    importedPlan?.fileType === "dxf" || !!targetPathName?.toLowerCase().endsWith(".dxf");
  const isCsvPath =
    importedPlan?.fileType === "csv" ||
    !!targetPathName?.toLowerCase().endsWith(".csv") ||
    localCsvPreview != null ||
    localCsvSummary != null;
  /** DXF parsed on device — never hit /parse-dxf, /entities, or /extensions. */
  const isLocalDxfPlanner = DXF_PLANNER === "app" && isDxfPath;
  /** Extension UI must not depend on local-only summary — that state dies on remount. */
  const showCsvExtension =
    isCsvPath &&
    !isDxfPath &&
    onCsvExtensionConfigChange != null &&
    csvExtensionConfig != null;
  /** Local DXF uses the same purple PRE/AFT card as CSV (app state only). */
  const showLocalDxfExtension =
    isLocalDxfPlanner &&
    onCsvExtensionConfigChange != null &&
    csvExtensionConfig != null &&
    !!importedPlan;

  // Rover-side extension config only when DXF still lives on the rover.
  useEffect(() => {
    if (isLocalDxfPlanner) return;
    if (isDxfPath && targetPathName && apiBaseUrl) {
      pathApi.getExtensions(apiBaseUrl, targetPathName)
        .then(cfg => {
          setExtEnabled(cfg.enabled);
          setExtPre(String(cfg.pre_extension_m ?? 0.5));
          setExtAft(String(cfg.aft_extension_m ?? 0.5));
        })
        .catch(() => {
          // keep defaults if it fails
        });
    }
  }, [targetPathName, isDxfPath, apiBaseUrl, isLocalDxfPlanner]);

  // Backend path preview for rover DXF / waypoints only — never local CSV or local DXF.
  useEffect(() => {
    if (isLocalDxfPlanner) return;
    if (!targetPathName || !apiBaseUrl || isCsvPath) return;
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
  }, [targetPathName, apiBaseUrl, isCsvPath, isLocalDxfPlanner]);

  /**
   * CSV + app-planned DXF: parse on-device (no upload).
   * Waypoints / rover DXF (DXF_PLANNER=rover): upload + backend preview.
   */
  const importAndPreviewFile = async (file: DocumentPicker.DocumentPickerAsset) => {
    if (blockProtectedWorkflowMutation("Parsing a new path")) return;

    const ext = file.name.split(".").pop()?.toLowerCase();

    // CSV is local-only and does not require a rover connection.
    if (ext === "csv") {
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
          warnings: parsed.warnings.slice(0, 12),
        });
        setPreviewData(null);
        setPickedFile(null);
        setImportError(null);

        if (parsed.warnings.length > 0) {
          // Keep for logs only — do not surface import warnings in the Upload UI.
          console.warn("[import][csv] warnings:", parsed.warnings);
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

    // DXF app-planned path: parse entirely on-device (mirrors CSV) — no rover round-trip.
    if (ext === "dxf" && DXF_PLANNER === "app") {
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
        const parsed = parseLocalDxf(text, file.name);
        onInvalidateWorkflow("alignment");
        onClearLocalCsv?.();
        onLocalDxfParsed?.(parsed);
        setImportedPlan({
          fileName: file.name,
          uri: stable.uri,
          fileType: "dxf",
          source: "imported",
        });
        setLocalCsvSummary(null);
        setPreviewData(null);
        setPickedFile(null);
        setImportError(null);
        // Seed local extension defaults (same as CSV card).
        if (onCsvExtensionConfigChange && csvExtensionConfig) {
          // per-line: CAD edges are independent PRE→MARK→AFT passes, and it is the only
          // mode under which a closed shape (a square drawn as one polyline) gets run-ups.
          onCsvExtensionConfigChange(normalizeCsvExtensionConfig(DXF_EXTENSION_CONFIG));
        }
        if (parsed.warnings.length > 0) {
          console.warn("[import][dxf-local] warnings:", parsed.warnings);
        }
      } catch (err) {
        console.log("Error importing DXF locally:", err);
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Could not parse the DXF file.";
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

  /** Persist DXF extension sidecar (always per_line=false — chain free ends only). */
  const saveDxfExtensions = async (opts: {
    enabled: boolean;
    preM: number;
    aftM: number;
  }) => {
    if (!targetPathName || !apiBaseUrl) return false;
    setIsExtSetting(true);
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathName, {
        enabled: opts.enabled,
        pre_extension_m: opts.preM,
        aft_extension_m: opts.aftM,
        // Always false: matches rover chain-ends freeness (no per-side split UI).
        per_line: false,
      });
      if (res.ok) {
        setExtEnabled(opts.enabled);
        onInvalidateWorkflow("spray");
        onSelectPath(targetPathName, true); // refreshOnly — rebuild purple PRE/AFT on device
        return true;
      }
      const errText = await res.text();
      Alert.alert("Error", errText || "Failed to update extensions");
      return false;
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
      return false;
    } finally {
      setIsExtSetting(false);
    }
  };

  const handleToggleExtension = async (enabled: boolean) => {
    await saveDxfExtensions({
      enabled,
      preM: parseFloat(extPre) || 0.5,
      aftM: parseFloat(extAft) || 0.5,
    });
  };

  /** Commit PRE/AFT when operator finishes editing (same as CSV blur). */
  const commitDxfExtensionLengths = async () => {
    if (!extEnabled || !targetPathName || !apiBaseUrl) return;
    await saveDxfExtensions({
      enabled: true,
      preM: parseFloat(extPre) || 0.5,
      aftM: parseFloat(extAft) || 0.5,
    });
  };

  return (
    <View style={{ gap: 14 }}>
      {/* File Upload Section */}
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        {DXF_PLANNER === "app"
          ? "Import a .dxf, .csv, or .waypoints file. CSV: the app generates the path from survey points. DXF / geo-DXF: the file’s real path is used unchanged (no path generation). Send uses plan-trajectory. Waypoints still use the rover."
          : "Import a .dxf, .csv, or .waypoints file. DXF/waypoints use the rover; CSV is parsed on-device and drawn locally (not uploaded)."}
      </Text>

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

          {/* Guide-points CSV lives in Align DXF, next to the control-point list it feeds —
              importing it from Upload put an alignment control two steps early. */}
        </View>
      ) : null}

      {/* Rover DXF extension (legacy) — only when file is on the rover. */}
      {targetPathName && isDxfPath && !isLocalDxfPlanner ? (
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
                Purple PRE/AFT run-ups at free chain ends only (same as rover). PRE lands on the path start.
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

          {extEnabled ? (
            <View style={{ padding: 12, paddingTop: 0, gap: 8 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>
                    PRE (m)
                  </Text>
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
                    onBlur={() => {
                      void commitDxfExtensionLengths();
                    }}
                    keyboardType="numeric"
                    editable={!isExtSetting}
                  />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>
                    AFT (m)
                  </Text>
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
                    onBlur={() => {
                      void commitDxfExtensionLengths();
                    }}
                    keyboardType="numeric"
                    editable={!isExtSetting}
                  />
                </View>
              </View>
              {isExtSetting ? (
                <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10 }}>Saving…</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {(showCsvExtension || showLocalDxfExtension) &&
      csvExtensionConfig &&
      onCsvExtensionConfigChange ? (
        <View
          style={{
            borderRadius: 10,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderWidth: 1,
            borderColor: csvExtensionConfig.enabled ? "#8b5cf6" : FIELDS_COLORS.panelBorder,
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
                {showLocalDxfExtension
                  ? "Purple PRE/AFT at free chain ends. Built on device — not saved to the rover."
                  : "Run-up / run-out (travel, no spray). Local only — not saved to the rover."}
              </Text>
            </View>
            <Switch
              value={csvExtensionConfig.enabled}
              onValueChange={(enabled) => {
                onInvalidateWorkflow("spray");
                // Preserve perLine — it is an independent geometry policy, and resetting it
                // here silently undid the operator's choice every time they re-enabled.
                onCsvExtensionConfigChange(
                  normalizeCsvExtensionConfig({
                    ...csvExtensionConfig,
                    enabled,
                    aftM: enabled
                      ? Math.max(CSV_EXT_AFT_FLOOR_M, csvExtensionConfig.aftM)
                      : csvExtensionConfig.aftM,
                  })
                );
              }}
              trackColor={{ false: FIELDS_COLORS.panelBorder, true: "#8b5cf6" }}
              thumbColor={csvExtensionConfig.enabled ? "#ffffff" : "#94a3b8"}
            />
          </View>

          {csvExtensionConfig.enabled ? (
            <View style={{ padding: 12, paddingTop: 0, gap: 8 }}>
              {extensionStatus ? (
                <Text
                  style={{
                    color: extensionStatus.count > 0 ? FIELDS_COLORS.textMuted : FIELDS_COLORS.warning,
                    fontSize: 10,
                    lineHeight: 14,
                  }}
                >
                  {extensionStatus.count > 0
                    ? `${extensionStatus.count} extension run(s) on the plan.`
                    : extensionStatus.hint}
                </Text>
              ) : null}

              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>
                    PRE (m)
                  </Text>
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
                    value={csvExtPreDraft}
                    onChangeText={(v) => {
                      onInvalidateWorkflow("spray");
                      setCsvExtPreDraft(v);
                      const n = parseFloat(v);
                      if (!Number.isFinite(n)) return;
                      onCsvExtensionConfigChange(
                        normalizeCsvExtensionConfig({
                          ...csvExtensionConfig,
                          preM: n,
                        })
                      );
                    }}
                    onBlur={() => {
                      const next = normalizeCsvExtensionConfig({
                        ...csvExtensionConfig,
                        preM: parseFloat(csvExtPreDraft),
                      });
                      onCsvExtensionConfigChange(next);
                      setCsvExtPreDraft(String(next.preM));
                    }}
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>
                    AFT (m) · min {CSV_EXT_AFT_FLOOR_M.toFixed(2)}
                  </Text>
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
                    value={csvExtAftDraft}
                    onChangeText={(v) => {
                      onInvalidateWorkflow("spray");
                      setCsvExtAftDraft(v);
                      const n = parseFloat(v);
                      if (!Number.isFinite(n)) return;
                      onCsvExtensionConfigChange(
                        normalizeCsvExtensionConfig({
                          ...csvExtensionConfig,
                          enabled: true,
                          aftM: n,
                        })
                      );
                    }}
                    onBlur={() => {
                      const next = normalizeCsvExtensionConfig({
                        ...csvExtensionConfig,
                        enabled: true,
                        aftM: parseFloat(csvExtAftDraft),
                      });
                      onCsvExtensionConfigChange(next);
                      setCsvExtAftDraft(String(next.aftM));
                    }}
                    keyboardType="numeric"
                  />
                </View>
              </View>
              {(csvExtensionConfig.preM > CSV_EXT_WARN_M ||
                csvExtensionConfig.aftM > CSV_EXT_WARN_M) && (
                <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10 }}>
                  Large extension (&gt;{CSV_EXT_WARN_M} m). Cap is {CSV_EXT_MAX_M} m.
                </Text>
              )}
            </View>
          ) : null}
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
