# Gesture Crash & VirtualizedList Warning — Root Cause Analysis

## Error 1: VirtualizedLists nested inside plain ScrollViews

**Warning text:**
```
VirtualizedLists should never be nested inside plain ScrollViews with the same orientation
because it can break windowing and other functionality - use another VirtualizedList-backed
container instead.
```

### Root cause chain

`FieldsPage.tsx` wraps its step panels in a `<ScrollView>`. Inside step 3 ("Path Order & Load"), `<PathOrderAndSprayStep>` renders `<DraggableReorderList>`, which renders `<DraggableFlatList>` — a VirtualizedList-backed component. The DraggableFlatList sits directly inside the ScrollView with the same vertical orientation.

**Snippets (exact locations):**

`FieldsPage.tsx:421-425` — outer ScrollView:
```tsx
<ScrollView
  style={{ flex: 1 }}
  contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 24 }}
  showsVerticalScrollIndicator={false}
>
```

`FieldsPage.tsx:516-543` — step 3 renders PathOrderAndSprayStep inside that ScrollView:
```tsx
<FieldsStepCard
  stepNumber={3}
  title="Path Order & Load"
  ...
>
  <PathOrderAndSprayStep ... />
</FieldsStepCard>
```

`PathOrderAndSprayStep.tsx:188-245` — renders DraggableReorderList:
```tsx
<DraggableReorderList
  data={reorderedLines}
  onDragEnd={(next) => { ... }}
  renderExtraRight={(item) => { ... }}
/>
```

`DraggableReorderList.tsx:18` — renders DraggableFlatList (VirtualizedList):
```tsx
<DraggableFlatList
  data={data}
  keyExtractor={(item) => item.id}
  onDragEnd={({ data: next }) => onDragEnd(next)}
  containerStyle={{ flex: 1 }}
  renderItem={...}
/>
```

### Production fix

Two options, pick one:

**Option A — Replace ScrollView with a VirtualizedList-backed container (best for most cases):**
Replace the `<ScrollView>` in `FieldsPage.tsx:421` with `<FlatList>` or another VirtualizedList wrapper that uses `ListHeaderComponent` / `ListFooterComponent` patterns. Or use `react-native`'s `KeyboardAwareScrollView` (from `react-native-keyboard-aware-scroll-view`) which respects nested VirtualizedLists.

**Option B — Isolate DraggableFlatList with a fixed height (simplest, preserves layout):**
The `DraggableReorderList` is already wrapped in a fixed-height `View` (`height: 320`) at `PathOrderAndSprayStep.tsx:179-186`. This means its scroll container is already bounded. However, React Native still sees the VirtualizedList inside a ScrollView ancestor. To fix:

In `PathOrderAndSprayStep.tsx:179-186`, replace the wrapping `<View>` with a `ScrollView` with `nestedScrollEnabled` (Android) and set `scrollEnabled={false}` on the DraggableFlatList. OR, simplest:

Replace the outer `<ScrollView>` at `FieldsPage.tsx:421` with:

```tsx
import { ScrollView } from "react-native";
// Change to:
<ScrollView
  style={{ flex: 1 }}
  contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 24 }}
  showsVerticalScrollIndicator={false}
  nestedScrollEnabled  // Android
>
```

But this only suppresses the warning on Android. The **proper fix** is to restructure so the VirtualizedList is not a descendant of the ScrollView. Since the side panel scrolls a fixed set of cards and the DraggableFlatList already has a bounded height, the ScrollView is unnecessary for the card content itself. Refactor to make the DraggableFlatList area a sibling, not a child, of the scrolling content.

**Recommended fix:** Remove the outer `ScrollView` from `FieldsPage.tsx` entirely. The panel has 3 accordion-style cards; if only the bottom card (step 3) can be tall due to the DraggableFlatList, keep the top two cards as static content and only wrap the content of step 3 in a fixed-height container. If all cards need to scroll together, replace the `ScrollView` with a `KeyboardAwareFlatList` using the cards as list items.

---

## Error 2: Gesture Handler — Failed to obtain view for NativeViewGestureHandler

**Error text:**
```
[Error: [Gesture Handler] Failed to obtain view for NativeViewGestureHandler.
Note that old API doesn't support functional components.]
```

### Root cause — Nested GestureHandlerRootView + PanResponder conflict

Two compounding root causes:

#### Cause A: Nested GestureHandlerRootView (primary)

