import math
from ezdxf.fonts.fonts import FontFace
from ezdxf.addons import text2path

def add_line(poly, x, y):
    poly.append((x, y))

def add_arc(poly, cx, cy, r, start_deg, end_deg, steps=6):
    s = start_deg * math.pi / 180
    e = end_deg * math.pi / 180
    for i in range(steps + 1):
        t = i / steps
        angle = s + t * (e - s)
        poly.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))

SIGNS = {}

# 1. Straight Arrow (Perfectly proportioned pavement arrow)
SIGNS['ArrowStraight'] = [
    [(0.4, 0.0), (0.6, 0.0), (0.6, 0.6), (0.8, 0.6), (0.5, 1.0), (0.2, 0.6), (0.4, 0.6)]
]

# 2. Left Turn Arrow
left_arrow = []
left_arrow.append((0.5, 0.0))
left_arrow.append((0.7, 0.0))
left_arrow.append((0.7, 0.4))
# Outer curve
add_arc(left_arrow, 0.3, 0.4, 0.4, 0, 90, steps=10)
left_arrow.append((0.2, 0.8)) # extend horizontal stem outer
left_arrow.append((0.2, 0.95)) # arrowhead top
left_arrow.append((0.0, 0.7)) # arrowhead tip
left_arrow.append((0.2, 0.45)) # arrowhead bottom
left_arrow.append((0.2, 0.6)) # extend horizontal stem inner
# Inner curve
add_arc(left_arrow, 0.3, 0.4, 0.2, 90, 0, steps=10)
left_arrow.append((0.5, 0.4))
SIGNS['ArrowLeftTurn'] = [left_arrow]

# 3. Right Turn Arrow
right_arrow = []
for (x, y) in left_arrow:
    right_arrow.append((1.0 - x, y))
SIGNS['ArrowRightTurn'] = [right_arrow]

# 4. Straight + Left Turn Arrow
sl_branch = []
sl_branch.append((0.6, 0.0))
sl_branch.append((0.6, 0.6))
sl_branch.append((0.8, 0.6))
sl_branch.append((0.5, 1.0))
sl_branch.append((0.2, 0.6))
sl_branch.append((0.4, 0.6))
sl_branch.append((0.4, 0.3))
# Outer curve left
add_arc(sl_branch, 0.1, 0.3, 0.3, 0, 90, steps=10)
# Arrowhead top
sl_branch.append((0.1, 0.75))
# Arrowhead tip
sl_branch.append((-0.15, 0.5))
# Arrowhead bottom
sl_branch.append((0.1, 0.25))
sl_branch.append((0.1, 0.4))
# Inner curve right
add_arc(sl_branch, 0.1, 0.1, 0.3, 90, 0, steps=10)
sl_branch.append((0.4, 0.0))
SIGNS['ArrowStraightLeft'] = [sl_branch]

# 5. Straight + Right Turn Arrow
sr_branch = []
for (x, y) in sl_branch:
    sr_branch.append((1.0 - x, y))
SIGNS['ArrowStraightRight'] = [sr_branch]

# 6. U-Turn Arrow
ut_arrow = []
ut_arrow.append((0.7, 0.0))
ut_arrow.append((0.9, 0.0))
ut_arrow.append((0.9, 0.4))
# Outer curve
add_arc(ut_arrow, 0.5, 0.4, 0.4, 0, 180, steps=16)
# Stem 2 (going down)
ut_arrow.append((0.1, 0.3))
# Arrowhead
ut_arrow.append((-0.05, 0.3))
ut_arrow.append((0.2, 0.0))
ut_arrow.append((0.45, 0.3))
ut_arrow.append((0.3, 0.3))
# Inner curve
add_arc(ut_arrow, 0.5, 0.4, 0.2, 180, 0, steps=16)
ut_arrow.append((0.7, 0.4))
SIGNS['ArrowUTurn'] = [ut_arrow]

# 7. HOV Diamond
# Clean, thick elongated diamond
SIGNS['HOVDiamond'] = [
    [(0.5, 1.0), (0.9, 0.5), (0.5, 0.0), (0.1, 0.5)],
    [(0.5, 0.85), (0.75, 0.5), (0.5, 0.15), (0.25, 0.5)]
]

