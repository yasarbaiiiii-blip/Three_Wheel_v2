import os
import sys
import ezdxf
import math

def normalize_entities(entities):
    min_x = float('inf')
    max_x = float('-inf')
    min_y = float('inf')
    max_y = float('-inf')

    # Find bounding box
    for e in entities:
        if e['type'] == 'line':
            min_x = min(min_x, e['p1'][0], e['p2'][0])
            max_x = max(max_x, e['p1'][0], e['p2'][0])
            min_y = min(min_y, e['p1'][1], e['p2'][1])
            max_y = max(max_y, e['p1'][1], e['p2'][1])
        elif e['type'] == 'arc':
            cx, cy, r = e['cx'], e['cy'], e['r']
            min_x = min(min_x, cx - r)
            max_x = max(max_x, cx + r)
            min_y = min(min_y, cy - r)
            max_y = max(max_y, cy + r)

    if min_x == float('inf'):
        return []

    w = max_x - min_x
    h = max_y - min_y
    scale = 1.0 / max(w, h) if max(w, h) > 0 else 1.0

    normalized = []
    for e in entities:
        if e['type'] == 'line':
            nx1 = (e['p1'][0] - min_x) * scale
            ny1 = (e['p1'][1] - min_y) * scale
            nx2 = (e['p2'][0] - min_x) * scale
            ny2 = (e['p2'][1] - min_y) * scale
            normalized.append({'type': 'line', 'p1': (nx1, ny1), 'p2': (nx2, ny2)})
        elif e['type'] == 'arc':
            ncx = (e['cx'] - min_x) * scale
            ncy = (e['cy'] - min_y) * scale
            nr = e['r'] * scale
            normalized.append({
                'type': 'arc',
                'cx': ncx, 'cy': ncy, 'r': nr,
                'start_angle': e['start_angle'], 'end_angle': e['end_angle']
            })

    return normalized

def process_dxf(filepath):
    doc = ezdxf.readfile(filepath)
    msp = doc.modelspace()
    
    entities = []
    for e in msp:
        if e.dxftype() == 'LINE':
            entities.append({
                'type': 'line',
                'p1': (e.dxf.start.x, e.dxf.start.y),
                'p2': (e.dxf.end.x, e.dxf.end.y)
            })
        elif e.dxftype() == 'ARC':
            entities.append({
                'type': 'arc',
                'cx': e.dxf.center.x,
                'cy': e.dxf.center.y,
                'r': e.dxf.radius,
                'start_angle': e.dxf.start_angle,
                'end_angle': e.dxf.end_angle
            })
        elif e.dxftype() == 'CIRCLE':
            entities.append({
                'type': 'arc',
                'cx': e.dxf.center.x,
                'cy': e.dxf.center.y,
                'r': e.dxf.radius,
                'start_angle': 0.0,
                'end_angle': 360.0
            })
        elif e.dxftype() == 'LWPOLYLINE':
            points = e.get_points()
            for i in range(len(points) - 1):
                entities.append({
                    'type': 'line',
                    'p1': (points[i][0], points[i][1]),
                    'p2': (points[i+1][0], points[i+1][1])
                })
            if e.closed:
                entities.append({
                    'type': 'line',
                    'p1': (points[-1][0], points[-1][1]),
                    'p2': (points[0][0], points[0][1])
                })
                
    return normalize_entities(entities)

