import React, { useState, useEffect, useRef, useCallback } from "react";
import { Alert, Platform, Pressable, TouchableOpacity, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Plus, Upload, X } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import { DXF_PLANNER } from "../../../config/featureFlags";
import type { MissionLayer } from "../../../types/missionLayers";
import type { ImportedPlan } from "../../../types/plan";
import { layerForFile, nonEmptyMissionLayers, sortedMissionLayers } from "../../../utils/missionLayerAssignment";
import {
  CSV_EXT_AFT_FLOOR_M,
  CSV_EXT_MAX_M,
  CSV_EXT_WARN_M,
  DXF_EXTENSION_CONFIG,
  isCompleteExtensionDraft,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "../../../utils/missionExtensions";
import {
  parseLocalDxf,
  type LocalDxfResult,
} from "../../../utils/dxfLocalImport";
import {
  parseLocalPointCsv,
  type LocalPointCsvResult,
} from "../../../utils/localPointCsv";
import { yieldToUi } from "../../../utils/runtimeGuards";
import type { UploadedFileEntry } from "../../../types/uploadedFiles";
import { FIELDS_COLORS } from "../fieldsTheme";
import { PlanOffsetCard } from "./PlanOffsetCard";

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
  /**
   * Parent snapshot of the current local DXF plan (mark lines only). Used so
   * "Add more files" still works after a remount loses in-component `lastLocalDxf`.
   */
  localDxfSnapshot?: LocalDxfResult | null;
  /** Multi-type local batch — per-file status list (App-owned). */
  uploadedFiles?: UploadedFileEntry[];
  /** Tap a file row → parent opens that file's section (Align when needed). */
  onSelectUploadedFile?: (fileId: string) => void;
  /** Currently selected file in the upload list. */
  selectedUploadedFileId?: string | null;
  /**
   * Reset multi-file batch state before a non-append local import so files
   * combine cleanly without residual geometry from a prior mission.
   */
  onBeginLocalImportBatch?: () => void;
  /** Mission Layers assignment (Control mode). */
  missionLayers?: MissionLayer[];
  controlModeActive?: boolean;
  pendingLayerAssignment?: { fileEntryId: string } | null;
  onPendingLayerAssignment?: (v: { fileEntryId: string } | null) => void;
  onAssignFileToNewLayer?: (fileEntryId: string) => void;
  onAssignFileToLayer?: (fileEntryId: string, layerId: string) => void;
  onUnassignFileFromLayer?: (fileEntryId: string) => void;
  /**
   * Offset plan (whole-plan rigid shift toward an absolute compass bearing).
   * Parent (App.tsx) owns the state and bakes the shift into `lines` on Apply
   * — this component only renders the control.
   */
  offsetDistanceM?: number;
  offsetBearingDeg?: number;
  onOffsetDistanceChange?: (m: number) => void;
  onOffsetBearingChange?: (deg: number) => void;
  onApplyOffset?: () => void;
  offsetTargetOptions?: import("../../../utils/missionLayerLines").AnchorTargetOption[];
  offsetTarget?: import("../../../utils/missionLayerLines").AnchorTarget | null;
  onOffsetTargetChange?: (target: import("../../../utils/missionLayerLines").AnchorTarget) => void;
  offsetResetAvailable?: boolean;
  onResetOffset?: () => void;
  onOffsetDragStateChange?: (dragging: boolean) => void;
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

/** Read picked file text via stable cache copy (native) or blob (web). */
async function readPickedFileText(
  file: DocumentPicker.DocumentPickerAsset
): Promise<{ text: string; stableUri: string }> {
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
  return { text, stableUri: stable.uri };
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
  localDxfSnapshot = null,
  extensionStatus = null,
  uploadedFiles = [],
  onSelectUploadedFile,
  selectedUploadedFileId = null,
  onBeginLocalImportBatch,
  missionLayers = [],
  controlModeActive = false,
  pendingLayerAssignment = null,
  onPendingLayerAssignment,
  onAssignFileToNewLayer,
  onAssignFileToLayer,
  onUnassignFileFromLayer,
  offsetDistanceM = 0,
  offsetBearingDeg = 0,
  onOffsetDistanceChange,
  onOffsetBearingChange,
  onApplyOffset,
  offsetTargetOptions = [],
  offsetTarget = null,
  onOffsetTargetChange,
  offsetResetAvailable = false,
  onResetOffset,
  onOffsetDragStateChange,
}: UploadAndPreviewStepProps) {
  /** Last failed batch (for Retry). Single-file rover uploads use length 1. */
  const [pickedFiles, setPickedFiles] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  /** When true, next successful local import merges into the already-loaded plan. */
  const [appendOnImport, setAppendOnImport] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<pathApi.PathPreviewResponse | null>(null);
  /** Source file names when multi-file import was merged into one plan. */
  const [loadedSourceFiles, setLoadedSourceFiles] = useState<string[]>(() =>
    localCsvPreview?.fileName ? [localCsvPreview.fileName] : []
  );
  /**
   * Last successful local DXF merge — needed so "Add more files" can append without
   * re-reading the previous pick (parent only keeps geometry in `lines`).
   */
  const [lastLocalDxf, setLastLocalDxf] = useState<LocalDxfResult | null>(null);
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

  /** Draft strings for CSV extension inputs (commit on blur / after a pause). */
  const [csvExtPreDraft, setCsvExtPreDraft] = useState(
    () => String(csvExtensionConfig?.preM ?? 0.5)
  );
  const [csvExtAftDraft, setCsvExtAftDraft] = useState(
    () => String(csvExtensionConfig?.aftM ?? 0.5)
  );
  const extPreFocusedRef = useRef(false);
  const extAftFocusedRef = useRef(false);
  const extCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!csvExtensionConfig) return;
    if (!extPreFocusedRef.current) setCsvExtPreDraft(String(csvExtensionConfig.preM));
    if (!extAftFocusedRef.current) setCsvExtAftDraft(String(csvExtensionConfig.aftM));
  }, [csvExtensionConfig?.preM, csvExtensionConfig?.aftM, csvExtensionConfig?.enabled]);

  useEffect(
    () => () => {
      if (extCommitTimerRef.current) clearTimeout(extCommitTimerRef.current);
    },
    []
  );

  const commitExtensionDrafts = useCallback(
    (preRaw: string, aftRaw: string) => {
      if (!csvExtensionConfig || !onCsvExtensionConfigChange) return;
      const next = normalizeCsvExtensionConfig({
        ...csvExtensionConfig,
        enabled: true,
        preM: isCompleteExtensionDraft(preRaw) ? parseFloat(preRaw) : csvExtensionConfig.preM,
        aftM: isCompleteExtensionDraft(aftRaw) ? parseFloat(aftRaw) : csvExtensionConfig.aftM,
      });
      const same =
        next.enabled === csvExtensionConfig.enabled &&
        next.preM === csvExtensionConfig.preM &&
        next.aftM === csvExtensionConfig.aftM &&
        next.perLine === csvExtensionConfig.perLine;
      if (same) {
        setCsvExtPreDraft(String(next.preM));
        setCsvExtAftDraft(String(next.aftM));
        return;
      }
      onInvalidateWorkflow("spray");
      onCsvExtensionConfigChange(next);
      setCsvExtPreDraft(String(next.preM));
      setCsvExtAftDraft(String(next.aftM));
    },
    [csvExtensionConfig, onCsvExtensionConfigChange, onInvalidateWorkflow]
  );

  const scheduleExtensionCommit = useCallback(
    (preRaw: string, aftRaw: string) => {
      if (extCommitTimerRef.current) clearTimeout(extCommitTimerRef.current);
      if (!isCompleteExtensionDraft(preRaw) || !isCompleteExtensionDraft(aftRaw)) return;
      extCommitTimerRef.current = setTimeout(() => {
        commitExtensionDrafts(preRaw, aftRaw);
      }, 400);
    },
    [commitExtensionDrafts]
  );

  // Re-hydrate summary when parent already holds the parse (layout remount on CSV flow).
  useEffect(() => {
    if (!localCsvPreview) return;
    setLocalCsvSummary({
      num_points: localCsvPreview.num_points,
      kind: localCsvPreview.kind,
      frame: localCsvPreview.point_source_frame,
      warnings: localCsvPreview.warnings.slice(0, 12),
    });
    setLoadedSourceFiles((prev) =>
      prev.length > 0 ? prev : localCsvPreview.fileName ? [localCsvPreview.fileName] : prev
    );
  }, [
    localCsvPreview?.num_points,
    localCsvPreview?.kind,
    localCsvPreview?.point_source_frame,
    localCsvPreview?.fileName,
  ]);

  // After remount, keep a DXF base so "+" append still works without re-picking.
  useEffect(() => {
    if (!localDxfSnapshot) return;
    setLastLocalDxf((prev) => prev ?? localDxfSnapshot);
    setLoadedSourceFiles((prev) =>
      prev.length > 0
        ? prev
        : localDxfSnapshot.fileName
          ? [localDxfSnapshot.fileName]
          : prev
    );
  }, [
    localDxfSnapshot?.fileName,
    localDxfSnapshot?.entityCount,
    localDxfSnapshot?.isGeographic,
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
  /** Offset lives in the same slot/conditions as Extension — both are whole-plan,
   * client-side-only adjustments applied before Path Order/Send. */
  const showOffsetCard = (showCsvExtension || showLocalDxfExtension) && onApplyOffset != null;

  // Backend path preview for rover DXF / waypoints only — never local CSV or local DXF.
  useEffect(() => {
    if (isLocalDxfPlanner) return;
    if (!targetPathName || !apiBaseUrl || isCsvPath) return;
    setPreviewData(null);
    const requestedName = targetPathName;
    const controller = new AbortController();
    pathApi.getPathPreview(apiBaseUrl, requestedName)
      .then(res => {
        if (controller.signal.aborted) return;
        if (res.ok) {
          return res.json().then((data: pathApi.PathPreviewResponse) => {
            if (controller.signal.aborted) return;
            setPreviewData(data);
          });
        }
      })
      .catch(() => {
        // Preview is optional — swallow errors silently
      });
    return () => {
      controller.abort();
    };
  }, [targetPathName, apiBaseUrl, isCsvPath, isLocalDxfPlanner]);

  /**
   * Local multi-CSV: parse each file on-device and merge into one plan.
   * When `append` is true, new files are merged into the already-loaded CSV plan.
   */
  /**
   * Parse each CSV on-device and hand up one file at a time. App.tsx owns append/rebase.
   */
  const importLocalCsvFiles = async (
    files: DocumentPicker.DocumentPickerAsset[],
    opts?: { append?: boolean }
  ) => {
    const append = !!opts?.append;
    setPickedFiles(files);
    setImportError(null);
    setIsUploading(true);
    await yieldToUi();
    try {
      if (!append) {
        onBeginLocalImportBatch?.();
      }
      // Append validity is enforced in importAndPreviewFiles (batch already loaded).

      let firstStableUri = files[0]?.uri ?? "";
      let lastParsed: LocalPointCsvResult | null = null;
      const allWarnings: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const { text, stableUri } = await readPickedFileText(file);
        if (i === 0) firstStableUri = stableUri;
        const parsed = parseLocalPointCsv(text, file.name);
        lastParsed = parsed;
        allWarnings.push(...parsed.warnings.map((w) => `${file.name}: ${w}`));
        onLocalCsvParsed?.(parsed);
      }

      if (lastParsed) {
        setLocalCsvSummary({
          num_points: lastParsed.num_points,
          kind: lastParsed.kind,
          frame: lastParsed.point_source_frame,
          warnings: allWarnings.slice(0, 12),
        });
      }
      setImportedPlan({
        fileName:
          files.length === 1
            ? files[0].name
            : `${files[0]?.name?.replace(/\.[^.]+$/, "") ?? "batch"}_x${files.length}.csv`,
        uri: firstStableUri,
        fileType: "csv",
        source: "imported",
      });
      const newNames = files.map((f) => f.name);
      setLoadedSourceFiles((prev) =>
        append && prev.length > 0 ? [...prev, ...newNames] : newNames
      );
      setPreviewData(null);
      setPickedFiles([]);
      setImportError(null);
      setAppendOnImport(false);

      if (allWarnings.length > 0) {
        console.warn("[import][csv] warnings:", allWarnings);
      }
    } catch (err) {
      console.log("Error importing CSV locally:", err);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not parse the CSV file(s).";
      setImportError(msg);
      Alert.alert("Import Failed", msg);
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Parse each DXF on-device and hand up one file at a time. App.tsx owns append/rebase
   * and per-file metric alignment gating.
   */
  const importLocalDxfFiles = async (
    files: DocumentPicker.DocumentPickerAsset[],
    opts?: { append?: boolean }
  ) => {
    const append = !!opts?.append;
    setPickedFiles(files);
    setImportError(null);
    setIsUploading(true);
    try {
      if (!append) {
        onBeginLocalImportBatch?.();
      }
      // Append validity is enforced in importAndPreviewFiles (batch already loaded).

      let firstStableUri = files[0]?.uri ?? "";
      let lastParsed: LocalDxfResult | null = null;
      const allWarnings: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const { text, stableUri } = await readPickedFileText(file);
        if (i === 0) firstStableUri = stableUri;
        const parsed = parseLocalDxf(text, file.name);
        lastParsed = parsed;
        allWarnings.push(...parsed.warnings.map((w) => `${file.name}: ${w}`));
        onLocalDxfParsed?.(parsed);
      }

      if (lastParsed) {
        setLastLocalDxf(lastParsed);
      }
      setImportedPlan({
        fileName:
          files.length === 1
            ? files[0].name
            : `${files[0]?.name?.replace(/\.[^.]+$/, "") ?? "batch"}_x${files.length}.dxf`,
        uri: firstStableUri,
        fileType: "dxf",
        source: "imported",
      });
      const newNames = files.map((f) => f.name);
      setLoadedSourceFiles((prev) =>
        append && prev.length > 0 ? [...prev, ...newNames] : newNames
      );
      setPreviewData(null);
      setPickedFiles([]);
      setImportError(null);
      setAppendOnImport(false);
      if (onCsvExtensionConfigChange && csvExtensionConfig) {
        // per-line: CAD edges are independent PRE→MARK→AFT passes, and it is the only
        // mode under which a closed shape (a square drawn as one polyline) gets run-ups.
        onCsvExtensionConfigChange(normalizeCsvExtensionConfig(DXF_EXTENSION_CONFIG));
      }
      if (allWarnings.length > 0) {
        console.warn("[import][dxf-local] warnings:", allWarnings);
      }
    } catch (err) {
      console.log("Error importing DXF locally:", err);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not parse the DXF file(s).";
      setImportError(msg);
      Alert.alert("Import Failed", msg);
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Rover DXF / waypoints: single-file upload + backend preview.
   * Multi-select is rejected for rover-side paths (one path name per upload).
   */
  const importRoverFile = async (file: DocumentPicker.DocumentPickerAsset) => {
    if (!apiBaseUrl) {
      Alert.alert("Not connected", "Connect to the rover before importing a file.");
      return;
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    setPickedFiles([file]);
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
        setLoadedSourceFiles([file.name]);
        setPickedFiles([]);
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

  /**
   * CSV + app-planned DXF: multi-file parse on-device (mixed types allowed).
   * Waypoints / rover DXF (DXF_PLANNER=rover): single-file upload + backend preview.
   * `append` adds into the local batch already shown as LOADED (Add more files).
   */
  const importAndPreviewFiles = async (
    files: DocumentPicker.DocumentPickerAsset[],
    opts?: { append?: boolean }
  ) => {
    if (blockProtectedWorkflowMutation("Parsing a new path")) return;
    if (files.length === 0) return;

    const append = !!opts?.append;
    const csvFiles = files.filter((f) => (f.name.split(".").pop()?.toLowerCase() ?? "") === "csv");
    const dxfFiles = files.filter((f) => (f.name.split(".").pop()?.toLowerCase() ?? "") === "dxf");
    const waypointFiles = files.filter(
      (f) => (f.name.split(".").pop()?.toLowerCase() ?? "") === "waypoints"
    );

    // Waypoints (and rover-side DXF when planner is not app) stay single-file.
    if (waypointFiles.length > 0) {
      if (csvFiles.length > 0 || dxfFiles.length > 0 || waypointFiles.length > 1) {
        Alert.alert(
          "One File at a Time",
          "Waypoints uploads support a single file. Select one .waypoints file alone."
        );
        return;
      }
      if (append) {
        Alert.alert(
          "Cannot Add Files",
          "Adding more files is only available for local CSV and app-planned DXF plans."
        );
        return;
      }
      await importRoverFile(waypointFiles[0]);
      return;
    }

    const localDxfOk = DXF_PLANNER === "app";
    const hasLocalBatch = uploadedFiles.length > 0 || localCsvPreview != null || isLocalDxfPlanner;

    if (append) {
      if (!hasLocalBatch) {
        Alert.alert(
          "Cannot Add Files",
          "Adding more files is only available for local CSV and app-planned DXF plans."
        );
        return;
      }
      if (dxfFiles.length > 0 && !localDxfOk) {
        Alert.alert("Wrong Type", "App-planned DXF is required to add .dxf files to a local batch.");
        return;
      }
      // Append each type into the existing multi-file batch (no type exclusivity).
      if (csvFiles.length > 0) {
        await importLocalCsvFiles(csvFiles, { append: true });
      }
      if (dxfFiles.length > 0 && localDxfOk) {
        await importLocalDxfFiles(dxfFiles, { append: true });
      }
      return;
    }

    // Fresh pick: mixed CSV + app DXF in one gesture is allowed.
    if (dxfFiles.length > 0 && !localDxfOk) {
      if (csvFiles.length > 0 || dxfFiles.length > 1) {
        Alert.alert(
          "One File at a Time",
          "Rover-side DXF uploads support a single file. Select one file, or switch to app-planned DXF for multi-file merge."
        );
        return;
      }
      await importRoverFile(dxfFiles[0]);
      return;
    }

    // Mixed CSV + app-planned DXF in one pick: reuse the per-type importers so summary
    // bookkeeping (localCsvSummary / lastLocalDxf) stays correct for both kinds — only the
    // first call resets the batch, the second appends into what it just started.
    const mixedLocal = csvFiles.length > 0 && dxfFiles.length > 0 && localDxfOk;
    if (mixedLocal) {
      await importLocalCsvFiles(csvFiles, { append: false });
      await importLocalDxfFiles(dxfFiles, { append: true });
      // Combined display name/uri once both kinds have imported — deliberately "dxf"
      // (no "mixed" fileType exists on ImportedPlan; this is only a display fallback,
      // superseded everywhere else by the per-file `uploadedFiles` list).
      const firstFile = csvFiles[0] ?? dxfFiles[0];
      const stableUri = firstFile ? (await resolveStableUploadAsset(firstFile)).uri : "";
      setImportedPlan({
        fileName: `mixed_x${csvFiles.length + dxfFiles.length}`,
        uri: stableUri,
        fileType: "dxf",
        source: "imported",
      });
      setLoadedSourceFiles([...csvFiles, ...dxfFiles].map((f) => f.name));
      return;
    }

    if (csvFiles.length > 0) {
      await importLocalCsvFiles(csvFiles, { append: false });
      return;
    }

    if (dxfFiles.length > 0 && localDxfOk) {
      await importLocalDxfFiles(dxfFiles, { append: false });
      return;
    }

    Alert.alert("Invalid File", "Please select one or more .dxf, .csv, or .waypoints files.");
  };

  const pickAndImport = async (opts?: { append?: boolean }) => {
    if (blockProtectedWorkflowMutation(opts?.append ? "Adding files to the plan" : "Uploading a new path"))
      return;
    if (isUploading) return;
    try {
      setAppendOnImport(!!opts?.append);
      const result = await DocumentPicker.getDocumentAsync({
        type: ["*/*"],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const valid = result.assets.filter((asset) => {
          const ext = asset.name.split(".").pop()?.toLowerCase();
          return ext === "dxf" || ext === "csv" || ext === "waypoints";
        });
        if (valid.length === 0) {
          setAppendOnImport(false);
          Alert.alert("Invalid File", "Please select one or more .dxf, .csv, or .waypoints files.");
          return;
        }
        if (valid.length < result.assets.length) {
          Alert.alert(
            "Some Files Skipped",
            `${result.assets.length - valid.length} unsupported file(s) ignored. Importing ${valid.length} file(s).`
          );
        }
        // Parse + map preview immediately — no separate Parse step.
        await importAndPreviewFiles(valid, { append: !!opts?.append });
      } else {
        setAppendOnImport(false);
      }
    } catch (err) {
      setAppendOnImport(false);
      console.log("Error picking file:", err);
    }
  };

  /** Replace the current plan with a new pick (full multi-select). */
  const handlePickFile = async () => {
    await pickAndImport({ append: false });
  };

  /** Append more files to the already-loaded local CSV / DXF plan. */
  const handleAddMoreFiles = async () => {
    await pickAndImport({ append: true });
  };

  const handleRetryImport = async () => {
    if (pickedFiles.length === 0 || isUploading) return;
    await importAndPreviewFiles(pickedFiles, { append: appendOnImport });
  };

  const pickedLabel =
    pickedFiles.length === 0
      ? ""
      : pickedFiles.length === 1
        ? pickedFiles[0].name
        : `${pickedFiles[0].name} + ${pickedFiles.length - 1} more`;

  const loadedFilesLabel =
    loadedSourceFiles.length > 1
      ? `${loadedSourceFiles.length} files: ${loadedSourceFiles.slice(0, 3).join(", ")}${
          loadedSourceFiles.length > 3 ? ` +${loadedSourceFiles.length - 3}` : ""
        }`
      : loadedSourceFiles.length === 1
        ? loadedSourceFiles[0]
        : null;

  /** Local CSV / app-planned DXF batch — can append more files after first load. */
  const canAddMoreFiles =
    !!targetPathName &&
    (uploadedFiles.length > 0 ||
      (isCsvPath && !isDxfPath && localCsvPreview != null) ||
      (isLocalDxfPlanner && (lastLocalDxf != null || localDxfSnapshot != null)));

  return (
    <View style={{ gap: 14 }}>
      {/* File Upload Section */}
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        {DXF_PLANNER === "app"
          ? "Import one or more .csv / .dxf files (mixed types OK). Each file is tracked; metric DXFs need Align before Path Order & Load. Use + after load to add more. Waypoints still use the rover (one file)."
          : "Import one or more .csv files (merged locally), or a single .dxf / .waypoints for the rover. Use + after load to add more CSV files."}
      </Text>

      {pickedFiles.length === 0 && !targetPathName ? (
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
            {isUploading ? "Loading preview…" : "Select File(s)"}
          </Text>
        </TouchableOpacity>
      ) : pickedFiles.length > 0 ? (
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
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "600" }} numberOfLines={2}>
              {pickedLabel}
            </Text>
            {isUploading ? (
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                {pickedFiles.length > 1
                  ? `Importing ${pickedFiles.length} files and loading map preview…`
                  : "Uploading and loading map preview…"}
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
              setPickedFiles([]);
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
            <View style={{ flex: 1, paddingRight: 4 }}>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>
                LOADED
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700", marginTop: 2 }} numberOfLines={1}>
                {targetPathName}
              </Text>
              {loadedFilesLabel && loadedSourceFiles.length > 1 ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }} numberOfLines={2}>
                  {loadedFilesLabel}
                </Text>
              ) : null}
              {uploadedFiles.length > 1 ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {uploadedFiles.length} files in mission ·{" "}
                  {uploadedFiles.filter((f) => f.status === "verified").length} verified
                </Text>
              ) : localCsvSummary ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {localCsvSummary.num_points} points · local {localCsvSummary.kind.toUpperCase()} ·{" "}
                  {localCsvSummary.frame}
                </Text>
              ) : previewData ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {previewData.num_points ?? "?"} points · {previewData.frame ?? "DXF"}
                </Text>
              ) : isLocalDxfPlanner && (lastLocalDxf || localDxfSnapshot) ? (
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                  {(lastLocalDxf ?? localDxfSnapshot)!.entityCount} path(s) ·{" "}
                  {(lastLocalDxf ?? localDxfSnapshot)!.isGeographic ? "geo DXF" : "metric DXF"}
                  {loadedSourceFiles.length > 1 ? ` · ${loadedSourceFiles.length} files` : ""}
                </Text>
              ) : null}
            </View>
            {/* + adds more files into this plan (forgot a file after first pick). */}
            {canAddMoreFiles ? (
              <Pressable
                onPress={() => {
                  void handleAddMoreFiles();
                }}
                disabled={protectedResident || isUploading}
                accessibilityLabel="Add more files"
                accessibilityRole="button"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: FIELDS_COLORS.stepActive,
                  opacity: protectedResident || isUploading ? 0.5 : 1,
                  marginRight: 4,
                }}
              >
                <Plus size={20} color="#fff" strokeWidth={2.5} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                setImportedPlan(null);
                setPreviewData(null);
                setLocalCsvSummary(null);
                setLoadedSourceFiles([]);
                setLastLocalDxf(null);
                setAppendOnImport(false);
                onClearLocalCsv?.();
              }}
              style={{ padding: 6 }}
            >
              <X size={18} color={FIELDS_COLORS.textDim} />
            </Pressable>
          </View>

          {/* Per-file status list (multi-type batch) */}
          {uploadedFiles.length > 0 ? (
            <View style={{ gap: 6 }}>
              {controlModeActive ? (
                <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, marginBottom: 2 }}>
                  Control mode — tap + to assign a file to a mission layer
                </Text>
              ) : null}
              {uploadedFiles.map((f) => {
                const selected = selectedUploadedFileId === f.id;
                const verified = f.status === "verified";
                const kindLabel =
                  f.kind === "template"
                    ? "template"
                    : f.kind === "csv"
                    ? f.isGeographic
                      ? "csv · gps"
                      : "csv · ned"
                    : f.isGeographic
                      ? "dxf · geo"
                      : "dxf · metric";
                const assigned = layerForFile(missionLayers, f.id);
                const pendingHere = pendingLayerAssignment?.fileEntryId === f.id;
                const existingLayers = sortedMissionLayers(missionLayers);
                return (
                  <View key={f.id} style={{ gap: 6 }}>
                    <Pressable
                      onPress={() => onSelectUploadedFile?.(f.id)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        paddingVertical: 8,
                        paddingHorizontal: 10,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: selected
                          ? FIELDS_COLORS.stepActive
                          : pendingHere
                            ? FIELDS_COLORS.accentBorder
                            : FIELDS_COLORS.panelBorder,
                        backgroundColor: FIELDS_COLORS.surfaceSolid,
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}
                          numberOfLines={1}
                        >
                          {f.fileName}
                        </Text>
                        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10, marginTop: 1 }}>
                          {kindLabel}
                          {assigned ? ` · mission layer ${assigned.number}` : ""}
                        </Text>
                      </View>
                      {controlModeActive ? (
                        <Pressable
                          onPress={(e) => {
                            e?.stopPropagation?.();
                            if (assigned) {
                              // Second tap on badge opens reassignment chips
                              onPendingLayerAssignment?.(
                                pendingHere ? null : { fileEntryId: f.id }
                              );
                              return;
                            }
                            if (existingLayers.length === 0) {
                              onAssignFileToNewLayer?.(f.id);
                              return;
                            }
                            onPendingLayerAssignment?.(
                              pendingHere ? null : { fileEntryId: f.id }
                            );
                          }}
                          accessibilityLabel={
                            assigned
                              ? `Mission layer ${assigned.number}`
                              : "Assign to mission layer"
                          }
                          style={{
                            minWidth: 32,
                            height: 28,
                            paddingHorizontal: 8,
                            borderRadius: 8,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: assigned
                              ? FIELDS_COLORS.accentMuted
                              : FIELDS_COLORS.stepActive,
                            borderWidth: 1,
                            borderColor: assigned
                              ? FIELDS_COLORS.accentBorder
                              : FIELDS_COLORS.stepActive,
                          }}
                        >
                          <Text
                            style={{
                              color: assigned
                                ? FIELDS_COLORS.accentBrand
                                : FIELDS_COLORS.accentText,
                              fontWeight: "900",
                              fontSize: assigned ? 12 : 16,
                              lineHeight: assigned ? 14 : 18,
                            }}
                          >
                            {assigned ? String(assigned.number) : "+"}
                          </Text>
                        </Pressable>
                      ) : assigned ? (
                        <View
                          style={{
                            minWidth: 28,
                            height: 24,
                            paddingHorizontal: 7,
                            borderRadius: 7,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: FIELDS_COLORS.accentMuted,
                            borderWidth: 1,
                            borderColor: FIELDS_COLORS.accentBorder,
                            marginRight: 4,
                          }}
                        >
                          <Text
                            style={{
                              color: FIELDS_COLORS.accentBrand,
                              fontWeight: "900",
                              fontSize: 11,
                            }}
                          >
                            {assigned.number}
                          </Text>
                        </View>
                      ) : null}
                      <View
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 999,
                          backgroundColor: verified
                            ? "rgba(16,185,129,0.15)"
                            : "rgba(245,158,11,0.18)",
                        }}
                      >
                        <Text
                          style={{
                            color: verified ? FIELDS_COLORS.success : FIELDS_COLORS.warning,
                            fontSize: 10,
                            fontWeight: "800",
                          }}
                        >
                          {verified ? "Verified" : "Needs Alignment"}
                        </Text>
                      </View>
                    </Pressable>

                    {controlModeActive && pendingHere ? (
                      <View
                        style={{
                          flexDirection: "row",
                          flexWrap: "wrap",
                          gap: 6,
                          paddingLeft: 4,
                        }}
                      >
                        {existingLayers.map((layer) => {
                          const isCurrent = assigned?.id === layer.id;
                          return (
                            <Pressable
                              key={layer.id}
                              onPress={() => onAssignFileToLayer?.(f.id, layer.id)}
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                                borderRadius: 999,
                                backgroundColor: isCurrent
                                  ? FIELDS_COLORS.accentBrand
                                  : FIELDS_COLORS.surfaceSolid,
                                borderWidth: 1,
                                borderColor: isCurrent
                                  ? FIELDS_COLORS.accentBrand
                                  : FIELDS_COLORS.panelBorder,
                              }}
                            >
                              <Text
                                style={{
                                  color: isCurrent
                                    ? FIELDS_COLORS.accentText
                                    : FIELDS_COLORS.textMain,
                                  fontSize: 11,
                                  fontWeight: "700",
                                }}
                              >
                                Layer {layer.number}
                              </Text>
                            </Pressable>
                          );
                        })}
                        <Pressable
                          onPress={() => onAssignFileToNewLayer?.(f.id)}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 999,
                            backgroundColor: FIELDS_COLORS.cardSolid,
                            borderWidth: 1,
                            borderColor: FIELDS_COLORS.stepActive,
                          }}
                        >
                          <Text
                            style={{
                              color: FIELDS_COLORS.stepActive,
                              fontSize: 11,
                              fontWeight: "700",
                            }}
                          >
                            + New layer
                          </Text>
                        </Pressable>
                        {assigned ? (
                          <Pressable
                            onPress={() => onUnassignFileFromLayer?.(f.id)}
                            style={{
                              paddingHorizontal: 10,
                              paddingVertical: 6,
                              borderRadius: 999,
                              backgroundColor: FIELDS_COLORS.dangerMuted,
                              borderWidth: 1,
                              borderColor: FIELDS_COLORS.dangerBorder,
                            }}
                          >
                            <Text
                              style={{
                                color: FIELDS_COLORS.danger,
                                fontSize: 11,
                                fontWeight: "700",
                              }}
                            >
                              Unassign
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
              {controlModeActive && nonEmptyMissionLayers(missionLayers).length > 0 ? (
                <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10, marginTop: 2 }}>
                  {nonEmptyMissionLayers(missionLayers).length} mission layer
                  {nonEmptyMissionLayers(missionLayers).length === 1 ? "" : "s"} · Hidden mission
                  layers are not started — toggle them under Control
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Add more (append) + replace all */}
          <View style={{ flexDirection: "row", gap: 8 }}>
            {canAddMoreFiles ? (
              <Pressable
                onPress={() => {
                  void handleAddMoreFiles();
                }}
                disabled={protectedResident || isUploading}
                style={{
                  flex: 1,
                  height: 36,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: 6,
                  backgroundColor: "transparent",
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.stepActive,
                  opacity: protectedResident || isUploading ? 0.5 : 1,
                }}
              >
                <Plus size={14} color={FIELDS_COLORS.stepActive} strokeWidth={2.5} />
                <Text style={{ color: FIELDS_COLORS.stepActive, fontSize: 12, fontWeight: "700" }}>
                  {isUploading && appendOnImport ? "Adding…" : "Add more files"}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={handlePickFile}
              disabled={protectedResident || isUploading}
              style={{
                flex: 1,
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
                {isUploading && !appendOnImport ? "Loading preview…" : "Replace all"}
              </Text>
            </Pressable>
          </View>

          {/* Guide-points CSV lives in Align DXF, next to the control-point list it feeds —
              importing it from Upload put an alignment control two steps early. */}
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
                    onFocus={() => {
                      extPreFocusedRef.current = true;
                    }}
                    onChangeText={(v) => {
                      setCsvExtPreDraft(v);
                      scheduleExtensionCommit(v, csvExtAftDraft);
                    }}
                    onBlur={() => {
                      extPreFocusedRef.current = false;
                      if (extCommitTimerRef.current) clearTimeout(extCommitTimerRef.current);
                      commitExtensionDrafts(csvExtPreDraft, csvExtAftDraft);
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
                    onFocus={() => {
                      extAftFocusedRef.current = true;
                    }}
                    onChangeText={(v) => {
                      setCsvExtAftDraft(v);
                      scheduleExtensionCommit(csvExtPreDraft, v);
                    }}
                    onBlur={() => {
                      extAftFocusedRef.current = false;
                      if (extCommitTimerRef.current) clearTimeout(extCommitTimerRef.current);
                      commitExtensionDrafts(csvExtPreDraft, csvExtAftDraft);
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

      <PlanOffsetCard
        visible={showOffsetCard}
        offsetDistanceM={offsetDistanceM}
        offsetBearingDeg={offsetBearingDeg}
        onOffsetDistanceChange={onOffsetDistanceChange ?? (() => {})}
        onOffsetBearingChange={onOffsetBearingChange ?? (() => {})}
        onApplyOffset={onApplyOffset ?? (() => {})}
        offsetTargetOptions={offsetTargetOptions}
        offsetTarget={offsetTarget}
        onOffsetTargetChange={onOffsetTargetChange ?? (() => {})}
        offsetResetAvailable={offsetResetAvailable}
        onResetOffset={onResetOffset ?? (() => {})}
        onOffsetDragStateChange={onOffsetDragStateChange}
      />

      {protectedResident && (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11 }}>
          A protected mission is currently resident. Upload is blocked.
        </Text>
      )}
    </View>
  );
}
