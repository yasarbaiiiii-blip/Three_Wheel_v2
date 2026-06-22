# Implementation Plan — Two Tasks

1. **Fix DXF Coordinate Inversion** — DXF export maps coordinates wrong (North→DXF X, East→DXF Y instead of East→DXF X, North→DXF Y)
2. **Achieve 90 FPS Canvas Rendering** — All 3 canvas views must sustain 90 FPS during pan/zoom with any data size

---

# Task 1: Fix DXF Coordinate Inversion

## Root Cause

There are **two duplicate** DXF generation functions in the codebase. Both incorrectly map:

| Internal Field | Current DXF Group | Meaning | Correct DXF Group |
|---|---|---|---|
| `entry.from.x` (North) | `10` (DXF X) | Vertical (Y in CAD) | `20` (DXF Y) |
| `entry.from.y` (East) | `20` (DXF Y) | Horizontal (X in CAD) | `10` (DXF X) |
| `entry.to.x` (North) | `11` (DXF X) | Vertical (Y in CAD) | `21` (DXF Y) |
| `entry.to.y` (East) | `21` (DXF Y) | Horizontal (X in CAD) | `11` (DXF X) |

**Result:** Importing the exported DXF into any CAD software (AutoCAD, QCAD, LibreCAD) shows the shape rotated/mirrored because X and Y are swapped.

**Note:** `generateDXF()` in `src/utils/dxfGenerator.ts` has the **same bug** but it's **unused** (no callers). It should still be fixed for consistency.

## Files to Modify

### 1. `App.tsx` lines 8229-8236 — ACTIVE export function

Current (lines 8229-8236):
```
"10", String(entry.from.x),   // ❌ North written to DXF X
"20", String(entry.from.y),   // ❌ East written to DXF Y
"11", String(entry.to.x),     // ❌ North written to DXF X
"21", String(entry.to.y),     // ❌ East written to DXF Y
```

Fix:
```
"10", String(entry.from.y),   // ✅ East → DXF X (horizontal)
"20", String(entry.from.x),   // ✅ North → DXF Y (vertical)
"11", String(entry.to.y),     // ✅ East → DXF X
"21", String(entry.to.x),     // ✅ North → DXF Y
```

### 2. `src/utils/dxfGenerator.ts` lines 23-26 and 31-36 — DEDUPLICATE or fix

`generateDXF()` (lines 23-26) same bug:
```
const startX = line.from.x;  // ❌ North as X
const startY = line.from.y;  // ❌ East as Y
const endX = line.to.x;
const endY = line.to.y;
```
→ Fix to:
```
const startX = line.from.y;  // ✅ East as DXF X
const startY = line.from.x;  // ✅ North as DXF Y
const endX = line.to.y;
const endY = line.to.x;
```

`linesToDxf()` (lines 73-80) same bug — fix with same swap pattern.

**OR better:** Since `generateDXF()` and `linesToDxf()` are duplicates, delete `generateDXF()` and make `linesToDxf()` the single source of truth.

### 3. `src/utils/dxfGenerator.ts` `linesToDxf()` lines 73-80 — same swap

Same fix as App.tsx lines 8229-8236.

## Verification

1. Run `npx tsc --noEmit` — must pass with no errors
2. Open app → load a template → export DXF → open in CAD software → verify shape orientation matches what the app shows
3. Test with a simple rectangle template (should export as 4 sides forming a closed rectangle, not rotated)

---

# Task 2: Achieve 90 FPS Canvas Rendering

## Current Performance Baseline

| Canvas | Component | File | Lines | Current FPS (est.) | Bottleneck |
|---|---|---|---|---|---|
| Plan Preview | `PlanPreview` | `App.tsx:6429-7121` | ~700 lines | 15-30 FPS | Full SVG tree re-render on every viewport change |
| Geometry Viewport | `GeometryViewport` | `src/components/GeometryViewport.tsx:83-1245` | ~1162 lines | 20-35 FPS | SVG re-render + PanResponder on JS thread |
| Boundary Editor | `BoundaryEditor` | `src/components/BoundaryEditor.tsx:30-584` | ~554 lines | 25-40 FPS | Per-item SVG `<Line>` elements + JS thread gestures |