def main():
    files = {
        'Sign594': 'd:/Rover_Three_Wheel/templates/Ceco.NET-Symbols-Signs-Signals-ISO-standards-Xm-594.dxf',
        'Sign596': 'd:/Rover_Three_Wheel/templates/Ceco.NET-Symbols-Signs-Signals-ISO-standards-Xm-596.dxf',
    }

    out_lines = []
    out_lines.append('import type { PlanLine } from "../types/plan";\n')
    out_lines.append('export type RoadSignType = "Sign594" | "Sign596";\n')
    out_lines.append('type Point = { x: number; y: number };')
    out_lines.append('type Segment = { type: "line"; p1: Point; p2: Point } | { type: "arc"; cx: number; cy: number; r: number; startAngle: number; endAngle: number };\n')
    
    out_lines.append('function createLine(x1: number, y1: number, x2: number, y2: number): Segment {')
    out_lines.append('    return { type: "line", p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };')
    out_lines.append('}\n')

    out_lines.append('function createArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): Segment {')
    out_lines.append('    return { type: "arc", cx, cy, r, startAngle, endAngle };')
    out_lines.append('}\n')

    out_lines.append('const roadSignsData: Record<RoadSignType, Segment[]> = {')

    for name, filepath in files.items():
        if not os.path.exists(filepath):
            print(f"File not found: {filepath}")
            continue

        entities = process_dxf(filepath)
        out_lines.append(f'  "{name}": [')
        for e in entities:
            if e['type'] == 'line':
                out_lines.append(f'    createLine({e["p1"][0]:.4f}, {e["p1"][1]:.4f}, {e["p2"][0]:.4f}, {e["p2"][1]:.4f}),')
            elif e['type'] == 'arc':
                out_lines.append(f'    createArc({e["cx"]:.4f}, {e["cy"]:.4f}, {e["r"]:.4f}, {e["start_angle"]:.4f}, {e["end_angle"]:.4f}),')
        out_lines.append('  ],')

    out_lines.append('};\n')

    out_lines.append('export function generateRoadSignLines(signType: RoadSignType, size: number): PlanLine[] {')
    out_lines.append('    const segments = roadSignsData[signType] || [];')
    out_lines.append('    const lines: PlanLine[] = [];')
    out_lines.append('    let pointId = 1;')
    out_lines.append('    let lineId = 1;')
    out_lines.append('    ')
    out_lines.append('    for (const seg of segments) {')
    out_lines.append('        if (seg.type === "line") {')
    out_lines.append('            lines.push({')
    out_lines.append('                id: `rs-${lineId++}`,')
    out_lines.append('                label: "Line",')
    out_lines.append('                layer: "marking",')
    out_lines.append('                from: { id: pointId++, x: seg.p1.y * size, y: seg.p1.x * size },')
    out_lines.append('                to: { id: pointId++, x: seg.p2.y * size, y: seg.p2.x * size },')
    out_lines.append('                width: 0.1')
    out_lines.append('            });')
    out_lines.append('        } else if (seg.type === "arc") {')
    out_lines.append('            const startRad = (seg.startAngle * Math.PI) / 180;')
    out_lines.append('            const endRad = (seg.endAngle * Math.PI) / 180;')
    out_lines.append('            const ptsCount = Math.max(10, Math.abs(seg.endAngle - seg.startAngle) / 10);')
    out_lines.append('            ')
    out_lines.append('            let prevX = seg.cx * size + (seg.r * size) * Math.cos(startRad);')
    out_lines.append('            let prevY = seg.cy * size + (seg.r * size) * Math.sin(startRad);')
    out_lines.append('            ')
    out_lines.append('            for (let i = 1; i <= ptsCount; i++) {')
    out_lines.append('                const t = i / ptsCount;')
    out_lines.append('                let angle = seg.startAngle + t * (seg.endAngle - seg.startAngle);')
    out_lines.append('                if (seg.startAngle > seg.endAngle) {')
    out_lines.append('                    angle = seg.startAngle + t * (seg.endAngle + 360 - seg.startAngle);')
    out_lines.append('                }')
    out_lines.append('                const rad = (angle * Math.PI) / 180;')
    out_lines.append('                const currX = seg.cx * size + (seg.r * size) * Math.cos(rad);')
    out_lines.append('                const currY = seg.cy * size + (seg.r * size) * Math.sin(rad);')
    out_lines.append('                lines.push({')
    out_lines.append('                    id: `rs-arc-${lineId++}`,')
    out_lines.append('                    label: "Arc Segment",')
    out_lines.append('                    layer: "marking",')
    out_lines.append('                    from: { id: pointId++, x: prevY, y: prevX },')
    out_lines.append('                    to: { id: pointId++, x: currY, y: currX },')
    out_lines.append('                    width: 0.1')
    out_lines.append('                });')
    out_lines.append('                prevX = currX;')
    out_lines.append('                prevY = currY;')
    out_lines.append('            }')
    out_lines.append('        }')
    out_lines.append('    }')
    out_lines.append('    return lines;')
    out_lines.append('}')

    with open('d:/Rover_Three_Wheel/src/utils/roadSignTemplates.ts', 'w', encoding='utf-8') as f:
        f.write('\n'.join(out_lines))
        
    print("roadSignTemplates.ts generated successfully!")

if __name__ == '__main__':
    main()
