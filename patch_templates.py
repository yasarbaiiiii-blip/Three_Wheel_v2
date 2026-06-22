import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add BoundaryEditor import
import_stmt = 'import { BoundaryEditor, PlacedItem } from "./src/components/BoundaryEditor";\n'
if import_stmt not in content:
    content = content.replace('import { readImportedPlanFile', import_stmt + 'import { readImportedPlanFile')

# 2. Extract lines from `function TemplatesPage` to `function LayerRow`
start_idx = content.find('function TemplatesPage(props: {')
end_idx = content.find('function LayerRow(', start_idx)

if start_idx != -1 and end_idx != -1:
    new_templates_page = """function TemplatesPage(props: {
  telemetrySnapshot: TelemetrySnapshot | null;
  layerVisibility: LayerVisibility;
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  previewRoverPoint: { north: number; east: number } | null;
  onGenerateTemplate: (name: string, lines: PlanLine[]) => void;
  apiBaseUrl: string;
  onSelectPath: (name: string) => void;
  onRefreshPaths: () => void;
  onNav: (page: Page) => void;
}) {
  const [boundaryMode, setBoundaryMode] = useState(false);
  const [boundaryWidthStr, setBoundaryWidthStr] = useState("4.0");
  const [boundaryHeightStr, setBoundaryHeightStr] = useState("3.0");
  const [indentSpacingStr, setIndentSpacingStr] = useState("0.25");
  const [letterSpacingStr, setLetterSpacingStr] = useState("0.1");
  const [snapCenter, setSnapCenter] = useState(true);
  const [snapCorners, setSnapCorners] = useState(true);
  const [snapAngles, setSnapAngles] = useState(true);
  const [placedItems, setPlacedItems] = useState<PlacedItem[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);

  const [category, setCategory] = useState<"shapes" | "alphabets" | "numbers" | "road_signs" | "sports_fields">("shapes");
  const [fontStyle, setFontStyle] = useState<FontStyle>("smooth");
  const [shape, setShape] = useState<ShapeType>("square");
  const [selectedLetter, setSelectedLetter] = useState<AlphabetType>("A");
  const [selectedDigit, setSelectedDigit] = useState<NumberType>("0");
  const [selectedSign, setSelectedSign] = useState<RoadSignType>("ArrowStraight");
  const [arcType, setArcType] = useState<ArcType>("full");
  const [sizeInput, setSizeInput] = useState("1.0");
  const [isParsing, setIsParsing] = useState(false);

  const parsedSize = Math.max(0.5, Math.min(3.0, parseFloat(sizeInput) || 1.0));
  const bw = parseFloat(boundaryWidthStr) || 4.0;
  const bh = parseFloat(boundaryHeightStr) || 3.0;
  const indent = parseFloat(indentSpacingStr) || 0.25;
  const lSpacing = parseFloat(letterSpacingStr) || 0.1;

  const previewLines = useMemo(() => {
    if (category === "shapes") return generateTemplateLines(shape, parsedSize, arcType);
    if (category === "alphabets") return generateAlphabetLines(selectedLetter, parsedSize, fontStyle);
    if (category === "numbers") return generateNumberLines(selectedDigit, parsedSize, fontStyle);
    if (category === "road_signs") return generateRoadSignLines(selectedSign, parsedSize);
    return [];
  }, [category, shape, selectedLetter, selectedDigit, selectedSign, parsedSize, arcType, fontStyle]);

  const handleAddToBoundary = () => {
    if (previewLines.length === 0) return;
    const newItem: PlacedItem = {
      id: "item-" + Date.now(),
      lines: previewLines,
      x: 0,
      y: 0,
      rotation: 0,
      width: parsedSize, // rough approximation
      height: parsedSize,
    };
    setPlacedItems(prev => [...prev, newItem]);
    setSelectedItemIds([newItem.id]);
  };

  const handleDeleteItem = () => {
    setPlacedItems(prev => prev.filter(p => !selectedItemIds.includes(p.id)));
    setSelectedItemIds([]);
  };

  const handleGroupItems = () => {
     if (selectedItemIds.length < 2) return;
     const groupId = "grp-" + Date.now();
     setPlacedItems(prev => prev.map(p => selectedItemIds.includes(p.id) ? { ...p, groupId } : p));
  };

  const handleParse = async () => {
    if (!props.apiBaseUrl) return;

    let finalLines: PlanLine[] = [];
    let title = "";

    if (boundaryMode) {
      if (placedItems.length === 0) {
        Alert.alert("Empty Boundary", "No items placed in boundary.");
        return;
      }
      title = `Boundary Layout - ${bw}x${bh}`;
      // Transform each item's lines to their real positions
      placedItems.forEach(item => {
         const cos = Math.cos(item.rotation * Math.PI / 180);
         const sin = Math.sin(item.rotation * Math.PI / 180);
         
         item.lines.forEach((l, i) => {
           // Plan coordinates typically: x=North, y=East
           // Our BoundaryEditor maps North/South to Y and East/West to X
           // but keeping PlanLine structure:
           // From: rotate and translate
           const fx = l.from.x * cos - l.from.y * sin;
           const fy = l.from.x * sin + l.from.y * cos;
           const tx = l.to.x * cos - l.to.y * sin;
           const ty = l.to.x * sin + l.to.y * cos;

           finalLines.push({
             ...l,
             id: `${item.id}-${l.id}-${i}`,
             from: { ...l.from, x: fx + item.x, y: fy + item.y },
             to: { ...l.to, x: tx + item.x, y: ty + item.y },
           });
         });
      });
    } else {
      if (previewLines.length === 0) {
        Alert.alert("Empty Template", "No valid template to generate.");
        return;
      }
      title = category === "shapes" 
        ? `${shape.charAt(0).toUpperCase() + shape.slice(1)} Template - ${parsedSize}m`
        : category === "alphabets"
          ? `Letter ${selectedLetter} (${fontStyle}) - ${parsedSize}m`
          : category === "numbers"
            ? `Number ${selectedDigit} (${fontStyle}) - ${parsedSize}m`
            : `Road Sign - ${parsedSize}m`;
      finalLines = previewLines;
    }

    setIsParsing(true);
    try {
      const fileName = `${title.replace(/\s+/g, "_")}.dxf`;
      const fileContent = linesToDxf(finalLines, fileName);

      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, fileContent, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      const formData = new FormData();
      formData.append("file", {
        uri: fileUri,
        name: fileName,
        type: "application/dxf",
      } as any);

      const res = await fetch(`${props.apiBaseUrl}/api/path/parse-dxf`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        Alert.alert("Success", `Template sent and parsed successfully.`);
        props.onRefreshPaths();
        props.onSelectPath(fileName);
        props.onNav("fields");
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
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ width: "58%", backgroundColor: "transparent", padding: 14 }}>
        <View style={{ flex: 1, borderRadius: 20, overflow: "hidden", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
          {boundaryMode ? (
            <BoundaryEditor
              boundaryWidth={bw}
              boundaryHeight={bh}
              indentSpacing={indent}
              letterSpacing={lSpacing}
              items={placedItems}
              setItems={setPlacedItems}
              selectedItemIds={selectedItemIds}
              setSelectedItemIds={setSelectedItemIds}
              snapSettings={{ center: snapCenter, corners: snapCorners, angles: snapAngles }}
            />
          ) : (
            <View style={{ flex: 1, position: "relative" }}>
              <PlanPreview
                lines={previewLines}
                visibility={props.layerVisibility}
                selectedLineId={props.selectedLineId}
                onSelectLine={props.onSelectLine}
                roverPosN={props.previewRoverPoint?.north ?? null}
                roverPosE={props.previewRoverPoint?.east ?? null}
                roverHeadingDeg={props.telemetrySnapshot?.heading_ned_deg ?? null}
              />
            </View>
          )}
        </View>
      </View>
      
      <View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          <View style={{ gap: 12 }}>
            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
              <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>
                Templates
              </Text>
              <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 5 }}>
                {boundaryMode ? "Boundary Mode" : "Generator"}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                 <Text style={{ color: "#cbd5e1", fontSize: 13, fontWeight: "700" }}>Use Boundary Concept</Text>
                 <Switch value={boundaryMode} onValueChange={setBoundaryMode} trackColor={{ false: "#334155", true: "#0b6b68" }} thumbColor={"#f8fafc"} />
              </View>
            </View>

            {boundaryMode && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 12 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>Boundary Settings</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Width (m)</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 8, color: "#0f172a" }} value={boundaryWidthStr} onChangeText={setBoundaryWidthStr} keyboardType="numeric" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Height (m)</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 8, color: "#0f172a" }} value={boundaryHeightStr} onChangeText={setBoundaryHeightStr} keyboardType="numeric" />
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Indent Spacing</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 8, color: "#0f172a" }} value={indentSpacingStr} onChangeText={setIndentSpacingStr} keyboardType="numeric" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Letter Spacing</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 8, color: "#0f172a" }} value={letterSpacingStr} onChangeText={setLetterSpacingStr} keyboardType="numeric" />
                  </View>
                </View>

                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginTop: 8 }}>Object Snapping</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Pressable onPress={() => setSnapCenter(!snapCenter)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: snapCenter ? "#0b6b68" : "#f1f5f9" }}><Text style={{ color: snapCenter ? "#fff" : "#475569", fontSize: 12, fontWeight: "700" }}>Center</Text></Pressable>
                  <Pressable onPress={() => setSnapCorners(!snapCorners)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: snapCorners ? "#0b6b68" : "#f1f5f9" }}><Text style={{ color: snapCorners ? "#fff" : "#475569", fontSize: 12, fontWeight: "700" }}>Corners</Text></Pressable>
                  <Pressable onPress={() => setSnapAngles(!snapAngles)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: snapAngles ? "#0b6b68" : "#f1f5f9" }}><Text style={{ color: snapAngles ? "#fff" : "#475569", fontSize: 12, fontWeight: "700" }}>Angles</Text></Pressable>
                </View>
              </View>
            )}

            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                Category
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                {(["shapes", "alphabets", "numbers", "road_signs", "sports_fields"] as const).map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setCategory(c)}
                    style={{
                      flexBasis: c === "sports_fields" ? "100%" : "47%",
                      padding: 8,
                      borderRadius: 12,
                      backgroundColor: category === c ? "#0b6b68" : "#f8fafc",
                      borderWidth: 1,
                      borderColor: category === c ? "#0b6b68" : "#e2e8f0",
                      alignItems: "center"
                    }}
                  >
                    <Text style={{ color: category === c ? "#fff" : "#0f172a", fontSize: 13, fontWeight: "800", textTransform: "capitalize" }}>
                      {c.replace("_", " ")}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {category === "sports_fields" && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                  Sports Fields
                </Text>
                <Text style={{ color: "#94a3b8", fontSize: 13, textAlign: "center" }}>Empty</Text>
              </View>
            )}

            {(category === "alphabets" || category === "numbers") && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                  Font Style
                </Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {(["smooth", "stencil"] as FontStyle[]).map((f) => (
                    <Pressable
                      key={f}
                      onPress={() => setFontStyle(f)}
                      style={{
                        flex: 1,
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: fontStyle === f ? "#0f172a" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: fontStyle === f ? "#0f172a" : "#e2e8f0",
                        alignItems: "center"
                      }}
                    >
                      <Text style={{ color: fontStyle === f ? "#fff" : "#0f172a", fontSize: 14, fontWeight: "800", textTransform: "capitalize" }}>
                        {f}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                Selection
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {category === "shapes" && ([] as ShapeType[]).concat(["square", "circle", "triangle"]).map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setShape(s)}
                      style={{
                        width: "30%",
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: shape === s ? "#0b6b68" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: shape === s ? "#0b6b68" : "#e2e8f0",
                        alignItems: "center"
                      }}
                    >
                      <Text style={{ color: shape === s ? "#fff" : "#0f172a", fontSize: 13, fontWeight: "800", textTransform: "capitalize" }}>
                        {s}
                      </Text>
                    </Pressable>
                  ))}

                  {category === "alphabets" && Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map((l) => (
                    <Pressable
                      key={l}
                      onPress={() => setSelectedLetter(l as AlphabetType)}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 12,
                        backgroundColor: selectedLetter === l ? "#0b6b68" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: selectedLetter === l ? "#0b6b68" : "#e2e8f0",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                    >
                      <Text style={{ color: selectedLetter === l ? "#fff" : "#0f172a", fontSize: 18, fontWeight: "800" }}>
                        {l}
                      </Text>
                    </Pressable>
                  ))}

                  {category === "numbers" && Array.from("0123456789").map((n) => (
                    <Pressable
                      key={n}
                      onPress={() => setSelectedDigit(n as NumberType)}
                      style={{
                        width: 50,
                        height: 50,
                        borderRadius: 12,
                        backgroundColor: selectedDigit === n ? "#0b6b68" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: selectedDigit === n ? "#0b6b68" : "#e2e8f0",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                    >
                      <Text style={{ color: selectedDigit === n ? "#fff" : "#0f172a", fontSize: 20, fontWeight: "800" }}>
                        {n}
                      </Text>
                    </Pressable>
                  ))}

                  {category === "road_signs" && (Object.keys(ROAD_SIGN_LABELS) as RoadSignType[]).map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setSelectedSign(s)}
                      style={{
                        flexBasis: "31%",
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: selectedSign === s ? "#0f172a" : "#f1f5f9",
                        borderWidth: 1,
                        borderColor: selectedSign === s ? "#0f172a" : "#e2e8f0",
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ color: selectedSign === s ? "#ffffff" : "#475569", fontSize: 13, fontWeight: "700", textAlign: "center" }}>
                        {ROAD_SIGN_LABELS[s]}
                      </Text>
                    </Pressable>
                  ))}
              </View>

              {category === "shapes" && shape === "circle" && (
                <View style={{ marginTop: 20 }}>
                  <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                    Arc Type
                  </Text>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    {([] as ArcType[]).concat(["quarter", "half", "full"]).map((a) => (
                      <Pressable
                        key={a}
                        onPress={() => setArcType(a)}
                        style={{
                          flex: 1,
                          padding: 12,
                          borderRadius: 12,
                          backgroundColor: arcType === a ? "#0b6b68" : "#f8fafc",
                          borderWidth: 1,
                          borderColor: arcType === a ? "#0b6b68" : "#e2e8f0",
                          alignItems: "center"
                        }}
                      >
                        <Text style={{ color: arcType === a ? "#fff" : "#0f172a", fontSize: 14, fontWeight: "800", textTransform: "capitalize" }}>
                          {a === "full" ? "Full" : a === "half" ? "Half" : "Quarter"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
            </View>

            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                Size (Scale)
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Slider
                    style={{ width: "100%", height: 40 }}
                    minimumValue={0.5}
                    maximumValue={3.0}
                    step={0.1}
                    value={parsedSize}
                    onValueChange={(val) => setSizeInput(val.toFixed(2))}
                    minimumTrackTintColor="#0f988f"
                    maximumTrackTintColor="#cbd5e1"
                    thumbTintColor="#0f172a"
                  />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 10 }}>
                  <TextInput
                    value={sizeInput}
                    onChangeText={setSizeInput}
                    keyboardType="numeric"
                    style={{ width: 44, height: 40, color: "#0f172a", fontSize: 14, fontWeight: "700", textAlign: "right" }}
                  />
                  <Text style={{ color: "#64748b", fontSize: 14, fontWeight: "700", marginLeft: 2 }}>m</Text>
                </View>
              </View>
              <Text style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>
                {category === "shapes" ? (shape === "circle" ? "Diameter in meters" : shape === "square" ? "Side length in meters" : "Height in meters") : "Height in meters"}
              </Text>
            </View>

            {boundaryMode && (
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable
                  onPress={handleAddToBoundary}
                  style={{
                    flex: 1,
                    height: 48,
                    borderRadius: 12,
                    backgroundColor: "#0ea5e9",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Add to Boundary</Text>
                </Pressable>
                
                {selectedItemIds.length > 0 && (
                  <>
                    {selectedItemIds.length > 1 && (
                      <Pressable
                        onPress={handleGroupItems}
                        style={{
                          height: 48,
                          paddingHorizontal: 16,
                          borderRadius: 12,
                          backgroundColor: "#6366f1",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Group</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={handleDeleteItem}
                      style={{
                        height: 48,
                        paddingHorizontal: 16,
                        borderRadius: 12,
                        backgroundColor: "#ef4444",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Delete</Text>
                    </Pressable>
                  </>
                )}
              </View>
            )}

            <Pressable
              onPress={handleParse}
              disabled={isParsing || (!boundaryMode && previewLines.length === 0) || (boundaryMode && placedItems.length === 0)}
              style={{
                height: 52,
                borderRadius: 14,
                backgroundColor: isParsing || (!boundaryMode && previewLines.length === 0) || (boundaryMode && placedItems.length === 0) ? "#94a3b8" : "#0f988f",
                alignItems: "center",
                justifyContent: "center",
                marginTop: 10,
                marginBottom: 20
              }}
            >
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800" }}>
                {isParsing ? "Parsing..." : "Parse"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}
"""

    content = content[:start_idx] + new_templates_page + content[end_idx:]

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Replaced TemplatesPage successfully!")
