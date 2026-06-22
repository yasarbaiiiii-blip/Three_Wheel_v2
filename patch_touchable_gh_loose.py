import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Just literally replace all `<TouchableOpacity` with `<GHTouchableOpacity` inside the DraggableFlatList area
start_idx = content.find('<DraggableFlatList')
if start_idx != -1:
    end_idx = content.find('/>', start_idx) + 2
    draggable_block = content[start_idx:end_idx]
    
    new_draggable_block = draggable_block.replace('<TouchableOpacity', '<GHTouchableOpacity')
    new_draggable_block = new_draggable_block.replace('</TouchableOpacity>', '</GHTouchableOpacity>')
    
    content = content[:start_idx] + new_draggable_block + content[end_idx:]

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Replaced inside DraggableFlatList block successfully!")
