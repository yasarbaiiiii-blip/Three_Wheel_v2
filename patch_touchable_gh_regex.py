import sys
import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern to find the renderItem and its TouchableOpacity
pattern = re.compile(r'(renderItem=\{\(\{ item, drag, isActive \}\} => \(\s*)<TouchableOpacity(.*?)</TouchableOpacity>(\s*\)\})', re.DOTALL)

def replacer(match):
    return match.group(1) + '<GHTouchableOpacity' + match.group(2) + '</GHTouchableOpacity>' + match.group(3)

new_content, count = pattern.subn(replacer, content)

if count > 0:
    with open('App.tsx', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"Successfully replaced TouchableOpacity with GHTouchableOpacity ({count} times)!")
else:
    print("Failed to find the TouchableOpacity pattern.")
