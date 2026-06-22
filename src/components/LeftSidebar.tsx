import React, { useEffect, useMemo, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Slider from "@react-native-community/slider";
import * as FileSystem from "expo-file-system/legacy";
import {
  Battery,
  ChevronLeft,
  X,
  Copy,
  FileUp,
  Info,
  ListChecks,
  MapPinned,
  Play,
  Satellite,
  Search,
  Settings2,
  Signal,
  Square,
  Trash2,
  Upload,
} from "lucide-react-native";

import type { Palette } from "../theme/colors";
import type {
  ImportedPlan,
  LayerVisibility,
  MarkingStyle,
  PlanLine,
  SidebarPanel,
} from "../types/plan";

const sliderThumbImage = require("../../assets/slider-thumb.png");

interface LeftSidebarProps {
  palette: Palette;
  compact: boolean;
  mode: "menu" | "panel";
  activePanel: SidebarPanel | null;
  onTogglePanel: (panel: SidebarPanel) => void;
  onCloseMenu?: () => void;
  onBack?: () => void;
  importedPlan: ImportedPlan | null;
  layerVisibility: LayerVisibility;
  onToggleLayer: (layer: keyof LayerVisibility) => void;
  onImportPress: () => void;
  onCopyFileName: () => void;
  onDeletePlan: () => void;
  selectedLine: PlanLine | null;
  totalVisibleLines: number;
  missionRunning: boolean;
  onToggleMission: () => void;
  markingStyle: MarkingStyle;
  onSelectMarkingStyle: (style: MarkingStyle) => void;
  rotation: number;
  onDeleteSelectedLine: () => void;
  planNotes: string;
  onSavePlanNotes: (notes: string) => void;
  apiBaseUrl?: string;
}

export function LeftSidebar({
  palette,
  compact,
  mode,
  activePanel,
  onTogglePanel,
  onCloseMenu,
  onBack,
  importedPlan,
  layerVisibility,
  onToggleLayer,
  onImportPress,
  onCopyFileName,
  onDeletePlan,
  selectedLine,
  totalVisibleLines,
  missionRunning,
  onToggleMission,
  markingStyle,
  onSelectMarkingStyle,
  rotation,
  onDeleteSelectedLine,
  planNotes,
  onSavePlanNotes,
  apiBaseUrl,
}: LeftSidebarProps) {
  const { width: screenWidth } = useWindowDimensions();
  const selectedMetrics = useMemo(() => {
    if (!selectedLine) {
      return null;
    }

    const dx = selectedLine.to.x - selectedLine.from.x;
    const dy = selectedLine.to.y - selectedLine.from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;

    return {
      length,
      angle,
      span: `${selectedLine.from.id} to ${selectedLine.to.id}`,
      range: `(${selectedLine.from.x.toFixed(1)}, ${selectedLine.from.y.toFixed(
        1
      )}) -> (${selectedLine.to.x.toFixed(1)}, ${selectedLine.to.y.toFixed(1)})`,
    };
}, [selectedLine]);

  if (mode === "menu") {
    console.log("[LS MENU] rendering in menu mode");
    const menuWidth = compact ? 300 : 340;
    return (
      <Modal
        visible={true}
        transparent={true}
        animationType="none"
        onRequestClose={() => {
          console.log("[LS MODAL] onRequestClose called (hardware back/Android back)");
          onCloseMenu?.();
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(9, 12, 18, 0.85)",
            flexDirection: "row",
          }}
        >
          {/* Sliding menu panel — on the left side */}
          <View
            style={{
              width: menuWidth,
              backgroundColor: palette.panel,
              borderRightWidth: 1,
              borderRightColor: palette.border,
              paddingTop: 18,
              paddingHorizontal: 18,
            }}
          >
            <View className="flex-row items-start justify-between" style={{ gap: 12 }}>
              <View className="flex-1">
                <Text className="text-xs font-semibold" style={{ color: palette.mutedForeground }}>
                  NAVIGATION
                </Text>
                <Text className="mt-2 text-2xl font-semibold" style={{ color: palette.foreground }}>
                  Open a section
                </Text>
                <Text className="mt-1 text-sm" style={{ color: palette.mutedForeground }}>
                  Choose one section at a time to keep the screen simple.
                </Text>
              </View>
<Pressable
                 onPress={onCloseMenu}
                 className="items-center justify-center px-3 py-3"
               >
                 <X size={20} color={palette.foreground} />
              </Pressable>
            </View>

            <View className="mt-6" style={{ gap: 14 }}>
              <MenuButton
                label="Import Profile"
                icon={<FileUp size={26} color={palette.foreground} />}
                palette={palette}
                onPress={() => onTogglePanel("import")}
              />
              <MenuButton
                label="Plan Info"
                icon={<Info size={26} color={palette.foreground} />}
                palette={palette}
                onPress={() => onTogglePanel("details")}
              />
              <MenuButton
                label="Mission Status"
                icon={<ListChecks size={26} color={palette.foreground} />}
                palette={palette}
                onPress={() => onTogglePanel("mission")}
              />
              <MenuButton
                label="Control Section"
                icon={<Settings2 size={26} color={palette.foreground} />}
                palette={palette}
                onPress={() => onTogglePanel("view")}
              />
              <MenuButton
                label="Positioning"
                icon={<MapPinned size={26} color={palette.foreground} />}
                palette={palette}
                onPress={() => onTogglePanel("positioning")}
              />
              <MenuButton
                label="Settings"
                icon={<Settings2 size={26} color={palette.foreground} />}
                palette={palette}
                onPress={() => onTogglePanel("settings")}
              />
            </View>
          </View>
{/* Back-drop — tapping here closes the menu. */}
           <Pressable
             onPress={() => {
               console.log("[LS BACKDROP] onPress called");
               console.trace("[LS BACKDROP] stack trace");
               onCloseMenu?.();
             }}
             style={{
               flex: 1,
             }}
           />
        </View>
      </Modal>
    );
  }

  if (!activePanel) {
    return null;
  }

  const panelWidthPercent = compact ? 0.72 : 0.5;
  const panelWidth = screenWidth * panelWidthPercent;

  return (
    <Modal
      visible={true}
      transparent={true}
      animationType="none"
      onRequestClose={onBack}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(9, 12, 18, 0.85)",
          flexDirection: "row",
        }}
      >
        {/* Panel — visible on the left side */}
        <View
          style={{
            width: panelWidth,
            backgroundColor: palette.background,
            borderRightWidth: 1,
            borderRightColor: palette.border,
          }}
        >
        <View
          className="flex-row items-center border-b px-4 py-3"
          style={{
            borderBottomColor: palette.border,
            backgroundColor: palette.panel,
            gap: 12,
          }}
        >
<Pressable
             onPress={onBack}
             className="h-14 w-14 items-center justify-center rounded-2xl"
           >
             <ChevronLeft size={26} color={palette.foreground} />
          </Pressable>
          <View style={{ marginLeft: 6 }}>
            <Text className="text-xs font-semibold" style={{ color: palette.mutedForeground }}>
              SECTION
            </Text>
            <Text className="text-xl font-semibold" style={{ color: palette.foreground }}>
              {panelTitle(activePanel)}
            </Text>
          </View>
        </View>

        <ScrollView
          key={activePanel}
          contentContainerStyle={{ padding: 20, gap: 20 }}
          showsVerticalScrollIndicator={false}
        >
          <PanelContent
            activePanel={activePanel}
            palette={palette}
            importedPlan={importedPlan}
            layerVisibility={layerVisibility}
            onToggleLayer={onToggleLayer}
            onImportPress={onImportPress}
            onCopyFileName={onCopyFileName}
            onDeletePlan={onDeletePlan}
            selectedLine={selectedLine}
            selectedMetrics={selectedMetrics}
            totalVisibleLines={totalVisibleLines}
            missionRunning={missionRunning}
            onToggleMission={onToggleMission}
            markingStyle={markingStyle}
            onSelectMarkingStyle={onSelectMarkingStyle}
            rotation={rotation}
            onDeleteSelectedLine={onDeleteSelectedLine}
            planNotes={planNotes}
            onSavePlanNotes={onSavePlanNotes}
            apiBaseUrl={apiBaseUrl}
          />
        </ScrollView>
      </View>
        <Pressable
          onPress={onBack}
          style={{
            flex: 1,
          }}
        />
      </View>
    </Modal>
  );
}