All 3 use `react-native-svg` — a **CPU-bound SVG DOM renderer** that renders on the React Native JS thread.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         React Native JS Thread                       │
│                                                                       │
│  State Update ──► React Re-render ──► SVG Tree ──► Native Canvas    │
│  (Pan)               (full tree)        (1k+ nodes)    (CPU draw)   │
│                                                                       │
│  PROBLEM: Every frame triggers entire pipeline on JS thread          │
│  MAX THEORETICAL: ~45 FPS with heavy optimization                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       With Skia GPU Rendering                        │
│                                                                       │
│  JS Thread (minimal):                                                 │
│    Gesture → update shared value → no re-render                      │
│                                                                       │
│  GPU Thread (Skia):                                                   │
│    Read shared value → draw directly on GPU → 90-120 FPS            │
│    (decoupled from React re-render cycle)                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Dependencies Already Available (no npm install needed)

| Package | Version | Purpose | Already in package.json? |
|---|---|---|---|
| `@shopify/react-native-skia` | ^2.6.5 | GPU-accelerated canvas | ✅ Line 17 |
| `react-native-gesture-handler` | ~2.28.0 | UI-thread gestures | ✅ Line 30 |
| `react-native-reanimated` | ~4.1.7 | Shared value animations | ✅ Line 31 |
| `react-native-worklets` | 0.5.1 | Worklet support | ✅ Line 36 |

## Plan: Three-Phase Approach

### Phase 1 — Max Out react-native-svg (Target: 45-55 FPS)
**No native build changes required. Pure JS/TS changes.**

#### Step 1.1 — Add viewport culling to `PlanPreview` (App.tsx ~line 6864)

**Already done in `GeometryViewport.tsx`** (lines 148-166), **not done in `PlanPreview`**.

Add `visibleBounds` computed from viewport + layout size:
- Compute screen-space bounding box with 20% margin
- Filter `cornerPoints` to only those within visible bounds
- Filter selectedLine rendering only if line is visible

Change in `PlanPreview`:
- Wrap the SVG `<G>` content in a visibility check
- Only render `<Circle>` elements for corners that are on-screen

**File:** `App.tsx` ~line 6864-6998

#### Step 1.2 — Add `React.memo` with custom comparator to `PlanPreview`

Wrap the `PlanPreview` function export with `React.memo` using a comparator that:
- Compares `lines` by length + first/last ID (not deep equality)
- Compares `visibility`, `selectedLineId` by value
- Ignores `roverPosN`/`roverPosE` changes within 0.5m (useViewportUpdate pattern)

**File:** `App.tsx` ~line 6429

#### Step 1.3 — Batch SVG paths in `BoundaryEditor`

Current state: Each `PlacedItem` renders `item.lines.map((l, i) => <Line ... />)` — one SVG `<Line>` element per plan line.

Fix: Build a single SVG path string per `PlacedItem` and render as `<Path>` element, same way `PlanPreview` does it with `buildSvgPathChunks`.

**File:** `src/components/BoundaryEditor.tsx` ~lines 482-499

#### Step 1.4 — Phase 1 Verification

- Test with 500-line DXF in all 3 canvases
- Pan and zoom — measure FPS (on-device debug menu or FPS overlay)
- Target: 45-55 FPS stable
- If this meets user's visual smoothness requirement → Phase 2 and 3 optional

---

### Phase 2 — Skia GPU Canvas (Target: 60-90 FPS)
**Requires: native build (`expo prebuild`, `gradlew assembleRelease`). Skia already in package.json.**

#### Step 2.1 — Verify Skia native module builds

1. Add Skia to `app.json` plugins: `"@shopify/react-native-skia"` in the plugins array
2. Run: `npx expo prebuild --platform android`
3. Run: `cd android && ./gradlew assembleRelease`
4. If build passes → proceed. If fails → diagnose Skia compat or fallback to Phase 1 only.

**File:** `app.json` ~line 23-31

#### Step 2.2 — Create `src/components/SkiaCanvas.tsx`

New reusable Skia canvas component that:
- Accepts `lines`, `viewport`, `selection`, `roverPose` as props
- Renders using Skia primitives instead of react-native-svg:

```tsx
import { Canvas, Path, Circle, Group, useCanvasRef } from "@shopify/react-native-skia";

interface SkiaCanvasProps {
  lines: { path: SkPath; stroke: string; width: number }[];
  gridLines?: SkPath;
  rover?: { east: number; north: number; headingDeg: number };
  selectedLinePath?: SkPath;
  selectedPoints?: { x: number; y: number }[];
}
```

