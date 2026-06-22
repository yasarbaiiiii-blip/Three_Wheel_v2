import re

with open('App.tsx', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Remove declaration
code = re.sub(r'  const \[frozenRoverPos, setFrozenRoverPos\] = useState[^\n]+\n', '', code)

# 2. Remove from useEffect condition
code = re.sub(r'telemetrySnapshot\?\.mission_state === "running" \|\| frozenRoverPos !== null', 'telemetrySnapshot?.mission_state === "running"', code)

# 3. Remove from dependencies
code = code.replace(', frozenRoverPos]);', ']);')

# 4. Update the mission completion block
old_block = '''        const lastLine = displayedLines[displayedLines.length - 1];
        if (lastLine) {
          setFrozenRoverPos({ n: lastLine.to.x, e: lastLine.to.y });
        }'''
code = code.replace(old_block, '        setAutoOrigin(false);')

# 5. Remove setFrozenRoverPos(null);
code = code.replace('    setFrozenRoverPos(null);\n', '')

# 6. Remove frozenRoverPos from HomeView/SectionScreen usage
code = code.replace('            frozenRoverPos={frozenRoverPos}\n', '')
code = code.replace('  frozenRoverPos,\n', '')

# 7. Remove frozenRoverPos from declarations/props
code = code.replace('  frozenRoverPos: { n: number; e: number } | null;\n', '')

# 8. Update PlanPreview roverPosN/E props
code = code.replace('roverPosN={frozenRoverPos ? frozenRoverPos.n : (telemetrySnapshot?.pos_n ?? null)}', 'roverPosN={telemetrySnapshot?.pos_n ?? null}')
code = code.replace('roverPosE={frozenRoverPos ? frozenRoverPos.e : (telemetrySnapshot?.pos_e ?? null)}', 'roverPosE={telemetrySnapshot?.pos_e ?? null}')

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(code)

print("Replacement complete")
