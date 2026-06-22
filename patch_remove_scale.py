import sys

with open('App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('<ScaleDecorator>', '')
content = content.replace('</ScaleDecorator>', '')

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Removed ScaleDecorator")