function PanelContent({
  activePanel,
  palette,
  importedPlan,
  layerVisibility,
  onToggleLayer,
  onImportPress,
  onCopyFileName,
  onDeletePlan,
  selectedLine,
  selectedMetrics,
  totalVisibleLines,
  missionRunning,
  onToggleMission,
  markingStyle,
  onSelectMarkingStyle,
  rotation,
  onDeleteSelectedLine,
  planNotes,
  onSavePlanNotes,
  apiBaseUrl,
}: {
  activePanel: SidebarPanel;
  palette: Palette;
  importedPlan: ImportedPlan | null;
  layerVisibility: LayerVisibility;
  onToggleLayer: (layer: keyof LayerVisibility) => void;
  onImportPress: () => void;
  onCopyFileName: () => void;
  onDeletePlan: () => void;
  selectedLine: PlanLine | null;
  selectedMetrics: {
    length: number;
    angle: number;
    span: string;
    range: string;
  } | null;
  totalVisibleLines: number;
  missionRunning: boolean;
  onToggleMission: () => void;
  markingStyle: MarkingStyle;
  onSelectMarkingStyle: (style: MarkingStyle) => void;
  rotation: number;
  onDeleteSelectedLine: () => void;
  planNotes: string;
  onSavePlanNotes: (notes: string) => void;
  apiBaseUrl?: string;
}) {
  const [fieldName, setFieldName] = useState("");
  const [fieldNotes, setFieldNotes] = useState(planNotes);
  const [loadedInfo, setLoadedInfo] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  const [manualPainting, setManualPainting] = useState(false);
  const [paintWhenReversing, setPaintWhenReversing] = useState(false);
  const [pumpStartDelay, setPumpStartDelay] = useState(0.2);
  const [pumpStopDelay, setPumpStopDelay] = useState(0.2);
  const [rateModalOpen, setRateModalOpen] = useState(false);
  const [slowestRateDraft, setSlowestRateDraft] = useState(100);
  const [fastestRateDraft, setFastestRateDraft] = useState(100);
  const [slowestRate, setSlowestRate] = useState(100);
  const [fastestRate, setFastestRate] = useState(100);
  const [pumpRelayInstalled, setPumpRelayInstalled] = useState(true);
  const [offsetSideways, setOffsetSideways] = useState("0.085");
  const [offsetFront, setOffsetFront] = useState("0.000");
  const [offsetUp, setOffsetUp] = useState("0.500");
  const [mowDeckCutWidth, setMowDeckCutWidth] = useState("1.000");
  const [savedDimensions, setSavedDimensions] = useState({
    offsetSideways: "0.085",
    offsetFront: "0.000",
    offsetUp: "0.500",
    mowDeckCutWidth: "1.000",
  });

  useEffect(() => {
    if (!importedPlan) {
      setFieldName("");
      setFieldNotes("");
      return;
    }

    const nextName = importedPlan.fileName.replace(/\.(csv|dxf)$/i, "");
    setFieldName(nextName);
    setFieldNotes(planNotes);
  }, [importedPlan]);

  useEffect(() => {
    setFieldNotes(planNotes);
  }, [planNotes]);

  const hasDimensionChanges =
    offsetSideways !== savedDimensions.offsetSideways ||
    offsetFront !== savedDimensions.offsetFront ||
    offsetUp !== savedDimensions.offsetUp ||
    mowDeckCutWidth !== savedDimensions.mowDeckCutWidth;

  function resolveApiUrl(path: string) {
    if (apiBaseUrl) {
      return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
    }
    return path;
  }

  if (activePanel === "import") {
    return (
      <View className="gap-6">
        <SectionIntro
          title="Import Profile"
          subtitle="Import a DXF or CSV file and decide which layers are visible."
          palette={palette}
        />

        <View
          className="gap-4 rounded-xl border p-4"
          style={{
            borderColor: palette.border,
            backgroundColor: palette.background,
          }}
        >
<Pressable
             onPress={onImportPress}
             className="h-14 flex-row items-center justify-center self-start rounded-md px-4"
             style={{ backgroundColor: palette.foreground, gap: 8, minWidth: 180 }}
           >
            <Upload size={18} color={palette.background} />
            <Text
              className="text-sm font-semibold"
              style={{ color: palette.background }}
            >
              Import File
            </Text>
          </Pressable>

          <Text className="text-xs" style={{ color: palette.mutedForeground }}>
            Only CSV and DXF supported.
          </Text>

          {importedPlan ? (
            <>
              <MetaPill
                label="Imported file"
                value={importedPlan.fileName}
                palette={palette}
              />

              <View className="mt-2 flex-row items-center justify-between" style={{ gap: 8 }}>
                <Pressable
                  onPress={async () => {
                    if (!importedPlan) return;
                    try {
                      const resp = await fetch(resolveApiUrl(`/api/mission/load`), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ mission_file: importedPlan.fileName }),
                      });
                      if (!resp.ok) {
                        const txt = await resp.text();
                        console.error("Load failed:", resp.status, txt);
                        return;
                      }
                      const data = await resp.json();
                      setLoadedInfo(`Loaded: ${data.loaded} (${data.num_points} points)`);
                      setIsLoaded(true);
                    } catch (err) {
                      console.error("Load error:", err);
                    }
                  }}
                  className="h-10 items-center justify-center rounded-md px-3"
                  style={{ backgroundColor: palette.foreground }}
                >
                  <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                    Load
                  </Text>
                </Pressable>

                {isLoaded ? (
                  <View className="flex-row" style={{ gap: 8 }}>
                    <Pressable
                      onPress={async () => {
                        try {
                          if (missionRunning) {
                            const resp = await fetch(resolveApiUrl(`/api/mission/stop`), { method: "POST" });
                            if (!resp.ok) {
                              const txt = await resp.text();
                              console.error("Stop failed:", resp.status, txt);
                              return;
                            }
                            onToggleMission();
                          } else {
                            const resp = await fetch(resolveApiUrl(`/api/mission/start`), { method: "POST" });
                            if (!resp.ok) {
                              const txt = await resp.text();
                              console.error("Start failed:", resp.status, txt);
                              return;
                            }
                            onToggleMission();
                          }
                        } catch (err) {
                          console.error("Start/Stop error:", err);
                        }
                      }}
                      className="h-10 items-center justify-center rounded-md px-3"
                      style={{ backgroundColor: missionRunning ? palette.crimson : palette.emerald }}
                    >
                      <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                        {missionRunning ? "Stop" : "Start"}
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={() => setExportModalOpen(true)}
                      className="h-10 items-center justify-center rounded-md px-3 border"
                      style={{ borderColor: palette.foreground }}
                    >
                      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                        Export
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>

              {loadedInfo ? (
                <Text className="mt-2 text-sm" style={{ color: palette.mutedForeground }}>
                  {loadedInfo}
                </Text>
              ) : null}
              <Modal
                visible={exportModalOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setExportModalOpen(false)}
              >
                <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: "rgba(0,0,0,0.55)" }}>
                  <View className="w-full max-w-[360px] rounded-xl border p-5" style={{ borderColor: palette.border, backgroundColor: palette.panel, gap: 14 }}>
                    <Text className="text-lg font-semibold" style={{ color: palette.foreground }}>Export File</Text>
                    <LabeledInput label="Filename" value={exportFileName} onChangeText={setExportFileName} palette={palette} />
                    <Text className="text-sm" style={{ color: palette.mutedForeground }}>Provide a filename (include .csv or .dxf extension).</Text>

                    <View className="flex-row" style={{ gap: 10 }}>
                      <Pressable onPress={() => setExportModalOpen(false)} className="flex-1 items-center justify-center rounded-md border px-4 py-3" style={{ borderColor: palette.foreground, backgroundColor: "transparent" }}>
                        <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        onPress={async () => {
                          // Create a minimal file from plan notes or a placeholder
                          const fname = exportFileName || (importedPlan ? importedPlan.fileName : "export.csv");
                          const hasExt = /\.[a-zA-Z0-9]+$/.test(fname);
                          const safeName = hasExt ? fname : `${fname}.csv`;
                          const content = fieldNotes || "";
                          try {
                            const tempFileName = `${Date.now()}-${safeName.replace(/[\\/:*?"<>|]/g, "_")}`;
                            const tempFileUri = `${FileSystem.cacheDirectory ?? ""}${tempFileName}`;
                            await FileSystem.writeAsStringAsync(tempFileUri, content, {
                              encoding: FileSystem.EncodingType.UTF8,
                            });
                            const form = new FormData();
                            form.append("file", {
                              uri: tempFileUri,
                              name: safeName,
                              type: "text/plain",
                            } as any);
                            const resp = await fetch(resolveApiUrl(`/api/path/upload`), { method: "POST", body: form });
                            if (!resp.ok) {
                              const txt = await resp.text();
                              console.error("Export/upload failed:", resp.status, txt);
                              return;
                            }
                            setExportModalOpen(false);
                          } catch (err) {
                            console.error("Export error:", err);
                          }
                        }}
                        className="flex-1 items-center justify-center rounded-md px-4 py-3"
                        style={{ backgroundColor: palette.foreground }}
                      >
                        <Text className="text-sm font-semibold" style={{ color: palette.background }}>Save</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </Modal>

              <LabeledInput
                label="Field Name"
                value={fieldName}
                onChangeText={setFieldName}
                palette={palette}
              />
              <LabeledInput
                label="Field Notes"
                value={fieldNotes}
                onChangeText={setFieldNotes}
                palette={palette}
                multiline
              />
              {fieldNotes.trim() !== planNotes.trim() && fieldNotes.trim() ? (
                <View className="items-end -mt-2">
<Pressable
                     onPress={() => onSavePlanNotes(fieldNotes.trim())}
                     className="rounded-md border px-4 py-3"
                     style={{
                       borderColor: palette.emerald,
                       backgroundColor: "transparent",
                     }}
                   >
                     <Text className="text-sm font-semibold" style={{ color: palette.emerald }}>
                       Add Notes
                     </Text>
                  </Pressable>
                </View>
              ) : null}

              <View className="flex-row flex-wrap" style={{ gap: 10 }}>
                <ActionChip
                  icon={<Copy size={16} color={palette.foreground} />}
                  label="Copy file name"
                  palette={palette}
                  onPress={onCopyFileName}
                />
                <ActionChip
                  icon={<Trash2 size={16} color="#FFFFFF" />}
                  label="Delete plan"
                  palette={palette}
                  destructive
                  wide
                  onPress={onDeletePlan}
                />
              </View>
            </>
          ) : null}
        </View>

        {importedPlan ? (
          <View className="gap-3">
            <Text style={labelStyle(palette)}>Visible Layers</Text>
            <CheckboxRow
              label="Boundary"
              checked={layerVisibility.boundary}
              onPress={() => onToggleLayer("boundary")}
              palette={palette}
            />
            <CheckboxRow
              label="Marking"
              checked={layerVisibility.marking}
              onPress={() => onToggleLayer("marking")}
              palette={palette}
            />
            <CheckboxRow
              label="Center"
              checked={layerVisibility.center}
              onPress={() => onToggleLayer("center")}
              palette={palette}
            />
          </View>
        ) : null}
      </View>
    );
  }

  if (activePanel === "details") {
    return (
      <View className="gap-6">
        <SectionIntro
          title="Plan Info"
          subtitle="Select a line in the canvas to inspect its values here."
          palette={palette}
        />

        <View
          className="gap-4 rounded-2xl border p-5"
          style={{
            borderColor: palette.border,
            backgroundColor: palette.background,
          }}
        >
          <Text style={labelStyle(palette)}>Plan Overview</Text>
          <View className="flex-row flex-wrap" style={{ gap: 12 }}>
            <OverviewChip label="Segments" value={`${totalVisibleLines}`} palette={palette} />
            <OverviewChip
              label="File"
              value={importedPlan ? "Imported" : "Not imported"}
              palette={palette}
            />
            <OverviewChip
              label="Selection"
              value={selectedLine ? "Active" : "Waiting"}
              palette={palette}
            />
          </View>
          <View
            className="rounded-2xl px-4 py-4"
            style={{ backgroundColor: palette.panel }}
          >
            <Text style={labelStyle(palette)}>Current Line</Text>
            <Text className="mt-2 text-lg font-semibold" style={{ color: palette.foreground }}>
              {selectedLine?.label ?? "Tap a line in the map"}
            </Text>
            <Text className="mt-1 text-sm" style={{ color: palette.mutedForeground }}>
              {importedPlan?.fileName ?? "Import a plan to start reviewing line details."}
            </Text>
            {planNotes ? (
              <View className="mt-3 rounded-xl px-3 py-3" style={{ backgroundColor: palette.background }}>
                <Text style={labelStyle(palette)}>Field Notes</Text>
                <Text className="mt-1 text-sm" style={{ color: palette.foreground }}>
                  {planNotes}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {selectedLine && selectedMetrics ? (
          <View
            className="rounded-2xl border p-5"
            style={{ borderColor: palette.border, backgroundColor: palette.background }}
          >
            <Text style={labelStyle(palette)}>Selected Line Details</Text>
            <View className="mt-4" style={{ gap: 12 }}>
              <ReadableRow label="Layer" value={selectedLine.layer} palette={palette} />
              <ReadableRow
                label="Length"
                value={`${selectedMetrics.length.toFixed(2)} m`}
                palette={palette}
              />
              <ReadableRow
                label="Width"
                value={`${selectedLine.width.toFixed(2)} m`}
                palette={palette}
              />
              <ReadableRow
                label="Angle"
                value={`${selectedMetrics.angle.toFixed(1)} deg`}
                palette={palette}
              />
              <ReadableRow label="Point span" value={selectedMetrics.span} palette={palette} />
              <ReadableRow label="Range" value={selectedMetrics.range} palette={palette} />
            </View>
          </View>
        ) : (
          <EmptyNote
            title="No line selected yet"
            body="After you import a plan, tap any highlighted line in the canvas and its details will show up here."
            palette={palette}
          />
        )}
      </View>
    );
  }

  if (activePanel === "mission") {
    return (
      <View className="gap-6">
        <SectionIntro
          title="Mission Status"
          subtitle="A clear view of what the tablet and machine are doing right now."
          palette={palette}
        />

        <View className="gap-3">
          <Text style={labelStyle(palette)}>Live Checks</Text>
          <View className="flex-row flex-wrap" style={{ gap: 12 }}>
            <StatusIconCard
              icon={<Battery size={24} color={palette.foreground} />}
              title="Battery"
              value="87%"
              palette={palette}
            />
            <StatusIconCard
              icon={<MapPinned size={24} color={palette.foreground} />}
              title="Location"
              value="Locked"
              palette={palette}
            />
            <StatusIconCard
              icon={<Satellite size={24} color={palette.foreground} />}
              title="RTK"
              value="Fixed"
              palette={palette}
            />
            <StatusIconCard
              icon={<Search size={24} color={palette.foreground} />}
              title="Machine"
              value="Searching"
              palette={palette}
            />
            <StatusIconCard
              icon={<Signal size={24} color={palette.foreground} />}
              title="Signal"
              value="Strong"
              palette={palette}
            />
          </View>
        </View>

        <View
          className="gap-3 rounded-xl border p-4"
          style={{
            borderColor: palette.border,
            backgroundColor: palette.background,
          }}
        >
          <DetailRow
            label="Current Status"
            value={missionRunning ? "Tablet connected to mission" : "Tablet ready"}
            palette={palette}
          />
          <DetailRow
            label="To Proceed"
            value="Ensure the tablet is configured"
            palette={palette}
          />
          <DetailRow
            label="Next Status"
            value="Connected to machine"
            palette={palette}
          />
          <DetailRow
            label="Plan Rotation"
            value={`${rotation.toFixed(0)} deg`}
            palette={palette}
          />
        </View>

        <Pressable
          onPress={onToggleMission}
          className="h-12 items-center justify-center self-start rounded-md px-6"
          style={{
            backgroundColor: missionRunning ? palette.crimson : palette.emerald,
            minWidth: 180,
          }}
        >
          <View className="flex-row items-center" style={{ gap: 8 }}>
            {missionRunning ? (
              <Square size={18} color="#FFFFFF" />
            ) : (
              <Play size={18} color="#FFFFFF" />
            )}
            <Text
              className="text-base font-semibold"
              style={{ color: "#FFFFFF" }}
            >
              {missionRunning ? "STOP" : "START"}
            </Text>
          </View>
        </Pressable>

        <View className="gap-3">
          <Text style={labelStyle(palette)}>Field Category</Text>
          <View className="flex-row flex-wrap" style={{ gap: 10 }}>
            <DisabledTag label="Football" palette={palette} />
            <DisabledTag label="Rugby" palette={palette} />
            <DisabledTag label="North American Football" palette={palette} />
            <DisabledTag label="Running Tracks" palette={palette} />
            <DisabledTag label="Athletics" palette={palette} />
            <DisabledTag label="Ball and Net Sports" palette={palette} />
            <DisabledTag label="Racquet" palette={palette} />
            <DisabledTag label="Bat and Stick Sports" palette={palette} />
            <DisabledTag label="Miscellaneous Fields" palette={palette} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-6">
      <SectionIntro
        title="Control Section"
        subtitle="Plan interaction and painting preferences for the imported field."
        palette={palette}
      />

      <View
        className="gap-3 rounded-xl border p-4"
        style={{
          borderColor: palette.border,
          backgroundColor: palette.background,
        }}
      >
        <DetailRow
          label="Current file"
          value={importedPlan?.fileName ?? "Nothing imported"}
          palette={palette}
        />
        <DetailRow
          label="Layer visibility"
          value={`${Number(layerVisibility.boundary) + Number(layerVisibility.marking) + Number(layerVisibility.center)} / 3 active`}
          palette={palette}
        />
      </View>

      <View className="gap-4">
        <ToggleRow
          label="Manual painting with long press"
          value={manualPainting}
          onValueChange={setManualPainting}
          palette={palette}
        />
        <ToggleRow
          label="Paint when reversing"
          value={paintWhenReversing}
          onValueChange={setPaintWhenReversing}
          palette={palette}
        />
      </View>

      <SliderBlock
        label="Pump Start Delay [s]"
        value={pumpStartDelay}
        onValueChange={setPumpStartDelay}
        palette={palette}
      />

      <SliderBlock
        label="Pump Stop Delay [s]"
        value={pumpStopDelay}
        onValueChange={setPumpStopDelay}
        palette={palette}
      />

      <View
        className="gap-3 rounded-xl border p-4"
        style={{
          borderColor: palette.border,
          backgroundColor: palette.background,
        }}
      >
        <Text style={labelStyle(palette)}>Heading Paint Rate</Text>
        <DetailRow
          label="Slowest rate"
          value={`${slowestRate}%`}
          palette={palette}
        />
        <DetailRow
          label="Fastest rate"
          value={`${fastestRate}%`}
          palette={palette}
        />
          <Pressable
            onPress={() => {
              setSlowestRateDraft(slowestRate);
              setFastestRateDraft(fastestRate);
              setRateModalOpen(true);
            }}
            className="mt-2 h-11 items-center justify-center self-start rounded-md border px-5"
            style={{
              borderColor: palette.foreground,
              backgroundColor: "transparent",
              minWidth: 180,
            }}
          >
            <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
              Adjust
            </Text>
        </Pressable>
      </View>

      <View className="gap-3">
        <Text style={labelStyle(palette)}>Heading Dimensions</Text>
        <DimensionInput
          label="Offset Sideways"
          value={offsetSideways}
          onChangeText={setOffsetSideways}
          palette={palette}
        />
        <DimensionInput
          label="Offset Front"
          value={offsetFront}
          onChangeText={setOffsetFront}
          palette={palette}
        />
        <DimensionInput
          label="Offset Up"
          value={offsetUp}
          onChangeText={setOffsetUp}
          palette={palette}
        />
        <DimensionInput
          label="Mow Deck Cut Width"
          value={mowDeckCutWidth}
          onChangeText={setMowDeckCutWidth}
          palette={palette}
        />

{hasDimensionChanges ? (
           <View className="flex-row flex-wrap" style={{ gap: 10 }}>
             <Pressable
               onPress={() => {
                 setOffsetSideways(savedDimensions.offsetSideways);
                 setOffsetFront(savedDimensions.offsetFront);
                 setOffsetUp(savedDimensions.offsetUp);
                 setMowDeckCutWidth(savedDimensions.mowDeckCutWidth);
               }}
               className="items-center justify-center rounded-md px-4 py-4"
               style={{
                 borderWidth: 1,
                 borderColor: palette.foreground,
                 backgroundColor: "transparent",
                 width: "48%",
               }}
             >
               <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                 Cancel Changes
               </Text>
             </Pressable>
             <Pressable
               onPress={() =>
                 setSavedDimensions({
                   offsetSideways,
                   offsetFront,
                   offsetUp,
                   mowDeckCutWidth,
                 })
               }
               className="items-center justify-center rounded-md px-4 py-4"
               style={{ backgroundColor: palette.foreground, width: "48%" }}
             >
               <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                 Save Changes
               </Text>
             </Pressable>
           </View>
         ) : null}
      </View>

      <Modal
        visible={rateModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRateModalOpen(false)}
      >
        <View
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
        >
          <View
            className="w-full max-w-[360px] rounded-xl border p-5"
            style={{
              borderColor: palette.border,
              backgroundColor: palette.panel,
              gap: 14,
            }}
          >
            <Text className="text-lg font-semibold" style={{ color: palette.foreground }}>
              Heading Paint Rate
            </Text>
            <RateSlider
              label="Slowest rate"
              value={slowestRateDraft}
              onValueChange={setSlowestRateDraft}
              palette={palette}
            />
            <RateSlider
              label="Fastest rate"
              value={fastestRateDraft}
              onValueChange={setFastestRateDraft}
              palette={palette}
            />

            <CheckboxRow
              label="Pump relay installed"
              checked={pumpRelayInstalled}
              onPress={() => setPumpRelayInstalled((current) => !current)}
              palette={palette}
            />

            <View className="flex-row" style={{ gap: 10 }}>
              <Pressable
                onPress={() => setRateModalOpen(false)}
                className="flex-1 items-center justify-center rounded-md border px-4 py-3"
                style={{ borderColor: palette.foreground, backgroundColor: "transparent" }}
              >
                <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setSlowestRate(slowestRateDraft);
                  setFastestRate(fastestRateDraft);
                  setRateModalOpen(false);
                }}
                className="flex-1 items-center justify-center rounded-md px-4 py-3"
                style={{ backgroundColor: palette.foreground }}
              >
                <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                  Save
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SectionIntro({
  title,
  subtitle,
  palette,
}: {
  title: string;
  subtitle: string;
  palette: Palette;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xl font-semibold" style={{ color: palette.foreground }}>
        {title}
      </Text>
      <Text className="text-sm" style={{ color: palette.mutedForeground }}>
        {subtitle}
      </Text>
    </View>
  );
}

function panelTitle(panel: SidebarPanel) {
  if (panel === "import") {
    return "Import Profile";
  }

  if (panel === "details") {
    return "Plan Info";
  }

  if (panel === "mission") {
    return "Mission Status";
  }

  return "Control Section";
}

function MenuButton({
  label,
  icon,
  palette,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center rounded-2xl border px-4 py-4"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.background,
        gap: 14,
      }}
    >
      <View
        className="h-14 w-14 items-center justify-center rounded-2xl"
        style={{ backgroundColor: palette.muted }}
      >
        {icon}
      </View>
      <Text className="flex-1 text-lg font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
      <ChevronLeft size={20} color={palette.mutedForeground} style={{ transform: [{ rotate: "180deg" }] }} />
    </Pressable>
  );
}

