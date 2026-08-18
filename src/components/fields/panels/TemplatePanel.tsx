import React, { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import Slider from "@react-native-community/slider";
import { Check, ChevronDown, MapPin } from "lucide-react-native";

import { generateRoadSignLines, ROAD_SIGN_LABELS, type RoadSignType } from "../../../utils/roadSignTemplates";
import { generateTextLines, type FontStyle } from "../../../utils/characterTemplates";
import { linesToDxf } from "../../../utils/dxfGenerator";
import { placeTemplateLinesInCsvFrame } from "../../../utils/csvTemplatePlacement";
import type { PlanLine } from "../../../types/plan";
import { FIELDS_COLORS } from "../fieldsTheme";
import { RoadSignThumbnail } from "../RoadSignThumbnail";

const ROAD_SIGN_TYPES = Object.keys(ROAD_SIGN_LABELS) as RoadSignType[];

/** Minimal shape of a placed template used by the dropdown. */
export type PlacedTemplateSummary = {
  id: string;
  fileName: string;
};

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  telemetryPosN?: number | null;
  telemetryPosE?: number | null;
  placementMode?: "dxf" | "csvLocal";
  onAddLocalTemplateLines?: (lines: PlanLine[]) => void;
  canPlace?: boolean;
  placeBlockedReason?: string | null;
  session?: "idle" | "picking" | "ghost";
  selectedLabel?: string | null;
  /** ID of the currently selected placed template. */
  selectedTemplateId?: string | null;
  dragEnabled?: boolean;
  scaleEnabled?: boolean;
  rotateEnabled?: boolean;
  onBeginPlace?: (draft: {
    kind: "sign" | "characters";
    fileName: string;
    sourceLines: PlanLine[];
  }) => void;
  onCancelPlace?: () => void;
  onConfirmPlace?: () => void;
  onToggleDrag?: () => void;
  onToggleScale?: () => void;
  onToggleRotate?: () => void;
  onRemoveSelected?: () => void;
  /** List of all currently placed templates. */
  placedTemplates?: PlacedTemplateSummary[];
  /** Called when the user picks a placed template from the dropdown. */
  onSelectPlacedTemplate?: (id: string) => void;
};

// â”€â”€â”€ PlacedTemplatesDropdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type PlacedTemplatesDropdownProps = {
  templates: PlacedTemplateSummary[];
  selectedId: string | null | undefined;
  onSelect: (id: string) => void;
};