Rendering pipeline:
- Build `Skia.Path` objects from line data using `Skia.Path.Make().moveTo().lineTo()`
- Apply viewport transform as a single Skia matrix transform on a `<Group>`
- Draw grid lines as a single path object
- Draw rover icon as Skia primitives (Circle + Polygon)
- Draw corner points as Skia Circles
- Selection highlight as Skia Path with red stroke

**File:** `src/components/SkiaCanvas.tsx` (NEW)

#### Step 2.3 — Migrate `PlanPreview` to use SkiaCanvas

Replace the SVG `return` block (lines 6848-7119) in `PlanPreview` with:

```tsx
<View onLayout={handleLayout} style={{ flex: 1 }}>
  <GestureDetector gesture={composedGesture}>
    <View style={{ flex: 1 }}>
      <SkiaCanvas
        lines={skiaLineData}
        gridLines={skiaGridPath}
        rover={roverData}
        selectedLinePath={selectedSkiaPath}
      />
    </View>
  </GestureDetector>
</View>
```

Key changes:
- Remove react-native-svg `Svg`, `Path`, `G`, `Circle`, `Polygon` imports for canvas
- Remove SVG `transform` string — replace with Skia matrix
- Keep compass overlay as SVG (tiny, not perf-critical)

**File:** `App.tsx` ~lines 6429-7121

#### Step 2.4 — Migrate `GeometryViewport` to use SkiaCanvas

Replace SVG block (lines 455-507) with SkiaCanvas:
- Build Skia Path objects for boundary/marking/center layers
- Pass through gesture handling (keep existing PanResponder or migrate to GestureDetector)
- Remove `Svg`, `G`, `Path`, `Circle`, `Line` imports

**File:** `src/components/GeometryViewport.tsx` ~lines 455-507

#### Step 2.5 — Migrate `BoundaryEditor` to use SkiaCanvas

Replace SVG rendering (lines ~440-530) with Skia:
- Each `PlacedItem` builds a Skia Path
- Selection highlights, snap lines as Skia primitives
- Keep RAF throttle pattern for gesture state updates

**File:** `src/components/BoundaryEditor.tsx` ~lines 440-530

---

### Phase 3 — Gesture Pipeline on UI Thread (Target: 90 FPS sustained)
**Removes JS thread from gesture handling entirely.**

#### Step 3.1 — Migrate `PlanPreview` gestures to reanimated shared values

Replace `PanResponder` with:
```tsx
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useSharedValue, useDerivedValue } from "react-native-reanimated";

const panX = useSharedValue(0);
const panY = useSharedValue(0);
const zoom = useSharedValue(1);
const rotation = useSharedValue(0);

const panGesture = Gesture.Pan()
  .onUpdate((e) => {
    panX.value = prevPanX.value + e.translationX;
    panY.value = prevPanY.value + e.translationY;
  });

const pinchGesture = Gesture.Pinch()
  .onUpdate((e) => {
    zoom.value = prevZoom.value * e.scale;
  });

const composed = Gesture.Simultaneous(panGesture, pinchGesture);
```

Skia canvas reads shared values directly (no React re-render):
```tsx
const viewportTransform = useDerivedValue(() => {
  return Skia.Matrix().translate(panX.value, panY.value).scale(zoom.value);
});
```

**File:** `App.tsx` ~lines 6610-6790 (PlanPreview PanResponder → Gesture)

#### Step 3.2 — Migrate `GeometryViewport` gestures to shared values

Replace PanResponder + onTouchStart/Move/End with GestureDetector:
- `Gesture.Pan()` for pan
- `Gesture.Pinch()` for zoom
- Tap detection via `Gesture.Tap()`

Remove `dragMode`/`rotateDragMode` state toggles — gestures always active but only respond when user touches canvas.

**File:** `src/components/GeometryViewport.tsx` ~lines 247-377

#### Step 3.3 — Migrate `BoundaryEditor` gestures to shared values

Replace PanResponder with:
- `Gesture.Pan()` for item drag
- `Gesture.Pinch()` for camera zoom
- RAF throttle gets replaced by shared value reads (zero overhead)

**File:** `src/components/BoundaryEditor.tsx` ~lines 200-400

---

## Files Summary

### Modified Files