function OverviewChip({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View
      className="rounded-2xl px-4 py-3"
      style={{ backgroundColor: palette.panel, minWidth: 112 }}
    >
      <Text style={labelStyle(palette)}>{label}</Text>
      <Text className="mt-1 text-base font-semibold" style={{ color: palette.foreground }}>
        {value}
      </Text>
    </View>
  );
}

function ReadableRow({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View
      className="rounded-2xl px-4 py-4"
      style={{ backgroundColor: palette.panel }}
    >
      <Text style={labelStyle(palette)}>{label}</Text>
      <Text className="mt-1 text-base font-semibold" style={{ color: palette.foreground }}>
        {value}
      </Text>
    </View>
  );
}

function NavButton({
  label,
  active,
  icon,
  onPress,
  palette,
}: {
  label: string;
  active: boolean;
  icon: React.ReactNode;
  onPress: () => void;
  palette: Palette;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="h-14 w-14 items-center justify-center rounded-[16px]"
      style={{
        backgroundColor: active ? palette.foreground : "transparent",
      }}
      accessibilityLabel={label}
    >
      {icon}
    </Pressable>
  );
}

function StatusIconCard({
  icon,
  title,
  value,
  palette,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View
      className="rounded-xl border px-4 py-4"
      style={{
        minWidth: 120,
        borderColor: palette.border,
        backgroundColor: palette.background,
        gap: 10,
      }}
    >
      <View
        className="h-11 w-11 items-center justify-center rounded-xl"
        style={{ backgroundColor: palette.muted }}
      >
        {icon}
      </View>
      <View>
        <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
          {title}
        </Text>
        <Text className="text-sm" style={{ color: palette.mutedForeground }}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function DisabledTag({
  label,
  palette,
}: {
  label: string;
  palette: Palette;
}) {
  return (
    <View
      className="rounded-xl border px-4 py-3"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.muted,
        opacity: 0.55,
      }}
    >
      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
    </View>
  );
}

