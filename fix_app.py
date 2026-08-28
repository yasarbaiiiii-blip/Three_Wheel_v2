import re

with open('App_a0fb.tsx', 'r', encoding='utf-16') as f:
    a0fb = f.read()

with open('App.tsx', 'r', encoding='utf-8') as f:
    app = f.read()

def get_block(text, start_marker, end_marker=None):
    start_idx = text.find(start_marker)
    if start_idx == -1: return None
    if end_marker:
        end_idx = text.find(end_marker, start_idx)
        if end_idx == -1: return None
        return text[start_idx:end_idx + len(end_marker)]
    else:
        # assume block ends at next function or useEffect
        block = ''
        brace_count = 0
        started = False
        for i in range(start_idx, len(text)):
            block += text[i]
            if text[i] == '{':
                brace_count += 1
                started = True
            elif text[i] == '}':
                brace_count -= 1
                if started and brace_count == 0:
                    return block
        return block

# 1. Imports
app = app.replace('import {\n  normalizeTelemetryPacket,\n  rtkModeFromStatus,\n} from "./src/utils/telemetryDeadband";', 'import { normalizeTelemetryPacket } from "./src/utils/telemetryDeadband";\nimport { EMPTY_RTK_STATUS, fetchRtkStatus, normalizeRtkStatus } from "./src/api/rtkStatus";')

app = app.replace('import { normalizeTelemetryPacket, rtkModeFromStatus } from "./src/utils/telemetryDeadband";', 'import { normalizeTelemetryPacket } from "./src/utils/telemetryDeadband";\nimport { EMPTY_RTK_STATUS, fetchRtkStatus, normalizeRtkStatus } from "./src/api/rtkStatus";')

# 2. startLora
lora_a0fb = get_block(a0fb, 'async function startLora() {')
lora_app = get_block(app, 'async function startLora() {')
if lora_a0fb and lora_app:
    app = app.replace(lora_app, lora_a0fb)
else:
    print('Failed to find startLora')

# 3. stopRtk
stop_a0fb = get_block(a0fb, 'async function stopRtk() {')
stop_app = get_block(app, 'async function stopRtk() {')
if stop_a0fb and stop_app:
    app = app.replace(stop_app, stop_a0fb)
else:
    print('Failed to find stopRtk')

# 4. startNtrip (DELETE IT)
ntrip_app = get_block(app, 'async function startNtrip() {')
if ntrip_app:
    app = app.replace(ntrip_app, '')
else:
    print('Failed to find startNtrip')

# 5. useEffect for RTK
ue_a0fb = get_block(a0fb, 'useEffect(() => {\n    if (!apiBaseUrl) {\n      setRtkStatus(EMPTY_RTK_STATUS);')
if not ue_a0fb:
    ue_a0fb = get_block(a0fb, '  useEffect(() => {\n    if (!apiBaseUrl) {\n      setRtkStatus(EMPTY_RTK_STATUS);')

ue_app = get_block(app, 'useEffect(() => {\n    if (!apiBaseUrl) return;\n    const fetchRtkStatus = async () => {')
if not ue_app:
    ue_app = get_block(app, '  useEffect(() => {\n    if (!apiBaseUrl) return;\n    const fetchRtkStatus = async () => {')

if ue_a0fb and ue_app:
    app = app.replace(ue_app, ue_a0fb)
else:
    print('Failed to find useEffect blocks')

# 6. Delete old state variables that might still be there due to non-conflict merges
app = re.sub(r'const \[rtkDefaultMode, setRtkDefaultMode\] = useState[^\n]+\n', '', app)
app = re.sub(r'const \[rtkAutoConnect, setRtkAutoConnect\] = useState[^\n]+\n', '', app)

# 7. Replace old props passing in App.tsx
app = re.sub(r'\s*rtkDefaultMode=\{rtkDefaultMode\}\n', '\n', app)
app = re.sub(r'\s*setRtkDefaultMode=\{setRtkDefaultMode\}\n', '\n', app)
app = re.sub(r'\s*rtkAutoConnect=\{rtkAutoConnect\}\n', '\n', app)
app = re.sub(r'\s*setRtkAutoConnect=\{setRtkAutoConnect\}\n', '\n', app)
app = re.sub(r'\s*startNtrip=\{startNtrip\}\n', '\n', app)

# also remove rtkRunning and rtkHealthy and rtkMode from being passed as props individually if they still exist!
# Wait! In conflict blocks, they were replaced with rtkStatus={rtkStatus}! 
# But if there are any lingering lines (like line 4625), this will help.
app = re.sub(r'\s*rtkRunning=\{rtkRunning\}\n', '\n', app)
app = re.sub(r'\s*rtkHealthy=\{rtkHealthy\}\n', '\n', app)
app = re.sub(r'\s*rtkMode=\{rtkMode\}\n', '\n', app)

with open('App.tsx', 'w', encoding='utf-8') as f:
    f.write(app)

print('App.tsx patched!')
