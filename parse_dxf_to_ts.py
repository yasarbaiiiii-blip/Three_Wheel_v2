#!/usr/bin/env python3
"""
Parse DXF sports field templates and generate a TypeScript constants file.

Handles entity types: LINE, LWPOLYLINE, CIRCLE, ARC
Normalizes coordinates so bounding box is centered at origin with 0-1 range.
"""

import os, math

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "utils", "sportsFieldTemplates.ts")

FIELDS = {
    "cricket_icc": "Cricket (ICC)",
    "field_hockey1_fih": "Field Hockey (FIH)",
    "football_soccer_fifa": "Football / Soccer (FIFA)",
    "kabaddi_indoor_mens": "Kabaddi Indoor (Men's)",
    "lacrosse": "Lacrosse",
    "nba_court": "Basketball (NBA)",
    "squash": "Squash",
    "track_field_400m": "Track & Field (400m)",
    "badminton_bwf": "Badminton (BWF)",
    "tennis_itf": "Tennis (ITF)",
    "volleyball": "Volleyball",
}

ARC_SEGMENTS = 24  # segments per full circle for approximation


def parse_dxf(filepath: str):
    """Parse a DXF file and return list of (x1,y1,x2,y2) line segments."""
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    # Split into group code / value pairs
    raw_lines = content.split("\n")
    pairs = []
    i = 0
    while i + 1 < len(raw_lines):
        code = raw_lines[i].strip()
        value = raw_lines[i + 1].strip()
        try:
            code = int(code)
        except ValueError:
            i += 1
            continue
        pairs.append((code, value))
        i += 2

    # Find ENTITIES section
    entities_start = None
    entities_end = None
    for idx, (code, value) in enumerate(pairs):
        if code == 2 and value == "ENTITIES":
            entities_start = idx + 1
        if entities_start is not None and code == 0 and value == "ENDSEC":
            entities_end = idx
            break

    if entities_start is None or entities_end is None:
        print(f"  WARNING: No ENTITIES section found in {filepath}")
        return []

    entity_pairs = pairs[entities_start:entities_end]

    # Split into individual entities
    entities = []
    current = []
    for code, value in entity_pairs:
        if code == 0:
            if current:
                entities.append(current)
            current = [(code, value)]
        else:
            current.append((code, value))
    if current:
        entities.append(current)

    segments = []

    for ent in entities:
        etype = ent[0][1] if ent else ""

        if etype == "LINE":
            x1 = y1 = x2 = y2 = 0.0
            for code, val in ent:
                if code == 10: x1 = float(val)
                elif code == 20: y1 = float(val)
                elif code == 11: x2 = float(val)
                elif code == 21: y2 = float(val)
            segments.append((x1, y1, x2, y2))

        elif etype == "LWPOLYLINE":
            vertices = []
            closed = False
            temp_x = None
            for code, val in ent:
                if code == 70:
                    closed = (int(val) & 1) == 1
                elif code == 10:
                    temp_x = float(val)
                elif code == 20:
                    if temp_x is not None:
                        vertices.append((temp_x, float(val)))
                        temp_x = None

            for j in range(len(vertices) - 1):
                segments.append((*vertices[j], *vertices[j + 1]))
            if closed and len(vertices) > 1:
                segments.append((*vertices[-1], *vertices[0]))

        elif etype == "CIRCLE":
            cx = cy = 0.0
            radius = 0.0
            for code, val in ent:
                if code == 10: cx = float(val)
                elif code == 20: cy = float(val)
                elif code == 40: radius = float(val)
            n = ARC_SEGMENTS
            for j in range(n):
                a1 = 2 * math.pi * j / n
                a2 = 2 * math.pi * (j + 1) / n
                segments.append((
                    cx + radius * math.cos(a1), cy + radius * math.sin(a1),
                    cx + radius * math.cos(a2), cy + radius * math.sin(a2),
                ))

        elif etype == "ARC":
            cx = cy = 0.0
            radius = 0.0
            start_angle = 0.0
            end_angle = 360.0
            for code, val in ent:
                if code == 10: cx = float(val)
                elif code == 20: cy = float(val)
                elif code == 40: radius = float(val)
                elif code == 50: start_angle = float(val)
                elif code == 51: end_angle = float(val)

            sa = math.radians(start_angle)
            ea = math.radians(end_angle)
            if ea <= sa:
                ea += 2 * math.pi

            span = ea - sa
            n_seg = max(4, int(ARC_SEGMENTS * span / (2 * math.pi)))
            for j in range(n_seg):
                a1 = sa + span * j / n_seg
                a2 = sa + span * (j + 1) / n_seg
                segments.append((
                    cx + radius * math.cos(a1), cy + radius * math.sin(a1),
                    cx + radius * math.cos(a2), cy + radius * math.sin(a2),
                ))

    return segments


