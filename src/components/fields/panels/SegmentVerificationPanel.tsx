import React, { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import * as pathApi from "../../../api/pathApi";
import type { ImportedPlan } from "../../../types/plan";
import type { StagedWorkflowStatus } from "../../../types/fieldsWorkflow";
import {
  formatExtensionRoleLabel,
  formatFinite,
  parsePathSegmentsResponse,
  summarizeNormalizedSegments,
} from "../../../utils/pathWorkflow";
import { FIELDS_COLORS } from "../fieldsTheme";

type SegmentVerificationPanelProps = {
  apiBaseUrl: string;
  selectedPathName: string | null;
  importedPlan: ImportedPlan | null;
  segmentVerification: pathApi.PathSegmentsResponse | null;
  setSegmentVerification: React.Dispatch<React.SetStateAction<pathApi.PathSegmentsResponse | null>>;
  onWorkflowStep?: (step: "spray", status: StagedWorkflowStatus) => void;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
};

export function SegmentVerificationPanel({
  apiBaseUrl,
  selectedPathName,
  importedPlan,
  segmentVerification,
  setSegmentVerification,
  onWorkflowStep,
  onInvalidateWorkflow,
}: SegmentVerificationPanelProps) {
  const [isVerifyingSegments, setIsVerifyingSegments] = useState(false);

  const segmentSummary = useMemo(() => {
    const segments = segmentVerification?.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      return summarizeNormalizedSegments([]);
    }
    return summarizeNormalizedSegments(segments);
  }, [segmentVerification]);

  const handleVerifySpraySegments = async () => {
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      setSegmentVerification(null);
      onWorkflowStep?.("spray", "failed");
      Alert.alert("Error", "No path selected to verify segments.");
      return;
    }
    if (!targetPath.toLowerCase().endsWith(".dxf")) {
      setSegmentVerification(null);
      onWorkflowStep?.("spray", "failed");
      Alert.alert("Error", "Segment verification is only available for DXF paths.");
      return;
    }

    setIsVerifyingSegments(true);
    onInvalidateWorkflow("staged");
    try {
      const res = await pathApi.getPathSegments(apiBaseUrl, targetPath);
      if (res.ok) {
        const raw = await res.json();
        const data = parsePathSegmentsResponse(raw);
        if (!data) {
          setSegmentVerification(null);
          onWorkflowStep?.("spray", "failed");
          Alert.alert("Verification Failed", "Response did not include a non-empty segments array.");
          return;
        }
        setSegmentVerification(data);
        onWorkflowStep?.("spray", "verified");
        Alert.alert("Success", "Segment verification complete.");
      } else {
        setSegmentVerification(null);
        onWorkflowStep?.("spray", "failed");
        const errText = await res.text();
        Alert.alert("Verification Failed", errText || "Could not fetch segments.");
      }
    } catch (err) {
      setSegmentVerification(null);
      onWorkflowStep?.("spray", "failed");
      console.log("Error verifying segments:", err);
      Alert.alert("Error", "Could not connect to the rover to verify segments.");
    } finally {
      setIsVerifyingSegments(false);
    }
  };

  const checklist = [
    { label: "Path selected", done: !!selectedPathName },
    { label: "DXF source", done: !!(selectedPathName || importedPlan?.fileName)?.toLowerCase().endsWith(".dxf") },
    { label: "Segments fetched", done: !!segmentVerification },
  ];

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Fetch runtime segment roles from the rover before staging.
      </Text>

      <View style={{ gap: 6 }}>
        {checklist.map((item) => (
          <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                backgroundColor: item.done ? FIELDS_COLORS.success : FIELDS_COLORS.surfaceSolid,
                borderWidth: 1,
                borderColor: item.done ? FIELDS_COLORS.successBorder : FIELDS_COLORS.panelBorder,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {item.done ? <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>✓</Text> : null}
            </View>
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12 }}>{item.label}</Text>
          </View>
        ))}
      </View>

      <Pressable
        onPress={handleVerifySpraySegments}
        disabled={isVerifyingSegments || !selectedPathName}
        style={{
          height: 44,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isVerifyingSegments || !selectedPathName ? FIELDS_COLORS.textDim : FIELDS_COLORS.teal,
        }}
      >
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
          {isVerifyingSegments ? "Verifying..." : "Verify Spray Segments"}
        </Text>
      </Pressable>

      {segmentVerification ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 10, lineHeight: 15 }}>
            Segments: {formatFinite(segmentVerification.num_segments, 0)} | Waypoints:{" "}
            {formatFinite(segmentVerification.num_waypoints, 0)} | Total:{" "}
            {formatFinite(segmentVerification.total_length_m, 1)} m | Mark:{" "}
            {formatFinite(segmentVerification.mark_length_m, 1)} m | Transit:{" "}
            {formatFinite(segmentVerification.transit_length_m, 1)} m
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {[
              { label: "MARK", value: segmentSummary.markCount },
              { label: "TRANSIT", value: segmentSummary.transitCount },
              { label: "PRE", value: segmentSummary.preExtensionCount },
              { label: "AFT", value: segmentSummary.aftExtensionCount },
              { label: "Spray ON", value: segmentSummary.sprayOnCount },
              { label: "Spray OFF", value: segmentSummary.sprayOffCount },
            ].map((chip) => (
              <View
                key={chip.label}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 999,
                  backgroundColor: FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 10, fontWeight: "800" }}>
                  {chip.label}: {chip.value}
                </Text>
              </View>
            ))}
          </View>

          <View style={{ borderRadius: 8, borderWidth: 1, borderColor: FIELDS_COLORS.panelBorder, overflow: "hidden" }}>
            <View
              style={{
                flexDirection: "row",
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderBottomWidth: 1,
                borderBottomColor: FIELDS_COLORS.panelBorder,
              }}
            >
              {["#", "Seq", "Type", "Ext", "Spray", "Entity", "Len (m)"].map((heading) => (
                <Text
                  key={heading}
                  style={{
                    flex: heading === "Entity" ? 2 : 1,
                    color: FIELDS_COLORS.textMuted,
                    fontSize: 9,
                    fontWeight: "800",
                    textTransform: "uppercase",
                  }}
                >
                  {heading}
                </Text>
              ))}
            </View>
            <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
              {segmentSummary.normalized.length === 0 ? (
                <View style={{ paddingVertical: 16, paddingHorizontal: 8, alignItems: "center" }}>
                  <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, fontStyle: "italic" }}>
                    No segments returned.
                  </Text>
                </View>
              ) : (
                segmentSummary.normalized.map((segment) => {
                  const extLabel = formatExtensionRoleLabel(segment.extensionRole);
                  return (
                    <View
                      key={`${segment.index}-${segment.sequence}`}
                      style={{
                        flexDirection: "row",
                        paddingVertical: 6,
                        paddingHorizontal: 8,
                        borderBottomWidth: 1,
                        borderBottomColor: FIELDS_COLORS.panelBorder,
                      }}
                    >
                      <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 10, fontWeight: "700" }}>
                        {segment.index}
                      </Text>
                      <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 10 }}>{segment.sequence}</Text>
                      <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 10, fontWeight: "700" }}>
                        {segment.type}
                      </Text>
                      <Text style={{ flex: 1, color: FIELDS_COLORS.textMuted, fontSize: 10, fontWeight: "700" }}>
                        {extLabel}
                      </Text>
                      <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 10, fontWeight: "700" }}>
                        {segment.sprayOn ? "ON" : "OFF"}
                      </Text>
                      <Text style={{ flex: 2, color: FIELDS_COLORS.textMuted, fontSize: 10 }} numberOfLines={1}>
                        {segment.sourceEntity || "—"}
                      </Text>
                      <Text style={{ flex: 1, color: FIELDS_COLORS.textMuted, fontSize: 10 }}>
                        {formatFinite(segment.lengthM, 1)}
                      </Text>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>

          {segmentVerification.warnings && segmentVerification.warnings.length > 0 ? (
            <Text style={{ color: FIELDS_COLORS.warning, fontSize: 10 }} numberOfLines={3}>
              Warnings: {segmentVerification.warnings.join("; ")}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}