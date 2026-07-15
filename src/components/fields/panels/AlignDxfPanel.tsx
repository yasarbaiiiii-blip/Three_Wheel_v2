import React, { useState } from "react";
import { Alert, Platform, Pressable, Text, TextInput, View } from "react-native";
import { Check, Move, Upload, X } from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";

import * as pathApi from "../../../api/pathApi";
import { enforceAlignmentScale } from "../../../utils/designAlignmentPolicy";
import {
  coerceFiniteNumber,
  formatFinite,
  sanitizePlanLines,
} from "../../../utils/pathWorkflow";
import type { AlignmentResultState, StagedWorkflowStatus } from "../../../types/fieldsWorkflow";
import type { PlanLine } from "../../../types/plan";
import type { AutoOriginReference } from "../../../types/autoOrigin";
import type { PlacedItem } from "../../BoundaryEditor";
import { FIELDS_COLORS } from "../fieldsTheme";

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

type ParsedCsvRefPoint = { dxf_x: number; dxf_y: number; latRaw: string; lonRaw: string };

const CSV_COLUMN_ALIASES: Record<"dxf_x" | "dxf_y" | "lat" | "lon", string[]> = {
  dxf_x: ["dxf_x", "x", "east", "easting"],
  dxf_y: ["dxf_y", "y", "north", "northing"],
  lat: ["lat", "latitude"],
  lon: ["lon", "lng", "long", "longitude"],
};

/** Splits one CSV line into trimmed cells, honoring double-quoted values. */
function splitCsvCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Parses a reference-point CSV: a header row with dxf_x/x/east, dxf_y/y/north, lat, lon
 * columns (any order, case-insensitive), or — with no recognizable header — 4 bare numeric
 * columns in that exact order (dxf_x, dxf_y, lat, lon).
 */
function parseRefPointsCsv(text: string): { points: ParsedCsvRefPoint[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  if (lines.length === 0) return { points: [], errors: ["The file is empty."] };

  const headerCells = splitCsvCells(lines[0]).map((cell) => cell.toLowerCase());
  const colIndex: Partial<Record<"dxf_x" | "dxf_y" | "lat" | "lon", number>> = {};
  (Object.keys(CSV_COLUMN_ALIASES) as (keyof typeof CSV_COLUMN_ALIASES)[]).forEach((key) => {
    const idx = headerCells.findIndex((cell) => CSV_COLUMN_ALIASES[key].includes(cell));
    if (idx >= 0) colIndex[key] = idx;
  });

  const hasFullHeader =
    colIndex.dxf_x != null && colIndex.dxf_y != null && colIndex.lat != null && colIndex.lon != null;

  let dataLines: string[];
  if (hasFullHeader) {
    dataLines = lines.slice(1);
  } else {
    colIndex.dxf_x = 0;
    colIndex.dxf_y = 1;
    colIndex.lat = 2;
    colIndex.lon = 3;
    const firstRowIsNumeric =
      headerCells.length >= 4 && headerCells.slice(0, 4).every((cell) => cell !== "" && Number.isFinite(Number(cell)));
    if (!firstRowIsNumeric && lines.length < 2) {
      return {
        points: [],
        errors: ["Could not find dxf_x/x, dxf_y/y, lat, and lon columns. Expected a header row like: dxf_x,dxf_y,lat,lon"],
      };
    }
    dataLines = firstRowIsNumeric ? lines : lines.slice(1);
  }

  const points: ParsedCsvRefPoint[] = [];
  dataLines.forEach((line, i) => {
    const cells = splitCsvCells(line);
    if (cells.every((cell) => cell === "")) return;
    const rowNum = i + (dataLines.length === lines.length ? 1 : 2);

    const rawDxfX = cells[colIndex.dxf_x!] ?? "";
    const rawDxfY = cells[colIndex.dxf_y!] ?? "";
    const rawLat = cells[colIndex.lat!] ?? "";
    const rawLon = cells[colIndex.lon!] ?? "";
    if ([rawDxfX, rawDxfY, rawLat, rawLon].some((v) => v === "")) {
      errors.push(`Row ${rowNum}: missing a coordinate value.`);
      return;
    }

    const dxfX = Number(rawDxfX);
    const dxfY = Number(rawDxfY);
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (![dxfX, dxfY, lat, lon].every((v) => Number.isFinite(v))) {
      errors.push(`Row ${rowNum}: could not parse numeric coordinates.`);
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`Row ${rowNum}: latitude/longitude out of range.`);
      return;
    }

    points.push({ dxf_x: dxfX, dxf_y: dxfY, latRaw: rawLat, lonRaw: rawLon });
  });

  return { points, errors };
}

