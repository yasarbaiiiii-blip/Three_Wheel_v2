import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the specific styling of the Path Planning checkbox
pattern = re.compile(
    r'backgroundColor: l\.entity\.is_mark \? "#0ea5e9" : "#f1f5f9",\s*borderWidth: 1, borderColor: l\.entity\.is_mark \? "#0ea5e9" : "#cbd5e1",\s*alignItems: "center", justifyContent: "center"\s*\}\}\s*>\s*\{l\.entity\.is_mark && <Text style=\{\{ color: "#fff", fontSize: 14, fontWeight: "900" \}\}>.*?</Text>\}',
    re.DOTALL
)

replacement = """borderWidth: 1,
                                borderColor: l.entity.is_mark ? "#0d9488" : "rgba(148,163,184,0.5)",
                                backgroundColor: l.entity.is_mark ? "#0d9488" : "transparent",
                                alignItems: "center", justifyContent: "center"
                              }}
                            >
                              {l.entity.is_mark && <CheckIcon size={14} color="#fff" />}"""

new_content, count = pattern.subn(replacement, content)
if count > 0:
    with open('App.tsx', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("Replaced checkbox UI successfully!")
else:
    print("Failed to replace using regex. Check pattern.")
