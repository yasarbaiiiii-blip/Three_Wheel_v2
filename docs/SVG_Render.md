# SVG Rendering, Pan, Zoom & Rotation — `GeometryViewport.tsx`

**Source file:** `src/components/GeometryViewport.tsx`
**SVG library:** `react-native-svg`
**Coordinate utility:** `src/utils/curveGeometry.ts`

---

## 1. Overview

`GeometryViewport` is a React Native component that renders imported DXF/CSV plan lines as an interactive SVG canvas. It supports:

- **Rendering** plan lines (straight, dotted, dashed), arcs/circles, and arrowheads
- **Pan** (drag to move the viewport)
- **Zoom** (buttons + two-finger pinch)
- **Rotation** (buttons, drag gesture, manual angle entry)
- **Line selection** via tap with inverse coordinate transform

---

## 2. Coordinate System

### Plan Coordinates (Design Metres)

| Axis | Direction | Semantic |
|------|-----------|----------|
| `x`  | Positive → North | `line.from.x`, `line.to.x` |
| `y`  | Positive → East  | `line.from.y`, `line.to.y` |

### SVG / Screen Coordinates

| Axis | Direction |
|------|-----------|
| x (SVG) → screen right | **East** (from plan `y`) |
| y (SVG) → screen down  | **−North** (negated plan `x`) |

The mapping is done inside `mapPlanPointToSvg`:

```ts
function mapPlanPointToSvg(point: PlanPoint, zoom, rotation, offset, surfaceSize): SvgPoint {
  return rotateSvgPoint(
    {
      x: point.y * zoom + offset.x,   // East → SVG x
      y: -point.x * zoom + offset.y,  // North → SVG y (negated!)
    },
    rotation,
    surfaceSize
  );
}
```

### Inverse Transform (for tap → world)

`invertCanvasTransform` reverses the pipeline:

1. **Undo rotation** around screen centre (negates `rotation`)
2. **Undo offset** → subtract offset, divide by zoom
3. **Undo Y-flip** → `worldX = -(screenY - offsetY) / zoom` (North), `worldY = (screenX - offsetX) / zoom` (East)

```ts
function invertCanvasTransform(x, y, zoom, rotation, offset, surfaceSize) {
  const centerX = surfaceSize.width / 2;
  const centerY = surfaceSize.height / 2;
  const radians = (-rotation * Math.PI) / 180;

  // 1. Undo rotation around screen centre
  const dx = x - centerX;
  const dy = y - centerY;
  const rotatedX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const rotatedY = dx * Math.sin(radians) + dy * Math.cos(radians);

  const screenX_unrotated = rotatedX + centerX;
  const screenY_unrotated = rotatedY + centerY;

  return {
    x: -(screenY_unrotated - offset.y) / zoom,  // World North
    y: (screenX_unrotated - offset.x) / zoom,   // World East
  };
}
```

---

## 3. SVG Rendering

### 3.1 The Root SVG Element

```tsx
<Svg
  width="100%"
  height="100%"
  preserveAspectRatio="xMidYMid meet"
>
  <G transform={planTransform}>
    {/* plan lines ... */}
    {/* selected line highlight ... */}
  </G>
  {/* arrowheads (outside G so they stay screen-sized) ... */}
</Svg>
```

### 3.2 The `planTransform` SVG Transform String

All plan geometry is wrapped in a single `<G>` with the transform:

```ts
`translate(${surfaceSize.width / 2} ${surfaceSize.height / 2})
 rotate(${rotation})
 translate(${-surfaceSize.width / 2} ${-surfaceSize.height / 2})
 translate(${offset.x} ${offset.y})
 scale(${zoom} ${-zoom})`
```

**Order of operations:**
1. **Translate to centre** of the SVG surface
2. **Rotate** around centre (`rotation` degrees)
3. **Translate back** from centre
4. **Translate** by pan offset
5. **Scale** by zoom (with `-zoom` on Y to flip the North-axis)

### 3.3 Plan Lines → `<Path>` Elements

