import sys

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# We want to replace <Pressable inside <ScaleDecorator> with <GHTouchableOpacity

search_text = """                    <ScaleDecorator>
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
                    </ScaleDecorator>"""

replace_text = """                    <ScaleDecorator>
                      <GHTouchableOpacity
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
                      </GHTouchableOpacity>
                    </ScaleDecorator>"""

if search_text in content:
    content = content.replace(search_text, replace_text)
    with open('App.tsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Successfully replaced Pressable with GHTouchableOpacity")
else:
    print("Could not find the exact search text. Trying regex...")
    import re
    # use regex to just replace <Pressable and </Pressable> between <ScaleDecorator> and </ScaleDecorator>
    
    pattern = re.compile(r'(<ScaleDecorator>\s*)<Pressable(.*?)</Pressable>(\s*</ScaleDecorator>)', re.DOTALL)
    
    def replacer(match):
        return match.group(1) + '<GHTouchableOpacity' + match.group(2) + '</GHTouchableOpacity>' + match.group(3)
        
    new_content, count = pattern.subn(replacer, content)
    if count > 0:
        with open('App.tsx', 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Successfully replaced {count} occurrences using regex.")
    else:
        print("Failed to replace using regex too.")