`App.tsx:2967` wraps the entire app in `<GestureHandlerRootView>`. Inside this tree, `ModernHomeUI.tsx:1713` wraps its own content in a **second** `<GestureHandlerRootView>`. The gesture handler native module assumes a single root view; when a second one mounts, the native view hierarchy cannot be properly resolved. `NativeViewGestureHandler` (used internally by gesture handler for `ScrollView` interop) fails to find its target native view because the inner `GestureHandlerRootView` tries to re-register views already claimed by the outer one.

**Snippets (exact locations):**

`App.tsx:2967` — outer GestureHandlerRootView:
```tsx
return (
  <GestureHandlerRootView style={{ flex: 1 }}>
    <SafeAreaProvider>
      ...
    </SafeAreaProvider>
    <FloatingEStop ... />
  </GestureHandlerRootView>
);
```

`App.tsx:3066` — HomeView rendered inside the outer GestureHandlerRootView:
```tsx
<HomeView ... />
```

`App.tsx:3537–3908` — HomeView renders ModernHomeUI:
```tsx
function HomeView(props: HomeViewProps) {
  ...
  return (
    <ModernHomeUI ... />
  );
}
```

`ModernHomeUI.tsx:1713` — **nested** GestureHandlerRootView inside the component:
```tsx
return (
  <GestureHandlerRootView style={styles.container}>
    ...
  </GestureHandlerRootView>
);
```

#### Cause B: PanResponder (old RN gesture API) usage in the same app

`App.tsx:22` imports `PanResponder` from React Native core — this is the old imperative API. `BoundaryEditor.tsx:411` uses `PanResponder.create()`. When `PanResponder` is active anywhere in the tree, it intercepts touches before the gesture handler's native module can register its views, causing the `NativeViewGestureHandler` to fail with the "Failed to obtain view" error.

`App.tsx:22`:
```tsx
PanResponder,
```

`BoundaryEditor.tsx:411-781`:
```tsx
PanResponder.create({
  onStartShouldSetPanResponder: () => true,
  onPanResponderGrant: (evt) => { ... },
  onPanResponderMove: (evt, gestureState) => { ... },
  onPanResponderRelease: (evt, gestureState) => { ... },
  onPanResponderTerminate: () => { ... },
})
```

### Production fix

**Fix 1 (mandatory): Remove the nested GestureHandlerRootView in ModernHomeUI.tsx.**

`ModernHomeUI.tsx:1713`: Replace `<GestureHandlerRootView style={styles.container}>` with a plain `<View style={styles.container}>`. The outer `GestureHandlerRootView` in `App.tsx:2967` already provides gesture handler context — the inner one is redundant and actively harmful.

```tsx
// ModernHomeUI.tsx:1713 — BEFORE:
<GestureHandlerRootView style={styles.container}>

// AFTER:
<View style={styles.container}>
```

And close with `</View>` instead of `</GestureHandlerRootView>` at line 1847.

**Fix 2 (recommended): Migrate PanResponder usage to the new Gesture API.**

`BoundaryEditor.tsx` uses `PanResponder.create()` (old API). Migrate to the composable Gesture API (`Gesture.Pan()`, `GestureDetector`) from `react-native-gesture-handler`. This ensures all gesture handling goes through the same native module and eliminates the conflict.

**Fix 3 (if Fix 2 is deferred): Isolate PanResponder behind a Gesture Handler-compatible wrapper.**

If PanResponder cannot be migrated immediately, wrap the `BoundaryEditor` in a container with `pointerEvents="box-none"` and ensure it renders *outside* any `GestureDetector` that uses the new API. Alternatively, gate it behind a platform check.

### Summary table

| Error | File | Line | Root cause | Fix priority |
|---|---|---|---|---|
| VirtualizedLists nested in ScrollView | `FieldsPage.tsx` | 421 | `<ScrollView>` wraps `<DraggableFlatList>` (VirtualizedList) via `PathOrderAndSprayStep` → `DraggableReorderList` | Medium (warning, not crash) |
| Gesture Handler failed to obtain view | `ModernHomeUI.tsx` | 1713 | Nested `<GestureHandlerRootView>` inside `App.tsx`'s outer `<GestureHandlerRootView>` | **High** (crash, blocks gesture features) |
| Gesture Handler failed to obtain view | `BoundaryEditor.tsx` | 411 | `PanResponder.create()` (old API) conflicts with new Gesture API | Medium if Fix 1 is applied, High if recurring |
