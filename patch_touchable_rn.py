import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add TouchableOpacity to react-native imports if not there
if 'TouchableOpacity' not in content and 'react-native"' in content:
    content = content.replace('import { SafeAreaProvider', 'import { TouchableOpacity } from "react-native";\nimport { SafeAreaProvider')

# 2. Replace GHTouchableOpacity with TouchableOpacity
content = content.replace('<GHTouchableOpacity', '<TouchableOpacity')
content = content.replace('</GHTouchableOpacity>', '</TouchableOpacity>')

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated to react-native TouchableOpacity")