| File | Change Type | Lines Affected | Task |
|---|---|---|---|
| `App.tsx` | Modify | 8229-8236 | DXF fix |
| `App.tsx` | Modify | 6864-6998 | Phase 1 — viewport culling |
| `App.tsx` | Modify | 6429 (wrapper) | Phase 1 — React.memo |
| `App.tsx` | Modify | 6429-7121 (PlanPreview) | Phase 2 — Skia migration |
| `App.tsx` | Modify | 6610-6790 (PlanPreview gestures) | Phase 3 — reanimated shared values |
| `src/utils/dxfGenerator.ts` | Modify OR delete | 1-100 | DXF fix (duplicate, delete if unused) |
| `src/components/BoundaryEditor.tsx` | Modify | 482-499 | Phase 1 — batch `<Line>` → `<Path>` |
| `src/components/BoundaryEditor.tsx` | Modify | 440-530 | Phase 2 — Skia migration |
| `src/components/BoundaryEditor.tsx` | Modify | 200-400 | Phase 3 — GestureDetector |
| `src/components/GeometryViewport.tsx` | Modify | 455-507 | Phase 2 — Skia migration |
| `src/components/GeometryViewport.tsx` | Modify | 247-377 | Phase 3 — GestureDetector |
| `app.json` | Modify | 23-31 | Phase 2 — add Skia build plugin |

### New Files

| File | Purpose |
|---|---|
| `src/components/SkiaCanvas.tsx` | Reusable Skia canvas component for all 3 views |

## Execution Order

Execute in sequence — each step is independently verifiable:

### Step A: DXF Fix (single commit, verified with CAD)
1. Fix `App.tsx` lines 8229-8236 (swap X/Y in DXF groups)
2. Fix or delete `src/utils/dxfGenerator.ts` (same swap in `linesToDxf()`, delete `generateDXF()` if unused)
3. `npx tsc --noEmit` to verify
4. Build APK and test DXF export → open in CAD → verify correct orientation

### Step B: Phase 1 Performance (no native build needed)
5. Add viewport culling to `PlanPreview` in `App.tsx`
6. Add `React.memo` wrapper to `PlanPreview`
7. Batch `<Line>` → `<Path>` in `BoundaryEditor`
8. Build APK and FPS test with 500-line DXF

### Step C: Phase 2 Skia (requires native build)
9. Add Skia plugin to `app.json`
10. Create `src/components/SkiaCanvas.tsx`
11. Migrate `PlanPreview` SVG → Skia
12. Migrate `GeometryViewport` SVG → Skia
13. Migrate `BoundaryEditor` SVG → Skia
14. Build APK and FPS test

### Step D: Phase 3 UI Thread (requires Phase 2)
15. Migrate `PlanPreview` PanResponder → GestureDetector + shared values
16. Migrate `GeometryViewport` PanResponder → GestureDetector
17. Migrate `BoundaryEditor` PanResponder → GestureDetector
18. Final FPS verification

## Verification & Acceptance

### DXF Fix Verification
- [ ] Export a rectangle template from app
- [ ] Open DXF in AutoCAD/QCad/LibreCAD
- [ ] Rectangle appears as a closed box (not rotated/mirrored)
- [ ] Export a multi-line template (e.g. football field) — all lines correctly oriented

### 90 FPS Verification
- [ ] All 3 canvases at 90 FPS with 1-line template during pan/zoom
- [ ] All 3 canvases at 90 FPS with 500+ line DXF during pan/zoom
- [ ] All 3 canvases at 90 FPS with 20 PlacedItems in BoundaryEditor
- [ ] No visual regression: same colors, stroke widths, rover icon, selection highlight
- [ ] Tap-to-select still works on all canvases
- [ ] Layer visibility toggles still work
- [ ] Spray overrides still work
- [ ] Export DXF from app still works (not affected by perf changes)
- [ ] `npx tsc --noEmit` passes

### FPS Measurement Method
- Enable React Native FPS monitor: `react-native start` → press `Ctrl+D` → "Show Perf Monitor"  
- OR add a simple FPS counter using `useRef` + `requestAnimationFrame` that counts frames per second

## Rollback Plan

If Skia fails to build:
1. Revert `app.json` Skia plugin addition
2. Revert SkiaCanvas.tsx creation
3. Revert all Skia migration in Phase 2
4. Keep Phase 1 optimizations only (45-55 FPS target)
5. This is still a significant improvement over the current 15-30 FPS