import React, { useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import * as pathApi from "../../../api/pathApi";
import { enforceAlignmentScale } from "../../../utils/designAlignmentPolicy";
import {
  coerceFiniteNumber,
  formatFinite,
  sanitizePlanLines,
} from "../../../utils/pathWorkflow";
import type { AlignmentResultState, StagedWorkflowStatus } from "../../../types/fieldsWorkflow";
import type { PlanLine } from "../../../types/plan";
import type { PlacedItem } from "../../BoundaryEditor";
import { FIELDS_COLORS } from "../fieldsTheme";

type RefPoint = { dxf_x: number; dxf_y: number; lat: string; lon: string };

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
};

export function AlignDxfPanel({
  apiBaseUrl,
  selectedPathName,
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
}: AlignDxfPanelProps) {
  const [rotationDeg, setRotationDeg] = useState("");
  const [isFixing, setIsFixing] = useState(false);

  const handleUpdateRefPoint = (idx: number, field: "lat" | "lon", value: string) => {
    onInvalidateWorkflow("alignment");
    const next = [...refPoints];
    next[idx] = { ...next[idx], [field]: value };
    setRefPoints(next);
  };

  const handleFixAlignment = async () => {
    if (blockProtectedWorkflowMutation("Changing GPS alignment")) return;
    if (
      !selectedPathName ||
      !apiBaseUrl ||
      (alignmentMethod !== "visual_alignment" && refPoints.length === 0) ||
      (alignmentMethod === "visual_alignment" && !extractedCorners)
    ) {
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
          Alert.alert("Validation", "Please select 2 points and enter their WGS84 coordinates.");
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
      }

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

      const res = await pathApi.alignPath(apiBaseUrl, selectedPathName, payload);
      if (res.ok) {
        const data = await res.json();
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
          if (rotDeg != null && offsetE != null && offsetN != null && !data.merged_waypoints) {
            const rotRad = (rotDeg * Math.PI) / 180;
            const cos = Math.cos(rotRad);
            const sin = Math.sin(rotRad);
            const applyOriginTransform = (pt: { x: number; y: number }) => ({
              x: pt.x * cos - pt.y * sin + offsetE,
              y: pt.x * sin + pt.y * cos + offsetN,
            });
            setLines((prev) =>
              prev.map((line) => {
                const transformedFrom = applyOriginTransform({ x: line.from.x, y: line.from.y });
                const transformedTo = applyOriginTransform({ x: line.to.x, y: line.to.y });
                let updatedEntity = line.entity;
                if (updatedEntity?.preview_points) {
                  updatedEntity = {
                    ...updatedEntity,
                    preview_points: updatedEntity.preview_points.map((pt: { north: number; east: number }) => {
                      const transformed = applyOriginTransform({ x: pt.north, y: pt.east });
                      return { ...pt, north: transformed.x, east: transformed.y };
                    }),
                  };
                }
                return {
                  ...line,
                  from: { ...line.from, x: transformedFrom.x, y: transformedFrom.y },
                  to: { ...line.to, x: transformedTo.x, y: transformedTo.y },
                  ...(updatedEntity ? { entity: updatedEntity } : {}),
                };
              })
            );
          }
          Alert.alert("Success", "Alignment verified.");
        }

        if (setAlignedRefPoints) {
          setAlignedRefPoints(
            validPoints.map((point) => ({
              dxf_x: point.dxf_x,
              dxf_y: point.dxf_y,
              lat: point.lat,
              lon: point.lon,
            }))
          );
        }
        setRefPoints([]);
        setExtractedCorners?.(null);
        setVisualAlignmentItem?.(null);
      } else {
        onWorkflowStep?.("alignment", "failed");
        setVerifiedAlignmentRequest(null);
        const errText = await res.text();
        Alert.alert("Alignment Failed", errText || "Unknown error occurred.");
      }
    } catch (err) {
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      console.log("Error aligning path:", err);
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

      <View style={{ flexDirection: "row", backgroundColor: FIELDS_COLORS.surfaceSolid, borderRadius: 8, padding: 4 }}>
        {([
          { id: "least_squares" as const, label: "2-Point Fit" },
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
                Drag and rotate the plan on the map to align it, then click Confirm.
              </Text>
              <View style={{ backgroundColor: FIELDS_COLORS.surfaceSolid, padding: 10, borderRadius: 6 }}>
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontFamily: "monospace" }}>
                  Offset: {visualAlignmentItem?.x?.toFixed(2) ?? "0.00"}m, {visualAlignmentItem?.y?.toFixed(2) ?? "0.00"}m
                </Text>
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
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>LLA Receiver (Confirm)</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={onStartVisualAlignment}
              style={{
                height: 44,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.textMain,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 14, fontWeight: "700" }}>Coordinate Receiver</Text>
            </Pressable>
          )}
        </View>
      ) : refPoints.length === 0 ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 12, fontStyle: "italic", textAlign: "center" }}>
          {alignmentMethod === "least_squares"
            ? "Tap 2 points on the canvas to set alignment."
            : "Tap 1 point on the canvas to set anchor."}
        </Text>
      ) : (
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
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700", marginBottom: 6 }}>
                Point {index + 1}{" "}
                <Text style={{ fontWeight: "400", color: FIELDS_COLORS.textMuted }}>
                  (X: {point.dxf_x.toFixed(2)}, Y: {point.dxf_y.toFixed(2)})
                </Text>
              </Text>
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

          {alignmentMethod === "least_squares" && refPoints.length === 2 ? (
            <View
              style={{
                backgroundColor: FIELDS_COLORS.panelBorder,
                padding: 10,
                borderRadius: 8,
                alignItems: "center",
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>
                Distance:{" "}
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
  );
}