function PlacedTemplatesDropdown({ templates, selectedId, onSelect }: PlacedTemplatesDropdownProps) {
  const [open, setOpen] = useState(false);

  if (templates.length === 0) return null;

  const selectedTemplate = templates.find((t) => t.id === selectedId);

  return (
    <View style={{ zIndex: 30 }}>
      <Text
        style={{
          color: FIELDS_COLORS.textDim,
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 0.6,
          marginBottom: 6,
          textTransform: "uppercase",
        }}
      >
        Placed Templates ({templates.length})
      </Text>

      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel="Placed templates dropdown"
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: 44,
          borderRadius: 10,
          borderWidth: 1.5,
          borderColor: open ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.panelBorder,
          backgroundColor: FIELDS_COLORS.cardSolid,
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <MapPin size={14} color={FIELDS_COLORS.accentBrand} />
        <Text
          style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}
          numberOfLines={1}
        >
          {selectedTemplate?.fileName ?? "Select a placed templateâ€¦"}
        </Text>
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <ChevronDown size={16} color={FIELDS_COLORS.textMuted} />
        </View>
      </Pressable>

      {open ? (
        <View
          style={{
            marginTop: 6,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            backgroundColor: FIELDS_COLORS.cardSolid,
            overflow: "hidden",
          }}
        >
          {templates.map((tpl, index) => {
            const isSelected = tpl.id === selectedId;
            return (
              <Pressable
                key={tpl.id}
                onPress={() => {
                  setOpen(false);
                  onSelect(tpl.id);
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  backgroundColor: isSelected ? "rgba(244,193,12,0.10)" : "transparent",
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: FIELDS_COLORS.accentBrand,
                    opacity: isSelected ? 1 : 0.45,
                  }}
                />
                <Text
                  style={{
                    flex: 1,
                    color: isSelected ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted,
                    fontSize: 13,
                    fontWeight: isSelected ? "800" : "600",
                  }}
                  numberOfLines={1}
                >
                  {tpl.fileName}
                </Text>
                {isSelected ? <Check size={15} color={FIELDS_COLORS.accentBrand} strokeWidth={2.5} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// â”€â”€â”€ ToolBtn â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type ToolBtnProps = {
  label: string;
  active: boolean;
  disabled: boolean;
  onPress?: () => void;
};

function ToolBtn({ label, active, disabled, onPress }: ToolBtnProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      style={[
        {
          flex: 1,
          height: 36,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1.5,
        },
        active
          ? { backgroundColor: FIELDS_COLORS.accentBrand, borderColor: FIELDS_COLORS.accentBorder }
          : disabled
          ? { backgroundColor: FIELDS_COLORS.surfaceSolid, borderColor: FIELDS_COLORS.panelBorder, opacity: 0.4 }
          : { backgroundColor: FIELDS_COLORS.surfaceSolid, borderColor: FIELDS_COLORS.panelBorder },
      ]}
    >
      <Text
        style={{
          color: active ? "#18181b" : FIELDS_COLORS.textMuted,
          fontSize: 11,
          fontWeight: "800",
          letterSpacing: 0.3,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// â”€â”€â”€ TemplatePanel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function TemplatePanel(props: TemplatePanelProps) {
  const { apiBaseUrl, onRefreshPaths, onSelectPath } = props;
  const [internalBoundaryMode] = useState(false);
  const [internalWidthStr, setInternalWidthStr] = useState("4.0");
  const [internalHeightStr, setInternalHeightStr] = useState("3.0");

  const boundaryMode = props.boundaryMode ?? internalBoundaryMode;
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

  const templateTitle = charactersEnabled
    ? `Text ${previewText || "ABC"} ${parsedSize.toFixed(1)}m`
    : `${ROAD_SIGN_LABELS[selectedSign]} ${parsedSize.toFixed(1)}m`;

  const handleParse = useCallback(async () => {
    if (previewLines.length === 0) {
      Alert.alert("Empty Template", "No valid template to generate.");
      return;
    }

    const title = charactersEnabled
      ? `Text_${previewText || "Empty"}_${parsedSize}m`
      : `Road_Sign_${ROAD_SIGN_LABELS[selectedSign].replace(/\s+/g, "_")}_${parsedSize}m`;

    if (props.onBeginPlace) {
      if (props.canPlace === false) {
        Alert.alert("Cannot place yet", props.placeBlockedReason || "Import or align a plan first.");
        return;
      }
      props.onBeginPlace({
        kind: charactersEnabled ? "characters" : "sign",
        fileName: templateTitle,
        sourceLines: previewLines,
      });
      return;
    }

    if (props.placementMode === "csvLocal") {
      if (!props.onAddLocalTemplateLines) {
        Alert.alert("Error", "CSV template placement is not wired.");
        return;
      }
      setIsParsing(true);
      try {
        const placed = placeTemplateLinesInCsvFrame(previewLines, {
          roverNorth: boundaryMode ? 0 : (props.telemetryPosN ?? 0),
          roverEast: boundaryMode ? 0 : (props.telemetryPosE ?? 0),
          offsetEast: boundaryMode ? 0 : 2.0,
          offsetNorth: 0,
          idPrefix: `csv-tpl-${Date.now().toString(36)}`,
          labelPrefix: title,
        });
        props.onAddLocalTemplateLines(placed);
        Alert.alert("Added", `${placed.length} template stroke(s) added to the CSV mission.`);
      } catch (err: any) {
        Alert.alert("Error", err?.message || "Failed to place template on CSV mission.");
      } finally {
        setIsParsing(false);
      }
      return;
    }

    if (!apiBaseUrl) return;

    setIsParsing(true);
    try {
      const fileName = `${title.replace(/\s+/g, "_")}.dxf`;
      let linesToConvert = previewLines;
      if (!boundaryMode) {
        const roverN = props.telemetryPosN ?? 0;
        const roverE = props.telemetryPosE ?? 0;
        linesToConvert = previewLines.map((line) => ({
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    previewLines,
    charactersEnabled,
    previewText,
    parsedSize,
    selectedSign,
    templateTitle,
    boundaryMode,
    apiBaseUrl,
    props.onBeginPlace,
    props.canPlace,
    props.placeBlockedReason,
    props.placementMode,
    props.onAddLocalTemplateLines,
    props.telemetryPosN,
    props.telemetryPosE,
    onRefreshPaths,
    onSelectPath,
  ]);

  // Derived
  const hasSelection = Boolean(props.selectedLabel);
  const toolsDisabled = !hasSelection;
  const placedTemplates = props.placedTemplates ?? [];
  const showDropdown = placedTemplates.length > 0;

  return (
    <View style={{ gap: 14 }}>
      {/* Instruction */}
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 17 }}>
        +Add, tap the map for a ghost, then Place. Select a placed sign to Drag, Scale, or Rotate.
      </Text>

      {/* â”€â”€ Placed Templates Dropdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {showDropdown ? (
        <PlacedTemplatesDropdown
          templates={placedTemplates}
          selectedId={props.selectedTemplateId}
          onSelect={(id) => props.onSelectPlacedTemplate?.(id)}
        />
      ) : null}

      {/* â”€â”€ Drag / Scale / Rotate (always visible) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <View style={{ gap: 8 }}>
        <Text
          style={{
            color: FIELDS_COLORS.textDim,
            fontSize: 10,
            fontWeight: "800",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Transform Tools
        </Text>

        {toolsDisabled ? (
          <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 16 }}>
            Select a placed template above to activate Drag, Scale, or Rotate.
          </Text>
        ) : (
          <Text
            style={{ color: FIELDS_COLORS.accentBrand, fontSize: 11, fontWeight: "700" }}
            numberOfLines={1}
          >
            Selected: {props.selectedLabel}
          </Text>
        )}

        <View style={{ flexDirection: "row", gap: 6 }}>
          <ToolBtn label="Drag" active={!!props.dragEnabled} disabled={toolsDisabled} onPress={props.onToggleDrag} />
          <ToolBtn label="Scale" active={!!props.scaleEnabled} disabled={toolsDisabled} onPress={props.onToggleScale} />
          <ToolBtn label="Rotate" active={!!props.rotateEnabled} disabled={toolsDisabled} onPress={props.onToggleRotate} />
        </View>

        {!toolsDisabled && (props.dragEnabled || props.scaleEnabled || props.rotateEnabled) ? (
          <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 15 }}>
            Tap the template on the map to apply. Tap empty space to deselect.
          </Text>
        ) : null}

        {!toolsDisabled && props.onRemoveSelected ? (
          <Pressable
            onPress={props.onRemoveSelected}
            accessibilityRole="button"
            style={{
              height: 32,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: FIELDS_COLORS.dangerMuted,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.dangerBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 11, fontWeight: "800" }}>
              Remove from map
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Divider */}
      <View style={{ height: 1, backgroundColor: FIELDS_COLORS.panelBorder }} />

      {/* â”€â”€ Characters toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }}>
          Characters
        </Text>
        <Switch
          value={charactersEnabled}
          onValueChange={setCharactersEnabled}
          trackColor={{ false: FIELDS_COLORS.panelBorder, true: FIELDS_COLORS.tealDark }}
        />
      </View>

      {/* â”€â”€ Sign picker or text input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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
                accessibilityRole="button"
                style={[
                  { flex: 1, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1 },
                  fontStyle === style
                    ? { backgroundColor: FIELDS_COLORS.tealDark, borderColor: FIELDS_COLORS.teal }
                    : { backgroundColor: FIELDS_COLORS.surfaceSolid, borderColor: FIELDS_COLORS.panelBorder },
                ]}
              >
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700", textTransform: "capitalize" }}>
                  {style}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
          removeClippedSubviews
        >
          {ROAD_SIGN_TYPES.map((sign) => {
            const selected = selectedSign === sign;
            return (
              <Pressable
                key={sign}
                onPress={() => setSelectedSign(sign)}
                accessibilityRole="button"
                style={[
                  { alignItems: "center", gap: 6, padding: 8, borderRadius: 10, borderWidth: 1 },
                  selected
                    ? { borderColor: FIELDS_COLORS.accentBrand, backgroundColor: FIELDS_COLORS.accentMuted }
                    : { borderColor: FIELDS_COLORS.panelBorder, backgroundColor: FIELDS_COLORS.surfaceSolid },
                ]}
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

      {/* â”€â”€ Size slider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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

      {/* â”€â”€ Session hints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {props.session === "picking" ? (
        <View style={{ backgroundColor: "rgba(244,193,12,0.10)", borderRadius: 8, borderWidth: 1, borderColor: FIELDS_COLORS.accentBorder, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 12, fontWeight: "700" }}>
            ðŸ‘† Tap the map to set the ghost position.
          </Text>
        </View>
      ) : null}
      {props.session === "ghost" ? (
        <View style={{ backgroundColor: "rgba(244,193,12,0.10)", borderRadius: 8, borderWidth: 1, borderColor: FIELDS_COLORS.accentBorder, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 12, fontWeight: "700" }}>
            Ghost is on the map â€” tap Place, or tap again to move it.
          </Text>
        </View>
      ) : null}

      {/* â”€â”€ Action Buttons â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {props.session === "ghost" || props.session === "picking" ? (
          <>
            {/* Cancel */}
            <Pressable
              onPress={props.onCancelPlace}
              accessibilityRole="button"
              style={{
                flex: 1,
                height: 44,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                borderWidth: 1.5,
                borderColor: FIELDS_COLORS.panelBorder,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
                Cancel
              </Text>
            </Pressable>

            {/* Place (ghost ready) or Tap mapâ€¦ (picking) */}
            {props.session === "ghost" ? (
              <Pressable
                onPress={props.onConfirmPlace}
                accessibilityRole="button"
                style={{
                  flex: 1,
                  height: 44,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: FIELDS_COLORS.teal,
                  borderWidth: 1.5,
                  borderColor: FIELDS_COLORS.tealDark,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>Place</Text>
              </Pressable>
            ) : (
              <View
                style={{
                  flex: 1,
                  height: 44,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: FIELDS_COLORS.textDim,
                  borderWidth: 1.5,
                  borderColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>Tap mapâ€¦</Text>
              </View>
            )}
          </>
        ) : (
          /* +Add button */
          <Pressable
            onPress={handleParse}
            disabled={isParsing}
            accessibilityRole="button"
            accessibilityState={{ disabled: isParsing }}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: isParsing ? FIELDS_COLORS.textDim : FIELDS_COLORS.accentBrand,
              borderWidth: 1.5,
              borderColor: isParsing ? FIELDS_COLORS.panelBorder : FIELDS_COLORS.accentBorder,
            }}
          >
            <Text style={{ color: "#18181b", fontSize: 13, fontWeight: "800" }}>
              {isParsing ? "Adding..." : "+ Add"}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