Lines are rendered as SVG `<Path>` elements. The path data (`d` attribute) is built by `buildPlanLineSvgPath` in `src/utils/curveGeometry.ts`:

- **Straight line (no curve/preview):** `M{east} {north}L{east} {north}` using `line.from.y, line.from.x` → `line.to.y, line.to.x`
- **Curves (ARC/CIRCLE entities):** SVG arc commands (`A r r 0 largeArc 1 endX endY`), or two arcs for full circles
- **Preview points:** Series of `L` commands connecting `preview_points[]`

Lines are grouped by layer and **chunked** (650 segments per chunk) to balance React reconciliation:

```ts
const PATH_SEGMENT_CHUNK_SIZE = 650;

function buildSvgPathChunks(lines: PlanLine[]) {
  const chunks: string[] = [];
  let current = "";
  let count = 0;
  for (const line of lines) {
    const segment = buildPlanLineSvgPath(line);
    current += segment;
    count += 1;
    if (count >= PATH_SEGMENT_CHUNK_SIZE) {
      chunks.push(current);
      current = "";
      count = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
```

Rendered layers:

```tsx
{RENDERED_PLAN_LAYERS.flatMap((layer) =>
  pathChunksByLayer[layer].map((d, index) => (
    <Path
      key={`${layer}-${index}`}
      d={d}
      stroke={ /* palette colour based on layer */ }
      strokeWidth={0.45 / zoom}
      strokeDasharray={dashPattern(markingStyle)}
      strokeLinecap="round"
      fill="none"
    />
  ))
)}
```

Notice `strokeWidth={0.45 / zoom}` — this keeps the stroke visually constant regardless of zoom level.

### 3.4 Arrowheads → `<Polygon>` Elements

Arrowheads are computed in SVG screen space (outside the `<G>` transform) so they remain a constant screen size:

```tsx
{RENDERED_PLAN_LAYERS.flatMap((layer) =>
  arrowheadsByLayer[layer].map((pts, index) => (
    <Polygon key={`arrow-${layer}-${index}`} points={pts} fill={...} stroke="none" />
  ))
)}
```

The arrowhead geometry is built by `buildArrowheadPoints`:
- Takes midpoint of `from→to`
- Computes direction unit vector (ux, uy) and perpendicular (px, py)
- Produces a triangle `{tip} {b1} {b2}` with configurable `ARROWHEAD_LENGTH_PX = 14` and `ARROWHEAD_HALF_WIDTH_PX = 5`

### 3.5 Selected Line Highlight

When a line is selected, an additional `<Line>` + two `<Circle>` endpoints are rendered above all layers in emerald colour, also with `strokeWidth={0.85 / zoom}` and endpoint circles with `r={1.2 / zoom}`.

### 3.6 Marking Styles (Dash Patterns)

```ts
function dashPattern(style: MarkingStyle) {
  if (style === "dotted") return "0.3 1.3";
  if (style === "dashed") return "2.2 1.5";
  return undefined; // solid line
}
```

### 3.7 Viewport Culling (Performance)

Before rendering, lines outside the visible viewport are filtered out to reduce SVG complexity:

```ts
const visibleBounds = useMemo(() => {
  const margin = 0.2;
  const halfW = (surfaceSize.width / zoom) * (1 + margin);
  const halfH = (surfaceSize.height / zoom) * (1 + margin);
  const cx = -offset.x / zoom;
  const cy = offset.y / zoom;
  return { minX: cx - halfW, maxX: cx + halfW, minY: cy - halfH, maxY: cy + halfH };
}, [offset, zoom, surfaceSize]);

const culledLines = useMemo(() => {
  return safeLines.filter(line => {
    const midX = (line.from.x + line.to.x) / 2;
    const midY = (line.from.y + line.to.y) / 2;
    return midX >= visibleBounds.minX && midX <= visibleBounds.maxX &&
           midY >= visibleBounds.minY && midY <= visibleBounds.maxY;
  });
}, [safeLines, visibleBounds]);
```

