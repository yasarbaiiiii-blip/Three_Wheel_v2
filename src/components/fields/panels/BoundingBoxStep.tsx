import React from "react";
import { Alert, Pressable, TouchableOpacity, Text, TextInput, View } from "react-native";
import { Check, CheckCircle2, Maximize2, ArrowRight } from "lucide-react-native";
import { FIELDS_COLORS } from "../fieldsTheme";

type BoundingBoxStepProps = {
  widthStr: string;
  onChangeWidthStr: (val: string) => void;
  heightStr: string;
  onChangeHeightStr: (val: string) => void;
  onApplyBoundary: (w: number, h: number) => void;
  activeWidth: number | null;
  activeHeight: number | null;
  onProceedToUpload?: () => void;
};

export function BoundingBoxStep({
  widthStr,
  onChangeWidthStr,
  heightStr,
  onChangeHeightStr,
  onApplyBoundary,
  activeWidth,
  activeHeight,
  onProceedToUpload,
}: BoundingBoxStepProps) {
  const isApplied = activeWidth != null && activeHeight != null;

  const handleApply = () => {
    const w = parseFloat(widthStr);
    const h = parseFloat(heightStr);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      Alert.alert("Invalid Dimensions", "Please enter valid positive numbers for width and height.");
      return;
    }
    onApplyBoundary(w, h);
  };

  return (
    <View style={{ gap: 14 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 13, lineHeight: 18 }}>
        Set a fixed bounding box for your plan before uploading. When a DXF file is parsed, it will be automatically centered inside this boundary.
      </Text>

      <View
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: FIELDS_COLORS.surfaceSolid,
          borderWidth: 1,
          borderColor: isApplied ? "#059669" : FIELDS_COLORS.panelBorder,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Maximize2 size={16} color={isApplied ? "#34d399" : FIELDS_COLORS.tealDark} />
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Boundary Dimensions
            </Text>
          </View>
          {isApplied ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(16, 185, 129, 0.15)", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 }}>
              <CheckCircle2 size={13} color="#34d399" />
              <Text style={{ color: "#34d399", fontSize: 11, fontWeight: "700" }}>Active ({activeWidth}m × {activeHeight}m)</Text>
            </View>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "700" }}>Width (meters)</Text>
            <TextInput
              style={{
                height: 44,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
                borderRadius: 8,
                paddingHorizontal: 12,
                color: FIELDS_COLORS.textMain,
                backgroundColor: FIELDS_COLORS.cardSolid,
                fontSize: 14,
                fontWeight: "600",
              }}
              value={widthStr}
              onChangeText={onChangeWidthStr}
              keyboardType="numeric"
              placeholder="4.0"
              placeholderTextColor={FIELDS_COLORS.textDim}
            />
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "700" }}>Height / Length (meters)</Text>
            <TextInput
              style={{
                height: 44,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
                borderRadius: 8,
                paddingHorizontal: 12,
                color: FIELDS_COLORS.textMain,
                backgroundColor: FIELDS_COLORS.cardSolid,
                fontSize: 14,
                fontWeight: "600",
              }}
              value={heightStr}
              onChangeText={onChangeHeightStr}
              keyboardType="numeric"
              placeholder="3.0"
              placeholderTextColor={FIELDS_COLORS.textDim}
            />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
          <TouchableOpacity
            onPress={handleApply}
            activeOpacity={0.85}
            style={{
              flex: 1,
              height: 46,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: isApplied ? "#059669" : FIELDS_COLORS.tealDark,
              borderWidth: 1.5,
              borderColor: isApplied ? "#10b981" : "#14b8a6",
              flexDirection: "row",
              gap: 8,
              elevation: 4,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.3,
              shadowRadius: 3.84,
            }}
          >
            <Check size={18} color="#ffffff" />
            <Text style={{ color: "#ffffff", fontSize: 14, fontWeight: "700" }}>
              {isApplied ? "Update Bounding Box" : "Apply Bounding Box"}
            </Text>
          </TouchableOpacity>

          {isApplied && onProceedToUpload ? (
            <TouchableOpacity
              onPress={onProceedToUpload}
              activeOpacity={0.85}
              style={{
                height: 46,
                paddingHorizontal: 16,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(59, 130, 246, 0.15)",
                borderWidth: 1,
                borderColor: "#3b82f6",
                flexDirection: "row",
                gap: 6,
              }}
            >
              <Text style={{ color: "#60a5fa", fontSize: 13, fontWeight: "700" }}>Next</Text>
              <ArrowRight size={16} color="#60a5fa" />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}
