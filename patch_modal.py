import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# We need to find: {/* --- SCALE MODAL --- */}
# And remove it until its closing </Modal>

start_idx = content.find('{/* --- SCALE MODAL --- */}')
if start_idx != -1:
    end_idx = content.find('</Modal>', start_idx)
    if end_idx != -1:
        end_idx += len('</Modal>')
        content = content[:start_idx] + content[end_idx:]

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Removed scale modal")
