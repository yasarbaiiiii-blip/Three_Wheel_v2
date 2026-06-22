import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                              style={{
                                width: 24, height: 24, borderRadius: 6,
                                backgroundColor: l.entity.is_mark ? "#0ea5e9" : "#f1f5f9",
                                borderWidth: 1, borderColor: l.entity.is_mark ? "#0ea5e9" : "#cbd5e1",
                                alignItems: "center", justifyContent: "center"
                              }}
                            >
                              {l.entity.is_mark && <Text style={{ color: "#fff", fontSize: 14, fontWeight: "900" }}>✓</Text>}"""

replacement = """                              style={{
                                width: 24, height: 24, borderRadius: 6, borderWidth: 1,
                                borderColor: l.entity.is_mark ? "#0d9488" : "rgba(148,163,184,0.5)",
                                backgroundColor: l.entity.is_mark ? "#0d9488" : "transparent",
                                alignItems: "center", justifyContent: "center"
                              }}
                            >
                              {l.entity.is_mark && <CheckIcon size={14} color="#fff" />}"""

if target in content:
    content = content.replace(target, replacement)
    with open('App.tsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Replaced checkbox UI successfully")
else:
    print("Could not find exact text, attempting regex or manual replace")
    # try relaxing whitespace
    target_clean = re.sub(r'\s+', '', target)
    content_clean = re.sub(r'\s+', '', content)
    if target_clean in content_clean:
        print("Found with stripped whitespace, but this script doesn't handle applying that back easily.")
