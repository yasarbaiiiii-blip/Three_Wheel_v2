# Rover Three Wheel — Map Features Analysis (for ChatGPT)

This document exhaustively catalogs all map-related features, components, utilities, types, and coordinate conventions in the Rover Three Wheel codebase. Use this as reference when analyzing, refactoring, or extending the map system.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Coordinate Systems & Conventions](#2-coordinate-systems--conventions)
3. [Core Component: `MapView` (Leaflet WebView)](#3-core-component-mapview-leaflet-webview)
4. [Core Component: `GeometryViewport` (SVG Preview)](#4-core-component-geometryviewport-svg-preview)
5. [Core Component: `BoundaryEditor` (SVG Canvas)](#5-core-component-boundaryeditor-svg-canvas)
6. [Map Projection Utilities](#6-map-projection-utilities)
7. [Map Geometry Frames & Auto-Origin System](#7-map-geometry-frames--auto-origin-system)
8. [GPS ↔ Local Metre Projection Math](#8-gps--local-metre-projection-math)
9. [Design Document Flattening (DesignDocument → PlanLine)](#9-design-document-flattening-designdocument--planline)
10. [Snap & Alignment Tools](#10-snap--alignment-tools)
11. [Types Related to Maps / Geometry](#11-types-related-to-maps--geometry)
12. [Data Flow: Plan → Map Projection → Leaflet Rendering](#12-data-flow-plan--map-projection--leaflet-rendering)

---

## 1. Architecture Overview

The app has **three distinct map/canvas systems**, each with different purposes:

| System | File | Technology | Purpose |
|--------|------|-----------|---------|
| **Leaflet Map** | `src/components/MapView.tsx` | React Native WebView + Leaflet.js CDN | GPS-tiled base map with rover overlay, plan lines, reference points, template placement |
| **SVG Plan Preview** | `src/components/GeometryViewport.tsx` | React Native SVG (react-native-svg) | DXF plan import preview — zoom, pan, rotate, line selection |
| **SVG Design Canvas** | `src/components/BoundaryEditor.tsx` | React Native SVG (react-native-svg) | Template placement, boundary editing, freehand drawing, snap grid |

**Data flow**: DXF/layout coordinates → `PlanLine[]` (with x=north, y=east in metres) → projection via GPS anchor/ref points → GPS coordinates → Leaflet rendering.

---

## 2. Coordinate Systems & Conventions

### 2.1 Primary Convention (from `docs/coordinate-conventions.md`)

| Context | X-axis | Y-axis | Unit |
|---------|--------|--------|------|
| **PlanLine / DXF geometry** | north | east | metres |
| **SVG (GeometryViewport)** | east (`y` value) | −north (`-x` value) | 100 px/metre |
| **SVG (BoundaryEditor)** | east | −north | 100 px/metre |
| **Leaflet (MapView)** | latitude (`[lat, lon]` tuples) | longitude | degrees |

### 2.2 Key Mappings in Code

- `PlanLine.from.x` = **North** (metres)
- `PlanLine.from.y` = **East** (metres)
- `PlanLine.to.x` = **North** (metres)
- `PlanLine.to.y` = **East** (metres)
- Leaflet coordinates: `[lat, lon]` arrays and `L.latLng(lat, lon)`
- `autoOrigin.planStartNorth` = plan start north (metres)
- `autoOrigin.planStartEast` = plan start east (metres)
- `projectionOrigin.originDxfNorth` = north offset subtracted before GPS projection
- `projectionOrigin.originDxfEast` = east offset subtracted before GPS projection

### 2.3 Coordinate Transform Chain

```
DXF/Local (north, east metres)
  → Subtract origin offset (originDxfNorth, originDxfEast)
  → projectLocalMetersToGps(north, east, originLat, originLon)
  → GPS (lat, lon degrees)
  → Leaflet map
```

**Reverse direction** (map click → DXF):
```
GPS click (lat, lon)
  → projectGpsToLocalMeters(lat, lon, originLat, originLon) → (north, east)
  → Add origin offset (originDxfNorth, originDxfEast)
  → DXF coordinates
```

---

## 3. Core Component: `MapView` (Leaflet WebView)

**File**: `src/components/MapView.tsx` (2599 lines)

### 3.1 Architecture

Uses `react-native-webview` to embed a full Leaflet.js map inside the React Native app. Communication is via `postMessage`/`onMessage` JSON protocol.

### 3.2 Leaflet HTML String (`LEAFLET_HTML`)

Embedded as a backtick template literal. Key features:

**Tile Layers** (lines 207-217):
- **OpenStreetMap** tiles: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`
- **Satellite imagery** (Esri): `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
- Max zoom: 25 (OSM), 22 (Satellite)
- Max native zoom: 19 (OSM), 18 (Satellite)

**Map Initialisation** (lines 219-225):
- `L.map('map', { center: [0,0], zoom: 18, layers: [osm], zoomControl: true })`
- `L.control.attribution({ position: 'bottomright', prefix: false })`

### 3.3 Leaflet Layers (State Variables)

| Variable | Type | Purpose |
|----------|------|---------|
| `roverMarker` | `L.marker` (divIcon) | Rover vehicle position with heading arrow SVG |
| `roverCircle` | `L.circle` | 1.5m radius dashed circle around rover |
| `nextTargetLine` | `L.polyline` | Dashed line from rover to next waypoint |
| `nextTargetCircle` | `L.circleMarker` | Pulsing circle at next waypoint |
| `planLinesGroup` | `L.layerGroup` | All projected plan lines |
| `refPointsGroup` | `L.layerGroup` | GPS reference point markers |
| `itemLayersGroup` | `L.layerGroup` | Placed template items (templates mode) |
| `boundaryLayersGroup` | `L.layerGroup` | Boundary box outline + drag handle |
| `boundaryPointsGroup` | `L.layerGroup` | Boundary control point circles |
| `cornerMarkers` | `L.layerGroup` | Selected line corner-point indicators |
| `selectedLineLayer` | `L.polyline` | Highlighted selected line (red, 4px) |
| `startArrowMarker` | `L.marker` (divIcon) | Red arrow at plan start direction |

### 3.4 React ↔ Leaflet Message Protocol

The React Native side sends JSON messages via `postMessage`. The Leaflet `handleMessage` function (line 1443) processes them:

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `updateRover` | RN → WebView | Update rover position (lat, lon, heading, nextTarget) |
| `updatePlanLines` | RN → WebView | Update projected plan lines |
| `updateRefPoints` | RN → WebView | Update reference point markers |
| `updateRefPointLabels` | RN → WebView | Toggle reference point tooltip labels |
| `recenter` | RN → WebView | Pan map to rover position |
| `fitPlan` | RN → WebView | Fit map bounds to all plan lines |
| `updatePlacedItems` | RN → WebView | Update template items in templates mode |
| `updateBoundary` | RN → WebView | Update boundary box geometry |
| `updateShowBoundaryPoints` | RN → WebView | Toggle boundary control points visibility |
| `updateActiveSnapPoint` | RN → WebView | Highlight a specific snap point |
| `updateSketchMode` | RN → WebView | Toggle sketch mode opacity |
| `updateLocks` | RN → WebView | Lock pan/zoom gestures |
| `updateMultiTouchMode` | RN → WebView | Set multi-touch mode (both/scale/rotate) |
| `updateSelection` | RN → WebView | Highlight selected line + corner points |
| `clearSelection` | RN → WebView | Clear selection highlights |
| `setMode` | RN → WebView | Switch between "fields" and "templates" mode |

Messages from WebView → React Native:

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `mapClick` | WebView → RN | User tapped on map (lat, lon) |
| `selectItems` | WebView → RN | User selected/deselected items |
| `boundaryDragDebug` | WebView → RN | Debug logging for boundary drag |
| `itemsMoved` | WebView → RN | Items dragged by user (latDelta, lonDelta converted to metres) |
| `itemsPinched` | WebView → RN | Items scaled/rotated via pinch |
| `boundaryDragged` | WebView → RN | Boundary box moved |

### 3.5 React Native Side (`MapView` function component)

**Props** (lines 70-108):
- `telemetrySnapshot` — rover GPS + heading
- `lines` — PlanLine[] array
- `alignedRefPoints` — GPS anchor points `{dxf_x, dxf_y, lat, lon}[]`
- `mode` — "fields" | "templates"
- `placedItems` / `selectedItemIds` — template mode
- `boundaryWidth` / `boundaryHeight` / `indentSpacing` — boundary box
- `lockPanDrag` / `lockZoom` — gesture locks
- `multiTouchMode` — "both" | "scale" | "rotate"
- `previewAnchor` / `autoOriginReference` / `mapGeometryFrame` — projection sources
- Callbacks: `onSelectPoint`, `onSelectLine`, `onSelectionChange`, `onUpdatePlacedItems`, `onMoveBoundary`, `onPlaceRoverAtPoint`

**Projection Memos** (used to convert DXF → GPS):

1. **`geometryFrame`** (line 1647): Resolves map geometry frame from inputs (mode, previewAnchor, alignedRefPoints, autoOrigin)
2. **`projectionOrigin`** (line 1669): Resolves the full `MapProjectionOrigin` from geometry frame + fallback to floating origin in templates mode
3. **`origin`** (line 1702): Simplified version of projection origin for caching

**GPS memoized projections**:

| Memo | Purpose |
|------|---------|
| `projectedPlanLines` (line 1732) | Lines converted to GPS `[lat, lon][]` with colour per layer |
| `projectedBoundary` (line 1752) | Boundary box corners projected to GPS |
| `projectedBoundaryControlPoints` (line 1800) | 8 control points (4 corners + 4 midpoints) |
| `projectedPlacedItems` (line 1817) | Template items with lines + bounding boxes in GPS |

**Rover next-target logic** (lines 1916-1954):
- Given rover's real N/E position, finds the closest plan segment ahead
- Projects the next waypoint to GPS
- Renders as dashed line + pulsing circle on map

### 3.6 Rover Marker SVG

Lines 354-365 — a divIcon containing an inline SVG of the rover vehicle:
- Rounded body with translucent cyan background circle
- Black "cabin" and "wheels" polygons
- Cyan "glass" windshield
- Yellow "beacon" circle on top
- Heading rotation via CSS transform with transition

### 3.7 Boundary Drag System (Templates Mode)

A sophisticated drag system that intercepts both mouse and touch events:

**Event flow**:
1. `onMouseDown` / `onTouchStart` → `hitTest` → identify if tap is on boundary handle, boundary edge, item, or background
2. `onMouseMove` / `onTouchMove` → update positions locally in Leaflet at 60fps
3. `onMouseUp` / `onTouchEnd` → commit changes

**Snap-to-rover**: When dragging boundary, if a control point comes within 3m of the rover, it snaps (lines 1033-1057).

**Boundary control points** (projectedBoundaryControlPoints, line 1800):
- 8 points: 4 corners (tl, tr, br, bl) + 4 midpoints (t, r, b, l)
- Active snap point shown with pulsing yellow glow

---

## 4. Core Component: `GeometryViewport` (SVG Preview)

**File**: `src/components/GeometryViewport.tsx` (1360 lines)

### 4.1 Purpose

Displays imported DXF plan geometry as an interactive SVG with zoom, pan, rotate, and line selection. Used in the Plan tab and the home screen (compact mode).

### 4.2 Rendering Pipeline

1. **`buildSvgPathChunks(lines)`** (line 69): Converts PlanLine[] to SVG path `d` strings (`M{y} {x}L{y} {x}` — note the x/y swap: SVG X = east, SVG Y = -north)
2. **`planTransform`** (line 331): Combined SVG transform: `translate(center) rotate(rotation) translate(-center) translate(offset) scale(zoom, -zoom)` — the negative Y scale handles the north→SVG flip
3. **Layers**: Rendered in order: boundary, marking, center — each with distinct colours
4. **Arrowheads**: Triangular arrowhead indicators at line midpoints (direction indicators)
5. **Selection**: Selected line highlighted in emerald green with endpoint circles

### 4.3 Viewport Culling

Lines 222-240: Lines outside the visible bounds are filtered out to improve performance (viewport culling with 20% margin).

### 4.4 Compass Overlay

Lines 626-658: Floating SVG compass rose in top-right corner showing:
- Cardinal labels (N, S, E, W)
- Rotating needle matching the plan rotation angle
- Red north pointer, grey south pointer

### 4.5 Interaction

- **Pan/Drag**: PanResponder with RAF-throttled offset updates (lines 337-383)
- **Rotate**: Drag-based rotation (dx*0.6 degrees) or modal numeric input
- **Zoom**: Pinch-to-zoom with 0.6–2.6 range
- **Tap selection**: `handleCanvasTapFromLocalPoint` converts screen→SVG→plan coordinates, then `findNearestLine` with hit threshold

### 4.6 RAF Throttle (Performance)

Lines 192-209: Uses `requestAnimationFrame` to batch offset/zoom state updates during drag operations, preventing React re-render thrashing.

---

## 5. Core Component: `BoundaryEditor` (SVG Canvas)

**File**: `src/components/BoundaryEditor.tsx` (1135 lines)

### 5.1 Purpose

Interactive SVG canvas for placing sports field templates, editing boundary box, drawing lines, and freehand sketching. Used in the templates overlay.

### 5.2 Key Features

- **Cartesian Grid** (lines 94-153): 0.1m grid lines with major/minor distinction and origin axes at (0,0)
- **Boundary Box**: Rectangular boundary with indent spacing (inner canvas area)
- **Drag Handle**: Interactive handle at top-left corner for moving the entire boundary
- **Control Points**: 8 points (4 corners + 4 midpoints) for snap alignment
- **Template Items**: Each item rendered with SVG Path (batched lines) with rotation, scaling, selection highlight
- **Drawing Tools**: LINE and FREEHAND modes with snap-to-grid and snap-to-existing-points

### 5.3 Coordinate Transform

- `METER_TO_PX = 100` (100 SVG pixels per metre)
- SVG viewBox computed from boundary dimensions and camera position
- `screenToDesignMeters()` / `designToSvg()` from `designTransform.ts`

### 5.4 Interaction System

- `PanResponder` for all gestures (line 410)
- `hitTest` (line 277): Sophisticated hit detection checking items (lines first, then bounding boxes), boundary handle, boundary edges, boundary interior
- Gesture types: items drag, camera pan, boundary move, pinch (scale/rotate)
- RAF throttle for camera and items state updates (line 237)

### 5.5 Pinch Gesture Details

Lines 506-600: Two-finger pinch with:
- `initialDist` / `initialAngle` tracking
- Scale and rotation computed relative to item group centroid
- Clamping inside boundary indent region
- Multi-touch mode controls whether scale, rotation, or both are applied

---

## 6. Map Projection Utilities

### 6.1 `src/utils/mapGeometryProjection.ts` (148 lines)

Central projection origin resolution and GPS conversion.

**Key types**:
```typescript
type MapProjectionOrigin = {
  frame: MapGeometryFrame;
  originLat: number;
  originLon: number;
  originDxfNorth: number;   // subtracted from PlanLine.from.x
  originDxfEast: number;    // subtracted from PlanLine.from.y
};
```

**Key functions**:

| Function | Input | Output |
|----------|-------|--------|
| `resolveMapGeometryFrame()` | mode, previewAnchor, alignedRefPoints, stagedVerified, autoOriginReference, autoOriginEnabled | `MapGeometryFrame` enum |
| `resolveMapProjectionOrigin()` | frame + input | `MapProjectionOrigin \| null` |
| `projectPlanNorthEastToGps()` | north, east, origin | `{lat, lon}` |
| `projectPlanLineToGpsSegments()` | PlanLine, origin | `[lat, lon][]` — preview_points preferred, falls back to from→to |

**Frame resolution priority**:
1. Templates + previewAnchor → `"RAW_DESIGN"`
2. Valid aligned ref point + stagedVerified → `"SURVEYED_LOCAL"`
3. Valid aligned ref point → `"ALIGNED_DESIGN"`
4. Auto-origin enabled + reference → `"AUTO_ORIGIN_RAW"`
5. Otherwise → `"NONE"`

### 6.2 `src/utils/visualAlignment.ts` (110 lines)

Coordinate transform utilities for template placement.

**Key functions**:

| Function | Purpose |
|----------|---------|
| `transformVisualDxfPoint(north, east, item)` | Apply rotation + scale + translation to a DXF point → local NED metres |
| `projectLocalMetersToGps(north, east, originLat, originLon)` | Local metres → GPS using equirectangular approximation |
| `projectGpsToLocalMeters(lat, lon, originLat, originLon)` | GPS → local metres (inverse) |
| `buildVisualAlignmentRefPoints(corners, item, originLat, originLon)` | Build ref point pairs from bounding box corners |
| `computeLineBoundingBox(lines)` | Compute min/max N/E from PlanLine[] |

### 6.3 `src/utils/designTransform.ts` (352 lines)

Full DesignDocument → PlanLine flattening + SVG coordinate transforms.

**Key functions**:

| Function | Purpose |
|----------|---------|
| `flattenDesignDocument(doc, registry)` | Full DesignDocument → PlanLine[] with validation |
| `flattenDesignNode(node, registry, frame)` | Single node → PlanLine[] |
| `flattenInstance(instance, registry, frame)` | Template instance: apply rotation + scale + translation to template lines ONCE |
| `flattenEntity(entity, frame)` | Entity vertices → consecutive PlanLines |
| `screenToDesignMeters(screenX, screenY, ctx)` | Screen pixels → design metres (northM, eastM) |
| `designToSvg(vertex, pxPerM, frame)` | Design metres → SVG coordinates |
| `planLineLength(line)` | Euclidean length of a PlanLine |
| `simplifyPath(points, tolerance)` | Ramer-Douglas-Peucker polyline simplification |
| `projectDesignToGps(vertex, anchor)` | Design vertex directly to GPS relative to anchor |
| `projectGpsToDesignMeters(lat, lon, anchor)` | GPS back to design metres relative to anchor |

---

## 7. Map Geometry Frames & Auto-Origin System

### 7.1 Frame Types (`src/types/autoOrigin.ts`)

```typescript
type MapGeometryFrame =
  | "RAW_DESIGN"       // Template preview with anchor point
  | "AUTO_ORIGIN_RAW"  // Auto-origin from rover GPS → plan start
  | "ALIGNED_DESIGN"   // Visual alignment ref points available, not yet surveyed
  | "SURVEYED_LOCAL"   // Visual alignment confirmed/staged
  | "GEOGRAPHIC"       // Pure GPS coordinates (future)
  | "NONE"             // No valid origin
```

### 7.2 AutoOriginReference

```typescript
type AutoOriginReference = {
  planStartNorth: number;  // plan start north (metres)
  planStartEast: number;   // plan start east (metres)
  roverNorth: number;      // rover current north (metres)
  roverEast: number;       // rover current east (metres)
  latitude: number;        // rover GPS latitude
  longitude: number;       // rover GPS longitude
  capturedAtMs: number;    // timestamp
};
```

### 7.3 Plan Start Detection (`src/utils/planGeometry.ts`)

`getPlanStartPoint(lines)`:
1. Look for `"runtime-transit-0"` line
2. Fallback to `"ext-pre-"` extension lines
3. Fallback to first primary editable line
4. Return `{north, east}` or null

### 7.4 Templates Floating Origin

In `MapView.tsx` lines 1619-1645: When in templates mode with no preview anchor and no aligned ref points, the rover's current GPS position is used as a floating origin for placing templates.

---

## 8. GPS ↔ Local Metre Projection Math

All projection uses the **equirectangular approximation** (flat-Earth for small areas):

```typescript
const EARTH_RADIUS = 6378137.0; // WGS-84 semi-major axis

// Local → GPS
lat = originLat + (north / EARTH_RADIUS) * (180 / π)
lon = originLon + (east / (EARTH_RADIUS * cos(originLatRad))) * (180 / π)

// GPS → Local
north = (lat - originLat) * (EARTH_RADIUS * π / 180)
east = (lon - originLon) * (EARTH_RADIUS * cos(originLatRad) * π / 180)
```

This is implemented in 3 places with identical math:
1. `visualAlignment.ts` — `projectLocalMetersToGps()` / `projectGpsToLocalMeters()`
2. `MapView.tsx` — `projectGpsToLocalMeters()` function (lines 20-30)
3. `designTransform.ts` — `projectDesignToGps()` / `projectGpsToDesignMeters()`

---

## 9. Design Document Flattening (DesignDocument → PlanLine)

`src/utils/designTransform.ts`

### 9.1 Tree Structure

```
DesignDocument
  └── DesignNode[] (nodes)
       ├── DesignInstance (template reference + transform)
       │   └── Template → PlanLine[] (from template registry)
       └── DesignEntity (raw geometry)
            └── DesignVertex[] → PlanLine[] (consecutive pairs)
```

### 9.2 Instance Transform

Applied ONCE per instance (no double-scaling):

```
worldNorth = (localNorth * cosθ - localEast * sinθ) * scale + northM
worldEast  = (localNorth * sinθ + localEast * cosθ) * scale + eastM
```

### 9.3 Entity Flattening

Consecutive vertex pairs become PlanLines:
- Vertex 0→1 = line 0, Vertex 1→2 = line 1, etc.
- POINT type entities produce no lines
- Layer string is normalised to lowercase

---

## 10. Snap & Alignment Tools

### 10.1 `src/utils/designSnap.ts` (63 lines)

| Function | Purpose |
|----------|---------|
| `snapToGrid(vertex, spacingM)` | Snap to grid with 0.001m (1mm) quantum precision |
| `findSnapCandidate(pointer, lines, zoom, pxPerM, radiusPx)` | Find nearest existing line endpoint within screen-pixel radius |

### 10.2 Visual Alignment (`src/utils/visualAlignment.ts`)

`buildVisualAlignmentRefPoints()` creates GPS reference pairs from bounding box corners after applying item transform. Used for "visual alignment mode" where the user aligns a template to a known GPS position.

### 10.3 Alignment Design Policy (`src/utils/designAlignmentPolicy.ts`)

(Referenced but not fully read — contains alignment business logic)

---

## 11. Types Related to Maps / Geometry

### 11.1 `src/types/autoOrigin.ts`

```typescript
type AutoOriginReference = { planStartNorth, planStartEast, roverNorth, roverEast, latitude, longitude, capturedAtMs }
type MapGeometryFrame = "RAW_DESIGN" | "AUTO_ORIGIN_RAW" | "ALIGNED_DESIGN" | "SURVEYED_LOCAL" | "GEOGRAPHIC" | "NONE"
```

### 11.2 `src/types/plan.ts` (key types)

```typescript
type PlanPoint = { id: number; x: number; y: number }          // x=north, y=east
type PlanLine = {
  id: string;
  from: PlanPoint;
  to: PlanPoint;
  layer: "boundary" | "marking" | "marking_false" | "center" | "transit" | "extension";
  entity?: { entity_type: string; preview_points?: { north: number; east: number }[] };
};
type TelemetrySnapshot = { lat: number; lon: number; heading_ned_deg: number; pos_n: number; pos_e: number };
```

### 11.3 `src/types/designDocument.ts` (key types)

```typescript
type DesignVertex = { northM: number; eastM: number };
type DesignFrame = { originNorthM: number; originEastM: number };
type DesignPreviewAnchor = { mode: "rover_latched" | "manual"; lat: number; lon: number };
type DesignEntity = { id: string; type: "LINE" | "FREEHAND" | "ARC"; layer: string; vertices: DesignVertex[] };
type DesignInstance = { id: string; templateId: string; transform: { northM: number; eastM: number; rotationDeg: number; scale: number } };
```

### 11.4 Boundary Editor Types

```typescript
type PlacedItem = {
  id: string;
  lines: PlanLine[];
  x: number;         // east (metres)
  y: number;         // north (metres)
  rotation: number;  // degrees
  scale: number;
  groupId?: string;
  width: number;     // east span
  height: number;    // north span
};
```

---

## 12. Data Flow: Plan → Map Projection → Leaflet Rendering

### 12.1 Fields Mode (Mission Plan)

```
DXF File Import
  → PlanLine[] (x=north, y=east)
  → Visual alignment (user matches DXF → GPS)
  → alignedRefPoints: {dxf_x, dxf_y, lat, lon}[]
  → resolveMapProjectionOrigin() → MapProjectionOrigin
  → projectPlanLineToGpsSegments() → [lat, lon][]
  → postMessage({ type: "updatePlanLines", lines })
  → Leaflet renders planLinesGroup
```

+ Telemetry rover position sent as `updateRover` message.

### 12.2 Templates Mode (Sports Fields)

```
Template selected from registry
  → PlacedItem (x=east, y=north, rotation, scale, lines)
  → transformVisualDxfPoint() → local NED
  → projectPlanNorthEastToGps() → GPS lines + bounding box
  → postMessage({ type: "updatePlacedItems", items })
  → Leaflet renders itemLayersGroup
```

+ Boundary box projected similarly.
+ Pinch/pan/drag events sent back as `itemsMoved`, `itemsPinched`, `boundaryDragged`.

### 12.3 Map Click → Plan Coordinate

```
Leaflet click event (lat, lon)
  → postMessage({ type: "mapClick", lat, lon })
  → projectGpsToLocalMeters() → {north, east}
  → Add originDxfNorth/East → DXF coordinates
  → Hit test against plan lines/points
  → onSelectPoint() or onSelectLine() called
```

---

## Appendix: Key File Index

| File | Lines | Role |
|------|-------|------|
| `src/components/MapView.tsx` | 2599 | Leaflet WebView — main map |
| `src/components/GeometryViewport.tsx` | 1360 | SVG plan preview |
| `src/components/BoundaryEditor.tsx` | 1135 | SVG template canvas |
| `src/utils/mapGeometryProjection.ts` | 148 | Projection origin resolution |
| `src/utils/visualAlignment.ts` | 110 | Coordinate transforms |
| `src/utils/designTransform.ts` | 352 | Design flattening + SVG coords |
| `src/utils/designSnap.ts` | 63 | Grid/endpoint snapping |
| `src/utils/planGeometry.ts` | 53 | Plan start detection |
| `src/utils/designMapProjection.test.ts` | 50 | Projection tests |
| `src/types/autoOrigin.ts` | 17 | Auto-origin types |
| `src/screens/HomeScreen.tsx` | 49 | Home screen (empty state) |
| `src/screens/PlanScreen.tsx` | 41 | Plan tab screen |
| `src/components/LeftSidebar.tsx` | 1743 | Sidebar (MapPinned, Satellite icons) |
| `src/data/samplePlan.ts` | — | Sample plan data |
| `docs/coordinate-conventions.md` | — | Coordinate documentation |

**End of document.** Use this as reference for all map-related code analysis, refactoring, and feature development.