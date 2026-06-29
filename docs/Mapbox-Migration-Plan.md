# Mapbox Migration Plan — Rover Three Wheel

**Status:** DRAFT — awaiting user approval before any implementation begins.
**Target library:** [`@rnmapbox/maps`](https://rnmapbox.github.io/docs/) v10.x (npm), backed by the Mapbox Maps SDK **v11** (native).
**Author:** Migration working document. Every API reference links to official documentation. No APIs are invented; anything unverified is flagged in §13.

> Source note: This plan is grounded in both (a) the live source in this repo (`src/components/MapView.tsx`, `src/utils/mapGeometryProjection.ts`, `src/utils/visualAlignment.ts`, `src/utils/designTransform.ts`) and (b) the project analysis document **`docs/map-features-chatgpt-analysis.md`** ("Rover Three Wheel — Map Features Analysis (for ChatGPT)"), which is treated as the canonical description of the current system. Where this plan cites line numbers or layer/message names, they were cross-checked against that analysis and the code.

---

## 1. Executive Summary

### What exists today
The main map (`src/components/MapView.tsx`, ~2,580 lines) is a **`react-native-webview` hosting Leaflet 1.9.4 loaded from a CDN** (`unpkg.com`). React Native and the WebView communicate exclusively through a hand-rolled JSON `postMessage` / `onMessage` protocol (16 inbound message types, 7 outbound). Two basemaps are configured inside the HTML: OpenStreetMap raster tiles and Esri World Imagery satellite tiles.

The SVG-based editors — `GeometryViewport.tsx` (~1,360 lines) and `BoundaryEditor.tsx` (~1,135 lines) — are **separate** from the Leaflet map. They render plan geometry in local screen space via `react-native-svg` and are **out of scope for Phase 1**.

### Recommended scope
**Phased / hybrid replacement.** Phase 1 replaces *only* the Leaflet WebView inside `MapView.tsx` with a native `@rnmapbox/maps` map, preserving the exact public props contract of `MapView` so that `App.tsx` and `TemplatesPage.tsx` need **zero call-site changes**. The SVG editors stay untouched.

**Phase 1 is rendering + read interactions only:**
- ✅ Full rendering parity (basemap, plan lines with `preview_points`, rover marker + heading + range circle, next-target line/marker, reference points + labels, start-direction arrow, placed items + bounding boxes, boundary box outer/indent, control points, corner points).
- ✅ Camera controls (recenter-on-rover, fit-to-plan).
- ✅ Tap selection (point/line in Fields; item/background in Templates) and tap-to-place-rover at boundary points.
- ✅ Selection highlighting (selected line + corner points; selected item/boundary styling).
- ⏭️ **Deferred to Phase 2:** interactive **drag / scale / rotate of placed items**, **boundary box dragging**, and **snap-to-rover** while dragging. In Phase 1 these are rendered statically and respond to selection, but are not gesture-editable on the native map.

This keeps Phase 1 a tractable, verifiable parity milestone and isolates the genuinely hard part (native multi-touch gesture math that today lives in the WebView) into its own phase.

### Basemap recommendation (summary)
**Switch from the current raw Esri + OSM raster tiles to a Mapbox vector/satellite style** (e.g. Mapbox **Satellite Streets**, or a custom Studio style). Rationale and trade-offs in §8; this is the single biggest enabler for the offline goal and is raised as a decision in §13.

### Why migrate
1. **Offline field use** is the core driver. The current map loads *both* the Leaflet library *and* its tiles over the network — it is effectively unusable without connectivity. Mapbox's native SDK supports proper offline region downloads.
2. **Performance**: native rendering vs. a WebView bridge marshalling JSON on every rover telemetry tick.
3. **Maintainability**: replace a bespoke string-based message protocol with typed refs/props and native events.

---

## 2. Current Architecture Analysis

### 2.1 `MapView.tsx` (Leaflet WebView) — the migration target

**Public props** (`MapViewProps`, lines ~71–110) — this contract MUST be preserved:

| Prop | Purpose |
|------|---------|
| `telemetrySnapshot` | Rover GPS (`lat`/`lon`), `heading_ned_deg`, `pos_n`/`pos_e` |
| `lines: PlanLine[]` | Plan geometry in DXF north/east metres |
| `alignedRefPoints` | `{dxf_x, dxf_y, lat, lon}[]` survey reference points |
| `mode` | `"fields"` \| `"templates"` |
| `placedItems`, `selectedItemIds`, `multiTouchMode` | Templates-mode item manipulation |
| `boundaryWidth/Height`, `indentSpacing`, `boundaryPosition` | Templates boundary box |
| `lockPanDrag`, `lockZoom`, `sketchMode` | Interaction locks |
| `showBoundaryPoints`, `activeSnapPointId`, `showRefPointLabels`, `showCornerPoints` | Overlays |
| `recenterRoverTrigger`, `recenterPlanTrigger` | Imperative camera nudges (counter pattern) |
| `previewAnchor`, `autoOriginReference`, `mapGeometryFrame`, `stagedVerified`, `autoOriginEnabled` | Projection-origin inputs |
| Callbacks | `onSelectPoint`, `onSelectLine`, `onMoveBoundary`, `onPlaceRoverAtPoint`, `onUpdatePlacedItem(s)`, `onSelectionChange` |

**Consumed at two call sites** (verified): `App.tsx` (~line 9690, Fields/visual-alignment) and `src/screens/TemplatesPage.tsx` (~line 1069, Templates boundary mode).

> **Preserved technical debt — `recenterRoverTrigger` / `recenterPlanTrigger`.** These two props use the "incrementing counter" trigger pattern (the parent bumps a number to imperatively request a recenter/fit). It is not the cleanest API — a `ref` with imperative methods would be more idiomatic — but it is **deliberately kept as-is** so the native `MapView` is a true drop-in with **zero call-site changes** in `App.tsx`/`TemplatesPage.tsx`. Internally the native renderer maps each trigger change to a `cameraRef` call (§7.2). Cleaning up this pattern is explicitly out of scope for Phases 1–2.

### 2.2 RN → WebView message protocol (inbound; `data.type ===`)
`updateRover`, `updatePlanLines`, `updateRefPoints`, `updateRefPointLabels`, `recenter`, `fitPlan`, `updatePlacedItems`, `updateBoundary`, `updateShowBoundaryPoints`, `updateActiveSnapPoint`, `updateSketchMode`, `updateLocks`, `updateMultiTouchMode`, `updateSelection`, `clearSelection`, `setMode`.

### 2.3 WebView → RN message protocol (outbound; `postMessage`)
`mapClick` (lat/lon), `selectItems` (ids), `boundaryDragDebug`, `itemsMoved` (updates), `itemsPinched` (updates), `boundaryDragged` (latDelta/lonDelta), `boundaryPointClicked` (pointId/latlng).

### 2.4 Map overlays / layers to reproduce (from analysis §3.3)
The Leaflet HTML maintains these layer groups — Phase 1 must reproduce each natively:

| Leaflet object | Visual | Phase 1 native equivalent |
|---|---|---|
| `roverMarker` (divIcon) | Rover vehicle SVG with heading rotation | `SymbolLayer`/`MarkerView` |
| `roverCircle` | 1.5 m dashed range circle around rover | **GeoJSON circle** via `@turf/circle` → `LineLayer`/`FillLayer` (see ⚠️ below) |
| `nextTargetLine` | Dashed line rover → next waypoint | `LineLayer` |
| `nextTargetCircle` | Pulsing circle at next waypoint | `MarkerView` + RN `Animated` (see ⚠️ pulse note below) |
| `planLinesGroup` | All projected plan lines (per-layer colour) | `ShapeSource` + `LineLayer` |
| `refPointsGroup` | GPS reference markers (+ optional labels) | `ShapeSource` + `Symbol`/`Circle` |
| `itemLayersGroup` | Placed template items (Templates) | `ShapeSource` + `Line`/`Fill` |
| `boundaryLayersGroup` | Boundary outline + drag handle | `ShapeSource` + `Fill`/`Line` |
| `boundaryPointsGroup` | 8 boundary control points | `CircleLayer` |
| `cornerMarkers` | Selected-line corner indicators | `CircleLayer` |
| `selectedLineLayer` | Highlighted selected line (red, 4px) | `LineLayer` (data-driven width/colour) |
| `startArrowMarker` (divIcon) | Red arrow at plan start direction | `SymbolLayer` |

> ⚠️ **The 1.5 m rover range circle is a real-world radius, not a screen radius.** `CircleLayer`'s `circleRadius` is measured in **pixels**, so it cannot represent a fixed 1.5 m ground distance (it would not scale with zoom). Generate a true geographic circle polygon with **`@turf/circle`** (`circle(center, 1.5, { units: 'meters' })`) and render the resulting GeoJSON via a `FillLayer` (filled) and/or `LineLayer` (dashed outline). The circle's center feature lives in the dedicated rover `ShapeSource` (§9.1) and is regenerated when the rover position changes. The same applies to any other metre-defined radii (e.g. the 3 m snap threshold visualisation in Phase 2).

> ⚠️ **Pulsing next-target marker:** a Mapbox `CircleLayer`/`SymbolLayer` style value cannot be smoothly animated frame-by-frame from JS without restyling the layer each tick (expensive and not the intended use). Instead, render the pulsing waypoint as a **`MarkerView`** anchored at the projected waypoint coordinate, containing a normal React Native view whose scale/opacity are driven by **`Animated`** (or `react-native-reanimated`, already a dependency) in a looping pulse. This keeps the animation on the RN/native animation driver and off the map-style hot path. The dashed connector line stays a `LineLayer` with `lineDasharray` (static). Note that `MarkerView` re-projects on pan/zoom, which is the desired behaviour for a point anchored to a geographic location. (`MarkerView` doc: https://rnmapbox.github.io/docs/components/MarkerView — to be confirmed per §14.)

### 2.5 Plan-line rendering detail (`preview_points`)
`projectPlanLineToGpsSegments()` (verified) **prefers `line.entity.preview_points`** (≥2 points → polyline through every point) and only **falls back to the straight `from → to` segment** when preview points are absent. The native `LineLayer` GeoJSON builder must replicate this preference exactly so curved/multi-vertex entities render identically.

**Concrete implementation:**
- Reuse `projectPlanLineToGpsSegments(line, origin)` unchanged — it already encodes the preview-points-first / `from→to`-fallback logic. The builder simply maps its returned `[lat, lon][]` through `toMapboxCoord` to produce a GeoJSON `LineString` `coordinates` array per line:
  ```ts
  const segs = projectPlanLineToGpsSegments(line, origin);          // [lat,lon][]
  const coordinates = segs.map(([lat, lon]) => toMapboxCoord(lat, lon)); // [lon,lat][]
  // → { type: 'Feature', geometry: { type: 'LineString', coordinates },
  //     properties: { id: line.id, layer: line.layer, color: colorFor(line.layer) } }
  ```
- **Layer colouring** is data-driven: each feature carries `properties.color` (and `properties.layer`), and the `LineLayer` reads it via the documented expression `lineColor: ['get', 'color']`. A single `colorFor(layer)` map replaces the per-feature loop currently in `projectedPlanLines`.
- **`marking_false` handling:** the analysis lists a `marking_false` layer value not present in the `PlanLayer` union in `src/types/plan.ts`. `colorFor` will therefore (a) be keyed off the existing `LAYER_COLORS` map, (b) treat `marking_false` as a distinct key (rendered de-emphasised — e.g. lighter/dashed to indicate a non-active marking), and (c) fall back to a default colour for any unrecognised value so an unexpected layer string can never crash rendering. Whether `marking_false` should be visible at all (vs. filtered out) is a small product question flagged to the user; default is render-but-de-emphasise to match current behaviour.

### 2.6 Snap-to-rover (Templates boundary drag) — Phase 2
Per analysis §3.7: while dragging the boundary, if a control point comes within **3 m of the rover** it snaps. This is part of the deferred boundary-drag interaction and moves to **Phase 2** with the rest of gesture editing.

### 2.7 SVG editors (NOT migrated in Phase 1)


- `GeometryViewport.tsx` — renders plan lines, builds SVG path chunks, nearest-line picking, in local pan/zoom screen space.
- `BoundaryEditor.tsx` — `PanResponder`-driven item drag/scale/rotate, design-meters ↔ SVG via `utils/designTransform.ts`.

These do not use GPS and have no Leaflet dependency, so they are unaffected.

---

## 3. Recommended Migration Strategy — Phased (Strongly Preferred)

**Phase 1 — Native MapView (drop-in replacement of the Leaflet WebView) — RENDERING + READ INTERACTIONS**
- New native renderer behind the **identical `MapViewProps` interface**.
- Implement, at parity: basemap, rover marker + heading + 1.5 m range circle, next-target line + pulsing marker, plan lines (honouring `preview_points`), reference points (+ labels), start-direction arrow, Fields selection highlight + corner points, Templates placed items (lines + bounding boxes) and boundary box (outer + indent + control points) **rendered statically**.
- Interactions in Phase 1: camera recenter/fit, **tap-select** (point/line, item/background), **tap-to-place-rover** at boundary points, and **selection highlighting**.
- **Explicitly deferred to Phase 2:** drag/scale/rotate of placed items, boundary box dragging, snap-to-rover during drag.
- Keep `react-native-webview` installed until Phase 1 is validated.
- Feature flag to switch implementations (see §11).

**Phase 2 — Native gesture editing + Offline**
- Native gesture-based item **drag / scale / rotate** to replace the WebView pinch math (reuse the existing clamping helpers extracted in §7.3).
- **Boundary box dragging** + **snap-to-rover** (3 m) behaviour.
- Offline region download for field areas (`offlineManager.createPack`).

> Detailed Phase 2 tasks, acceptance criteria, and sequencing are documented in [docs/Phase2-Task-List.md](./Phase2-Task-List.md).

**Phase 3 — Optional**
- Evaluate whether `GeometryViewport`/`BoundaryEditor` benefit from migration onto the Mapbox canvas. Only if there is a concrete UX win; otherwise leave as-is.

---

## 4. Key Technical Challenges & Risks

| # | Challenge | Mitigation |
|---|-----------|-----------|
| R1 | **Access token requirement.** `@rnmapbox/maps` requires `Mapbox.setAccessToken(...)` to initialize, even when rendering non-Mapbox raster tiles. | Decision needed (§13). Either provision a Mapbox public token, or confirm whether a raster-only `RasterSource` path works with an empty/placeholder token on the installed native SDK version. Must be verified on-device, not assumed. |
| R2 | **Coordinate order.** Existing projection returns `{lat, lon}`; Mapbox/GeoJSON expects `[longitude, latitude]`. | Single conversion boundary (§5). Reorder at the GeoJSON build step only; do **not** touch projection math. |
| R3 | **Offline tiles + custom raster basemap.** Mapbox offline packs are designed around Mapbox styles/tilesets; offline for arbitrary Esri/OSM raster tiles is not first-class. | Phase 2 decision: either adopt a Mapbox style (enables native offline) or build a custom raster offline cache. Flag to user (§13). |
| R4 | **New Architecture / Hermes / RN 0.81 / Expo 54 compatibility.** | Pin native SDK via config plugin; verify the chosen `@rnmapbox/maps` version supports RN 0.81 + Fabric before committing. Build through existing `expo prebuild` + Gradle flow (per `AGENTS.md`). |
| R5 | **`expo prebuild --clean` wipes signing edits** (documented in `AGENTS.md`). | Adding the config plugin only changes `app.json`; rebuild with plain `./gradlew assembleRelease`. Avoid `--clean`; if unavoidable, re-add `release.keystore` per `AGENTS.md`. |
| R6 | **High-frequency telemetry updates.** Rover position updates every tick. | Drive the rover marker through a `ShapeSource` whose GeoJSON updates via state/ref; avoid remounting layers. |
| R7 | **Behaviour parity of tap hit-testing.** Current point (2.0 m) / line (3.5 m) tolerances live in RN, fed by WebView `mapClick`. | Reuse the exact RN-side hit-testing logic (`distToSegment`, thresholds); only the click event source changes from `mapClick` message to Mapbox `onPress`. |

---

## 5. Coordinate System Handling Strategy (CRITICAL)

### 5.1 Existing conventions (verified, must be preserved)
- `PlanLine.from.x = North`, `PlanLine.from.y = East`, in metres (DXF/local NED). (`src/types/plan.ts`, comments in `mapGeometryProjection.ts`.)
- `item.x = East translation`, `item.y = North translation`, `item.rotation` = degrees CCW in the north/east plane. (`visualAlignment.ts` header contract.)
- Projection origin is resolved per **`MapGeometryFrame`** (`RAW_DESIGN`, `AUTO_ORIGIN_RAW`, `ALIGNED_DESIGN`, `SURVEYED_LOCAL`, `GEOGRAPHIC`, `NONE`) by `resolveMapGeometryFrame()` and `resolveMapProjectionOrigin()`.
- Local metres → GPS uses an **equirectangular flat-earth approximation** in `projectLocalMetersToGps()` (`visualAlignment.ts`), producing `{lat, lon}`. The inverse is `projectGpsToLocalMeters()`.

### 5.2 What stays unchanged
`resolveMapProjectionOrigin`, `resolveMapGeometryFrame`, `projectPlanNorthEastToGps`, `projectPlanLineToGpsSegments`, `transformVisualDxfPoint`, `projectLocalMetersToGps`, `projectGpsToLocalMeters`. **None of this math changes.** This is the explicit requirement from the brief and it is also the lowest-risk path.

Frame-resolution priority (analysis §6.1, verified in code), preserved as-is:
1. Templates + `previewAnchor` → `RAW_DESIGN`
2. Valid aligned ref point + `stagedVerified` → `SURVEYED_LOCAL`
3. Valid aligned ref point → `ALIGNED_DESIGN`
4. Auto-origin enabled + reference → `AUTO_ORIGIN_RAW`
5. Otherwise → `NONE` (plus the Templates floating-origin fallback that uses the rover's GPS, analysis §7.4)

> **Duplication note (analysis §8):** the identical equirectangular math exists in **three** places — `visualAlignment.ts`, `MapView.tsx` (local `projectGpsToLocalMeters`), and `designTransform.ts`. **`src/utils/visualAlignment.ts` is designated the canonical source** for this math (it already exports both `projectLocalMetersToGps` and `projectGpsToLocalMeters` and is the file the projection origin utilities build on). The new native `MapView` will **import `projectGpsToLocalMeters`/`projectLocalMetersToGps` from `visualAlignment.ts`** and will **not** re-declare its own copy (unlike the current Leaflet `MapView`, which has a private duplicate at lines ~20–30). Consolidating the third copy in `designTransform.ts` onto the canonical file is out of scope but noted as cleanup.

### 5.3 The only conversion the migration introduces
Leaflet consumes `[lat, lon]`. Mapbox/GeoJSON consume `[lon, lat]`. So everywhere the current code produces a Leaflet coordinate, the native renderer instead builds a GeoJSON coordinate by **swapping the pair**:

```ts
// projection util returns { lat, lon } — unchanged.
const { lat, lon } = projectPlanNorthEastToGps(north, east, origin);
const mapboxCoord = toMapboxCoord(lat, lon); // → [lon, lat], GeoJSON/Mapbox order
```

For inbound taps, Mapbox's `onPress` event geometry is `[lon, lat]`; feed it into the *existing* `projectGpsToLocalMeters(lat, lon, ...)` after unswapping. The hit-test thresholds and DXF reconstruction (`clickedDxfX = east + originDxfEast`, etc.) are reused verbatim.

This single conversion is centralised in one small, documented, unit-tested helper so the `[lat,lon]`↔`[lon,lat]` swap is never done ad-hoc:

```ts
// src/utils/mapboxCoords.ts
/**
 * Convert the app's geographic convention { lat, lon } (degrees) into a
 * Mapbox/GeoJSON position tuple [longitude, latitude].
 *
 * The projection utilities (projectPlanNorthEastToGps, projectLocalMetersToGps)
 * return { lat, lon }; Leaflet consumed [lat, lon]; Mapbox/GeoJSON require
 * [lon, lat]. This is the ONLY place the order is swapped for rendering.
 */
export function toMapboxCoord(lat: number, lon: number): [number, number] {
  return [lon, lat];
}

/** Inverse: a Mapbox/GeoJSON [lon, lat] position back to { lat, lon }. */
export function fromMapboxCoord([lon, lat]: [number, number]): { lat: number; lon: number } {
  // GeoJSON/Mapbox positions are ordered [longitude, latitude], so destructuring
  // as [lon, lat] is correct. We then return { lat, lon } to match the app's
  // own convention — the field ORDER in the object is irrelevant, the NAMES are
  // what matter, so this is not a swap bug.
  return { lat, lon };
}
```

All GeoJSON builders call `toMapboxCoord`; all `onPress` handlers call `fromMapboxCoord` before invoking existing projection math. Both are pure and covered by the unit tests in §10.

> Note on accuracy: the flat-earth approximation is intentionally kept for parity. It is accurate at field scale (sub-cm over typical agricultural plots). Mapbox renders in Web Mercator, but since we hand it already-projected lat/lon points, Mapbox's own projection just places those geographic points — no double projection occurs. This is documented here so reviewers don't "fix" it.

---

## 6. Component Mapping (Leaflet → `@rnmapbox/maps`)

References: components index — https://rnmapbox.github.io/docs/ . Exact prop names will be confirmed against each component's doc page during implementation (see §13 verification gate).

| Current (Leaflet inside WebView) | Native replacement (to verify per docs page) |
|---|---|
| `L.map(...)` container | `<Mapbox.MapView>` — https://rnmapbox.github.io/docs/components/MapView |
| Camera/`setView`/`fitBounds` | `<Mapbox.Camera>` (`centerCoordinate`, `zoomLevel`, `bounds`, `setCamera`) — https://rnmapbox.github.io/docs/components/Camera |
| `L.tileLayer` (OSM / Esri satellite) | `<Mapbox.RasterSource>` + `<Mapbox.RasterLayer>`, or a Mapbox `styleURL` — https://rnmapbox.github.io/docs/components/RasterSource |
| `L.polyline` plan lines (honours `preview_points`, per-layer colour) | `<Mapbox.ShapeSource>` + `<Mapbox.LineLayer>` — https://rnmapbox.github.io/docs/components/LineLayer |
| Rover marker + heading arrow | `<Mapbox.MarkerView>` or `<Mapbox.SymbolLayer>` (`iconRotate`) — https://rnmapbox.github.io/docs/components/MarkerView |
| Rover 1.5 m range circle (real-world radius) | **`@turf/circle` GeoJSON polygon** + `<Mapbox.FillLayer>` / `<Mapbox.LineLayer>` — *not* `CircleLayer` (its `circleRadius` is in pixels). https://github.com/Turfjs/turf/tree/master/packages/turf-circle |
| Next-target dashed line + pulsing waypoint circle | `<Mapbox.LineLayer>` (`lineDasharray`) for the line; pulsing marker via `<Mapbox.MarkerView>` hosting an animated RN view (see pulse note in §2.4) |
| Start-direction arrow (`startArrowMarker`) | `<Mapbox.SymbolLayer>` (`iconImage` + `iconRotate`) — https://rnmapbox.github.io/docs/components/SymbolLayer |
| Reference points (+ labels) | `<Mapbox.ShapeSource>` + `<Mapbox.SymbolLayer>` (`textField`) |
| Boundary box, indent, placed-item boxes | `<Mapbox.ShapeSource>` + `<Mapbox.FillLayer>` / `<Mapbox.LineLayer>` — https://rnmapbox.github.io/docs/components/FillLayer |
| Control-point / corner-point circles | `<Mapbox.CircleLayer>` — https://rnmapbox.github.io/docs/components/CircleLayer |
| `map.on('click')` → `mapClick` msg | `onPress` on `MapView` (background taps) + `onPress` on `ShapeSource` (feature taps) — see note below |
| `postMessage`/`onMessage` protocol | Direct props + `useRef` imperative calls (e.g. `cameraRef.current?.setCamera(...)`) |
| Offline (none today) | `Mapbox.offlineManager` — https://rnmapbox.github.io/docs/offline (Phase 2) |

> **`ShapeSource.onPress` vs `MapView.onPress`:** these are two distinct documented event paths and Phase 1 uses both:
> - **`ShapeSource.onPress`** fires when a tap lands on a rendered feature in that source. The event payload includes the tapped GeoJSON `features` (with the `properties` we attach, e.g. `id`, `layer`). This is the clean path for "user tapped *this* plan line / *this* item" — we read `properties.id` directly instead of doing geometric hit-testing.
> - **`MapView.onPress`** fires for taps on the map background (anywhere not consumed by a feature press) and gives a raw geographic coordinate `[lon, lat]`. This is the path for "tapped empty space" → deselect, or the Fields tap-to-pick / tap-to-place-rover flows that need a coordinate rather than a feature.
>
> Exact event payload shapes to be confirmed per §14 (`ShapeSource` and `MapView` doc pages).

> All component/prop names above are **candidates to be confirmed** against the linked doc pages at implementation time. Per the no-hallucination rule, no layer prop will be written without checking its doc page first.

---

## 7. Data Flow Changes

### 7.1 Today
RN state → `useMemo` projects to GPS → `useEffect` diffs + `sendToWebView(JSON)` → WebView parses → mutates Leaflet layers. Reverse path: Leaflet event → `postMessage(JSON)` → `handleWebViewMessage` → callbacks.

### 7.2 After Phase 1
RN state → same `useMemo` projection (reused) → build **GeoJSON FeatureCollections** → passed as `shape` props to `ShapeSource`s → Mapbox renders natively. No serialization bridge, no diffing message keys (`buildPlanLinesMsgKey`, `lastLinesMsgRef`, etc. become unnecessary — React reconciliation + memoized GeoJSON handles updates).

Reverse path: Mapbox `onPress` / layer press events → the **same** RN handler logic that `handleWebViewMessage` used (refactored into pure helpers) → existing callbacks (`onSelectLine`, `onSelectPoint`, `onMoveBoundary`, ...).

Imperative camera (`recenter`/`fitPlan` triggers) → `cameraRef` calls instead of messages.

### 7.3 Refactor extraction (keeps logic identical, just re-sourced)
- Extract tap hit-testing from `handleWebViewMessage`'s `mapClick` branch into a pure `pickPlanFeatureAt(lat, lon, lines, origin)` returning `{point}|{lineId}|null`.
  - **Input normalisation:** `pickPlanFeatureAt` always receives plain `lat`/`lon` numbers in the app's `{lat, lon}` convention. The two event sources are normalised by a thin wrapper *before* calling it: a `MapView.onPress` handler unpacks the event's `[lon, lat]` geometry through `fromMapboxCoord` (§5.3) and passes the numbers in; a `ShapeSource.onPress` handler can usually skip geometric hit-testing entirely by reading `feature.properties.id`, but where it needs a coordinate it uses the same `fromMapboxCoord` normalisation. So `pickPlanFeatureAt` never sees a raw Mapbox event and is unit-testable in isolation.
- Extract item drag/pinch clamping (`itemsMoved`/`itemsPinched`) into pure helpers reused by native gesture handlers in Phase 2.

---

## 8. Offline Support Strategy

### 8.0 Basemap recommendation: adopt a Mapbox style
**Recommendation: replace the raw Esri World Imagery + OSM raster tiles with a Mapbox style** — `mapbox://styles/mapbox/satellite-streets-v12` (satellite imagery + road/label overlay) or a custom Mapbox Studio style. Reasons:

- **Offline becomes first-class.** `offlineManager.createPack` is built around Mapbox `styleURL` + tileset packs. With a Mapbox style we get supported, resumable, bounded offline downloads. With third-party Esri/OSM rasters there is **no** native offline path (R3) — we'd have to build and maintain a custom tile cache.
- **Single SDK pipeline.** Mapbox styles render through the same vector pipeline the SDK is optimised for (crisper labels, smooth zoom, no `maxNativeZoom` upscaling tricks the Leaflet config currently relies on).
- **Licensing clarity.** Esri/OSM tiles via Mapbox's renderer sit in a grey area for redistribution/offline caching; using Mapbox's own tiles under a Mapbox account keeps usage within one ToS.
- **Satellite parity.** `satellite-streets-v12` gives equivalent aerial imagery to the current Esri satellite layer, which is the layer that matters most for field work.

Trade-off / cost: requires a Mapbox account + access token and accepting Mapbox pricing (R1, §13). If that is unacceptable, the fallback is keeping Esri/OSM rasters via `RasterSource` and **dropping native offline** (or building a custom cache in Phase 2). This is the key decision in §13.

### 8.1 Phasing
**Phase 1:** No regression vs. today (today there is effectively *no* offline). Render the chosen basemap online.

**Phase 2 (the real win):**
- With a **Mapbox style**: `Mapbox.offlineManager.createPack({ name, styleURL, minZoom, maxZoom, bounds })` with a progress listener — https://rnmapbox.github.io/docs/offline .
- If we **must** keep Esri/OSM raster: custom tile-cache effort (larger, see R3).
- UX: a "Download this field for offline" action computing `bounds` from the plan/boundary extent (we already compute plan bounds for `fitPlan`).

> All offline APIs to be confirmed against the offline doc page before coding; exact method signatures vary by SDK major version.

---

## 9. Performance & Optimization Goals

### 9.1 High-frequency rover telemetry handling (ShapeSource strategy)
The rover position/heading arrives on every telemetry tick (potentially several Hz). This is the hottest path and must not thrash React or re-create layers. Strategy:

- **Dedicated rover `ShapeSource`.** Give the rover marker, range circle, and next-target line/marker their *own* `ShapeSource` separate from the (slow-changing) plan-line and reference-point sources. Telemetry updates then touch only that one source's `shape` and never re-render plan geometry.
- **Memoized, tightly-scoped state is the primary update path.** Keep the rover GeoJSON in its own small piece of state (or a `useMemo` whose only dependencies are `lat/lon/heading/nextTarget`), so a telemetry tick re-renders just the rover `ShapeSource`'s `shape` prop and nothing else. Because the rover source is isolated, React reconciliation of a single `ShapeSource` per tick is cheap and predictable.
  > ⚠️ **Do not rely on `setNativeProps`.** On the New Architecture (this app runs RN 0.81 + Fabric + Hermes per `AGENTS.md`), `setNativeProps` is deprecated/removed and behaves unreliably. The memoized-state approach above is the supported path; imperative `setNativeProps` mutation of `ShapeSource` is explicitly **not** recommended here.
- **Heading via data-driven style, not remount.** Rotate the rover icon using the `iconRotate` style property bound to a feature `properties.heading` value (update the property inside the memoized GeoJSON, not the layer) rather than swapping icons.
- **Throttle / coalesce.** If telemetry exceeds ~10 Hz, coalesce to one state update per animation frame (`requestAnimationFrame`) before setting the rover GeoJSON state — mirrors the RAF throttling the SVG editors already use (analysis §4.6 / §5.4).
- **No camera follow by default.** Only move the camera on explicit `recenter`/`fitPlan` triggers (current behaviour); never auto-pan on every tick, which would fight user gestures and cost frames.
- **Drop the message-diffing layer.** The current `buildPlanLinesMsgKey` / `lastRoverMsgRef` / `lastLinesMsgRef` de-dup machinery existed to avoid spamming the WebView bridge. Native rendering replaces it with memoized GeoJSON + isolated sources, so that bridge-era bookkeeping is removed.

### 9.2 General optimization goals
- Memoize each FeatureCollection (`plan lines`, `ref points`, `placed items`, `boundary`) with the same dependency arrays already used by the current `useMemo`s.
- Use `SymbolLayer`/`CircleLayer` data-driven styling instead of per-feature React components where counts are high (plan lines, corner points).
- Remove the WebView bridge entirely from the hot path (no JSON stringify/parse per frame).
- Acceptance target: smooth pan/zoom and rover tracking at field scale on the existing Android test device; no dropped frames during continuous telemetry.

---

## 10. Testing & Validation Plan

1. **Unit tests (Vitest, already configured):** projection round-trips (`projectLocalMetersToGps` ↔ `projectGpsToLocalMeters`), `[lat,lon]→[lon,lat]` GeoJSON builders, hit-test helpers (`pickPlanFeatureAt`), clamping helpers. These are pure functions and fully testable without a device.
2. **Visual parity checks:** side-by-side Leaflet vs. Mapbox for each frame type (`RAW_DESIGN`, `AUTO_ORIGIN_RAW`, `ALIGNED_DESIGN`, `SURVEYED_LOCAL`) using `src/data/samplePlan.ts`.
3. **Interaction tests (manual, on-device):** *Phase 1* — tap-select point/line, tap-place-rover at boundary point, selection highlighting, recenter/fit. *Phase 2* — Templates item select/move/scale/rotate, boundary drag, snap-to-rover.
4. **Build validation:** `npx expo prebuild --platform android` + `cd android && ./gradlew assembleRelease` per `AGENTS.md`; confirm APK boots and map renders.
5. **Regression:** confirm `App.tsx` and `TemplatesPage.tsx` compile with no call-site changes (proves the props contract held).

---

## 11. Rollback Strategy

- **Feature flag:** introduce a single switch (e.g. `USE_NATIVE_MAPBOX` constant or existing `mapViewEnabled` pathway) that renders either the legacy Leaflet `MapView` or the new native one behind the identical props. Default to legacy until Phase 1 is signed off.
- Keep the legacy component file (e.g. rename to `MapViewLeaflet.tsx`) and `react-native-webview` installed during Phases 1–2.
- Because the public props contract is unchanged, rollback is flipping the flag — no call-site churn.
- Git: implement on a feature branch; the config-plugin change to `app.json` is isolated and reversible.

---

## 12. Estimated Effort Breakdown (by phase)

> Rough engineering estimates for planning only, not commitments.

| Phase | Work | Estimate |
|------|------|----------|
| **0 — Setup** | Install `@rnmapbox/maps` + `@turf/circle` (for metre-radius geometry), add config plugin to `app.json`, token provisioning, prebuild + Gradle build, "hello map" render | 0.5–1.5 days (build/token risk) |
| **1a — Static rendering** | Basemap, plan lines, ref points (+labels), rover + heading + next target; projection GeoJSON layer; camera recenter/fit | 2–3 days |
| **1b — Fields interactions** | Tap select point/line (reuse hit-test), selection highlight + corner points | 1–1.5 days |
| **1c — Templates rendering (static)** | Placed items (lines+boxes), boundary outer/indent, control points, selection styling, snap-point highlight, tap-place-rover, item/background tap-select | 1.5–2 days |
| **1d — Parity + flag + tests** | Feature flag, unit tests, visual parity pass, on-device validation | 1.5–2 days |
| **2 — Native gestures + Offline** | Item drag/scale/rotate, boundary dragging, snap-to-rover (3 m), offline packs (style decision) | 4–6 days |
| **3 — Optional SVG editor migration** | Evaluation + optional work | TBD after Phase 2 |

**Phase 1 total:** ~6.5–10 working days (reduced — placed-item drag/scale/rotate and boundary dragging are now Phase 2), dependent on R1 (token) and R4 (native compatibility) resolving cleanly.

> **Phase 2 estimate caveat:** the 4–6 day Phase 2 figure is a rough pre-implementation guess and is the **least certain** estimate in this table. Native multi-touch gesture math (simultaneous drag + pinch-scale + rotate around a group centroid, with boundary-indent clamping and 3 m snap-to-rover) is genuinely hard to get pixel-faithful to the current WebView behaviour. Expect this estimate to grow once implementation begins; it will be re-estimated at the start of Phase 2 with the Phase 1 code in hand.

---

## 13. Open Questions / Decisions Needed From User

1. **Mapbox account & access token (blocker for R1).** Do you have / can you create a Mapbox account and public access token? Are you comfortable with Mapbox's pricing/ToS for field use? This determines whether we can use Mapbox styles (which unlock native offline) or must stay on Esri/OSM raster.
2. **Basemap source (RECOMMENDED CHANGE).** This plan **recommends switching to a Mapbox style** (`satellite-streets-v12` or a custom Studio style) instead of the current raw Esri + OSM raster tiles — see §8.0. This unlocks first-class native offline, a single render pipeline, and clearer licensing. **Decision needed:** approve the switch to a Mapbox style, or instruct us to keep Esri/OSM rasters (which means dropping native offline or building a custom tile cache in Phase 2 — R3). Approving this is also tied to Q1 (token).
3. **Offline priority.** Is offline needed in Phase 1, or acceptable in Phase 2? (Recommended: Phase 2.)
4. **`@rnmapbox/maps` version pin.** Confirm we should pin the latest stable supporting RN 0.81 / New Architecture, with native SDK set via the config plugin's `RNMapboxMapsVersion`. The official Expo install doc currently shows `RNMapboxMapsVersion` "11.20.1" as the example native pin — exact versions to be locked at install time and verified to build.
5. **WebView removal.** OK to keep `react-native-webview` installed through Phases 1–2 for rollback, then remove later? (Check it isn't used elsewhere first.)
6. **Scope confirmation.** Confirm the tightened Phase 1 scope: **rendering parity + camera + tap selection + selection highlighting only**, with **placed-item drag/scale/rotate, boundary dragging, and snap-to-rover deferred to Phase 2**. Confirm SVG editors (`GeometryViewport`, `BoundaryEditor`) stay as-is for Phase 1.

---

## 14. Verification Gate (No-Hallucination Discipline) — STRENGTHENED

**Hard rule for Phase 1:** No Mapbox component or prop may be written into code until its exact behaviour is confirmed against the official documentation, and the confirmation is recorded inline.

For **every** Mapbox component and **every** prop/style key used in Phase 1, the implementer must:
1. **Cite the exact official documentation page URL** (e.g. `https://rnmapbox.github.io/docs/components/LineLayer`) in a code comment next to its first use.
2. **Quote the exact prop/method name and its documented type/signature** from that page (a short verbatim snippet, ≤30 words, attributed) — no paraphrased prop names, no guessed types.
3. If a prop's behaviour is **ambiguous or undocumented**, stop and raise it to the user rather than guessing.

A per-component **verification checklist** will be maintained (in this doc or a companion `docs/mapbox-api-verification.md`) before implementation, listing each Phase 1 component/prop and its source URL:

| Component / prop | Official doc page | Verified? |
|---|---|---|
| `MapView` (`styleURL`, `onPress`) | https://rnmapbox.github.io/docs/components/MapView | ✅ `styleURL` (compiles v10.3.1, Phase 0); `onPress` ☐ |
| `Camera` (`centerCoordinate`, `zoomLevel`, `bounds`, `setCamera`) | https://rnmapbox.github.io/docs/components/Camera | ✅ `centerCoordinate`/`zoomLevel` (Phase 0); `bounds`/`setCamera` ☐ |
| `ShapeSource` (`shape`, `onPress`, ref setters) | https://rnmapbox.github.io/docs/components/ShapeSource | ☐ |
| `LineLayer` (`lineColor`, `lineWidth`, `lineDasharray`) | https://rnmapbox.github.io/docs/components/LineLayer | ☐ |
| `FillLayer` (`fillColor`, `fillOpacity`) | https://rnmapbox.github.io/docs/components/FillLayer | ☐ |
| `CircleLayer` (`circleRadius`, `circleColor`) | https://rnmapbox.github.io/docs/components/CircleLayer | ☐ |
| `SymbolLayer` (`iconImage`, `iconRotate`, `textField`) | https://rnmapbox.github.io/docs/components/SymbolLayer | ☐ |
| `MarkerView` | https://rnmapbox.github.io/docs/components/MarkerView | ☐ |
| `RasterSource`/`RasterLayer` (only if Esri/OSM kept) | https://rnmapbox.github.io/docs/components/RasterSource | ☐ |
| `offlineManager.createPack` (Phase 2) | https://rnmapbox.github.io/docs/offline | ☐ |
| `Mapbox.setAccessToken` | https://rnmapbox.github.io/docs/setup | ✅ verified (Phase 0 — `src/config/mapbox.ts`) |

---

## 15. Phase 0 — Status: ✅ COMPLETE

Done and validated:
- Installed `@rnmapbox/maps` **10.3.1** (v10.x; native Mapbox Maps SDK **v11.20.1**) and `@turf/circle` **7.3.5** via `npx expo install`.
- Added the `@rnmapbox/maps` Expo **config plugin** to `app.json`, pinned `RNMapboxMapsVersion: "11.20.1"`.
- Confirmed (official Android install doc) that the secret `MAPBOX_DOWNLOADS_TOKEN` is **no longer required** — the `pk.` public token suffices for build + runtime.
- Runtime token wired via `src/config/mapbox.ts` (`initMapbox()` → `Mapbox.setAccessToken`), called once at the top of `App.tsx`.
- Chosen basemap: `mapbox://styles/mapbox/satellite-streets-v12` (Q2 decided — Mapbox style).
- Created the canonical coord helper `src/utils/mapboxCoords.ts` (`toMapboxCoord`/`fromMapboxCoord`).
- `npx expo prebuild --platform android` applied the plugin (Mapbox Maven repo + version pin in `gradle.properties`) **without disturbing** the custom `release` signing config / keystore.
- **`./gradlew assembleRelease` → BUILD SUCCESSFUL**, producing a signed `app-release.apk` (~242 MB). Native SDK links and compiles on RN 0.81 + New Architecture + Hermes.
- `src/components/MapboxHelloMap.tsx` "hello map" scaffold type-checks against the installed API.

> ⏭️ **Not yet done (needs a device/emulator):** visually confirming the hello map renders tiles on-screen. The release build + type-check prove the toolchain and native linkage; on-device render confirmation is a manual step.

Awaiting approval to begin **Phase 1** (native `MapView` rendering parity behind the existing `MapViewProps` contract).

---

## 16. Phase 1 — Rendering Parity Milestone: ✅ IMPLEMENTED (pending on-device verification)

**Architecture (zero call-site changes):**
- `src/components/MapView.tsx` is now a thin dispatcher: `MapView(props)` renders `MapViewNative` when `USE_NATIVE_MAPBOX` is true, else the legacy `MapViewLeaflet` (the renamed legacy component, unchanged). `MapViewProps` stays defined here as the single source of truth. Both call sites (`App.tsx`, `TemplatesPage.tsx`) are untouched.
- `src/components/MapViewNative.tsx` — the native implementation.
- Flag `USE_NATIVE_MAPBOX` defaults to **false** (legacy remains the default).

**Implemented in `MapViewNative` (rendering parity):**
- Basemap `satellite-streets-v12`.
- Plan lines via `projectPlanLineToGpsSegments` (preview_points-first), data-driven `lineColor` from `LAYER_COLORS` incl. `marking_false`, with safe fallback.
- Rover vehicle marker (react-native-svg port of the legacy icon) + heading rotation, 1.5 m **Turf** range circle (Fill + dashed outline), next-target dashed line + pulsing `MarkerView`.
- Reference points (CircleLayer) + optional labels (SymbolLayer, opacity-toggled).
- Start-direction arrow (bearing from first segment).
- Boundary outer (selected-aware) + dashed indent + 8 control points (active highlighted).
- Placed items: lines + bounding boxes (selection-aware styling).
- Fields selection highlight (red line) + corner points.
- Camera: `recenterRoverTrigger`, `recenterPlanTrigger`/fit, initial autocenter (rover → zoom 19, else fit plan).
- Tap selection: Fields background tap reuses the legacy point(2.0 m)/line(3.5 m) hit-test via `fromMapboxCoord` + existing projection; Templates item tap (ShapeSource onPress) selects, background tap deselects.
- High-frequency rover updates isolated in their own memo + `ShapeSource`s (plan/boundary/item sources untouched per tick).

**Verification done:** `tsc --noEmit` clean; full Vitest suite 85/85; Metro `expo export` bundles (2969 modules) with `.env` token loaded. **Not yet done:** on-device visual confirmation (requires flipping `USE_NATIVE_MAPBOX` and running on a device/emulator).

**Deferred to Phase 2 (unchanged):** placed-item drag/scale/rotate, boundary dragging, snap-to-rover.

---

## 17. Phase 1 — Optimization & Build Prep

**File structure (Task 1):**
- `src/components/mapViewTypes.ts` — shared `MapViewProps` (51 lines).
- `src/components/MapViewLeaflet.tsx` — legacy implementation, unchanged behaviour (`export default`).
- `src/components/MapViewNative.tsx` — native implementation (`export default`).
- `src/components/MapView.tsx` — thin dispatcher, **45 lines** (was ~2593), lazy-loads each implementation via `React.lazy` + `Suspense` and selects by `USE_NATIVE_MAPBOX`. Call sites unchanged.

**Bundle finding (honest):** Metro (default Expo single-bundle config) does **not** tree-shake based on a runtime flag, and `React.lazy`/`import()` does not create a separate chunk here, so module count is essentially unchanged (2969 → 2972 from the two new files; bundle 7.03 MB → 7.03 MB). The native Mapbox SDK is also linked into the APK at the native layer regardless. What the lazy split *does* buy: the inactive implementation's module code is not **evaluated** at startup (deferred), and the code is cleanly separated for maintenance/rollback. True JS-bundle exclusion would require a build-time flag (Babel define + transform-time DCE) or Metro bundle splitting — not enabled in this Expo setup; flagged as optional future work.

**Runtime perf (Task 2):**
- Turf range circle reduced 48 → 16 steps (visually fine at field zoom, ~3× cheaper on the per-tick path).
- Heavy FeatureCollection memos (plan lines, selection, ref points, placed items, boundary) now keyed on **stable primitive signatures** (`originSig`, `refPointsSig`) instead of the `projectionOrigin`/`alignedRefPoints` object references, which could churn every telemetry tick. Result: a rover tick recomputes only the isolated rover memo + its `ShapeSource`s; plan/boundary/item sources stay referentially stable and don't trigger native source updates.

**Build (Task 3):**
- `USE_NATIVE_MAPBOX` documented with enable/rollback steps in `src/config/featureFlags.ts`; dispatcher header documents the same.
- `tsc --noEmit` clean; Vitest 85/85; `./gradlew assembleRelease` → **BUILD SUCCESSFUL**, signed APK (~242 MB). Flag left at `false` (default).

Installation follows https://rnmapbox.github.io/docs/install and the Expo config-plugin guide (`@rnmapbox/maps` plugin with `RNMapboxMapsVersion`). Anything the docs leave ambiguous (raster-only token behaviour, offline for third-party rasters) is escalated, not guessed.

---

### Official sources this plan relies on
- `@rnmapbox/maps` docs: https://rnmapbox.github.io/docs/
- Install / Expo config plugin: https://rnmapbox.github.io/docs/install and https://github.com/rnmapbox/maps/blob/main/plugin/install.md
- Mapbox React Native getting-started tutorial: https://docs.mapbox.com/help/tutorials/getting-started-react-native/
- GitHub repo: https://github.com/rnmapbox/maps
- Offline: https://rnmapbox.github.io/docs/offline

*Content from external sources was rephrased/summarized for compliance with licensing restrictions.*
