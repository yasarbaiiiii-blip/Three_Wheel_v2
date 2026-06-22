import math
from ezdxf.fonts.fonts import FontFace
from ezdxf.addons import text2path

# 1. Setup our definitions
ICONS = {
    'ArrowStraight': chr(0xe5d8),
    'ArrowLeft': chr(0xe5c4),
    'ArrowRight': chr(0xe5c8),
    'ArrowUTurn': chr(0xe5d5),
    'Roundabout': chr(0xeb3f),
    'Wheelchair': chr(0xe914),
    'Bicycle': chr(0xe52f),
    'Pedestrian': chr(0xe536),
    'EVStation': chr(0xeb71),
    'Parking': chr(0xe561),
    'Airplane': chr(0xe53d),
    'BusZone': chr(0xe532),
}

MATH_SIGNS = [
    'StopSign', 'YieldSign', 'WarningDiamond', 'NoEntry', 
    'SpeedLimit', 'Crosswalk', 'Hospital', 'KeepRight'
]

def generate_icon_paths(char, font_path):
    font = FontFace(filename=font_path)
    string_path = text2path.make_path_from_str(char, font, size=1.0)
    
    segments = []
    # Flatten the bezier curves into line segments
    for sub_path in string_path.sub_paths():
        sub_pts = list(sub_path.flattening(0.01, segments=4))
        for i in range(len(sub_pts) - 1):
            segments.append({
                'p1': sub_pts[i],
                'p2': sub_pts[i+1]
            })
            
    if not segments:
        return []
        
    min_x = min(min(s['p1'].x, s['p2'].x) for s in segments)
    max_x = max(max(s['p1'].x, s['p2'].x) for s in segments)
    min_y = min(min(s['p1'].y, s['p2'].y) for s in segments)
    max_y = max(max(s['p1'].y, s['p2'].y) for s in segments)
    
    width = max_x - min_x
    height = max_y - min_y
    scale = 1.0 / max(width, height)
    
    lines = []
    point_id = 1
    line_id = 1
    
    for seg in segments:
        nx1 = (seg['p1'].x - min_x) * scale
        ny1 = (seg['p1'].y - min_y) * scale
        nx2 = (seg['p2'].x - min_x) * scale
        ny2 = (seg['p2'].y - min_y) * scale
        
        lines.append(f'        lines.push({{')
        lines.append(f'            id: `rs-${{lineId++}}`, label: "Stroke", layer: "marking", width: 0.1,')
        # Map X to East, Y to North (as requested to fix inversion)
        lines.append(f'            from: {{ id: pointId++, x: {ny1:.4f} * size, y: {nx1:.4f} * size }},')
        lines.append(f'            to: {{ id: pointId++, x: {ny2:.4f} * size, y: {nx2:.4f} * size }},')
        lines.append(f'        }});')
        
    return lines

