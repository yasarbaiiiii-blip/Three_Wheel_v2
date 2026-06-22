import os
import urllib.request
from ezdxf.addons import text2path
from ezdxf.math import Matrix44

FONTS = {
    'smooth': 'Arial',
    'stencil': 'Stencil'
}

def download_fonts():
    return FONTS

from ezdxf.fonts.fonts import FontFace

def generate_char_paths(font_family, char):
    font = FontFace(family=font_family)
    string_path = text2path.make_path_from_str(char, font, size=1.0)
    
    # Flatten the bezier curves into line segments (tolerance controls smoothness)
    flattened = list(string_path.flattening(distance=0.01))
    
    if not flattened:
        return []

    # Calculate bounding box
    min_x = min(p.x for p in flattened)
    max_x = max(p.x for p in flattened)
    min_y = min(p.y for p in flattened)
    max_y = max(p.y for p in flattened)

    w = max_x - min_x
    h = max_y - min_y
    scale = 1.0 / max(w, h) if max(w, h) > 0 else 1.0

    lines = []
    # string_path.flattening() yields points, but the path might be composed of multiple sub-paths
    # However, flattening a compound path yields ALL points in sequence, which might connect sub-paths
    # We should iterate over sub-paths
    
    for subpath in string_path.sub_paths():
        sub_pts = list(subpath.flattening(distance=0.01))
        if len(sub_pts) < 2:
            continue
        for i in range(len(sub_pts) - 1):
            nx1 = (sub_pts[i].x - min_x) * scale
            ny1 = (sub_pts[i].y - min_y) * scale
            nx2 = (sub_pts[i+1].x - min_x) * scale
            ny2 = (sub_pts[i+1].y - min_y) * scale
            lines.append({'x1': nx1, 'y1': ny1, 'x2': nx2, 'y2': ny2})
            
        # Close the subpath if it's not already closed
        if sub_pts[0].isclose(sub_pts[-1]):
            pass # already closed
        else:
            nx1 = (sub_pts[-1].x - min_x) * scale
            ny1 = (sub_pts[-1].y - min_y) * scale
            nx2 = (sub_pts[0].x - min_x) * scale
            ny2 = (sub_pts[0].y - min_y) * scale
            lines.append({'x1': nx1, 'y1': ny1, 'x2': nx2, 'y2': ny2})

    # Optional: Center it in X
    curr_w = (max_x - min_x) * scale
    offset_x = (1.0 - curr_w) / 2.0
    for l in lines:
        l['x1'] += offset_x
        l['x2'] += offset_x

    return lines

def main():
    font_paths = download_fonts()
    
    chars = {
        'alphabets': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'numbers': '0123456789'
    }

    out_lines = []
    out_lines.append('import type { PlanLine } from "../types/plan";')
    out_lines.append('')
    out_lines.append('export type FontStyle = "smooth" | "stencil";')
    out_lines.append('export type AlphabetType = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M" | "N" | "O" | "P" | "Q" | "R" | "S" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z";')
    out_lines.append('export type NumberType = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";')
    out_lines.append('')
    out_lines.append('type Point = { x: number; y: number };')
    out_lines.append('type LineSegment = { p1: Point; p2: Point };')
    out_lines.append('')

    out_lines.append('const alphabetsData: Record<FontStyle, Record<AlphabetType, LineSegment[]>> = {')
    for style, fpath in font_paths.items():
        out_lines.append(f'  {style}: {{')
        for c in chars['alphabets']:
            lines = generate_char_paths(fpath, c)
            out_lines.append(f'    "{c}": [')
            for l in lines:
                out_lines.append(f'      {{ p1: {{ x: {l["x1"]:.4f}, y: {l["y1"]:.4f} }}, p2: {{ x: {l["x2"]:.4f}, y: {l["y2"]:.4f} }} }},')
            out_lines.append('    ],')
        out_lines.append('  },')
    out_lines.append('};\n')

    out_lines.append('const numbersData: Record<FontStyle, Record<NumberType, LineSegment[]>> = {')
    for style, fpath in font_paths.items():
        out_lines.append(f'  {style}: {{')
        for c in chars['numbers']:
            lines = generate_char_paths(fpath, c)
            out_lines.append(f'    "{c}": [')
            for l in lines:
                out_lines.append(f'      {{ p1: {{ x: {l["x1"]:.4f}, y: {l["y1"]:.4f} }}, p2: {{ x: {l["x2"]:.4f}, y: {l["y2"]:.4f} }} }},')
            out_lines.append('    ],')
        out_lines.append('  },')
    out_lines.append('};\n')

    out_lines.append('export function generateAlphabetLines(char: AlphabetType, size: number, fontStyle: FontStyle): PlanLine[] {')
    out_lines.append('    const segments = alphabetsData[fontStyle][char] || [];')
    out_lines.append('    const lines: PlanLine[] = [];')
    out_lines.append('    let pointId = 1;')
    out_lines.append('    let lineId = 1;')
    out_lines.append('    for (const seg of segments) {')
    out_lines.append('        lines.push({')
    out_lines.append('            id: `alpha-${lineId++}`, label: "Stroke", layer: "marking", width: 0.1,')
    out_lines.append('            from: { id: pointId++, x: seg.p1.y * size, y: seg.p1.x * size },')
    out_lines.append('            to: { id: pointId++, x: seg.p2.y * size, y: seg.p2.x * size },')
    out_lines.append('        });')
    out_lines.append('    }')
    out_lines.append('    return lines;')
    out_lines.append('}\n')

    out_lines.append('export function generateNumberLines(digit: NumberType, size: number, fontStyle: FontStyle): PlanLine[] {')
    out_lines.append('    const segments = numbersData[fontStyle][digit] || [];')
    out_lines.append('    const lines: PlanLine[] = [];')
    out_lines.append('    let pointId = 1;')
    out_lines.append('    let lineId = 1;')
    out_lines.append('    for (const seg of segments) {')
    out_lines.append('        lines.push({')
    out_lines.append('            id: `num-${lineId++}`, label: "Stroke", layer: "marking", width: 0.1,')
    out_lines.append('            from: { id: pointId++, x: seg.p1.y * size, y: seg.p1.x * size },')
    out_lines.append('            to: { id: pointId++, x: seg.p2.y * size, y: seg.p2.x * size },')
    out_lines.append('        });')
    out_lines.append('    }')
    out_lines.append('    return lines;')
    out_lines.append('}\n')

    with open('d:/Rover_Three_Wheel/src/utils/characterTemplates.ts', 'w', encoding='utf-8') as f:
        f.write('\n'.join(out_lines))

if __name__ == '__main__':
    main()