type DxfBounds = { minNorth: number; maxNorth: number; minEast: number; maxEast: number };

/** Bounding box of the currently-loaded DXF's OWN drawing coordinates (PlanLine.x=north, .y=east). */
function computeDxfBounds(lines: PlanLine[]): DxfBounds | null {
  if (lines.length === 0) return null;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  let minEast = Infinity;
  let maxEast = -Infinity;
  for (const line of lines) {
    for (const pt of [line.from, line.to]) {
      if (pt.x < minNorth) minNorth = pt.x;
      if (pt.x > maxNorth) maxNorth = pt.x;
      if (pt.y < minEast) minEast = pt.y;
      if (pt.y > maxEast) maxEast = pt.y;
    }
  }
  if (!Number.isFinite(minNorth) || !Number.isFinite(minEast)) return null;
  return { minNorth, maxNorth, minEast, maxEast };
}

/**
 * A ref point's dxf_x/dxf_y must be expressed in the SAME coordinate system as the loaded
 * DXF's own lines — least-squares alignment fits a similarity transform between these
 * numbers and lat/lon, then reapplies that exact transform to the drawing's real coordinates.
 * If a point is wildly outside the drawing's own coordinate range (a common real-world
 * case: a raw RTK/GNSS survey export's Easting/Northing are in a project-specific grid CRS
 * with a large false easting/northing, e.g. hundreds of thousands to millions — completely
 * unrelated to a small CAD drawing's local origin), the fit still "succeeds" numerically but
 * reapplying it to the drawing's tiny native coordinates lands the whole plan thousands of
 * kilometres away. Margin is generous (20x the drawing's own span, floor of 200 units) so
 * legitimate large-scale/state-plane-native DXFs and ref points a reasonable distance outside
 * the drawn shape (survey control points, corner markers) aren't falsely flagged.
 */
function pointMatchesDxfScale(point: { dxf_x: number; dxf_y: number }, bounds: DxfBounds): boolean {
  const spanNorth = bounds.maxNorth - bounds.minNorth;
  const spanEast = bounds.maxEast - bounds.minEast;
  const margin = Math.max(spanNorth, spanEast, 10) * 20 + 200;
  const centerNorth = (bounds.minNorth + bounds.maxNorth) / 2;
  const centerEast = (bounds.minEast + bounds.maxEast) / 2;
  return Math.abs(point.dxf_y - centerNorth) <= margin && Math.abs(point.dxf_x - centerEast) <= margin;
}

type AlignDxfPanelProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  lines: PlanLine[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApi.AlignPathRequest | null>>;
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  onWorkflowStep?: (step: "alignment", status: StagedWorkflowStatus) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  refPoints: RefPoint[];
  setRefPoints: React.Dispatch<React.SetStateAction<RefPoint[]>>;
  alignmentMethod: "least_squares" | "single_point" | "visual_alignment";
  setAlignmentMethod: React.Dispatch<React.SetStateAction<"least_squares" | "single_point" | "visual_alignment">>;
  setMissionSummary: React.Dispatch<React.SetStateAction<any>>;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
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
  /** True while the whole plan is a draggable/scalable/rotatable "sticker" on the map (tap-to-pick-point is disabled meanwhile). */
  isPlanEditingMode?: boolean;
  /** Enters plan editing (drag/scale/rotate) when off, or bakes the transform back into `lines` and returns to point-picking when on. */
  onToggleMovePlan?: () => void;
};

