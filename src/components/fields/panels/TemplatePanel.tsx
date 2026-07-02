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
  boundaryMode?: boolean;
  onToggleBoundaryMode?: (enabled: boolean) => void;
  boundaryWidthStr?: string;
  onChangeBoundaryWidthStr?: (val: string) => void;
  boundaryHeightStr?: string;
  onChangeBoundaryHeightStr?: (val: string) => void;
  onApplyBoundary?: (w: number, h: number) => void;
  sketchMode?: boolean;
  onToggleSketchMode?: (enabled: boolean) => void;
  showSnapPoints?: boolean;
  onToggleShowSnapPoints?: (enabled: boolean) => void;
  telemetryPosN?: number | null;
  telemetryPosE?: number | null;
};

export function TemplatePanel(props: TemplatePanelProps) {
  const { apiBaseUrl, onRefreshPaths, onSelectPath } = props;
  const [internalBoundaryMode, setInternalBoundaryMode] = useState(false);
  const [internalSketchMode, setInternalSketchMode] = useState(false);
  const [internalShowSnapPoints, setInternalShowSnapPoints] = useState(true);
  const [internalWidthStr, setInternalWidthStr] = useState("4.0");
  const [internalHeightStr, setInternalHeightStr] = useState("3.0");

  const boundaryMode = props.boundaryMode ?? internalBoundaryMode;
  const setBoundaryMode = props.onToggleBoundaryMode ?? setInternalBoundaryMode;
  const sketchMode = props.sketchMode ?? internalSketchMode;
  const setSketchMode = props.onToggleSketchMode ?? setInternalSketchMode;
  const showSnapPoints = props.showSnapPoints ?? internalShowSnapPoints;
  const setShowSnapPoints = props.onToggleShowSnapPoints ?? setInternalShowSnapPoints;
  const widthStr = props.boundaryWidthStr ?? internalWidthStr;
  const setWidthStr = props.onChangeBoundaryWidthStr ?? setInternalWidthStr;
  const heightStr = props.boundaryHeightStr ?? internalHeightStr;
  const setHeightStr = props.onChangeBoundaryHeightStr ?? setInternalHeightStr;
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
      let linesToConvert = previewLines;
      if (!boundaryMode) {
        const roverN = props.telemetryPosN ?? 0;
        const roverE = props.telemetryPosE ?? 0;
        linesToConvert = previewLines.map(line => ({
          ...line,
          from: { ...line.from, x: line.from.x + roverE + 2.0, y: line.from.y + roverN },
          to: { ...line.to, x: line.to.x + roverE + 2.0, y: line.to.y + roverN },
        }));
      }
      const fileContent = linesToDxf(linesToConvert, fileName);
      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, fileContent, { encoding: FileSystem.EncodingType.UTF8 });

      const formData = new FormData();
      formData.append("file", { uri: fileUri, name: fileName, type: "application/dxf" } as any);

      const res = await fetch(`${apiBaseUrl}/api/path/parse-dxf`, { method: "POST", body: formData });
      if (res.ok) {
        Alert.alert("Success", `Component added to map as "${fileName}".`);
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
        <View
          style={{
            padding: 12,
            borderRadius: 12,
            backgroundColor: FIELDS_COLORS.surfaceSolid,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            gap: 12,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Boundary Dimensions
          </Text>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "700" }}>Width (m)</Text>
              <TextInput
                style={{
                  height: 40,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  color: FIELDS_COLORS.textMain,
                  backgroundColor: FIELDS_COLORS.cardSolid,
                  fontSize: 13,
                  fontWeight: "600",
                }}
                value={widthStr}
                onChangeText={setWidthStr}
                keyboardType="numeric"
                placeholder="4.0"
                placeholderTextColor={FIELDS_COLORS.textDim}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "700" }}>Height (m)</Text>
              <TextInput
                style={{
                  height: 40,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  color: FIELDS_COLORS.textMain,
                  backgroundColor: FIELDS_COLORS.cardSolid,
                  fontSize: 13,
                  fontWeight: "600",
                }}
                value={heightStr}
                onChangeText={setHeightStr}
                keyboardType="numeric"
                placeholder="3.0"
                placeholderTextColor={FIELDS_COLORS.textDim}
              />
            </View>
          </View>

          <Pressable
            onPress={() => {
              const w = parseFloat(widthStr);
              const h = parseFloat(heightStr);
              if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
                Alert.alert("Invalid Dimensions", "Please enter valid positive numbers for width and height.");
                return;
              }
              props.onApplyBoundary?.(w, h);
            }}
            style={({ pressed }) => ({
              height: 44,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: FIELDS_COLORS.tealDark,
              borderWidth: 1.5,
              borderColor: "#14b8a6",
              flexDirection: "row",
              elevation: 4,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.3,
              shadowRadius: 3.84,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.5 }}>
              ✓ Apply to Map
            </Text>
          </Pressable>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Sketch Mode</Text>
            <Switch value={sketchMode} onValueChange={setSketchMode} trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>Show Snap Points</Text>
            <Switch value={showSnapPoints} onValueChange={setShowSnapPoints} trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }} />
          </View>
        </View>
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
        style={({ pressed }) => ({
          height: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isParsing ? FIELDS_COLORS.textDim : "#0ea5e9",
          borderWidth: 1.5,
          borderColor: "#38bdf8",
          elevation: 4,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 0.5 }}>
          {isParsing ? "Adding..." : "+ Add"}
        </Text>
      </Pressable>
    </View>
  );
}