# 8. Yield Shark Teeth (3 big triangles)
SIGNS['YieldSharkTeeth'] = [
    [(0.05, 0.9), (0.25, 0.9), (0.15, 0.1)],
    [(0.4, 0.9), (0.6, 0.9), (0.5, 0.1)],
    [(0.75, 0.9), (0.95, 0.9), (0.85, 0.1)]
]

# 9. Crosswalk
SIGNS['Crosswalk'] = []
for i in range(5):
    x = i * 0.2 + 0.02
    SIGNS['Crosswalk'].append([(x, 0.1), (x+0.16, 0.1), (x+0.16, 0.9), (x, 0.9)])

# 10. Stop Line (Thick horizontal bar)
SIGNS['StopLine'] = [
    [(0.0, 0.3), (1.0, 0.3), (1.0, 0.7), (0.0, 0.7)]
]

# To draw perfect words, we use the Arial font directly!
def generate_word_paths(word):
    font = FontFace(family='Arial')
    string_path = text2path.make_path_from_str(word, font, size=1.0)
    
    segments = []
    for sub_path in string_path.sub_paths():
        # Coarse flattening (0.05) so the rover doesn't stutter!
        sub_pts = list(sub_path.flattening(0.05, segments=4))
        poly = []
        for p in sub_pts:
            poly.append((p.x, p.y))
        segments.append(poly)
        
    if not segments:
        return []
        
    # Scale to 0-1
    min_x = min(min(pt[0] for pt in poly) for poly in segments)
    max_x = max(max(pt[0] for pt in poly) for poly in segments)
    min_y = min(min(pt[1] for pt in poly) for poly in segments)
    max_y = max(max(pt[1] for pt in poly) for poly in segments)
    
    width = max_x - min_x
    height = max_y - min_y
    scale = 1.0 / max(width, height)
    
    polys = []
    for poly in segments:
        # Scale and center
        scaled_poly = [((pt[0] - min_x) * scale, (pt[1] - min_y) * scale) for pt in poly]
        polys.append(scaled_poly)
        
    return polys

# 11-15. Render Words using actual high-quality font!
SIGNS['WordSTOP'] = generate_word_paths("STOP")
SIGNS['WordSLOW'] = generate_word_paths("SLOW")
SIGNS['WordBUS'] = generate_word_paths("BUS")
SIGNS['WordTAXI'] = generate_word_paths("TAXI")
SIGNS['WordONLY'] = generate_word_paths("ONLY")

# 16. Parking T-Mark
# Single unified T-shaped polygon
SIGNS['ParkingTMark'] = [
    [(0.1, 0.95), (0.9, 0.95), (0.9, 0.8), (0.575, 0.8), (0.575, 0.1), (0.425, 0.1), (0.425, 0.8), (0.1, 0.8)]
]

# 17. Parking L-Mark
# Single unified L-shaped polygon corner piece
SIGNS['ParkingLMark'] = [
    [(0.1, 0.1), (0.9, 0.1), (0.9, 0.25), (0.25, 0.25), (0.25, 0.9), (0.1, 0.9)]
]