function CheckboxRow({
  label,
  checked,
  onPress,
  palette,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  palette: Palette;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between rounded-md border p-3"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
      <View
        className="items-center justify-center rounded-sm"
        style={{
          width: 18,
          height: 18,
          borderWidth: 1.5,
          borderColor: checked ? palette.emerald : palette.mutedForeground,
          backgroundColor: checked ? palette.emerald : "transparent",
        }}
      >
        {checked ? (
          <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "700" }}>
            X
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function ToggleRow({
  label,
  value,
  onValueChange,
  palette,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  palette: Palette;
}) {
  return (
    <View
      className="flex-row items-center justify-between rounded-md border p-3"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <Text
        className="mr-3 flex-1 text-sm font-semibold"
        style={{ color: palette.foreground }}
      >
        {label}
      </Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: palette.muted, true: palette.emerald }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

function SliderBlock({
  label,
  value,
  onValueChange,
  palette,
}: {
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  palette: Palette;
}) {
  return (
    <View
      className="gap-3 rounded-xl border p-4"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
          {label}
        </Text>
        <Text className="text-sm" style={{ color: palette.mutedForeground }}>
          {value.toFixed(2)} s
        </Text>
      </View>
      <Slider
        minimumValue={0}
        maximumValue={3}
        step={0.05}
        value={value}
        onValueChange={onValueChange}
        minimumTrackTintColor={palette.emerald}
        maximumTrackTintColor={sliderTrackColor(palette)}
        thumbImage={Platform.OS === "web" ? undefined : sliderThumbImage}
      />
    </View>
  );
}

function RateSlider({
  label,
  value,
  onValueChange,
  palette,
}: {
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  palette: Palette;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
          {label}
        </Text>
        <Text className="text-sm" style={{ color: palette.mutedForeground }}>
          {value}%
        </Text>
      </View>
      <Slider
        minimumValue={0}
        maximumValue={100}
        step={10}
        value={value}
        onValueChange={onValueChange}
        minimumTrackTintColor={palette.emerald}
        maximumTrackTintColor={sliderTrackColor(palette)}
        thumbImage={Platform.OS === "web" ? undefined : sliderThumbImage}
      />
    </View>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  palette,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  palette: Palette;
  multiline?: boolean;
}) {
  return (
    <View className="gap-1.5">
      <Text style={labelStyle(palette)}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        className="rounded-md border px-3 py-3 text-sm font-semibold"
        style={{
          minHeight: multiline ? 92 : undefined,
          color: palette.foreground,
          borderColor: palette.border,
          backgroundColor: palette.panel,
        }}
      />
    </View>
  );
}

function DimensionInput({
  label,
  value,
  onChangeText,
  palette,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  palette: Palette;
}) {
  return (
    <View className="gap-1.5">
      <Text style={labelStyle(palette)}>{label}</Text>
      <View
        className="flex-row items-center rounded-md border px-3"
        style={{
          borderColor: palette.border,
          backgroundColor: palette.background,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          keyboardType="decimal-pad"
          className="flex-1 py-3 text-sm font-semibold"
          style={{ color: palette.foreground }}
        />
        <Text className="text-sm" style={{ color: palette.mutedForeground }}>
          m
        </Text>
      </View>
    </View>
  );
}

function ActionChip({
  icon,
  label,
  palette,
  destructive = false,
  wide = false,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  palette: Palette;
  destructive?: boolean;
  wide?: boolean;
  onPress: () => void;
}) {
  return (
<Pressable
       onPress={onPress}
       className="flex-row items-center justify-center rounded-md border px-4 py-3.5"
       style={{
         gap: 8,
         borderColor: destructive ? palette.crimson : palette.foreground,
         backgroundColor: destructive ? palette.crimson : "transparent",
         minWidth: wide ? 170 : 150,
       }}
     >
      {icon}
      <Text
        className="text-sm font-semibold"
        style={{ color: destructive ? "#FFFFFF" : palette.foreground }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function OptionButton({
  label,
  active,
  palette,
  onPress,
}: {
  label: string;
  active: boolean;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-md border px-4 py-3"
      style={{
        borderColor: active ? palette.foreground : palette.border,
        backgroundColor: active ? palette.muted : palette.background,
      }}
    >
      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

function MetaPill({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View className="gap-1.5">
      <Text style={labelStyle(palette)}>{label}</Text>
      <View
        className="rounded-md border px-3 py-3"
        style={{
          borderColor: palette.border,
          backgroundColor: palette.panel,
        }}
      >
        <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function DetailRow({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View className="gap-1">
      <Text style={labelStyle(palette)}>{label}</Text>
      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
        {value}
      </Text>
    </View>
  );
}

function InfoTile({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View
      className="rounded-md border p-3"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <Text style={labelStyle(palette)}>{label}</Text>
      <Text className="mt-1 text-sm font-semibold" style={{ color: palette.foreground }}>
        {value}
      </Text>
    </View>
  );
}

function EmptyNote({
  title,
  body,
  palette,
}: {
  title: string;
  body: string;
  palette: Palette;
}) {
  return (
    <View
      className="gap-2 rounded-xl border p-4"
      style={{
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
        {title}
      </Text>
      <Text className="text-sm" style={{ color: palette.mutedForeground }}>
        {body}
      </Text>
    </View>
  );
}

function labelStyle(palette: Palette) {
  return {
    color: palette.mutedForeground,
    fontSize: 12,
    fontWeight: "700" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  };
}

function sliderTrackColor(palette: Palette) {
  const isDark = palette.background.toLowerCase() === "#09090b";
  return isDark ? palette.muted : "#B8C3D1";
}
