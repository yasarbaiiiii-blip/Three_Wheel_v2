import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, Text, TextInput, View } from "react-native";
import { Check, MapPin, Maximize2, Move, Plus, Upload, X } from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";

import { assessAlignmentTrust, enforceAlignmentScale } from "../../../utils/designAlignmentPolicy";
import {
  applyAlignmentToLines,
  solveMultiPointAlignment,
} from "../../../utils/dxfAlignment";
import {
  coerceFiniteNumber,
  formatFinite,
  sanitizePlanLines,
} from "../../../utils/pathWorkflow";
import {
  similarityTransform,
  transformPlanLinesGeometry,
} from "../../../utils/planLineTransform";
import type {
  AlignRefPoint,
  AlignmentResultState,
  StagedWorkflowStatus,
  StagedWorkflowStep,
  VerifiedAlignment,
} from "../../../types/fieldsWorkflow";
import type { PlanLine } from "../../../types/plan";
import type { AutoOriginReference } from "../../../types/autoOrigin";
import type { PlacedItem } from "../../BoundaryEditor";
import { FieldsSegmented } from "../FieldsButtons";
import { FIELDS_COLORS } from "../fieldsTheme";
import { parseGuidePointsCsv } from "../../../utils/refPointsCsv";

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

type AlignDxfPanelProps = {
  lines: PlanLine[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<VerifiedAlignment | null>>;
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  onWorkflowStep?: (step: "alignment", status: StagedWorkflowStatus) => void;
  onInvalidateWorkflow: (step: StagedWorkflowStep) => void;
  blockPlanEdit: (action: string) => boolean;
  refPoints: RefPoint[];
  setRefPoints: React.Dispatch<React.SetStateAction<RefPoint[]>>;
  /** True while Multi-Point guide points came from CSV — disables map tap-to-pick. */
  csvGuidePointsActive?: boolean;
  setCsvGuidePointsActive?: React.Dispatch<React.SetStateAction<boolean>>;
  /** Imported guide CSV file names for the import button label (supports multiple files). */
  guideCsvFileNames?: string[];
  setGuideCsvFileNames?: React.Dispatch<React.SetStateAction<string[]>>;
  alignmentMethod: "least_squares" | "visual_alignment";
  setAlignmentMethod: React.Dispatch<React.SetStateAction<"least_squares" | "visual_alignment">>;
  setMissionSummary: React.Dispatch<React.SetStateAction<any>>;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  /**
   * Clears the provisional map projection anchor used during plan-edit / visual placement.
   * Must be invoked synchronously on Fix Alignment success (same turn as setAlignedRefPoints
   * + line transform) so MapViewNative does not paint transformed lines under the old origin
   * for one frame (shift-then-settle).
   */
  setVisualAlignmentAnchor?: React.Dispatch<
    React.SetStateAction<{
      originLat: number;
      originLon: number;
      originDxfNorth: number;
      originDxfEast: number;
    } | null>
  >;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
  extractedCorners?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[] | null;
  setExtractedCorners?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[] | null>>;
  /** Current plan LLA coordinates read from the map (for visual alignment) */
  mapLLA?: { lat: number; lon: number } | null;
  /** Auto Origin: skips formal GPS alignment, shifts the plan to the rover's live position instead. */
  autoOrigin?: boolean;
  onToggleAutoOrigin?: () => void;
  autoOriginReference?: AutoOriginReference | null;
  /** Whether Auto Origin is currently eligible (no verified alignment yet). */
  autoOriginEnabled?: boolean;
  /** True once a formal GPS alignment has been staged & verified — Auto Origin is force-disabled at mission start in this state. */
  stagedVerified?: boolean;
  missionRunning?: boolean;
  /** True while the whole plan is a draggable/rotatable "sticker" on the map (tap-to-pick-point is disabled meanwhile). */
  isPlanEditingMode?: boolean;
  /** Enters plan editing (drag/rotate) when off, or bakes the transform back into `lines` and returns to point-picking when on. */
  onToggleMovePlan?: () => void;
  /** One-tap similarity fit (translate+rotate+scale) onto ≥2 lat/lon reference points. */
  onFitToReferencePoints?: (refs: Array<{ lat: number; lon: number }>) => void;
  /** Map pin tap focuses this guide row for Lat/Lon entry (0-based). */
  focusedGuidePointIndex?: number | null;
  onFocusedGuidePointIndexChange?: (index: number | null) => void;
  /**
   * When set, local (app-planned) Fix Alignment commits through this callback
   * instead of only mutating parent mission `lines` / global workflow verified.
   * Used for per-file metric DXF in a multi-type batch.
   */
  onLocalFixApplied?: (result: {
    alignedLines: PlanLine[];
    originGps: [number, number];
    scale: number | null;
    rotationDeg: number | null;
    rmseM: number | null;
  }) => void;
};

export function AlignDxfPanel({
  lines,
  setLines,
  alignmentResult,
  setAlignmentResult,
  setVerifiedAlignmentRequest,
  setAlignedRefPoints,
  onWorkflowStep,
  onInvalidateWorkflow,
  blockPlanEdit,
  refPoints,
  setRefPoints,
  csvGuidePointsActive = false,
  setCsvGuidePointsActive,
  guideCsvFileNames = [],
  setGuideCsvFileNames,
  alignmentMethod,
  setAlignmentMethod,
  setMissionSummary,
  isVisualAlignmentMode,
  visualAlignmentItem,
  setVisualAlignmentItem,
  setVisualAlignmentAnchor,
  onStartVisualAlignment,
  onConfirmVisualAlignment,
  extractedCorners,
  setExtractedCorners,
  mapLLA,
  autoOrigin = false,
  onToggleAutoOrigin,
  autoOriginReference = null,
  autoOriginEnabled = false,
  stagedVerified = false,
  missionRunning = false,
  isPlanEditingMode = false,
  onToggleMovePlan,
  onFitToReferencePoints,
  focusedGuidePointIndex = null,
  onFocusedGuidePointIndexChange,
  onLocalFixApplied,
}: AlignDxfPanelProps) {
  const [isFixing, setIsFixing] = useState(false);
  const [isImportingCsv, setIsImportingCsv] = useState(false);
  const latInputRefs = useRef<Array<TextInput | null>>([]);

  // Map pin focus → highlight row and open the Latitude field for typing.
  useEffect(() => {
    if (focusedGuidePointIndex == null) return;
    if (focusedGuidePointIndex < 0 || focusedGuidePointIndex >= refPoints.length) return;
    const t = setTimeout(() => {
      latInputRefs.current[focusedGuidePointIndex]?.focus?.();
    }, 80);
    return () => clearTimeout(t);
  }, [focusedGuidePointIndex, refPoints.length]);

  type AlignUiMethod = "least_squares" | "visual_alignment" | "auto_origin";

  const selectedUiMethod: AlignUiMethod = autoOrigin
    ? "auto_origin"
    : alignmentMethod === "visual_alignment"
    ? "visual_alignment"
    : "least_squares";

  const setAutoOriginEnabled = (enabled: boolean) => {
    if (enabled === autoOrigin) return;
    onToggleAutoOrigin?.();
  };

  const selectAlignMethod = (id: AlignUiMethod) => {
    if (id === selectedUiMethod) return;

    onInvalidateWorkflow("alignment");
    setMissionSummary(null);
    setAlignmentResult(null);
    setVerifiedAlignmentRequest(null);
    setRefPoints([]);
    onFocusedGuidePointIndexChange?.(null);
    setCsvGuidePointsActive?.(false);
    setGuideCsvFileNames?.([]);
    setExtractedCorners?.(null);
    setVisualAlignmentItem?.(null);
    setVisualAlignmentAnchor?.(null);

    if (id === "auto_origin") {
      setAutoOriginEnabled(true);
      return;
    }

    setAutoOriginEnabled(false);
    setAlignmentMethod(id);
  };

  const handleUpdateRefPoint = (idx: number, field: "lat" | "lon", value: string) => {
    onInvalidateWorkflow("alignment");
    const next = [...refPoints];
    next[idx] = { ...next[idx], [field]: value };
    setRefPoints(next);
  };

  const handleRemoveRefPoint = (idx: number) => {
    onInvalidateWorkflow("alignment");
    setMissionSummary(null);
    setAlignmentResult(null);
    if (focusedGuidePointIndex === idx) {
      onFocusedGuidePointIndexChange?.(null);
    } else if (focusedGuidePointIndex != null && focusedGuidePointIndex > idx) {
      onFocusedGuidePointIndexChange?.(focusedGuidePointIndex - 1);
    }
    setVerifiedAlignmentRequest(null);
    setRefPoints((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        setCsvGuidePointsActive?.(false);
        setGuideCsvFileNames?.([]);
      }
      return next;
    });
  };

  // Reference points are a PURE visual guide (any count, 1+) — only Latitude/Longitude are
  // read from the file (a survey device's own Easting/Northing, in whatever arbitrary
  // project-specific grid CRS, is ignored entirely). They're never sent anywhere for a
  // computed fit: the user drags/scales/rotates the plan (Move Plan) using these dots as a
  // guide, then "Use This Position" captures wherever they actually placed it.
  const handleUploadRefPointsCsv = async () => {
    if (blockPlanEdit("Importing reference points")) return;

    let assets: DocumentPicker.DocumentPickerAsset[] = [];
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["*/*"],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      assets = result.assets;
    } catch (err) {
      console.log("[AlignDXF][CSV] Error picking CSV:", err);
      Alert.alert("Error", "Could not open the file picker.");
      return;
    }

    const csvAssets = assets.filter((a) => a.name.split(".").pop()?.toLowerCase() === "csv");
    if (csvAssets.length === 0) {
      Alert.alert("Invalid File", "Please select one or more .csv files.");
      return;
    }

    setIsImportingCsv(true);
    try {
      const newPoints: RefPoint[] = [];
      const newFileNames: string[] = [];
      const allErrors: string[] = [];

      for (const asset of csvAssets) {
        let text: string;
        if (Platform.OS === "web") {
          const webFile = (asset as any).file ?? (await (await fetch(asset.uri)).blob());
          text = await webFile.text();
        } else {
          text = await (await fetch(asset.uri)).text();
        }
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        console.log(`[AlignDXF][CSV] Raw file "${asset.name}" (first 300 chars):\n${text.slice(0, 300)}`);

        const { points, errors } = parseGuidePointsCsv(text);
        console.log(`[AlignDXF][CSV] Parsed ${points.length} point(s), ${errors.length} error(s) from ${asset.name}.`);
        if (errors.length > 0) {
          console.log(`[AlignDXF][CSV] Errors in ${asset.name}:`, errors);
          allErrors.push(...errors.map((e) => `${asset.name}: ${e}`));
        }
        if (points.length > 0) {
          newFileNames.push(asset.name || "guide.csv");
          newPoints.push(...points.map((p) => ({ dxf_x: 0, dxf_y: 0, lat: p.latRaw, lon: p.lonRaw })));
        }
      }

      if (newPoints.length === 0) {
        Alert.alert(
          "Import Failed",
          allErrors[0] ?? "No valid Latitude/Longitude rows were found in the selected file(s)."
        );
        return;
      }

      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      // The first CSV import replaces any tapped points and locks out map tap-to-pick
      // until Clear Points; further imports add to the existing CSV guide set so multiple
      // guide files can be combined. dxf_x/dxf_y are unused placeholders — rendering
      // prioritizes lat/lon (see MapViewNative's selectedPointsFC).
      setRefPoints((prev) => (csvGuidePointsActive ? [...prev, ...newPoints] : newPoints));
      setCsvGuidePointsActive?.(true);
      setGuideCsvFileNames?.((prev) => [...prev, ...newFileNames]);
      console.log(
        `[AlignDXF][CSV] Loaded ${newPoints.length} point(s) from ${newFileNames.length} file(s); tap-to-pick disabled.`
      );

      if (allErrors.length > 0) {
        Alert.alert(
          "Imported With Warnings",
          `${newPoints.length} point(s) imported from ${newFileNames.length} file(s). ${allErrors.length} row(s) skipped:\n${allErrors
            .slice(0, 5)
            .join("\n")}${allErrors.length > 5 ? `\n…and ${allErrors.length - 5} more` : ""}`
        );
      } else {
        Alert.alert(
          "Guide CSV Loaded",
          `${newPoints.length} point(s) from ${
            newFileNames.length === 1 ? newFileNames[0] : `${newFileNames.length} files`
          }. Use Move / Rotate Plan, then Resize for edge handles.`
        );
      }
    } catch (err) {
      console.log("[AlignDXF][CSV] Error importing CSV:", err);
      Alert.alert("Error", "Could not read or parse the selected CSV file(s).");
    } finally {
      setIsImportingCsv(false);
    }
  };

  /** Parsed Multi-Point control points ready for /align (plan NE + GPS). */
  const validTypedRefPoints = useMemo(() => {
    const out: AlignRefPoint[] = [];
    for (const point of refPoints) {
      const lat = parseFloat(point.lat);
      const lon = parseFloat(point.lon);
      const dxf_x = coerceFiniteNumber(point.dxf_x);
      const dxf_y = coerceFiniteNumber(point.dxf_y);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        dxf_x == null ||
        dxf_y == null ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        continue;
      }
      out.push({ dxf_x, dxf_y, lat, lon });
    }
    return out;
  }, [refPoints]);

  const canFixFromTypedRefs =
    alignmentMethod === "least_squares" &&
    !csvGuidePointsActive &&
    validTypedRefPoints.length >= 1;

  const handleFixAlignment = async () => {
    console.log(
      `[AlignDXF][Fix] Clicked. method=${alignmentMethod} refPoints=`,
      JSON.stringify(refPoints),
      `extractedCorners=${extractedCorners?.length ?? 0} typedRefs=${validTypedRefPoints.length}`
    );
    if (blockPlanEdit("Changing GPS alignment")) return;

    // Two Multi-Point paths:
    // 1) Captured plan placement (Move Plan / Visual) → extractedCorners
    // 2) Tapped plan points + typed lat/lon (no CSV) → validTypedRefPoints
    let validPoints: AlignRefPoint[] | null = null;
    if (extractedCorners && extractedCorners.length > 0) {
      validPoints = extractedCorners.map((point) => ({
        dxf_x: point.dxf_x,
        dxf_y: point.dxf_y,
        lat: point.lat,
        lon: point.lon,
      }));
    } else if (canFixFromTypedRefs) {
      validPoints = validTypedRefPoints;
    }

    if (!validPoints || validPoints.length === 0) {
      console.log("[AlignDXF][Fix] Aborted: missing points guard.");
      if (alignmentMethod === "least_squares" && !extractedCorners) {
        Alert.alert(
          "Need control points",
          "Tap at least one plan point and enter its Latitude/Longitude, or use Move / Rotate Plan → Use This Position."
        );
      }
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      return;
    }

    setIsFixing(true);
    try {
      console.log("[AlignDXF][Fix] validPoints (dxf_x=east, dxf_y=north):", JSON.stringify(validPoints));

      const payload: VerifiedAlignment = { ref_points: validPoints };

      // Local DXF: solve similarity on device — no POST /align.
      // Bake R·scale into the real DXF path vertices; origin_gps is GPS of design (0,0).
      // the mission then receives those NED runs about origin_gps (no further affine).
      {
        const refs = validPoints.map((p) => ({
          designNorth: p.dxf_y,
          designEast: p.dxf_x,
          lat: p.lat,
          lon: p.lon,
        }));
        const solved = solveMultiPointAlignment(refs);
        const trust = assessAlignmentTrust(solved);
        if (!trust.ok) {
          // Never apply an alignment that does not reproduce the reference points.
          setAlignmentResult(null);
          setVerifiedAlignmentRequest(null);
          onWorkflowStep?.("alignment", "failed");
          Alert.alert(
            "Alignment not applied",
            `${trust.blockers.join("\n")}\n\nFix the reference points and try again.`
          );
          return;
        }
        const originLat = solved.originGps[0];
        const originLon = solved.originGps[1];
        const scale = solved.scale;
        const alignedLines = sanitizePlanLines(
          applyAlignmentToLines(lines, solved, 0, 0)
        );
        setMissionSummary(null);
        setAlignmentResult({
          method: solved.method,
          scale,
          rotation_deg: solved.rotationDeg,
          offset_n: null,
          offset_e: null,
          origin_gps: solved.originGps,
          rmse_m: solved.rmseM,
          sample_coords: null,
          residuals: solved.residualsM,
          warnings: trust.warnings.length > 0 ? trust.warnings : null,
        });
        if (onLocalFixApplied) {
          // Multi-file batch: parent rebases onto sharedOriginGps and merges into mission lines.
          onLocalFixApplied({
            alignedLines,
            originGps: [originLat, originLon],
            scale,
            rotationDeg: solved.rotationDeg,
            rmseM: solved.rmseM,
          });
        } else {
          setVerifiedAlignmentRequest({
            ...payload,
            origin_gps: solved.originGps,
            rotation_deg: 0, // rotation already baked into vertices
          });
          setLines(() => alignedLines);
          // Frame contract: after bake, local (0,0) is at origin_gps (same as CSV anchor).
          setAlignedRefPoints?.([{ dxf_x: 0, dxf_y: 0, lat: originLat, lon: originLon }]);
          onWorkflowStep?.("alignment", "verified");
        }
        // Atomic handoff — clear sticker/provisional anchor so map projects baked NED
        // under the origin_gps frame (never design-frame + sticker residual).
        setRefPoints([]);
        onFocusedGuidePointIndexChange?.(null);
        setCsvGuidePointsActive?.(false);
        setGuideCsvFileNames?.([]);
        setExtractedCorners?.(null);
        setVisualAlignmentItem?.(null);
        setVisualAlignmentAnchor?.(null);
        Alert.alert(
          "Alignment applied",
          [
            `Local fix (RMSE ${solved.rmseM != null ? solved.rmseM.toFixed(3) : "—"} m, scale ${scale.toFixed(4)}). DXF path ready for Send.`,
            ...trust.warnings,
          ].join("\n\n")
        );
        return;
      }
    } catch (err) {
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      console.log("[AlignDXF][Fix] Error aligning path:", err);
      Alert.alert("Error", "Could not apply the alignment.");
    } finally {
      setIsFixing(false);
    }
  };

  const resetAlignment = () => {
    onInvalidateWorkflow("alignment");
    setMissionSummary(null);
    setAlignmentResult(null);
    setVerifiedAlignmentRequest(null);
    setRefPoints([]);
    onFocusedGuidePointIndexChange?.(null);
    setCsvGuidePointsActive?.(false);
    setGuideCsvFileNames?.([]);
    setExtractedCorners?.(null);
    setVisualAlignmentItem?.(null);
    setVisualAlignmentAnchor?.(null);
  };

  // True once Auto Origin is both requested and actually eligible (no verified/staged alignment blocking it).
  const autoOriginActive = autoOrigin && autoOriginEnabled;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <FieldsSegmented
            options={[
              { id: "least_squares", label: "Guides" },
              { id: "visual_alignment", label: "Move on map" },
              { id: "auto_origin", label: "Auto" },
            ]}
            value={selectedUiMethod}
            onChange={selectAlignMethod}
          />
        </View>
        {refPoints.length > 0 && selectedUiMethod !== "auto_origin" ? (
          <Pressable onPress={resetAlignment} hitSlop={6}>
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 11, fontWeight: "800" }}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Auto Origin status (selected via dropdown) */}
      {selectedUiMethod === "auto_origin" && !missionRunning ? (
        <View
          style={{
            borderRadius: 12,
            borderWidth: 1,
            borderColor: autoOriginActive ? FIELDS_COLORS.successBorder : FIELDS_COLORS.panelBorder,
            backgroundColor: autoOriginActive
              ? "rgba(16, 185, 129, 0.08)"
              : FIELDS_COLORS.surfaceSolid,
            padding: 12,
          }}
        >
          <Text
            style={{
              color:
                stagedVerified || !autoOriginEnabled
                  ? FIELDS_COLORS.danger
                  : autoOriginReference
                  ? FIELDS_COLORS.success
                  : FIELDS_COLORS.textMuted,
              fontSize: 11,
              lineHeight: 15,
            }}
          >
            {stagedVerified
              ? "GPS alignment is already set."
              : !autoOriginEnabled
              ? "Clear the current alignment first."
              : autoOriginReference
              ? `Rover N ${autoOriginReference.roverNorth.toFixed(2)}, E ${autoOriginReference.roverEast.toFixed(2)}`
              : "Waiting for GPS…"}
          </Text>
        </View>
      ) : null}

      {/* Formal alignment controls — not shown while Auto Origin is selected */}
      {selectedUiMethod !== "auto_origin" ? (
      <View style={{ gap: 12 }}>
      {alignmentMethod !== "visual_alignment" &&
      !(alignmentMethod === "least_squares" && extractedCorners) ? (
        <View style={{ gap: 8 }}>
          <Pressable
            onPress={onToggleMovePlan}
            disabled={isFixing || missionRunning}
            style={{
              height: 40,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: isPlanEditingMode ? FIELDS_COLORS.success : FIELDS_COLORS.panelBorder,
              backgroundColor: isPlanEditingMode ? FIELDS_COLORS.successMuted : FIELDS_COLORS.surfaceSolid,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              opacity: isFixing || missionRunning ? 0.5 : 1,
            }}
          >
            {isPlanEditingMode ? (
              <Check color={FIELDS_COLORS.success} size={15} />
            ) : (
              <Move color={FIELDS_COLORS.textMain} size={15} />
            )}
            <Text
              style={{
                color: isPlanEditingMode ? FIELDS_COLORS.success : FIELDS_COLORS.textMain,
                fontSize: 13,
                fontWeight: "700",
              }}
            >
              {isPlanEditingMode
                ? alignmentMethod === "least_squares"
                  ? "Use this position"
                  : "Lock position"
                : "Move plan"}
            </Text>
          </Pressable>

          {alignmentMethod === "least_squares" && onFitToReferencePoints ? (
            <Pressable
              onPress={() => {
                const parsed = refPoints
                  .map((p) => ({
                    lat: parseFloat(String(p.lat).trim()),
                    lon: parseFloat(String(p.lon).trim()),
                  }))
                  .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
                onFitToReferencePoints(parsed);
              }}
              disabled={
                isFixing ||
                missionRunning ||
                refPoints.filter(
                  (p) =>
                    Number.isFinite(parseFloat(String(p.lat).trim())) &&
                    Number.isFinite(parseFloat(String(p.lon).trim()))
                ).length < 2
              }
              style={{
                height: 40,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.stepActive,
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                opacity:
                  isFixing ||
                  missionRunning ||
                  refPoints.filter(
                    (p) =>
                      Number.isFinite(parseFloat(String(p.lat).trim())) &&
                      Number.isFinite(parseFloat(String(p.lon).trim()))
                  ).length < 2
                    ? 0.45
                    : 1,
              }}
            >
              <Maximize2 color={FIELDS_COLORS.stepActive} size={15} />
              <Text style={{ color: FIELDS_COLORS.stepActive, fontSize: 13, fontWeight: "700" }}>
                Fit to guides
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {alignmentMethod === "least_squares" && !isPlanEditingMode && !extractedCorners ? (
        <View
          style={{
            gap: 10,
            padding: 12,
            borderRadius: 12,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderWidth: 1,
            borderColor: csvGuidePointsActive ? FIELDS_COLORS.guideCsvBorder : FIELDS_COLORS.panelBorder,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: FIELDS_COLORS.guideCsvMuted,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MapPin size={12} color={FIELDS_COLORS.guideCsv} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
                Guide points
              </Text>
            </View>
            {refPoints.length > 0 ? (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  backgroundColor: FIELDS_COLORS.guideCsvMuted,
                }}
              >
                <Text style={{ color: FIELDS_COLORS.guideCsv, fontSize: 11, fontWeight: "800" }}>
                  {refPoints.length}
                </Text>
              </View>
            ) : null}
          </View>

          {guideCsvFileNames.length > 0 ? (
            <View style={{ gap: 4 }}>
              {guideCsvFileNames.map((name, i) => (
                <Text
                  key={`${name}-${i}`}
                  numberOfLines={1}
                  style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "600" }}
                >
                  {name}
                </Text>
              ))}
            </View>
          ) : null}

          <Pressable
            onPress={handleUploadRefPointsCsv}
            disabled={isImportingCsv || isFixing || missionRunning}
            style={{
              height: 40,
              borderRadius: 10,
              backgroundColor: FIELDS_COLORS.guideCsvMuted,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.guideCsvBorder,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              opacity: isImportingCsv || isFixing || missionRunning ? 0.5 : 1,
            }}
          >
            {guideCsvFileNames.length === 0 ? (
              <Upload color={FIELDS_COLORS.guideCsv} size={15} />
            ) : (
              <Plus color={FIELDS_COLORS.guideCsv} size={15} />
            )}
            <Text style={{ color: FIELDS_COLORS.guideCsv, fontSize: 13, fontWeight: "800" }}>
              {isImportingCsv
                ? "Importing…"
                : guideCsvFileNames.length === 0
                  ? "Import CSV"
                  : "Add CSV"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {alignmentMethod === "visual_alignment" ? (
        <View style={{ gap: 12 }}>
          {extractedCorners ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Extracted Coordinates</Text>
              {extractedCorners.map((point, index) => (
                <View
                  key={index}
                  style={{
                    backgroundColor: FIELDS_COLORS.surfaceSolid,
                    padding: 8,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: FIELDS_COLORS.panelBorder,
                  }}
                >
                  <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "600" }}>Corner {index + 1}</Text>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontFamily: "monospace" }}>
                    Lat: {point.lat.toFixed(6)}
                  </Text>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontFamily: "monospace" }}>
                    Lon: {point.lon.toFixed(6)}
                  </Text>
                </View>
              ))}
              <Pressable
                onPress={handleFixAlignment}
                disabled={isFixing}
                style={{
                  height: 44,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor:
                    isFixing
                      ? FIELDS_COLORS.surfaceSolid
                      : FIELDS_COLORS.accentBrand,
                }}
              >
                <Text
                  style={{
                    color:
                      isFixing
                        ? FIELDS_COLORS.textDim
                        : FIELDS_COLORS.accentText,
                    fontSize: 14,
                    fontWeight: "800",
                  }}
                >
                  {isFixing ? "Fixing..." : "Fix Alignment"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setExtractedCorners?.(null);
                  setVisualAlignmentItem?.(null);
                  setAlignedRefPoints?.([]);
                }}
                style={{
                  marginTop: 4,
                  padding: 10,
                  alignItems: "center",
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderRadius: 6,
                }}
              >
                <Text style={{ color: FIELDS_COLORS.danger, fontSize: 13, fontWeight: "600" }}>Clear Alignment</Text>
              </Pressable>
            </View>
          ) : isVisualAlignmentMode ? (
            <View style={{ gap: 12 }}>
              <View style={{ backgroundColor: FIELDS_COLORS.surfaceSolid, padding: 10, borderRadius: 6 }}>
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontFamily: "monospace" }}>
                  Offset: {visualAlignmentItem?.x?.toFixed(2) ?? "0.00"}m, {visualAlignmentItem?.y?.toFixed(2) ?? "0.00"}m
                </Text>
                {mapLLA && (
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontFamily: "monospace", marginTop: 4 }}>
                    Lat: {mapLLA.lat.toFixed(6)} · Lon: {mapLLA.lon.toFixed(6)}
                  </Text>
                )}
              </View>
              <Pressable
                onPress={onConfirmVisualAlignment}
                style={{
                  height: 44,
                  backgroundColor: FIELDS_COLORS.success,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>Capture & Confirm</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {mapLLA && (
                <View style={{ backgroundColor: FIELDS_COLORS.surfaceSolid, padding: 8, borderRadius: 6 }}>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontFamily: "monospace" }}>
                    Lat {mapLLA.lat.toFixed(6)}  ·  Lon {mapLLA.lon.toFixed(6)}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={onStartVisualAlignment}
                style={{
                  height: 44,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.stepActive,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: FIELDS_COLORS.stepActive, fontSize: 14, fontWeight: "700" }}>Start Visual Alignment</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : alignmentMethod === "least_squares" && extractedCorners ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Captured Position</Text>
          {extractedCorners.map((point, index) => (
            <View
              key={index}
              style={{
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                padding: 8,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "600" }}>Corner {index + 1}</Text>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontFamily: "monospace" }}>
                Lat: {point.lat.toFixed(6)}
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontFamily: "monospace" }}>
                Lon: {point.lon.toFixed(6)}
              </Text>
            </View>
          ))}
          <Pressable
            onPress={handleFixAlignment}
            disabled={isFixing}
            style={{
              height: 44,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor:
                isFixing
                  ? FIELDS_COLORS.surfaceSolid
                  : FIELDS_COLORS.accentBrand,
            }}
          >
            <Text
              style={{
                color:
                  isFixing
                    ? FIELDS_COLORS.textDim
                    : FIELDS_COLORS.accentText,
                fontSize: 14,
                fontWeight: "800",
              }}
            >
              {isFixing ? "Fixing..." : "Fix Alignment"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setExtractedCorners?.(null);
              setVisualAlignmentItem?.(null);
            }}
            style={{
              marginTop: 4,
              padding: 10,
              alignItems: "center",
              backgroundColor: FIELDS_COLORS.surfaceSolid,
              borderRadius: 6,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 13, fontWeight: "600" }}>Clear & Reposition</Text>
          </Pressable>
          {alignmentResult ? (
            <View
              style={{
                marginTop: 4,
                padding: 12,
                backgroundColor: FIELDS_COLORS.successMuted,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.successBorder,
                gap: 4,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.success, fontWeight: "800", fontSize: 13 }}>Alignment Verified</Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Scale: {formatFinite(alignmentResult.scale, 6)}
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Rotation: {formatFinite(alignmentResult.rotation_deg, 3)} deg
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                RMSE: {formatFinite(alignmentResult.rmse_m, 3)}
              </Text>
              {Array.isArray(alignmentResult.warnings)
                ? (alignmentResult.warnings as unknown[]).map((w, wi) => (
                    <Text key={`align-warn-${wi}`} style={{ color: FIELDS_COLORS.warning, fontSize: 12 }}>
                      {String(w)}
                    </Text>
                  ))
                : null}
            </View>
          ) : null}
        </View>
      ) : isPlanEditingMode ? null : alignmentMethod !== "least_squares" ? null : refPoints.length === 0 ? null : (
        <View style={{ gap: 10 }}>
          <View style={{ gap: 8 }}>
            {refPoints.map((point, index) => {
              const latOk = Number.isFinite(parseFloat(point.lat));
              const lonOk = Number.isFinite(parseFloat(point.lon));
              const filled = latOk && lonOk;
              const isFocused = focusedGuidePointIndex === index;
              return (
                <Pressable
                  key={index}
                  onPress={() => onFocusedGuidePointIndexChange?.(index)}
                  style={{
                    backgroundColor: isFocused ? "rgba(249, 115, 22, 0.08)" : FIELDS_COLORS.surfaceSolid,
                    padding: 10,
                    borderRadius: 8,
                    borderWidth: isFocused ? 2 : 1,
                    borderColor: isFocused
                      ? "#f97316"
                      : filled
                        ? FIELDS_COLORS.successBorder
                        : FIELDS_COLORS.panelBorder,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
                    <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                      Point {index + 1}
                      {isFocused ? null : !csvGuidePointsActive ? (
                        <Text style={{ color: FIELDS_COLORS.textDim, fontWeight: "500" }}>
                          {`  ·  N ${Number(point.dxf_y).toFixed(2)}  E ${Number(point.dxf_x).toFixed(2)}`}
                        </Text>
                      ) : null}
                    </Text>
                    <Pressable
                      onPress={() => {
                        if (focusedGuidePointIndex === index) onFocusedGuidePointIndexChange?.(null);
                        handleRemoveRefPoint(index);
                      }}
                      hitSlop={8}
                    >
                      <X size={14} color={FIELDS_COLORS.danger} />
                    </Pressable>
                  </View>
                  {/* Lat/Lon always shown for tapped points; CSV rows already have coords but stay editable. */}
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TextInput
                      ref={(el) => {
                        latInputRefs.current[index] = el;
                      }}
                      style={{
                        flex: 1,
                        height: 40,
                        backgroundColor: FIELDS_COLORS.cardSolid,
                        borderWidth: 1,
                        borderColor: isFocused
                          ? "#f97316"
                          : latOk
                            ? FIELDS_COLORS.successBorder
                            : FIELDS_COLORS.panelBorder,
                        borderRadius: 6,
                        paddingHorizontal: 10,
                        fontSize: 13,
                        color: FIELDS_COLORS.textMain,
                      }}
                      placeholder="Latitude"
                      placeholderTextColor={FIELDS_COLORS.textDim}
                      value={point.lat}
                      onChangeText={(value) => handleUpdateRefPoint(index, "lat", value)}
                      onFocus={() => onFocusedGuidePointIndexChange?.(index)}
                      keyboardType="numeric"
                      editable={!isFixing && !missionRunning}
                    />
                    <TextInput
                      style={{
                        flex: 1,
                        height: 40,
                        backgroundColor: FIELDS_COLORS.cardSolid,
                        borderWidth: 1,
                        borderColor: isFocused
                          ? "#f97316"
                          : lonOk
                            ? FIELDS_COLORS.successBorder
                            : FIELDS_COLORS.panelBorder,
                        borderRadius: 6,
                        paddingHorizontal: 10,
                        fontSize: 13,
                        color: FIELDS_COLORS.textMain,
                      }}
                      placeholder="Longitude"
                      placeholderTextColor={FIELDS_COLORS.textDim}
                      value={point.lon}
                      onChangeText={(value) => handleUpdateRefPoint(index, "lon", value)}
                      onFocus={() => onFocusedGuidePointIndexChange?.(index)}
                      keyboardType="numeric"
                      editable={!isFixing && !missionRunning}
                    />
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* Fix Alignment for tapped + typed control points (not CSV-only visual guide). */}
          {!csvGuidePointsActive ? (
            <View style={{ gap: 6 }}>
              <Pressable
                onPress={handleFixAlignment}
                disabled={
                  isFixing ||
                                    !canFixFromTypedRefs ||
                  missionRunning
                }
                style={{
                  height: 46,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor:
                    isFixing ||
                                        !canFixFromTypedRefs ||
                    missionRunning
                      ? FIELDS_COLORS.surfaceSolid
                      : FIELDS_COLORS.accentBrand,
                }}
              >
                <Text
                  style={{
                    color:
                      isFixing ||
                                            !canFixFromTypedRefs ||
                      missionRunning
                        ? FIELDS_COLORS.textDim
                        : FIELDS_COLORS.accentText,
                    fontSize: 14,
                    fontWeight: "800",
                  }}
                >
                  {isFixing
                    ? "Fixing..."
                    : canFixFromTypedRefs
                    ? "Fix Alignment"
                    : "Need lat / lon"}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {alignmentResult && !extractedCorners ? (
            <View
              style={{
                padding: 12,
                backgroundColor: FIELDS_COLORS.successMuted,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.successBorder,
                gap: 4,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.success, fontWeight: "800", fontSize: 13 }}>Alignment Verified</Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Scale: {formatFinite(alignmentResult.scale, 6)}
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Rotation: {formatFinite(alignmentResult.rotation_deg, 3)} deg
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                RMSE: {formatFinite(alignmentResult.rmse_m, 3)}
              </Text>
              {Array.isArray(alignmentResult.warnings)
                ? (alignmentResult.warnings as unknown[]).map((w, wi) => (
                    <Text key={`align-warn-${wi}`} style={{ color: FIELDS_COLORS.warning, fontSize: 12 }}>
                      {String(w)}
                    </Text>
                  ))
                : null}
            </View>
          ) : null}
        </View>
      )}
      </View>
      ) : null}
    </View>
  );
}