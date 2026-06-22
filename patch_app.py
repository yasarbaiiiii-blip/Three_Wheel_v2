import sys

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Replace the old right pane start with the condition
start_marker = '<View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>'
# We need to find the specific one inside FieldsPage.
# Let's use string manipulation based on known surrounding text.

marker_search = """            />
          </View>
        </View>
      </View>
      <View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>
        <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
            <View>"""

new_pane = """            />
          </View>
        </View>
      </View>
      
      {isPathPlanningMode ? (
        <View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>
          {/* Path Planning Header */}
          <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>
                  Field Workspace
                </Text>
                <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 5 }}>
                  Path Planning
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  onPress={() => setInfoModalOpen(true)}
                  style={{
                    height: 36,
                    paddingHorizontal: 12,
                    backgroundColor: "#334155",
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Info</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setIsPathPlanningMode(false);
                    setIsReordering(false);
                  }}
                  style={{
                    height: 36,
                    paddingHorizontal: 12,
                    backgroundColor: "#ef4444",
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Exit</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {/* Filters & Actions */}
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {(["All", "lines", "arcs", "transits", "extensions"] as const).map(f => (
                <Pressable
                  key={f}
                  onPress={() => setPathFilter(f)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 20,
                    backgroundColor: pathFilter === f ? "#0f172a" : "#f1f5f9",
                    borderWidth: 1,
                    borderColor: pathFilter === f ? "#0f172a" : "#e2e8f0"
                  }}
                >
                  <Text style={{ color: pathFilter === f ? "#fff" : "#475569", fontSize: 12, fontWeight: "700", textTransform: "capitalize" }}>
                    {f}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => {
                if (isReordering) {
                  handleSetOrder();
                } else {
                  setIsReordering(true);
                  setPathFilter("All");
                }
              }}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: isReordering ? "#10b981" : "#8b5cf6",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>
                {isReordering ? (isSavingOrder ? "Saving..." : "Save Order") : "Reorder Path"}
              </Text>
            </Pressable>
          </View>

          {/* List Content */}
          <View style={{ flex: 1, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0", overflow: "hidden" }}>
            {isReordering ? (
              <DraggableFlatList
                data={reorderedLines}
                onDragEnd={({ data }) => setReorderedLines(data)}
                keyExtractor={(item) => item.id}
                containerStyle={{ flex: 1 }}
                renderItem={({ item, drag, isActive }) => (
                  <ScaleDecorator>
                    <Pressable
                      onLongPress={drag}
                      disabled={isActive}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        padding: 14,
                        backgroundColor: isActive ? "#f8fafc" : "#fff",
                        borderBottomWidth: 1,
                        borderBottomColor: "#f1f5f9",
                        opacity: isActive ? 0.8 : 1
                      }}
                    >
                      <View style={{ paddingRight: 12 }}>
                        <Text style={{ color: "#cbd5e1", fontSize: 20 }}>☰</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "700" }}>
                          {item.label} <Text style={{ color: "#64748b", fontWeight: "500", fontSize: 12 }}>({item.entity?.entity_type})</Text>
                        </Text>
                      </View>
                    </Pressable>
                  </ScaleDecorator>
                )}
              />
            ) : (
              <ScrollView style={{ flex: 1 }}>
                {lines
                  .filter(l => {
                    if (pathFilter === "All") return true;
                    if (pathFilter === "lines") return l.entity?.entity_type === "line" && l.layer !== "transit" && l.layer !== "extension";
                    if (pathFilter === "arcs") return l.entity?.entity_type === "arc" || l.entity?.entity_type === "circle";
                    if (pathFilter === "transits") return l.layer === "transit";
                    if (pathFilter === "extensions") return l.layer === "extension";
                    return true;
                  })
                  .map(l => {
                    const isPrimary = ["line", "arc", "circle"].includes(l.entity?.entity_type || "") && l.layer !== "transit" && l.layer !== "extension";
                    const isSelected = selectedLineId === l.id;
                    return (
                      <Pressable
                        key={l.id}
                        onPress={() => onSelectLine(isSelected ? null : l.id)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          padding: 14,
                          backgroundColor: isSelected ? "#f0fdfa" : "#fff",
                          borderBottomWidth: 1,
                          borderBottomColor: "#f1f5f9"
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: isSelected ? "#0d9488" : "#0f172a", fontSize: 14, fontWeight: "700" }}>
                            {l.label} <Text style={{ color: "#64748b", fontWeight: "500", fontSize: 12 }}>({l.layer === "transit" || l.layer === "extension" ? l.layer : l.entity?.entity_type})</Text>
                          </Text>
                        </View>
                        {isPrimary && l.entity && (
                          <Pressable
                            onPress={() => {
                              const newLines = [...lines];
                              const idx = newLines.findIndex(x => x.id === l.id);
                              if (idx !== -1 && newLines[idx].entity) {
                                newLines[idx].entity!.is_mark = !newLines[idx].entity!.is_mark;
                                setLines(newLines);
                              }
                            }}
                            style={{
                              width: 24, height: 24, borderRadius: 6,
                              backgroundColor: l.entity.is_mark ? "#0ea5e9" : "#f1f5f9",
                              borderWidth: 1, borderColor: l.entity.is_mark ? "#0ea5e9" : "#cbd5e1",
                              alignItems: "center", justifyContent: "center"
                            }}
                          >
                            {l.entity.is_mark && <Text style={{ color: "#fff", fontSize: 14, fontWeight: "900" }}>✓</Text>}
                          </Pressable>
                        )}
                      </Pressable>
                    );
                  })}
              </ScrollView>
            )}
          </View>
          
          {!isReordering && (
            <Pressable
              onPress={handleSetSpray}
              disabled={isSprayingSet}
              style={{
                height: 48,
                backgroundColor: isSprayingSet ? "#475569" : "#0ea5e9",
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>{isSprayingSet ? "Saving..." : "Save Spray Settings"}</Text>
            </Pressable>
          )}

          {/* Info Modal */}
          <Modal visible={infoModalOpen} transparent={true} animationType="fade">
            <View style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.6)", justifyContent: "center", alignItems: "center" }}>
              <View style={{ width: 340, backgroundColor: "#fff", borderRadius: 16, padding: 20, elevation: 10 }}>
                <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "900", marginBottom: 16 }}>Path Summary</Text>
                
                <View style={{ gap: 12, marginBottom: 20 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Primary Lines</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>
                      {lines.filter(l => l.entity?.entity_type === "line" && l.layer !== "transit" && l.layer !== "extension").length} total 
                      ({lines.filter(l => l.entity?.entity_type === "line" && l.layer !== "transit" && l.layer !== "extension" && l.entity.is_mark).length} spray ready)
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Arcs/Circles</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>
                      {lines.filter(l => (l.entity?.entity_type === "arc" || l.entity?.entity_type === "circle") && l.layer !== "transit" && l.layer !== "extension").length} total
                      ({lines.filter(l => (l.entity?.entity_type === "arc" || l.entity?.entity_type === "circle") && l.layer !== "transit" && l.layer !== "extension" && l.entity.is_mark).length} spray ready)
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Transits</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>{lines.filter(l => l.layer === "transit").length} total (No spray)</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Extensions</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>{lines.filter(l => l.layer === "extension").length} total (No spray)</Text>
                  </View>
                </View>

                <Pressable
                  onPress={() => setInfoModalOpen(false)}
                  style={{ height: 44, backgroundColor: "#f1f5f9", borderRadius: 10, alignItems: "center", justifyContent: "center" }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "800" }}>Close</Text>
                </Pressable>
              </View>
            </View>
          </Modal>

        </View>
      ) : (
      <View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>
        <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
            <View>"""

content = content.replace(marker_search, new_pane)

# 2. Add the closing parenthesis and handle the old Scale Plan button replacement.
scale_btn_search = """                <Pressable
                  onPress={() => setScaleModalOpen(true)}
                  style={{
                    height: 36,
                    paddingHorizontal: 12,
                    backgroundColor: "#eab308",
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Scale Plan</Text>
                </Pressable>"""

new_scale_btn = """                <Pressable
                  onPress={() => setIsPathPlanningMode(true)}
                  style={{
                    height: 36,
                    paddingHorizontal: 12,
                    backgroundColor: "#eab308",
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800" }}>Path Planning</Text>
                </Pressable>"""

content = content.replace(scale_btn_search, new_scale_btn)

# 3. Add the closing tag for the `isPathPlanningMode ? (...) : (...)` block.
end_marker_search = """        </View>
      </View>
    </View>
  );
}



function TemplatesPage(props: {"""

end_new = """        </View>
      </View>
      )}
    </View>
  );
}



function TemplatesPage(props: {"""

content = content.replace(end_marker_search, end_new)

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Update complete")
