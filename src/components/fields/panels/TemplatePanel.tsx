import React, { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import Slider from "@react-native-community/slider";

import { generateRoadSignLines, ROAD_SIGN_LABELS, type RoadSignType } from "../../../utils/roadSignTemplates";
import { generateTextLines, type FontStyle } from "../../../utils/characterTemplates";
import { linesToDxf } from "../../../utils/dxfGenerator";
import type { PlanLine } from "../../../types/plan";
import { FIELDS_COLORS } from "../fieldsTheme";
import { RoadSignThumbnail } from "../RoadSignThumbnail";

const ROAD_SIGN_TYPES = Object.keys(ROAD_SIGN_LABELS) as RoadSignType[];

type TemplatePanelProps = {
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onSelectPath: (name: string) => void;
};

export function TemplatePanel({ apiBaseUrl, onRefreshPaths, onSelectPath }: TemplatePanelProps) {
  const [boundaryMode, setBoundaryMode] = useState(false);
  const [sketchMode, setSketchMode] = useState(false);
  const [showSnapPoints, setShowSnapPoints] = useState(true);
  const [charactersEnabled, setCharactersEnabled] = useState(false);
  const [previewText, setPreviewText] = useState("HELLO");
  const [fontStyle, setFontStyle] = useState<FontStyle>("smooth");
  const [selectedSign, setSelectedSign] = useState<RoadSignType>("am_01");
  const [sizeInput, setSizeInput] = useState("2.0");
  const [isParsing, setIsParsing] = useState(false);

  const parsedSize = useMemo(() => {
    const next = parseFloat(sizeInput);
    return Number.isFinite(next) && next > 0 ? next : 2.0;
  }, [sizeInput]);

  const previewLines: PlanLine[] = useMemo(() => {
    if (charactersEnabled) {
      return generateTextLines(previewText, parsedSize, fontStyle, 0.1);
    }
    return generateRoadSignLines(selectedSign, parsedSize);
  }, [charactersEnabled, previewText, fontStyle, selectedSign, parsedSize]);

  const handleParse = async () => {
    if (!apiBaseUrl) return;
    if (previewLines.length === 0) {
      Alert.alert("Empty Template", "No valid template to generate.");
      return;
    }

    const title = charactersEnabled
      ? `Text_${previewText || "Empty"}_${parsedSize}m`
      : `Road_Sign_${ROAD_SIGN_LABELS[selectedSign].replace(/\s+/g, "_")}_${parsedSize}m`;

    setIsParsing(true);
    try {
      const fileName = `${title.replace(/\s+/g, "_")}.dxf`;
      const fileContent = linesToDxf(previewLines, fileName);
      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, fileContent, { encoding: FileSystem.EncodingType.UTF8 });

      const formData = new FormData();
      formData.append("file", { uri: fileUri, name: fileName, type: "application/dxf" } as any);

      const res = await fetch(`${apiBaseUrl}/api/path/parse-dxf`, { method: "POST", body: formData });
      if (res.ok) {
        Alert.alert("Success", `Template "${fileName}" sent to rover.`);
        onRefreshPaths();
        onSelectPath(fileName);
      } else {
        const errText = await res.text();
        Alert.alert("Parse Failed", errText || "Unknown error");
      }
    } catch (err: any) {
      console.log("Error parsing template:", err);
      Alert.alert("Error", err.message || "Failed to send template to backend.");
    } finally {
      setIsParsing(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        Quick template generator for road signs and text. Boundary toggles apply when placing in boundary mode.
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Boundary Mode</Text>
        <Switch value={boundaryMode} onValueChange={setBoundaryMode} trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }} />
      </View>
      {boundaryMode ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Sketch Mode</Text>
            <Switch value={sketchMode} onValueChange={setSketchMode} trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Show Snap Points</Text>
            <Switch value={showSnapPoints} onValueChange={setShowSnapPoints} trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }} />
          </View>
        </>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Characters</Text>
        <Switch value={charactersEnabled} onValueChange={setCharactersEnabled} trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }} />
      </View>

      {charactersEnabled ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={previewText}
            onChangeText={setPreviewText}
            placeholder="Type characters..."
            placeholderTextColor={FIELDS_COLORS.textDim}
            autoCapitalize="characters"
            style={{
              height: 44,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.panelBorder,
              borderRadius: 8,
              paddingHorizontal: 12,
              color: FIELDS_COLORS.textMain,
              backgroundColor: FIELDS_COLORS.surfaceSolid,
            }}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["smooth", "stencil"] as FontStyle[]).map((style) => (
              <Pressable
                key={style}
                onPress={() => setFontStyle(style)}
                style={{
                  flex: 1,
                  height: 36,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: fontStyle === style ? FIELDS_COLORS.tealDark : FIELDS_COLORS.surfaceSolid,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700", textTransform: "capitalize" }}>
                  {style}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {ROAD_SIGN_TYPES.map((sign) => {
            const selected = selectedSign === sign;
            return (
              <Pressable
                key={sign}
                onPress={() => setSelectedSign(sign)}
                style={{
                  alignItems: "center",
                  gap: 6,
                  padding: 8,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: selected ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.panelBorder,
                  backgroundColor: selected ? FIELDS_COLORS.accentMuted : FIELDS_COLORS.surfaceSolid,
                }}
              >
                <RoadSignThumbnail sign={sign} />
                <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 9, fontWeight: "700" }}>
                  {ROAD_SIGN_LABELS[sign]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={{ gap: 6 }}>
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "800", textTransform: "uppercase" }}>
          Size (m): {parsedSize.toFixed(1)}
        </Text>
        <Slider
          style={{ width: "100%", height: 36 }}
          minimumValue={0.5}
          maximumValue={10}
          step={0.1}
          value={parsedSize}
          onValueChange={(val) => setSizeInput(val.toFixed(1))}
          minimumTrackTintColor={FIELDS_COLORS.teal}
          maximumTrackTintColor={FIELDS_COLORS.panelBorder}
          thumbTintColor={FIELDS_COLORS.accentBrand}
        />
      </View>

      <Pressable
        onPress={handleParse}
        disabled={isParsing}
        style={{
          height: 44,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isParsing ? FIELDS_COLORS.textDim : FIELDS_COLORS.tealDark,
        }}
      >
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
          {isParsing ? "Sending..." : "Send Template to Rover"}
        </Text>
      </Pressable>
    </View>
  );
}