# 18. Handicap Box (Cleaner, proportioned wheelchair)
wheelchair = []
add_arc(wheelchair, 0.6, 0.4, 0.3, 0, 360, steps=16) # Wheel outer
wheelchair_inner = []
add_arc(wheelchair_inner, 0.6, 0.4, 0.2, 360, 0, steps=16) # Wheel inner
body = [(0.4, 0.7), (0.4, 0.9), (0.5, 0.9), (0.5, 0.7), (0.8, 0.7), (0.8, 0.6), (0.5, 0.6), (0.5, 0.3), (0.4, 0.3)]
head = []
add_arc(head, 0.45, 0.95, 0.1, 0, 360, steps=8)
SIGNS['HandicapBox'] = [
    [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
    [(0.05, 0.05), (0.95, 0.05), (0.95, 0.95), (0.05, 0.95)],
    wheelchair, wheelchair_inner, body, head
]

# 19. Bicycle (Cleaner primitives)
wheel1 = []
add_arc(wheel1, 0.25, 0.25, 0.2, 0, 360, steps=12)
wheel1_in = []
add_arc(wheel1_in, 0.25, 0.25, 0.15, 360, 0, steps=12)
wheel2 = []
add_arc(wheel2, 0.75, 0.25, 0.2, 0, 360, steps=12)
wheel2_in = []
add_arc(wheel2_in, 0.75, 0.25, 0.15, 360, 0, steps=12)
frame = [(0.25, 0.25), (0.4, 0.6), (0.7, 0.6), (0.75, 0.25), (0.5, 0.25), (0.4, 0.6)]
seat = [(0.35, 0.6), (0.45, 0.6), (0.45, 0.7), (0.35, 0.7)]
handle = [(0.7, 0.6), (0.6, 0.8), (0.65, 0.8), (0.75, 0.6)]
SIGNS['BicycleOutline'] = [wheel1, wheel1_in, wheel2, wheel2_in, frame, seat, handle]

# 20. No Parking Cross
# Unified X-shaped polygon
SIGNS['NoParkingCross'] = [
    [(0.1, 0.9), (0.4, 0.5), (0.1, 0.1), (0.3, 0.1), (0.5, 0.35), (0.7, 0.1), (0.9, 0.1), (0.6, 0.5), (0.9, 0.9), (0.7, 0.9), (0.5, 0.65), (0.3, 0.9)]
]

def main():
    out_lines = []
    out_lines.append('import type { PlanLine } from "../types/plan";\n')
    
    all_signs = list(SIGNS.keys())
    type_union = " | ".join(f'"{s}"' for s in all_signs)
    
    out_lines.append(f'export type RoadSignType = {type_union};\n')
    
    out_lines.append('export const ROAD_SIGN_LABELS: Record<RoadSignType, string> = {')
    for s in all_signs:
        import re
        label = re.sub(r'(?<!^)(?=[A-Z])', ' ', s)
        out_lines.append(f'    "{s}": "{label}",')
    out_lines.append('};\n')
    
    out_lines.append('export function generateRoadSignLines(signType: RoadSignType, size: number): PlanLine[] {')
    out_lines.append('    const lines: PlanLine[] = [];')
    out_lines.append('    let pointId = 1;')
    out_lines.append('    let lineId = 1;\n')
    
    first = True
    for name, polys in SIGNS.items():
        if first:
            out_lines.append(f'    if (signType === "{name}") {{')
            first = False
        else:
            out_lines.append(f'    }} else if (signType === "{name}") {{')
            
        for poly in polys:
            for i in range(len(poly)):
                p1 = poly[i]
                p2 = poly[(i + 1) % len(poly)] if i < len(poly) - 1 else None
                if p2 is None:
                    if len(poly) > 2:
                        p2 = poly[0]
                    else:
                        continue
                
                # Math: X goes 0 to 1, Y goes 0 to 1
                # Output TS X = North, Output TS Y = East
                # To make it face North natively (Top points UP):
                # X -> East -> Output Y
                # Y -> North -> Output X
                out_lines.append(f'        lines.push({{')
                out_lines.append(f'            id: `rs-${{lineId++}}`, label: "Stroke", layer: "marking", width: 0.1,')
                out_lines.append(f'            from: {{ id: pointId++, x: {p1[1]:.4f} * size, y: {p1[0]:.4f} * size }},')
                out_lines.append(f'            to: {{ id: pointId++, x: {p2[1]:.4f} * size, y: {p2[0]:.4f} * size }},')
                out_lines.append(f'        }});')
                
    out_lines.append('    }')
    out_lines.append('    return lines;')
    out_lines.append('}\n')
    
    with open('d:/Rover_Three_Wheel/src/utils/roadSignTemplates.ts', 'w', encoding='utf-8') as f:
        f.write('\n'.join(out_lines))
        
    print("roadSignTemplates.ts generated successfully!")

if __name__ == '__main__':
    main()
