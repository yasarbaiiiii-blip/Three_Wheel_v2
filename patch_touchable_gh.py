import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Make sure we import TouchableOpacity from react-native-gesture-handler as GHTouchableOpacity
if 'GHTouchableOpacity' not in content:
    content = content.replace('import { GestureHandlerRootView } from "react-native-gesture-handler";', 
                              'import { GestureHandlerRootView, TouchableOpacity as GHTouchableOpacity } from "react-native-gesture-handler";')

# Replace the specific <TouchableOpacity in the DraggableFlatList renderItem
# We will just replace it in the context of onLongPress={drag}
content = content.replace('<TouchableOpacity\n                        onLongPress={drag}', '<GHTouchableOpacity\n                        onLongPress={drag}')
content = content.replace('</TouchableOpacity>\n                  )}', '</GHTouchableOpacity>\n                  )}')

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated renderItem to use GHTouchableOpacity!")