def normalize_segments(segments):
    """Normalize segments to be centered at origin in 0-1 range. Returns (normalized, bounds)."""
    if not segments:
        return [], {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0, "naturalWidth": 0, "naturalHeight": 0}

    all_x = []
    all_y = []
    for x1, y1, x2, y2 in segments:
        all_x.extend([x1, x2])
        all_y.extend([y1, y2])

    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)

    w = max_x - min_x
    h = max_y - min_y
    scale = max(w, h) if max(w, h) > 0 else 1.0
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2

    normalized = []
    for x1, y1, x2, y2 in segments:
        normalized.append((
            round((x1 - cx) / scale, 6),
            round((y1 - cy) / scale, 6),
            round((x2 - cx) / scale, 6),
            round((y2 - cy) / scale, 6),
        ))

    return normalized, {
        "minX": round((min_x - cx) / scale, 6),
        "maxX": round((max_x - cx) / scale, 6),
        "minY": round((min_y - cy) / scale, 6),
        "maxY": round((max_y - cy) / scale, 6),
        "naturalWidth": round(w, 4),
        "naturalHeight": round(h, 4),
    }


def generate_ts(all_data: dict):
    """Generate the TypeScript file."""
    field_names = list(all_data.keys())

    ts = []
    ts.append('import type { PlanLine } from "../types/plan";\n')

    # Type union
    union = " | ".join(f'"{f}"' for f in field_names)
    ts.append(f"export type SportsFieldType = {union};\n")

    # Labels
    ts.append("export const SPORTS_FIELD_LABELS: Record<SportsFieldType, string> = {")
    for f in field_names:
        ts.append(f'    "{f}": "{FIELDS[f]}",')
    ts.append("};\n")

    # Bounds
    ts.append("export const SPORTS_FIELD_BOUNDS: Record<SportsFieldType, { minX: number; maxX: number; minY: number; maxY: number; naturalWidth: number; naturalHeight: number }> = {")
    for f in field_names:
        b = all_data[f]["bounds"]
        ts.append(f'    "{f}": {{ minX: {b["minX"]}, maxX: {b["maxX"]}, minY: {b["minY"]}, maxY: {b["maxY"]}, naturalWidth: {b["naturalWidth"]}, naturalHeight: {b["naturalHeight"]} }},')
    ts.append("};\n")

    # Raw data arrays
    ts.append("// Pre-computed normalized line segments [x1, y1, x2, y2][]")
    ts.append("const FIELD_DATA: Record<SportsFieldType, number[][]> = {")
    for f in field_names:
        segs = all_data[f]["segments"]
        ts.append(f'    "{f}": [')
        for seg in segs:
            ts.append(f"        [{seg[0]}, {seg[1]}, {seg[2]}, {seg[3]}],")
        ts.append("    ],")
    ts.append("};\n")

    # Generator function
    ts.append("export function generateSportsFieldLines(field: SportsFieldType, size: number): PlanLine[] {")
    ts.append("    const data = FIELD_DATA[field];")
    ts.append("    if (!data) return [];")
    ts.append("    const lines: PlanLine[] = [];")
    ts.append("    let pointId = 1;")
    ts.append("    for (let i = 0; i < data.length; i++) {")
    ts.append("        const [x1, y1, x2, y2] = data[i];")
    ts.append("        lines.push({")
    ts.append('            id: `sf-${i}`,')
    ts.append('            label: "Field Line",')
    ts.append('            layer: "marking",')
    ts.append("            width: 0.1,")
    ts.append("            from: { id: pointId++, x: x1 * size, y: y1 * size },")
    ts.append("            to: { id: pointId++, x: x2 * size, y: y2 * size },")
    ts.append("        });")
    ts.append("    }")
    ts.append("    return lines;")
    ts.append("}\n")

    return "\n".join(ts)


def main():
    all_data = {}

    for field_key, label in FIELDS.items():
        dxf_path = os.path.join(TEMPLATES_DIR, f"{field_key}.dxf")
        if not os.path.exists(dxf_path):
            print(f"WARNING: {dxf_path} not found, skipping")
            continue

        print(f"Parsing {field_key}...")
        segments = parse_dxf(dxf_path)
        print(f"  Raw segments: {len(segments)}")

        normalized, bounds = normalize_segments(segments)
        print(f"  Normalized segments: {len(normalized)}")
        print(f"  Natural dims: {bounds['naturalWidth']:.2f} x {bounds['naturalHeight']:.2f}")

        all_data[field_key] = {
            "segments": normalized,
            "bounds": bounds,
        }

    ts_content = generate_ts(all_data)

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(ts_content)

    print(f"\nGenerated {OUTPUT_FILE}")
    total_segs = sum(len(d["segments"]) for d in all_data.values())
    print(f"Total line segments across all fields: {total_segs}")


if __name__ == "__main__":
    main()
