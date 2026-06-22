import math

# Each sign is a list of polygons. A polygon is a list of (x, y) coordinates.
# X is horizontal (0 to 1), Y is vertical (0 to 1).
# We will output x -> East, y -> North in the TS file (using x: y, y: x).

SIGNS = {}

# 1. Straight Arrow
SIGNS['ArrowStraight'] = [
    [(0.4, 0.0), (0.6, 0.0), (0.6, 0.6), (0.8, 0.6), (0.5, 1.0), (0.2, 0.6), (0.4, 0.6)]
]

# 2. Left Turn Arrow
SIGNS['ArrowLeftTurn'] = [
    [(0.5, 0.0), (0.7, 0.0), (0.7, 0.4), (0.6, 0.6), (0.4, 0.6), (0.4, 0.8), (0.0, 0.5), (0.4, 0.2), (0.4, 0.4), (0.5, 0.4)]
]

# 3. Right Turn Arrow
SIGNS['ArrowRightTurn'] = [
    [(0.3, 0.0), (0.5, 0.0), (0.5, 0.4), (0.6, 0.4), (0.6, 0.2), (1.0, 0.5), (0.6, 0.8), (0.6, 0.6), (0.4, 0.6), (0.3, 0.4)]
]

# 4. Straight + Left Turn Arrow
SIGNS['ArrowStraightLeft'] = [
    [(0.5, 0.0), (0.7, 0.0), (0.7, 0.6), (0.9, 0.6), (0.6, 1.0), (0.3, 0.6), (0.5, 0.6), (0.5, 0.4), (0.4, 0.4), (0.4, 0.8), (0.0, 0.5), (0.4, 0.2), (0.4, 0.4)]
]

# 5. Straight + Right Turn Arrow
SIGNS['ArrowStraightRight'] = [
    [(0.3, 0.0), (0.5, 0.0), (0.5, 0.4), (0.6, 0.4), (0.6, 0.2), (1.0, 0.5), (0.6, 0.8), (0.6, 0.6), (0.5, 0.6), (0.7, 0.6), (0.4, 1.0), (0.1, 0.6), (0.3, 0.6)]
]

# 6. U-Turn Arrow
SIGNS['ArrowUTurn'] = [
    [(0.8, 0.0), (1.0, 0.0), (1.0, 0.6), (0.8, 0.8), (0.2, 0.8), (0.2, 0.6), (0.4, 0.6), (0.0, 0.2), (0.0, 0.6), (0.2, 1.0), (0.8, 1.0)]
]

# 7. HOV Diamond
SIGNS['HOVDiamond'] = [
    [(0.5, 1.0), (0.9, 0.5), (0.5, 0.0), (0.1, 0.5)],
    [(0.5, 0.9), (0.8, 0.5), (0.5, 0.1), (0.2, 0.5)]
]

# 8. Yield Shark Teeth (3 triangles)
SIGNS['YieldSharkTeeth'] = [
    [(0.0, 1.0), (0.3, 1.0), (0.15, 0.0)],
    [(0.35, 1.0), (0.65, 1.0), (0.5, 0.0)],
    [(0.7, 1.0), (1.0, 1.0), (0.85, 0.0)]
]

# 9. Crosswalk (5 blocks)
SIGNS['Crosswalk'] = []
for i in range(5):
    x = i * 0.2 + 0.02
    SIGNS['Crosswalk'].append([(x, 0.0), (x+0.16, 0.0), (x+0.16, 1.0), (x, 1.0)])

# 10. Stop Line
SIGNS['StopLine'] = [
    [(0.0, 0.4), (1.0, 0.4), (1.0, 0.6), (0.0, 0.6)]
]

