# Coordinate Conventions — DXF_THREE_WHEEL

> Internal reference for all coordinate code. Read this before writing any
> geometry logic.

## 1. PlanPoint / PlanLine (legacy types — `src/types/plan.ts`)

| Field | Meaning | Unit |
|-------|---------|------|
| `PlanPoint.x` | **North** (NED convention) | metres |
| `PlanPoint.y` | **East** (NED convention) | metres |

These are used throughout `PlanLine.from` / `PlanLine.to` and in template generators
(`shapeTemplates.ts`, `characterTemplates.ts`, `sportsFieldTemplates.ts`).

## 2. PlacedItem placement (BoundaryEditor.tsx)

| Field | Meaning | Unit |
|-------|---------|------|
| `item.x` | **East** translation | metres |
| `item.y` | **North** translation | metres |
| `item.rotation` | CCW in the north/east plane | degrees |
| `item.scale` | Uniform scale multiplier | dimensionless |

**⚠️ Swap alert:** `PlacedItem.x` = east, but `PlanPoint.x` = north.
This is opposite. The `handleParse` flatten accounts for this by using
`item.y` as the north offset and `item.x` as the east offset.

## 3. SVG canvas (BoundaryEditor.tsx)

| SVG axis | Maps to | Sign |
|----------|---------|------|
| SVG X (right) | East | positive |
| SVG Y (down) | **−North** (north points UP on screen) | **negated** |

Conversion: `svgX = east * METER_TO_PX`, `svgY = -north * METER_TO_PX`
where `METER_TO_PX = 100`.

## 4. DXF export (dxfGenerator.ts)

| DXF group code | Maps to | Source field |
|----------------|---------|-------------|
| 10 (X) | **East** | `PlanPoint.y` |
| 20 (Y) | **North** | `PlanPoint.x` |

The swap happens in `linesToDxf`: `"10", String(entry.from.y), "20", String(entry.from.x)`.

## 5. Backend alignment API

| API field | Maps to |
|-----------|---------|
| `dxf_x` | **East** (= PlanPoint.y) |
| `dxf_y` | **North** (= PlanPoint.x) |

See `buildVisualAlignmentRefPoints` in `visualAlignment.ts`.

## 6. handleParse flatten (TemplatesPage.tsx L524–553)

```
fx = (line.from.x * cos − line.from.y * sin) + item.y   // north
fy = (line.from.x * sin + line.from.y * cos) + item.x   // east
```

This rotates template-local (north, east) by `item.rotation`, then
translates by `(item.y=north, item.x=east)`.

**⚠️ item.scale is NOT applied here** — see double-scale bug (R1).

## 7. transformVisualDxfPoint (visualAlignment.ts)

```
north = (north_in * cos − east_in * sin) * scale + item.y
east  = (north_in * sin + east_in * cos) * scale + item.x
```

This DOES apply `item.scale`. Map preview uses this function.
When `item.scale ≠ 1`, map preview and export disagree.

## 8. New canonical types (Phase 1+)

All new types use explicit field names:
- `northM` — north in metres
- `eastM` — east in metres

No ambiguous `x`/`y` in new code. See `src/types/designDocument.ts`.

---

## Summary of swaps

```
PlanPoint.x = north,  PlanPoint.y = east
PlacedItem.x = east,  PlacedItem.y = north
DXF group 10 = east,  DXF group 20 = north
API dxf_x = east,     API dxf_y = north
SVG X = east,         SVG Y = −north
```

All consistent: **east goes to X-like axes, north goes to Y-like axes**.
The confusion is only in naming (`PlanPoint.x` is actually the Y-like axis).