The margin factor (0.2 = 20% outside visible area) prevents lines from popping at the edges.

### 3.8 Compass Overlay (SVG)

A floating compass in the top-right corner is rendered as a separate small SVG (54×54px) showing N/S/E/W labels and a rotating needle that mirrors the plan rotation:

```tsx
<Svg width={54} height={54} viewBox="0 0 54 54">
  <Circle cx={27} cy={27} r={24} ... />
  <SvgText x={27} y={12}>N</SvgText>
  ...
  <G transform={`rotate(${rotation} 27 27)`}>
    <Polygon points="27,15 31,27 23,27" fill="#ef4444" />  {/* North pointer */}
    <Polygon points="27,39 31,27 23,27" fill="#cbd5e1" />  {/* South pointer */}
  </G>
</Svg>
```

---

## 4. Pan (Drag)

### 4.1 Mode Activation

Pan is **mode-based**: the user must tap the **Move** button to toggle `dragMode` on/off. When active, the button turns emerald.

```tsx
<Pressable onPress={() => {
  setRotateDragMode(false);
  setDragMode((current) => !current);
}}>
  {/* Hand icon, background emerald when active */}
</Pressable>
```

### 4.2 PanResponder Setup

A React Native `PanResponder` is created in a `useMemo`:

```ts
const panResponder = useMemo(() =>
  PanResponder.create({
    onStartShouldSetPanResponder: () => dragMode || rotateDragMode,
    onMoveShouldSetPanResponder: (_, gesture) => {
      if (!(rotateDragMode || dragMode)) return false;
      return (
        Math.abs(gesture.dx) > 6 ||
        Math.abs(gesture.dy) > 6 ||
        gesture.numberActiveTouches > 1
      );
    },
    onPanResponderGrant: () => {
      dragBaseRotation.current = rotationRef.current;
      dragBaseOffset.current = offset;
    },
    onPanResponderMove: (_, gesture) => {
      if (rotateDragMode) { /* rotation handled below */ }
      if (dragMode) {
        rafPendingRef.current.offset = {
          x: dragBaseOffset.current.x + gesture.dx,
          y: dragBaseOffset.current.y + gesture.dy,
        };
        scheduleCommit();
      }
    },
    onPanResponderRelease: () => { if (rotateDragMode) setRotateDragMode(false); },
  }),
  [dragMode, offset, onRotationChange, rotateDragMode]
);
```

**Key details:**
- Only claims the gesture when `dragMode` or `rotateDragMode` is true
- Requires a **6px dead-zone** before moving (prevents accidental drag on tap)
- Stores the base offset at grant time, then adds cumulative `gesture.dx`/`gesture.dy`
- State updates are throttled via `requestAnimationFrame` (see §7)

### 4.3 Touch Handlers for Pinch + Tap

The `PanResponder` is attached alongside raw `onTouchStart`/`onTouchMove`/`onTouchEnd` handlers to support both PanResponder-based gestures **and** two-finger pinch zoom + tap detection:

```tsx
<View
  style={styles.canvasGestureSurface}
  onLayout={handleSurfaceLayout}
  {...panResponder.panHandlers}
  onTouchStart={handleTouchStart}
  onTouchMove={handleTouchMove}
  onTouchEnd={handleTouchEnd}
>
```

---

## 5. Zoom

Zoom is controlled by the `zoom` state (default `1.0`, clamped to `[0.6, 2.6]`).

### 5.1 Button-Based Zoom (Discrete Steps)

```tsx
<LabeledToolButton
  icon={<ZoomOut size={24} />}
  label="Zoom -"
  onPress={() => setZoom((current) => Math.max(0.6, current - 0.15))}
/>
<LabeledToolButton
  icon={<ZoomIn size={24} />}
  label="Zoom +"
  onPress={() => setZoom((current) => Math.min(2.6, current + 0.15))}
/>
```

Each press adjusts ±0.15, clamped to `[0.6, 2.6]`.