export function AlignDxfPanel({
  apiBaseUrl,
  selectedPathName,
  lines,
  setLines,
  alignmentResult,
  setAlignmentResult,
  setVerifiedAlignmentRequest,
  setAlignedRefPoints,
  onWorkflowStep,
  onInvalidateWorkflow,
  blockProtectedWorkflowMutation,
  refPoints,
  setRefPoints,
  alignmentMethod,
  setAlignmentMethod,
  setMissionSummary,
  isVisualAlignmentMode,
  visualAlignmentItem,
  setVisualAlignmentItem,
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
}: AlignDxfPanelProps) {
  const [rotationDeg, setRotationDeg] = useState("");
  const [isFixing, setIsFixing] = useState(false);
  const [isImportingCsv, setIsImportingCsv] = useState(false);

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
    setVerifiedAlignmentRequest(null);
    setRefPoints((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUploadRefPointsCsv = async () => {
    if (blockProtectedWorkflowMutation("Importing alignment points")) return;

    let asset: DocumentPicker.DocumentPickerAsset | null = null;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["*/*"], copyToCacheDirectory: true });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      asset = result.assets[0];
    } catch (err) {
      console.log("Error picking ref-point CSV:", err);
      Alert.alert("Error", "Could not open the file picker.");
      return;
    }

    const ext = asset.name.split(".").pop()?.toLowerCase();
    if (ext !== "csv") {
      Alert.alert("Invalid File", "Please select a .csv file.");
      return;
    }

    setIsImportingCsv(true);
    try {
      let text: string;
      if (Platform.OS === "web") {
        const webFile = (asset as any).file ?? (await (await fetch(asset.uri)).blob());
        text = await webFile.text();
      } else {
        text = await (await fetch(asset.uri)).text();
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      console.log(`[AlignDXF][CSV] Raw file "${asset.name}" (first 300 chars):\n${text.slice(0, 300)}`);

      const { points, errors } = parseRefPointsCsv(text);
      console.log(`[AlignDXF][CSV] Parsed ${points.length} point(s), ${errors.length} error(s).`);
      points.forEach((p, i) =>
        console.log(
          `[AlignDXF][CSV] Point ${i + 1}: dxf_x(east)=${p.dxf_x} dxf_y(north)=${p.dxf_y} lat="${p.latRaw}" lon="${p.lonRaw}"`
        )
      );
      if (errors.length > 0) console.log("[AlignDXF][CSV] Errors:", errors);
      if (points.length === 0) {
        Alert.alert("Import Failed", errors[0] ?? "No valid coordinate rows were found in the file.");
        return;
      }

      const dxfBounds = computeDxfBounds(lines);
      const scaleMismatch = dxfBounds != null && points.every((p) => !pointMatchesDxfScale(p, dxfBounds));
      console.log(
        `[AlignDXF][CSV] dxfBounds=${JSON.stringify(dxfBounds)} scaleMismatch=${scaleMismatch}`
      );

      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);

      if (scaleMismatch) {
        // The file's coordinate columns don't match this drawing's own coordinate range — a
        // common real case: a raw RTK/GNSS survey export's Easting/Northing are in a
        // project-specific grid CRS (often with a large false easting/northing), completely
        // unrelated to a CAD drawing's local origin. Importing them as dxf_x/dxf_y would
        // silently compute a similarity transform for the wrong coordinate system and, when
        // reapplied to the drawing, place the whole plan thousands of km away. Only the
        // file's lat/lon are trustworthy here — fill them into already-tapped points (which
        // DO carry correct drawing-native coordinates), matched in order.
        let filled = 0;
        setRefPoints((prev) => {
          const blankIdx = prev
            .map((_, i) => i)
            .filter((i) => prev[i].lat.trim() === "" && prev[i].lon.trim() === "");
          filled = Math.min(blankIdx.length, points.length);
          if (filled === 0) return prev;
          const next = [...prev];
          for (let k = 0; k < filled; k++) {
            next[blankIdx[k]] = { ...next[blankIdx[k]], lat: points[k].latRaw, lon: points[k].lonRaw };
          }
          return next;
        });
        console.log(`[AlignDXF][CSV] Scale mismatch: filled lat/lon for ${filled} of ${points.length} row(s).`);

        if (filled === 0) {
          Alert.alert(
            "Coordinates Don't Match This Drawing",
            `This file's coordinates (e.g. ${points[0].dxf_x.toFixed(1)}, ${points[0].dxf_y.toFixed(1)}) look like real-world survey coordinates, not this drawing's own local coordinates — importing them directly would misalign the plan by a huge distance.\n\nTap ${points.length} point(s) on the drawing that correspond to this file's rows (in order), then upload the CSV again — only its Latitude/Longitude will be used to fill them in.`
          );
        } else {
          const remaining = points.length - filled;
          Alert.alert(
            "Partially Imported",
            `Filled in Latitude/Longitude for ${filled} tapped point(s) from the file.${
              remaining > 0
                ? ` ${remaining} row(s) left over — tap ${remaining} more point(s) on the drawing and upload again to fill those in too.`
                : ""
            }`
          );
        }
        return;
      }

      setRefPoints((prev) => {
        const merged = [...prev];
        points.forEach((p) => {
          const idx = merged.findIndex(
            (existing) => Math.abs(existing.dxf_x - p.dxf_x) < 0.001 && Math.abs(existing.dxf_y - p.dxf_y) < 0.001
          );
          const entry: RefPoint = { dxf_x: p.dxf_x, dxf_y: p.dxf_y, lat: p.latRaw, lon: p.lonRaw };
          if (idx >= 0) merged[idx] = entry;
          else merged.push(entry);
        });
        console.log("[AlignDXF][CSV] refPoints after merge:", JSON.stringify(merged));
        return merged;
      });

      if (errors.length > 0) {
        Alert.alert(
          "Imported With Warnings",
          `${points.length} point(s) imported. ${errors.length} row(s) skipped:\n${errors.slice(0, 5).join("\n")}${
            errors.length > 5 ? `\n…and ${errors.length - 5} more` : ""
          }`
        );
      } else {
        Alert.alert("Import Successful", `${points.length} point(s) imported from CSV.`);
      }
    } catch (err) {
      console.log("Error importing ref-point CSV:", err);
      Alert.alert("Error", "Could not read or parse the selected CSV file.");
    } finally {
      setIsImportingCsv(false);
    }
  };

  const handleFixAlignment = async () => {
    console.log(
      `[AlignDXF][Fix] Clicked. method=${alignmentMethod} selectedPathName=${selectedPathName} refPoints=`,
      JSON.stringify(refPoints)
    );
    if (blockProtectedWorkflowMutation("Changing GPS alignment")) return;
    if (
      !selectedPathName ||
      !apiBaseUrl ||
      (alignmentMethod !== "visual_alignment" && refPoints.length === 0) ||
      (alignmentMethod === "visual_alignment" && !extractedCorners)
    ) {
      console.log("[AlignDXF][Fix] Aborted: missing path/apiBaseUrl/points guard.");
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      return;
    }

    setIsFixing(true);
    try {
      let validPoints: { dxf_x: number; dxf_y: number; lat: number; lon: number }[] = [];

      if (alignmentMethod === "visual_alignment") {
        validPoints = extractedCorners!.map((point) => ({
          dxf_x: point.dxf_x,
          dxf_y: point.dxf_y,
          lat: point.lat,
          lon: point.lon,
        }));
      } else {
        validPoints = refPoints
          .filter((point) => point.lat.trim() !== "" && point.lon.trim() !== "")
          .map((point) => ({
            dxf_x: point.dxf_x,
            dxf_y: point.dxf_y,
            lat: parseFloat(point.lat),
            lon: parseFloat(point.lon),
          }));

        if (alignmentMethod === "least_squares" && validPoints.length < 2) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please select at least 2 points and enter their WGS84 coordinates.");
          setIsFixing(false);
          return;
        }
        if (alignmentMethod === "single_point" && validPoints.length === 0) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please select a point and enter its coordinates.");
          setIsFixing(false);
          return;
        }

        // Defense-in-depth: even if a mismatched point slipped through (typed in by hand,
        // or from some other path than the CSV importer above), never send a fit whose
        // input coordinates don't match this drawing's own scale — that computes a transform
        // for the wrong coordinate system and, reapplied to the drawing, can misplace the
        // whole plan by thousands of kilometres. This is a physical spraying rover; a wrong
        // alignment is a safety issue, not just a display glitch, so this blocks outright.
        const dxfBoundsForFix = computeDxfBounds(lines);
        if (dxfBoundsForFix && !validPoints.every((p) => pointMatchesDxfScale(p, dxfBoundsForFix))) {
          console.log(
            `[AlignDXF][Fix] BLOCKED: ref point coordinates don't match drawing bounds`,
            JSON.stringify(dxfBoundsForFix)
          );
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert(
            "Coordinates Don't Match This Drawing",
            "One or more reference points' drawing coordinates are far outside this DXF's own coordinate range. This usually means a raw survey file's Easting/Northing got used directly instead of the drawing's own local coordinates — sending this would misalign the plan by a huge distance. Re-check the points below, or re-import matching them to tapped points instead."
          );
          setIsFixing(false);
          return;
        }
      }

      console.log("[AlignDXF][Fix] validPoints (dxf_x=east, dxf_y=north):", JSON.stringify(validPoints));

      const payload: pathApi.AlignPathRequest = { ref_points: validPoints };
      if (alignmentMethod === "single_point") {
        const rot = parseFloat(rotationDeg);
        if (isNaN(rot)) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please enter a valid Heading (Degrees).");
          setIsFixing(false);
          return;
        }
        payload.rotation_deg = rot;
      }

      console.log(`[AlignDXF][Fix] POST /api/path/${selectedPathName}/align payload:`, JSON.stringify(payload));

      const res = await pathApi.alignPath(apiBaseUrl, selectedPathName, payload);
      console.log(`[AlignDXF][Fix] Response status: ${res.status} ok=${res.ok}`);
      if (res.ok) {
        const data = await res.json();
        console.log("[AlignDXF][Fix] Response body:", JSON.stringify(data));
        if (data.mission_summary) {
          setMissionSummary(data.mission_summary);
          if (data.merged_waypoints) {
            const alignedLines: PlanLine[] = [];
            const pts = Array.isArray(data.merged_waypoints) ? data.merged_waypoints : [];
            const sprayFlags = Array.isArray(data.spray_flags) ? data.spray_flags : [];
            for (let i = 0; i < pts.length - 1; i++) {
              const sprayFlag = sprayFlags[i] ?? true;
              const fromNorth = coerceFiniteNumber(pts[i]?.[0]);
              const fromEast = coerceFiniteNumber(pts[i]?.[1]);
              const toNorth = coerceFiniteNumber(pts[i + 1]?.[0]);
              const toEast = coerceFiniteNumber(pts[i + 1]?.[1]);
              if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) continue;
              alignedLines.push({
                id: `aligned-line-${i}`,
                label: `Segment ${i + 1}`,
                layer: sprayFlag ? "marking" : "center",
                from: { id: i * 2 + 1, x: fromNorth, y: fromEast },
                to: { id: i * 2 + 2, x: toNorth, y: toEast },
                width: 0.1,
              });
            }
            setLines(sanitizePlanLines(alignedLines));
          }
          Alert.alert("Success", "Alignment applied. Mission is ready to be loaded!");
        } else {
          setMissionSummary(null);
          setVerifiedAlignmentRequest({ ...payload });
          setAlignmentResult({
            method: data.method ?? null,
            scale: enforceAlignmentScale(coerceFiniteNumber(data.scale) ?? 1.0),
            rotation_deg: coerceFiniteNumber(data.rotation_deg),
            offset_n: coerceFiniteNumber(data.offset_n),
            offset_e: coerceFiniteNumber(data.offset_e),
            origin_gps: data.origin_gps ?? null,
            rmse_m: coerceFiniteNumber(data.rmse_m),
            sample_coords: data.sample_coords ?? null,
            residuals: data.residuals ?? null,
            warnings: data.warnings ?? null,
          });
          onWorkflowStep?.("alignment", "verified");

          const rotDeg = coerceFiniteNumber(data.rotation_deg);
          const offsetE = coerceFiniteNumber(data.offset_e);
          const offsetN = coerceFiniteNumber(data.offset_n);
          const alignScale = coerceFiniteNumber(data.scale) ?? 1;
          console.log(
            `[AlignDXF][Fix] Transform params: rotDeg=${rotDeg} offsetN=${offsetN} offsetE=${offsetE} scale=${alignScale} data.origin_gps=${JSON.stringify(data.origin_gps)} merged_waypoints=${!!data.merged_waypoints}`
          );
          if (rotDeg != null && offsetE != null && offsetN != null && !data.merged_waypoints) {
            const rotRad = (rotDeg * Math.PI) / 180;
            const cos = Math.cos(rotRad);
            const sin = Math.sin(rotRad);
            // Mirror the backend's affine transform exactly: NED = scale * R(theta) * DXF + offset
            // (see path_engine/ned.py apply_affine_transform / dxf_to_ned_affine).
            // pt.x/pt.y follow the SAME dxf_x=east / dxf_y=north contract used when ref_points
            // were sent to the backend (see handleSelectPoint in FieldsPage.tsx and
            // buildVisualAlignmentRefPoints in visualAlignment.ts, and the documented contract
            // in visualAlignment.ts's header) — pt.x is dxf_x (east), pt.y is dxf_y (north).
            // Output is {x: north, y: east}: offsetN pairs with the north output, offsetE with
            // east, matching PlanLine's own x=north/y=east convention.
            const applyOriginTransform = (pt: { x: number; y: number }) => {
              const sx = pt.x * alignScale;
              const sy = pt.y * alignScale;
              return {
                x: sx * cos - sy * sin + offsetN,
                y: sx * sin + sy * cos + offsetE,
              };
            };
            setLines((prev) => {
              console.log(`[AlignDXF][Fix] Transforming ${prev.length} line(s). Before -> After (north,east):`);
              const next = prev.map((line) => {
                const transformedFrom = applyOriginTransform({ x: line.from.y, y: line.from.x });
                const transformedTo = applyOriginTransform({ x: line.to.y, y: line.to.x });
                let updatedEntity = line.entity;
                if (updatedEntity?.preview_points) {
                  updatedEntity = {
                    ...updatedEntity,
                    preview_points: updatedEntity.preview_points.map((pt: { north: number; east: number }) => {
                      const transformed = applyOriginTransform({ x: pt.east, y: pt.north });
                      return { ...pt, north: transformed.x, east: transformed.y };
                    }),
                  };
                }
                console.log(
                  `[AlignDXF][Fix]   ${line.id}: from (${line.from.x},${line.from.y}) -> (${transformedFrom.x.toFixed(3)},${transformedFrom.y.toFixed(3)}) | to (${line.to.x},${line.to.y}) -> (${transformedTo.x.toFixed(3)},${transformedTo.y.toFixed(3)})`
                );
                return {
                  ...line,
                  from: { ...line.from, x: transformedFrom.x, y: transformedFrom.y },
                  to: { ...line.to, x: transformedTo.x, y: transformedTo.y },
                  ...(updatedEntity ? { entity: updatedEntity } : {}),
                };
              });
              return next;
            });
          }
          Alert.alert("Success", "Alignment verified.");
        }

        if (setAlignedRefPoints) {
          // `lines` is now in local NED metres relative to `data.origin_gps` (either
          // rebuilt from merged_waypoints, or rotated/scaled/translated above via
          // applyOriginTransform) — NOT the raw pre-alignment DXF pick coordinates.
          // The projection origin must match that frame: local (0,0) anchored at
          // origin_gps, same convention as anchorToAlignedRefPoints() in
          // stagedMissionHydration.ts for reloaded/staged alignments.
          const originGps = Array.isArray(data.origin_gps) ? data.origin_gps : null;
          const originLat = originGps ? coerceFiniteNumber(originGps[0]) : null;
          const originLon = originGps ? coerceFiniteNumber(originGps[1]) : null;
          console.log(
            `[AlignDXF][Fix] origin_gps raw=${JSON.stringify(data.origin_gps)} -> parsed originLat=${originLat} originLon=${originLon}`
          );
          if (originLat != null && originLon != null) {
            console.log(`[AlignDXF][Fix] setAlignedRefPoints -> [{dxf_x:0, dxf_y:0, lat:${originLat}, lon:${originLon}}]`);
            setAlignedRefPoints([{ dxf_x: 0, dxf_y: 0, lat: originLat, lon: originLon }]);
          } else {
            const fallbackAligned = validPoints.map((point) => ({
              dxf_x: point.dxf_x,
              dxf_y: point.dxf_y,
              lat: point.lat,
              lon: point.lon,
            }));
            console.log("[AlignDXF][Fix] origin_gps missing/invalid, setAlignedRefPoints -> validPoints:", JSON.stringify(fallbackAligned));
            setAlignedRefPoints(fallbackAligned);
          }
        }
        setRefPoints([]);
        setExtractedCorners?.(null);
        setVisualAlignmentItem?.(null);
      } else {
        onWorkflowStep?.("alignment", "failed");
        setVerifiedAlignmentRequest(null);
        const errText = await res.text();
        console.log(`[AlignDXF][Fix] Backend rejected alignment (status ${res.status}):`, errText);
        Alert.alert("Alignment Failed", errText || "Unknown error occurred.");
      }
    } catch (err) {
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      console.log("[AlignDXF][Fix] Error aligning path:", err);
      Alert.alert("Error", "Could not connect to the rover to apply alignment.");
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
    setExtractedCorners?.(null);
    setVisualAlignmentItem?.(null);
  };

  // True once Auto Origin is both requested and actually eligible (no verified/staged alignment blocking it).
  const autoOriginActive = autoOrigin && autoOriginEnabled;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17, flex: 1 }}>
          Tap points on the map to set alignment references.
        </Text>
        {refPoints.length > 0 ? (
          <Pressable onPress={resetAlignment}>
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 11, fontWeight: "700" }}>Clear Points</Text>
          </Pressable>
        ) : null}
      </View>

      {!missionRunning ? (
        <View
          style={{
            borderRadius: 10,
            borderWidth: 1,
            borderColor: autoOrigin ? "#10b981" : FIELDS_COLORS.panelBorder,
            backgroundColor: autoOrigin ? "rgba(16, 185, 129, 0.08)" : FIELDS_COLORS.surfaceSolid,
            padding: 10,
            gap: 8,
          }}
        >
          <Pressable
            onPress={onToggleAutoOrigin}
            accessibilityLabel="Auto Origin Checkbox"
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                borderWidth: 1.5,
                borderColor: autoOrigin ? "#10b981" : FIELDS_COLORS.panelBorder,
                backgroundColor: autoOrigin ? "rgba(16, 185, 129, 0.15)" : FIELDS_COLORS.cardSolid,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {autoOrigin ? <Check color="#10b981" size={14} strokeWidth={3} /> : null}
            </View>
            <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>
              Auto Origin — skip GPS alignment, start from rover's current position
            </Text>
          </Pressable>

          {autoOrigin ? (
            <Text
              style={{
                color: stagedVerified || !autoOriginEnabled
                  ? FIELDS_COLORS.danger
                  : autoOriginReference
                  ? FIELDS_COLORS.success
                  : FIELDS_COLORS.textMuted,
                fontSize: 11,
                lineHeight: 15,
              }}
            >
              {stagedVerified
                ? "A verified GPS alignment is active — Auto Origin will have no effect until that alignment is cleared."
                : !autoOriginEnabled
                ? "Auto Origin is blocked by an existing alignment. Clear the ref points below to use it."
                : autoOriginReference
                ? `Captured — plan will start at the rover's current position (N ${autoOriginReference.roverNorth.toFixed(2)}, E ${autoOriginReference.roverEast.toFixed(2)}).`
                : "Waiting for a valid GPS fix and position from the rover..."}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        style={{ gap: 12, opacity: autoOriginActive ? 0.4 : 1 }}
        pointerEvents={autoOriginActive ? "none" : "auto"}
      >
      <View style={{ flexDirection: "row", backgroundColor: FIELDS_COLORS.surfaceSolid, borderRadius: 8, padding: 4 }}>
        {([
          { id: "least_squares" as const, label: "Multi-Point Fit" },
          { id: "single_point" as const, label: "1-Point + Angle" },
          { id: "visual_alignment" as const, label: "Visual" },
        ]).map((method) => (
          <Pressable
            key={method.id}
            onPress={() => {
              onInvalidateWorkflow("alignment");
              setAlignmentMethod(method.id);
              setRefPoints([]);
              setMissionSummary(null);
              setAlignmentResult(null);
              setVerifiedAlignmentRequest(null);
              setExtractedCorners?.(null);
              setVisualAlignmentItem?.(null);
            }}
            style={{
              flex: 1,
              paddingVertical: 8,
              alignItems: "center",
              borderRadius: 6,
              backgroundColor: alignmentMethod === method.id ? FIELDS_COLORS.cardSolid : "transparent",
            }}
          >
            <Text
              style={{
                color: alignmentMethod === method.id ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted,
                fontSize: 11,
                fontWeight: "700",
              }}
            >
              {method.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {alignmentMethod !== "visual_alignment" ? (
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
            {isPlanEditingMode ? "Done — Lock Plan Position" : "Move / Scale / Rotate Plan"}
          </Text>
        </Pressable>
      ) : null}

      {isPlanEditingMode ? (
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontStyle: "italic" }}>
          {refPoints.length > 0
            ? "Drag, pinch, or twist the plan on the map. Your reference points move with it, so they stay valid — tap-to-pick-point is paused until you lock it in."
            : "Drag, pinch, or twist the plan into position on the map. Tap-to-pick-point is paused until you lock it in."}
        </Text>
      ) : null}

      {alignmentMethod === "least_squares" && !isPlanEditingMode ? (
        <Pressable
          onPress={handleUploadRefPointsCsv}
          disabled={isImportingCsv || isFixing || missionRunning}
          style={{
            height: 40,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: FIELDS_COLORS.stepActive,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: isImportingCsv || isFixing || missionRunning ? 0.5 : 1,
          }}
        >
          <Upload color={FIELDS_COLORS.stepActive} size={15} />
          <Text style={{ color: FIELDS_COLORS.stepActive, fontSize: 13, fontWeight: "700" }}>
            {isImportingCsv ? "Importing CSV..." : "Upload Points CSV"}
          </Text>
        </Pressable>
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
                disabled={isFixing || !selectedPathName}
                style={{
                  height: 44,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: isFixing || !selectedPathName ? FIELDS_COLORS.textDim : FIELDS_COLORS.warning,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
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
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12 }}>
                Coordinates are captured from the plan's current map position.
              </Text>
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
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12 }}>
                Position the plan on the map, then capture its LLA coordinates.
              </Text>
              {mapLLA && (
                <View style={{ backgroundColor: FIELDS_COLORS.surfaceSolid, padding: 8, borderRadius: 6 }}>
                  <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontFamily: "monospace" }}>
                    Current Map LLA — Lat: {mapLLA.lat.toFixed(6)} · Lon: {mapLLA.lon.toFixed(6)}
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
      ) : isPlanEditingMode ? null : refPoints.length === 0 ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 12, fontStyle: "italic", textAlign: "center" }}>
          {alignmentMethod === "least_squares"
            ? "Tap points on the canvas to set alignment references (2 minimum), or upload a CSV with this drawing's own coordinates. If your file has real-world survey Easting/Northing instead, tap the matching points first — the CSV will fill in their Latitude/Longitude."
            : "Tap 1 point on the canvas to set anchor."}
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          {alignmentMethod === "least_squares" ? (
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
              {refPoints.length} point{refPoints.length === 1 ? "" : "s"} selected
              {refPoints.length < 2 ? " — at least 2 required." : "."}
            </Text>
          ) : null}
          <View style={{ gap: 8 }}>
            {refPoints.map((point, index) => (
              <View
                key={index}
                style={{
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
                  <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
                    Point {index + 1}{" "}
                    <Text style={{ fontWeight: "400", color: FIELDS_COLORS.textMuted }}>
                      (X: {point.dxf_x.toFixed(2)}, Y: {point.dxf_y.toFixed(2)})
                    </Text>
                  </Text>
                  <Pressable onPress={() => handleRemoveRefPoint(index)} hitSlop={8}>
                    <X size={14} color={FIELDS_COLORS.danger} />
                  </Pressable>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    style={{
                      flex: 1,
                      height: 36,
                      backgroundColor: FIELDS_COLORS.cardSolid,
                      borderWidth: 1,
                      borderColor: FIELDS_COLORS.panelBorder,
                      borderRadius: 6,
                      paddingHorizontal: 10,
                      fontSize: 13,
                      color: FIELDS_COLORS.textMain,
                    }}
                    placeholder="Latitude"
                    placeholderTextColor={FIELDS_COLORS.textDim}
                    value={point.lat}
                    onChangeText={(value) => handleUpdateRefPoint(index, "lat", value)}
                    keyboardType="numeric"
                  />
                  <TextInput
                    style={{
                      flex: 1,
                      height: 36,
                      backgroundColor: FIELDS_COLORS.cardSolid,
                      borderWidth: 1,
                      borderColor: FIELDS_COLORS.panelBorder,
                      borderRadius: 6,
                      paddingHorizontal: 10,
                      fontSize: 13,
                      color: FIELDS_COLORS.textMain,
                    }}
                    placeholder="Longitude"
                    placeholderTextColor={FIELDS_COLORS.textDim}
                    value={point.lon}
                    onChangeText={(value) => handleUpdateRefPoint(index, "lon", value)}
                    keyboardType="numeric"
                  />
                </View>
              </View>
            ))}
          </View>

          {alignmentMethod === "single_point" && refPoints.length === 1 ? (
            <View
              style={{
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700", marginBottom: 6 }}>
                Heading Angle
              </Text>
              <TextInput
                style={{
                  height: 36,
                  backgroundColor: FIELDS_COLORS.cardSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  borderRadius: 6,
                  paddingHorizontal: 10,
                  fontSize: 13,
                  color: FIELDS_COLORS.textMain,
                }}
                placeholder="Degrees (e.g. 45)"
                placeholderTextColor={FIELDS_COLORS.textDim}
                value={rotationDeg}
                onChangeText={(value) => {
                  onInvalidateWorkflow("alignment");
                  setRotationDeg(value);
                }}
                keyboardType="numeric"
              />
            </View>
          ) : null}

          {alignmentMethod === "least_squares" && refPoints.length >= 2 ? (
            <View
              style={{
                backgroundColor: FIELDS_COLORS.panelBorder,
                padding: 10,
                borderRadius: 8,
                alignItems: "center",
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>
                Distance (Point 1 → 2):{" "}
                {Math.hypot(refPoints[1].dxf_x - refPoints[0].dxf_x, refPoints[1].dxf_y - refPoints[0].dxf_y).toFixed(2)} meters
              </Text>
            </View>
          ) : null}

          <Pressable
            onPress={handleFixAlignment}
            disabled={isFixing || !selectedPathName}
            style={{
              height: 44,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: isFixing || !selectedPathName ? FIELDS_COLORS.textDim : FIELDS_COLORS.warning,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
              {isFixing ? "Fixing..." : "Fix Alignment"}
            </Text>
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
                Method: {alignmentResult.method != null ? String(alignmentResult.method) : "n/a"}
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Scale: {formatFinite(alignmentResult.scale, 6)}
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Rotation: {formatFinite(alignmentResult.rotation_deg, 3)} deg
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                Offset: N {formatFinite(alignmentResult.offset_n, 3)} / E {formatFinite(alignmentResult.offset_e, 3)}
              </Text>
              <Text style={{ color: FIELDS_COLORS.success, fontSize: 12 }}>
                RMSE: {formatFinite(alignmentResult.rmse_m, 3)}
              </Text>
            </View>
          ) : null}
        </View>
      )}
      </View>
    </View>
  );
}