# Quick Letter generator (Simple block letters)
def get_letter(char, x_off, y_off, w, h):
    polys = []
    if char == 'S':
        polys.append([(x_off+w, y_off+h), (x_off, y_off+h), (x_off, y_off+h/2), (x_off+w, y_off+h/2), (x_off+w, y_off), (x_off, y_off)])
    elif char == 'T':
        polys.append([(x_off, y_off+h), (x_off+w, y_off+h)])
        polys.append([(x_off+w/2, y_off+h), (x_off+w/2, y_off)])
    elif char == 'O':
        polys.append([(x_off, y_off), (x_off+w, y_off), (x_off+w, y_off+h), (x_off, y_off+h)])
    elif char == 'P':
        polys.append([(x_off, y_off), (x_off, y_off+h), (x_off+w, y_off+h), (x_off+w, y_off+h/2), (x_off, y_off+h/2)])
    elif char == 'L':
        polys.append([(x_off, y_off+h), (x_off, y_off), (x_off+w, y_off)])
    elif char == 'W':
        polys.append([(x_off, y_off+h), (x_off+w/4, y_off), (x_off+w/2, y_off+h/2), (x_off+3*w/4, y_off), (x_off+w, y_off+h)])
    elif char == 'B':
        polys.append([(x_off, y_off), (x_off, y_off+h), (x_off+w*0.8, y_off+h), (x_off+w, y_off+0.75*h), (x_off+w*0.8, y_off+h/2), (x_off, y_off+h/2)])
        polys.append([(x_off+w*0.8, y_off+h/2), (x_off+w, y_off+0.25*h), (x_off+w*0.8, y_off), (x_off, y_off)])
    elif char == 'U':
        polys.append([(x_off, y_off+h), (x_off, y_off), (x_off+w, y_off), (x_off+w, y_off+h)])
    elif char == 'A':
        polys.append([(x_off, y_off), (x_off+w/2, y_off+h), (x_off+w, y_off)])
        polys.append([(x_off+w/4, y_off+h/2), (x_off+3*w/4, y_off+h/2)])
    elif char == 'X':
        polys.append([(x_off, y_off), (x_off+w, y_off+h)])
        polys.append([(x_off, y_off+h), (x_off+w, y_off)])
    elif char == 'I':
        polys.append([(x_off+w/2, y_off), (x_off+w/2, y_off+h)])
    elif char == 'N':
        polys.append([(x_off, y_off), (x_off, y_off+h), (x_off+w, y_off), (x_off+w, y_off+h)])
    elif char == 'Y':
        polys.append([(x_off, y_off+h), (x_off+w/2, y_off+h/2), (x_off+w, y_off+h)])
        polys.append([(x_off+w/2, y_off+h/2), (x_off+w/2, y_off)])
    return polys

def draw_word(word):
    polys = []
    # Vertical word (top to bottom)
    h_step = 1.0 / len(word)
    for i, char in enumerate(word):
        y_off = 1.0 - (i + 1) * h_step + h_step * 0.1
        h = h_step * 0.8
        w = 0.6
        x_off = 0.2
        polys.extend(get_letter(char, x_off, y_off, w, h))
    return polys

# 11. Word STOP
SIGNS['WordSTOP'] = draw_word("STOP")

# 12. Word SLOW
SIGNS['WordSLOW'] = draw_word("SLOW")

# 13. Word BUS
SIGNS['WordBUS'] = draw_word("BUS")

# 14. Word TAXI
SIGNS['WordTAXI'] = draw_word("TAXI")

# 15. Word ONLY
SIGNS['WordONLY'] = draw_word("ONLY")

# 16. Parking T-Mark
SIGNS['ParkingTMark'] = [
    [(0.2, 0.8), (0.8, 0.8), (0.8, 1.0), (0.2, 1.0)],
    [(0.4, 0.0), (0.6, 0.0), (0.6, 0.8), (0.4, 0.8)]
]

# 17. Parking L-Mark
SIGNS['ParkingLMark'] = [
    [(0.2, 0.0), (0.4, 0.0), (0.4, 0.8), (1.0, 0.8), (1.0, 1.0), (0.2, 1.0)]
]

# 18. Handicap Box (Box + stick figure)
SIGNS['HandicapBox'] = [
    # Box
    [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
    # Wheel (circle approximation)
    [(0.3, 0.3), (0.6, 0.3), (0.7, 0.45), (0.6, 0.6), (0.3, 0.6), (0.2, 0.45)],
    # Back / Body
    [(0.45, 0.6), (0.45, 0.9)],
    # Legs
    [(0.45, 0.6), (0.7, 0.6), (0.7, 0.3)],
    # Arms
    [(0.45, 0.75), (0.7, 0.75)],
    # Head (small square)
    [(0.4, 0.92), (0.5, 0.92), (0.5, 0.98), (0.4, 0.98)]
]

# 19. Bicycle Outline
SIGNS['BicycleOutline'] = [
    # Back Wheel
    [(0.1, 0.1), (0.3, 0.1), (0.4, 0.3), (0.3, 0.5), (0.1, 0.5), (0.0, 0.3)],
    # Front Wheel
    [(0.6, 0.1), (0.8, 0.1), (0.9, 0.3), (0.8, 0.5), (0.6, 0.5), (0.5, 0.3)],
    # Frame
    [(0.2, 0.3), (0.4, 0.6), (0.75, 0.6), (0.75, 0.3), (0.2, 0.3)],
    # Handlebar
    [(0.75, 0.6), (0.7, 0.8), (0.8, 0.8)],
    # Seat
    [(0.4, 0.6), (0.4, 0.7), (0.3, 0.7), (0.5, 0.7)]
]

# 20. No Parking Cross
SIGNS['NoParkingCross'] = [
    [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
    [(0.0, 0.0), (1.0, 1.0)],
    [(0.0, 1.0), (1.0, 0.0)]
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
        # Add spaces before capital letters
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
                # If it's a closed polygon, we draw the last edge, unless it's a 2-point line
                if p2 is None:
                    if len(poly) > 2:
                        p2 = poly[0]
                    else:
                        continue
                
                # We map x -> East, y -> North. TS uses x: North, y: East.
                # So TS x = y, TS y = x.
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