### 5.2 Pinch-to-Zoom (Continuous)

Handled in the raw touch event handlers (not PanResponder) to avoid conflicts:

```ts
const handleTouchStart = (event: any) => {
  const touches = event.nativeEvent.touches;
  if (touches.length === 2) {
    const [a, b] = touches;
    pinchDistanceRef.current = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
    pinchZoomBaseRef.current = zoom;
  }
};

const handleTouchMove = (event: any) => {
  const touches = event.nativeEvent.touches;
  if (touches.length === 2 && pinchDistanceRef.current) {
    const [a, b] = touches;
    const nextDistance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
    const scale = nextDistance / pinchDistanceRef.current;
    const nextZoom = Math.max(0.6, Math.min(2.6, pinchZoomBaseRef.current * scale));
    rafPendingRef.current.zoom = nextZoom;
    scheduleCommit();
  }
};
```

**Process:**
1. On two-finger touch start, record the **baseline distance** between fingers
2. On each move, compute **scale ratio** = current distance / baseline distance
3. Multiply base zoom by scale ratio, clamp to `[0.6, 2.6]`
4. Commit via RAF throttle

### 5.3 Auto-Fit on Import

When a plan is first loaded, the viewport auto-fits to the bounding box of all lines:

```ts
let minX = Number.POSITIVE_INFINITY;
let minY = Number.POSITIVE_INFINITY;
let maxX = Number.NEGATIVE_INFINITY;
let maxY = Number.NEGATIVE_INFINITY;

for (const line of safeLines) {
  minX = Math.min(minX, line.from.x, line.to.x);
  minY = Math.min(minY, line.from.y, line.to.y);
  maxX = Math.max(maxX, line.from.x, line.to.x);
  maxY = Math.max(maxY, line.from.y, line.to.y);
}

const bboxW = maxX - minX;
const bboxH = maxY - minY;

const paddingFactor = 0.82;
const scaleX = (surfaceSize.width * paddingFactor) / bboxW;
const scaleY = (surfaceSize.height * paddingFactor) / bboxH;
const newZoom = Math.min(scaleX, scaleY);

const centerX = (minX + maxX) / 2;
const centerY = (minY + maxY) / 2;

setZoom(newZoom);
setOffset({
  x: surfaceSize.width / 2 - centerX * newZoom,
  y: surfaceSize.height / 2 + centerY * newZoom,
});
```

The `paddingFactor = 0.82` leaves 18% margin around the plan.

---

## 6. Rotation

Rotation is stored externally via `onRotationChange` (lifted state to parent).

### 6.1 Button-Based Rotation (Discrete 15° Steps)

```tsx
<LabeledToolButton
  icon={<RotateCcw size={24} />}
  label="Rot CCW"
  onPress={() => onRotationChange(((rotation - 15) % 360 + 360) % 360)}
/>
<LabeledToolButton
  icon={<RotateCw size={24} />}
  label="Rot CW"
  onPress={() => onRotationChange(((rotation + 15) % 360 + 360) % 360)}
/>
```

### 6.2 Rotation Drag Gesture

Activated by **long-pressing** (260ms) the **Rotate** button:

```tsx
<Pressable
  onPress={() => { /* open angle modal */ }}
  onLongPress={() => {
    ignoreTapRef.current = true;
    setDragMode(false);
    setRotateDragMode(true);
  }}
  delayLongPress={260}
>
```

When `rotateDragMode` is active, horizontal finger movement rotates the plan:

```ts
onPanResponderMove: (_, gesture) => {
  if (rotateDragMode) {
    const nextAngle = (dragBaseRotation.current + gesture.dx * 0.6 + 3600) % 360;
    onRotationChange(nextAngle);
  }
};
```

- Sensitivity: `gesture.dx × 0.6` degrees per pixel
- Released on finger lift (`onPanResponderRelease`)
- Button background turns emerald when active

### 6.3 Manual Angle Entry

A modal allows entering a precise angle:

```tsx
onPress={() => {
  setAngleInput(rotation.toFixed(0));
  setAngleModalVisible(true);
}}>
```

The modal has a `TextInput` (numeric keyboard) and **Apply** button:

```ts
const next = Number(angleInput);
if (!Number.isNaN(next)) {
  onRotationChange(((next % 360) + 360) % 360);
}
```

---

## 7. RAF‑Throttled State Commit (Performance)

Both pan offset and zoom updates use a `requestAnimationFrame` throttle:

```ts
const rafPendingRef = useRef<Record<string, any>>({});
const rafIdRef = useRef<number | null>(null);

const scheduleCommit = useCallback(() => {
  if (rafIdRef.current !== null) return;
  rafIdRef.current = requestAnimationFrame(() => {
    const pending = rafPendingRef.current;
    if (pending.offset) setOffset(pending.offset);
    if (pending.zoom !== undefined) setZoom(pending.zoom);
    rafPendingRef.current = {};
    rafIdRef.current = null;
  });
}, []);
```

- Only one RAF is queued at a time
- Intermediate values overwrite the pending ref without extra renders
- Cleaned up on unmount via `useEffect` return

---

## 8. Tap → Line Selection

When `dragMode` is off and the user taps (touch start→end with <6px movement):

```ts
const handleTouchEnd = (event: any) => {
  if (!dragMode && !rotateDragMode && !touchMovedRef.current && touchStartRef.current) {
    handleCanvasTapFromLocalPoint(locationX, locationY);
  }
};

const handleCanvasTapFromLocalPoint = (locationX, locationY) => {
  const viewportPoint = mapLocalPointToCanvas(locationX, locationY, width, height);
  const planPoint = invertCanvasTransform(viewportPoint.x, viewportPoint.y, zoom, rotation, offset, surfaceSize);
  const nearest = findNearestLine(planPoint.x, planPoint.y, safeLines);
  const hitThreshold = Math.max(0.8, 18 / (zoom));

  if (nearest && nearest.distance <= hitThreshold) {
    onSelectLine(nearest.line.id);
  } else {
    onSelectLine(null);
  }
};
```

**Hit testing:** Uses `pointToSegmentDistance` — perpendicular distance from tap to each line. Threshold scales with zoom: `max(0.8, 18/zoom)` design-metres.

---

## 9. Summary of State

| State | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `zoom` | `number` | `1` | `[0.6, 2.6]` | Viewport scale factor |
| `offset` | `{x, y}` | `{0, 0}` | unbounded | Pan offset in screen pixels |
| `dragMode` | `boolean` | `false` | — | Enable pan gesture |
| `rotateDragMode` | `boolean` | `false` | — | Enable rotation drag |
| `surfaceSize` | `{width, height}` | `{0, 0}` | — | SVG container dimensions |
| `rotation` | `number` | (prop) | `[0, 360)` | Plan rotation in degrees (lifted) |
| `selectedLineId` | `string\|null` | (prop) | — | Currently selected line |

---

## 10. Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `PATH_SEGMENT_CHUNK_SIZE` | 650 | Segments per SVG `<Path>` chunk |
| `ARROWHEAD_LENGTH_PX` | 14 | Arrowhead triangle length in screen px |
| `ARROWHEAD_HALF_WIDTH_PX` | 5 | Arrowhead triangle half-width in screen px |
| `zoom` range | `[0.6, 2.6]` | Min/max zoom limits |
| `zoom` step (buttons) | `0.15` | Discrete zoom increment |
| Pan dead-zone | `6px` | Minimum movement before gesture activates |
| Rotation sensitivity | `0.6` | Degrees per pixel of horizontal drag |
| Long-press delay | `260ms` | Time to hold Rotate button for drag mode |
| Hit threshold | `max(0.8, 18/zoom)` | Tap selection distance in design metres |
| Viewport culling margin | `0.2 (20%)` | Extra extent beyond visible area |
| Auto-fit padding | `0.82 (82%)` | Fraction of surface used for initial fit |