def generate_math_shape(shape_name):
    lines = []
    def add_line(nx1, ny1, nx2, ny2):
        lines.append(f'        lines.push({{')
        lines.append(f'            id: `rs-${{lineId++}}`, label: "Stroke", layer: "marking", width: 0.1,')
        # Map X to East, Y to North
        lines.append(f'            from: {{ id: pointId++, x: {ny1:.4f} * size, y: {nx1:.4f} * size }},')
        lines.append(f'            to: {{ id: pointId++, x: {ny2:.4f} * size, y: {nx2:.4f} * size }},')
        lines.append(f'        }});')
        
    def add_polygon(pts, close=True):
        for i in range(len(pts)-1):
            add_line(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1])
        if close:
            add_line(pts[-1][0], pts[-1][1], pts[0][0], pts[0][1])

    if shape_name == 'StopSign':
        # Octagon
        pts = []
        for i in range(8):
            angle = math.pi/8 + i * math.pi/4
            pts.append((0.5 + 0.5*math.cos(angle), 0.5 + 0.5*math.sin(angle)))
        add_polygon(pts)
        # Inner octagon
        pts_in = []
        for i in range(8):
            angle = math.pi/8 + i * math.pi/4
            pts_in.append((0.5 + 0.45*math.cos(angle), 0.5 + 0.45*math.sin(angle)))
        add_polygon(pts_in)
        
    elif shape_name == 'YieldSign':
        # Triangle pointing down
        pts = [(0.0, 1.0), (1.0, 1.0), (0.5, 0.0)]
        add_polygon(pts)
        pts_in = [(0.1, 0.9), (0.9, 0.9), (0.5, 0.15)]
        add_polygon(pts_in)
        
    elif shape_name == 'WarningDiamond':
        pts = [(0.5, 1.0), (1.0, 0.5), (0.5, 0.0), (0.0, 0.5)]
        add_polygon(pts)
        pts_in = [(0.5, 0.95), (0.95, 0.5), (0.5, 0.05), (0.05, 0.5)]
        add_polygon(pts_in)
        
    elif shape_name == 'NoEntry':
        # Circle
        pts = []
        for i in range(32):
            angle = i * 2 * math.pi / 32
            pts.append((0.5 + 0.5*math.cos(angle), 0.5 + 0.5*math.sin(angle)))
        add_polygon(pts)
        # Horizontal bar
        add_polygon([(0.2, 0.6), (0.8, 0.6), (0.8, 0.4), (0.2, 0.4)])
        
    elif shape_name == 'SpeedLimit':
        pts = []
        for i in range(32):
            angle = i * 2 * math.pi / 32
            pts.append((0.5 + 0.5*math.cos(angle), 0.5 + 0.5*math.sin(angle)))
        add_polygon(pts)
        pts_in = []
        for i in range(32):
            angle = i * 2 * math.pi / 32
            pts_in.append((0.5 + 0.45*math.cos(angle), 0.5 + 0.45*math.sin(angle)))
        add_polygon(pts_in)
        
    elif shape_name == 'Crosswalk':
        # Parallel zebra strips
        for i in range(5):
            x1 = 0.1 + i*0.2
            x2 = 0.15 + i*0.2
            add_polygon([(x1, 0.1), (x2, 0.1), (x2, 0.9), (x1, 0.9)])
            
    elif shape_name == 'Hospital':
        # Cross
        add_polygon([
            (0.35, 1.0), (0.65, 1.0), (0.65, 0.65),
            (1.0, 0.65), (1.0, 0.35), (0.65, 0.35),
            (0.65, 0.0), (0.35, 0.0), (0.35, 0.35),
            (0.0, 0.35), (0.0, 0.65), (0.35, 0.65)
        ])
        
    elif shape_name == 'KeepRight':
        # Arrow pointing down-right
        add_polygon([
            (0.3, 0.9), (0.5, 0.9), (0.8, 0.4),
            (0.95, 0.4), (0.7, 0.1), (0.45, 0.4),
            (0.6, 0.4), (0.3, 0.9)
        ])
        # Barrier island on the left
        add_polygon([(0.1, 0.8), (0.2, 0.8), (0.2, 0.2), (0.1, 0.2)])
        
    return lines

def main():
    font_path = 'MaterialIcons-Regular.ttf'
    
    out_lines = []
    out_lines.append('import type { PlanLine } from "../types/plan";\n')
    
    all_signs = list(ICONS.keys()) + MATH_SIGNS
    type_union = " | ".join(f'"{s}"' for s in all_signs)
    
    out_lines.append(f'export type RoadSignType = {type_union};\n')
    
    out_lines.append('export const ROAD_SIGN_LABELS: Record<RoadSignType, string> = {')
    for s in all_signs:
        label = s.replace('Arrow', 'Arrow ').replace('Sign', ' Sign').replace('Diamond', ' Diamond')
        out_lines.append(f'    "{s}": "{label}",')
    out_lines.append('};\n')
    
    out_lines.append('export function generateRoadSignLines(signType: RoadSignType, size: number): PlanLine[] {')
    out_lines.append('    const lines: PlanLine[] = [];')
    out_lines.append('    let pointId = 1;')
    out_lines.append('    let lineId = 1;\n')
    
    first = True
    for name, char in ICONS.items():
        if first:
            out_lines.append(f'    if (signType === "{name}") {{')
            first = False
        else:
            out_lines.append(f'    }} else if (signType === "{name}") {{')
            
        lines = generate_icon_paths(char, font_path)
        out_lines.extend(lines)
        
    for name in MATH_SIGNS:
        out_lines.append(f'    }} else if (signType === "{name}") {{')
        lines = generate_math_shape(name)
        out_lines.extend(lines)
        
    out_lines.append('    }')
    out_lines.append('    return lines;')
    out_lines.append('}\n')
    
    with open('d:/Rover_Three_Wheel/src/utils/roadSignTemplates.ts', 'w', encoding='utf-8') as f:
        f.write('\n'.join(out_lines))
        
    print("roadSignTemplates.ts generated successfully!")

if __name__ == '__main__':
    main()
