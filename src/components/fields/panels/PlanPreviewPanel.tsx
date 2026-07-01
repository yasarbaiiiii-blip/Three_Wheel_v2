import React from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Trash2 } from "lucide-react-native";

import * as pathApi from "../../../api/pathApi";
import {
  getLoadedMissionId,
  isProtectedMissionResident,
} from "../../../api/missionContract";
import * as missionApi from "../../../api/missionApi";
import type { AlignmentResultState, StagedPlanResultState } from "../../../types/fieldsWorkflow";
import * as pathApiTypes from "../../../api/pathApi";
import { FIELDS_COLORS } from "../fieldsTheme";

type PlanPreviewPanelProps = {
  apiBaseUrl: string;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApiTypes.AlignPathRequest | null>>;
  setSegmentVerification: React.Dispatch<React.SetStateAction<pathApiTypes.PathSegmentsResponse | null>>;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApiTypes.StagedMissionResponse | null>>;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  setMissionSummary: React.Dispatch<React.SetStateAction<any>>;
  onRefreshPaths: () => void;
  blockProtectedWorkflowMutation: (action: string) => boolean;
  onContinue: () => void;
};

export function PlanPreviewPanel({
  apiBaseUrl,
  backendPaths,
  selectedPathName,
  onSelectPath,
  loadedPathInspection,
  setAlignmentResult,
  setVerifiedAlignmentRequest,
  setSegmentVerification,
  setStagedPlanResult,
  setStagedMissionInspection,
  setStagedMissionId,
  setMissionSummary,
  onRefreshPaths,
  blockProtectedWorkflowMutation,
  onContinue,
}: PlanPreviewPanelProps) {
  const protectedResident = isProtectedMissionResident(loadedPathInspection);

  const handleDeletePath = async (filename: string) => {
    if (blockProtectedWorkflowMutation("Deleting a path")) return;
    Alert.alert(
      "Delete Path",
      `Are you sure you want to delete ${filename}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await pathApi.deletePath(apiBaseUrl, filename);
              if (res.ok) {
                if (selectedPathName === filename) onSelectPath("");
                onRefreshPaths();
              } else {
                const errText = await res.text();
                Alert.alert("Error", errText || "Failed to delete path");
              }
            } catch (err: any) {
              Alert.alert("Error", err.message || "Failed to connect to backend");
            }
          },
        },
      ]
    );
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Select a path from the rover to begin planning.
      </Text>
      <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled contentContainerStyle={{ gap: 8 }}>
        {backendPaths.length === 0 ? (
          <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 13, fontStyle: "italic", textAlign: "center", marginTop: 12 }}>
            No paths found on rover or offline.
          </Text>
        ) : (
          backendPaths.map((path) => {
            const isSelected = selectedPathName === path.name;
            return (
              <Pressable
                key={path.name}
                onPress={() => {
                  if (blockProtectedWorkflowMutation("Selecting another path")) return;
                  setMissionSummary(null);
                  setAlignmentResult(null);
                  setVerifiedAlignmentRequest(null);
                  setSegmentVerification(null);
                  setStagedPlanResult(null);
                  setStagedMissionInspection(null);
                  setStagedMissionId(null);
                  onSelectPath(path.name);
                }}
                style={{
                  borderRadius: 10,
                  padding: 10,
                  backgroundColor: isSelected ? FIELDS_COLORS.tealDark : FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: isSelected ? FIELDS_COLORS.teal : FIELDS_COLORS.panelBorder,
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: isSelected ? "#fff" : FIELDS_COLORS.textMain, fontWeight: "800", fontSize: 14 }}>
                    {path.name}
                  </Text>
                  <Text style={{ color: isSelected ? "#d1fae5" : FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
                    {path.description || `Points: ${path.num_points}`}
                  </Text>
                </View>
                {isSelected ? (
                  <Pressable
                    onPress={() => handleDeletePath(path.name)}
                    style={{ padding: 8, backgroundColor: "rgba(239, 68, 68, 0.2)", borderRadius: 8 }}
                  >
                    <Trash2 size={18} color="#fca5a5" />
                  </Pressable>
                ) : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {selectedPathName ? (
        <Pressable
          onPress={onContinue}
          style={{
            height: 44,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: FIELDS_COLORS.accentBrand,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.accentText, fontSize: 14, fontWeight: "800" }}>
            Continue to Plan Editing
          </Text>
        </Pressable>
      ) : null}

      {protectedResident ? (
        <Text style={{ color: FIELDS_COLORS.warning, fontSize: 11 }}>
          Protected mission resident: {getLoadedMissionId(loadedPathInspection) ?? "unknown"}
        </Text>
      ) : null}
    </View>
  );
}