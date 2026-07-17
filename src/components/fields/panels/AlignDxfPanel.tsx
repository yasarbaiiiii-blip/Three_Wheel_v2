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
import {
  similarityTransform,
  transformPlanLinesGeometry,
} from "../../../utils/planLineTransform";
import type { AlignmentResultState, StagedWorkflowStatus } from "../../../types/fieldsWorkflow";
import type { PlanLine } from "../../../types/plan";
import type { AutoOriginReference } from "../../../types/autoOrigin";
import type { PlacedItem } from "../../BoundaryEditor";
import { FIELDS_COLORS } from "../fieldsTheme";

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

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

type GuidePoint = { latRaw: string; lonRaw: string };

/**
 * Parses a PURE visual reference-point CSV: only Latitude/Longitude are read (any other
 * columns, e.g. a survey device's own Easting/Northing in some arbitrary project grid, are
 * ignored — they don't need to correspond to this drawing's coordinate system at all, since
 * these points are just a visual marker on the map, not an input to a computed fit).
 * Accepts a header row (lat/latitude, lon/lng/long/longitude, any order) or, with no
 * recognizable header, 2 bare numeric columns in that order (lat, lon).
 */
function parseGuidePointsCsv(text: string): { points: GuidePoint[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  if (lines.length === 0) return { points: [], errors: ["The file is empty."] };

  const headerCells = splitCsvCells(lines[0]).map((cell) => cell.toLowerCase());
  const latAliases = ["lat", "latitude"];
  const lonAliases = ["lon", "lng", "long", "longitude"];
  let latIdx = headerCells.findIndex((cell) => latAliases.includes(cell));
  let lonIdx = headerCells.findIndex((cell) => lonAliases.includes(cell));

  let dataLines: string[];
  if (latIdx >= 0 && lonIdx >= 0) {
    dataLines = lines.slice(1);
  } else {
    latIdx = 0;
    lonIdx = 1;
    const firstRowIsNumeric =
      headerCells.length >= 2 && headerCells.slice(0, 2).every((cell) => cell !== "" && Number.isFinite(Number(cell)));
    if (!firstRowIsNumeric && lines.length < 2) {
      return {
        points: [],
        errors: ["Could not find Latitude/Longitude columns. Expected a header row like: lat,lon"],
      };
    }
    dataLines = firstRowIsNumeric ? lines : lines.slice(1);
  }

  const points: GuidePoint[] = [];
  dataLines.forEach((line, i) => {
    const cells = splitCsvCells(line);
    if (cells.every((cell) => cell === "")) return;
    const rowNum = i + (dataLines.length === lines.length ? 1 : 2);

    const rawLat = cells[latIdx] ?? "";
    const rawLon = cells[lonIdx] ?? "";
    if (rawLat === "" || rawLon === "") {
      errors.push(`Row ${rowNum}: missing latitude/longitude.`);
      return;
    }
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      errors.push(`Row ${rowNum}: could not parse latitude/longitude.`);
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`Row ${rowNum}: latitude/longitude out of range.`);
      return;
    }
    points.push({ latRaw: rawLat, lonRaw: rawLon });
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

  // Reference points are a PURE visual guide (any count, 1+) — only Latitude/Longitude are
  // read from the file (a survey device's own Easting/Northing, in whatever arbitrary
  // project-specific grid CRS, is ignored entirely). They're never sent anywhere for a
  // computed fit: the user drags/scales/rotates the plan (Move Plan) using these dots as a
  // guide, then "Use This Position" captures wherever they actually placed it.
  const handleUploadRefPointsCsv = async () => {
    if (blockProtectedWorkflowMutation("Importing reference points")) return;

    let asset: DocumentPicker.DocumentPickerAsset | null = null;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["*/*"], copyToCacheDirectory: true });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      asset = result.assets[0];
    } catch (err) {
      console.log("[AlignDXF][CSV] Error picking CSV:", err);
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

      const { points, errors } = parseGuidePointsCsv(text);
      console.log(`[AlignDXF][CSV] Parsed ${points.length} point(s), ${errors.length} error(s).`);
      if (errors.length > 0) console.log("[AlignDXF][CSV] Errors:", errors);
      if (points.length === 0) {
        Alert.alert("Import Failed", errors[0] ?? "No valid Latitude/Longitude rows were found in the file.");
        return;
      }

      onInvalidateWorkflow("alignment");
      setMissionSummary(null);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      // dxf_x/dxf_y are unused placeholders — rendering prioritizes lat/lon whenever present
      // (see MapViewNative's selectedPointsFC), which every one of these points has.
      setRefPoints((prev) => [...prev, ...points.map((p) => ({ dxf_x: 0, dxf_y: 0, lat: p.latRaw, lon: p.lonRaw }))]);
      console.log(`[AlignDXF][CSV] Added ${points.length} reference point(s).`);

      if (errors.length > 0) {
        Alert.alert(
          "Imported With Warnings",
          `${points.length} point(s) imported. ${errors.length} row(s) skipped:\n${errors.slice(0, 5).join("\n")}${
            errors.length > 5 ? `\n…and ${errors.length - 5} more` : ""
          }`
        );
      } else {
        Alert.alert(
          "Reference Points Loaded",
          `${points.length} point(s) shown on the map. Drag, scale, or rotate the plan to position it — these points are just a visual guide.`
        );
      }
    } catch (err) {
      console.log("[AlignDXF][CSV] Error importing CSV:", err);
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
    const usesManualPlacement = alignmentMethod === "visual_alignment" || alignmentMethod === "least_squares";
    if (
      !selectedPathName ||
      !apiBaseUrl ||
      (usesManualPlacement && !extractedCorners) ||
      (alignmentMethod === "single_point" && refPoints.length === 0)
    ) {
      console.log("[AlignDXF][Fix] Aborted: missing path/apiBaseUrl/points guard.");
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      return;
    }

    setIsFixing(true);
    try {
      let validPoints: { dxf_x: number; dxf_y: number; lat: number; lon: number }[] = [];

      if (usesManualPlacement) {
        // Both Visual and Multi-Point Fit now work the same way: the reference points (tapped
        // or CSV-imported) are just an on-screen guide — the actual alignment comes from
        // wherever the user manually dragged/scaled/rotated the plan to (captured via "Use
        // This Position" / "Capture & Confirm" into extractedCorners), not a computed fit.
        validPoints = extractedCorners!.map((point) => ({
          dxf_x: point.dxf_x,
          dxf_y: point.dxf_y,
          lat: point.lat,
          lon: point.lon,
        }));
      } else {
        // single_point (1-Point + Angle): still a computed fit from one tapped point + a
        // given heading, so its dxf_x/dxf_y must genuinely correspond to this drawing.
        validPoints = refPoints
          .filter((point) => point.lat.trim() !== "" && point.lon.trim() !== "")
          .map((point) => ({
            dxf_x: point.dxf_x,
            dxf_y: point.dxf_y,
            lat: parseFloat(point.lat),
            lon: parseFloat(point.lon),
          }));

        if (validPoints.length === 0) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please select a point and enter its coordinates.");
          setIsFixing(false);
          return;
        }

        // Defense-in-depth: never send a fit whose input coordinates don't match this
        // drawing's own scale — that computes a transform for the wrong coordinate system
        // and, reapplied to the drawing, can misplace the whole plan by thousands of
        // kilometres. This is a physical spraying rover; a wrong alignment is a safety issue.
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
            "This point's drawing coordinates are far outside this DXF's own coordinate range. This usually means a raw survey file's Easting/Northing got used directly instead of a point actually tapped on the drawing — sending this would misalign the plan by a huge distance."
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
          // Same scale policy as setAlignmentResult above and rehydrateAlignedPlanLines —
          // Fix bake, stored result, and post-refresh rehydrate must agree or extension
          // toggle would reintroduce a small pose shift.
          const alignScale = enforceAlignmentScale(coerceFiniteNumber(data.scale) ?? 1.0);
          console.log(
            `[AlignDXF][Fix] Transform params: rotDeg=${rotDeg} offsetN=${offsetN} offsetE=${offsetE} scale=${alignScale} data.origin_gps=${JSON.stringify(data.origin_gps)} merged_waypoints=${!!data.merged_waypoints}`
          );
          if (rotDeg != null && offsetE != null && offsetN != null && !data.merged_waypoints) {
            // Mirror the backend's affine transform exactly: NED = scale * R(theta) * DXF + offset
            // (see path_engine/ned.py apply_affine_transform). Routed through the shared bake
            // helper so from/to, preview_points, AND entity.geometry.center (circles/arcs) all
            // move together — baking only endpoints left getCurveGeometry() reading a stale
            // center and the AlignDXF map jumped after Fix until Load rehydrated waypoints.
            const applyOriginTransform = similarityTransform({
              rotationDeg: rotDeg,
              scale: alignScale,
              offsetN,
              offsetE,
            });
            setLines((prev) => {
              console.log(`[AlignDXF][Fix] Transforming ${prev.length} line(s). Before -> After (north,east):`);
              const next = transformPlanLinesGeometry(prev, applyOriginTransform);
              for (let i = 0; i < Math.min(prev.length, next.length); i++) {
                const line = prev[i];
                const out = next[i];
                console.log(
                  `[AlignDXF][Fix]   ${line.id}: from (${line.from.x},${line.from.y}) -> (${out.from.x.toFixed(3)},${out.from.y.toFixed(3)}) | to (${line.to.x},${line.to.y}) -> (${out.to.x.toFixed(3)},${out.to.y.toFixed(3)})`
                );
              }
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
        // Atomic origin handoff (same React event turn as transform + alignedRefPoints):
        // clear sticker + provisional projection anchor together so MapViewNative never
        // paints transformed NED lines under visualAlignmentAnchor for one intermediate frame
        // (the shift-then-settle bug). Do not rely on App's useEffect for this first paint.
        setRefPoints([]);
        setExtractedCorners?.(null);
        setVisualAlignmentItem?.(null);
        setVisualAlignmentAnchor?.(null);
        console.log("[AlignDXF][Fix] Cleared visualAlignmentItem + visualAlignmentAnchor (atomic handoff)");
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
    setVisualAlignmentAnchor?.(null);
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

      {alignmentMethod !== "visual_alignment" && !(alignmentMethod === "least_squares" && extractedCorners) ? (
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
                ? "Use This Position"
                : "Done — Lock Plan Position"
              : "Move / Rotate Plan"}
          </Text>
        </Pressable>
      ) : null}

      {isPlanEditingMode ? (
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontStyle: "italic" }}>
          {alignmentMethod === "least_squares"
            ? "Drag, pinch, or twist the plan on the map, using the reference points as a guide. Tap \"Use This Position\" to capture wherever you place it as the alignment."
            : refPoints.length > 0
            ? "Drag, pinch, or twist the plan on the map. Your reference points move with it, so they stay valid — tap-to-pick-point is paused until you lock it in."
            : "Drag, pinch, or twist the plan into position on the map. Tap-to-pick-point is paused until you lock it in."}
        </Text>
      ) : null}

      {alignmentMethod === "least_squares" && !isPlanEditingMode && !extractedCorners ? (
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
            {isImportingCsv ? "Importing CSV..." : "Upload Reference Points CSV"}
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
            </View>
          ) : null}
        </View>
      ) : isPlanEditingMode ? null : refPoints.length === 0 ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 12, fontStyle: "italic", textAlign: "center" }}>
          {alignmentMethod === "least_squares"
            ? "Tap points on the canvas, or upload a CSV, to show reference points on the map — any number, purely a visual guide. Then use \"Move / Rotate Plan\" to position the plan."
            : "Tap 1 point on the canvas to set anchor."}
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          {alignmentMethod === "least_squares" ? (
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11 }}>
              {refPoints.length} reference point{refPoints.length === 1 ? "" : "s"} shown on the map — drag the plan close to
              one to snap onto it.
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
                    Point {index + 1}
                    {alignmentMethod === "single_point" ? (
                      <Text style={{ fontWeight: "400", color: FIELDS_COLORS.textMuted }}>
                        {" "}(X: {point.dxf_x.toFixed(2)}, Y: {point.dxf_y.toFixed(2)})
                      </Text>
                    ) : null}
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

          {alignmentMethod === "least_squares" ? (
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontStyle: "italic", textAlign: "center" }}>
              Now tap "Move / Rotate Plan" above to position the plan using these points as a guide.
            </Text>
          ) : (
            <>
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
            </>
          )}
        </View>
      )}
      </View>
    </View>
  );
}