# Phase 2 Task List – Final

**Status:** Official plan for Phase 2 (Gesture Editing + Offline Support). All work stays behind the `USE_NATIVE_MAPBOX` feature flag. This document is the source of truth for Phase 2 scope, acceptance criteria, and sequencing.

---

## Phase 2 Overview
Phase 2 turns the native Mapbox map from a faithful **renderer** (Phase 1) into a fully **interactive editor** and makes it usable in the field without connectivity. Two pillars: (1) porting the editing gestures that today live only in the legacy Leaflet WebView — drag, scale, rotate of placed template items, boundary dragging, indent clamping, and snap-to-rover — onto the native map using `react-native-gesture-handler` + Reanimated with reliable screen↔geo conversion; and (2) adding offline map download and management so a field can be cached and used offline. All work stays behind `USE_NATIVE_MAPBOX`, preserves the `MapViewProps` contract, and feeds results through the existing callbacks (`onUpdatePlacedItems`, `onMoveBoundary`, `onPlaceRoverAtPoint`, `onSelectionChange`). This is the most technically demanding phase — matching the legacy multi-touch behavior pixel-faithfully is genuinely hard — so estimates are deliberately conservative.

## Phase 2 Main Goals
- Native drag of placed items (single + multi-select), matching legacy behavior.
- Native pinch-scale and rotate around the group centroid, respecting `multiTouchMode`.
- Boundary box dragging with indent clamping and snap-to-rover (~3 m).
- Offline region download + management, with clear progress and warning UI.
- Maintain rendering performance and telemetry isolation under gesture load.
- Guarantee instant, verified rollback to the legacy map via the feature flag.

---

## Prerequisites (Must Complete Before Phase 2)
**These gate implementation — do not build gestures on an unvalidated base.**

- **High — On-device Phase 1 sign-off:** confirm on the tablet that basemap, plan lines (incl. `preview_points`), rover marker/heading/range circle, next-target, reference points, start arrow, boundary + control points, placed items, and selection render correctly across all projection frames (RAW_DESIGN, AUTO_ORIGIN_RAW, ALIGNED_DESIGN, SURVEYED_LOCAL).
- **High — Tap selection + camera verified on device:** Fields point/line tap, Templates item/background tap, recenter (one-shot, fixed), fit-to-plan, and `lockPanDrag`/`lockZoom`.
- **High — Resolve open parity nuances first:** decide on ref-point labels (currently always-on vs legacy tap-tooltips) and placed-item bounding-box fill — so gestures aren't built on behavior we will change.
- **Medium — Gesture stack compatibility spike:** verify `react-native-gesture-handler` + Reanimated interplay with the Mapbox view on the New Architecture.
- **Medium — Flag/branch hygiene:** `USE_NATIVE_MAPBOX` stays `false` on `main`; Phase 2 is developed on a dedicated branch.

**Prerequisite acceptance:** a written Phase 1 device checklist is completed and signed off; no open High-severity rendering/interaction bugs; the gesture spike produces a working drag-a-dot proof on device.

---

## Feature Flag & Rollback Strategy

### How we develop behind the flag
- **Top-level flag:** `USE_NATIVE_MAPBOX` (in `src/config/featureFlags.ts`) selects native vs legacy via the `MapView` dispatcher. The legacy Leaflet implementation (`MapViewLeaflet.tsx`) is **never modified** in Phase 2, which is what guarantees a clean rollback.
- **Branch + flag default:** develop on a `phase-2` branch; keep `USE_NATIVE_MAPBOX = false` on `main`. Enable the flag only in local/test builds.
- **Sub-gating incomplete features:** add granular build-time constants so partially finished work can be merged in a disabled state without affecting the native render path:
  - `ENABLE_NATIVE_GESTURES` (drag/scale/rotate/boundary),
  - `ENABLE_SNAP_TO_ROVER`,
  - `ENABLE_OFFLINE` (download/manage UI + logic).
  Each gesture/offline code path checks its sub-flag and falls back to read-only Phase 1 behavior when off. This lets us ship `main` safely at any time.
- **Testing matrix per change:** every PR is validated in three configurations — (a) flag `false` (legacy, must be unchanged), (b) flag `true` + sub-flags `false` (Phase 1 parity), (c) flag `true` + sub-flag(s) `true` (new feature).

### Rollback & Safety (must verify after Phase 2 changes)
- **Task — Legacy regression check:** with `USE_NATIVE_MAPBOX = false`, confirm the Leaflet map behaves exactly as before Phase 2 (rendering, selection, recenter, boundary). *Acceptance: no visual/behavioral diff vs pre-Phase-2 legacy build; `git diff` shows zero changes in `MapViewLeaflet.tsx`.*
- **Task — Native-with-gestures-off check:** with `USE_NATIVE_MAPBOX = true` and all sub-flags `false`, confirm the app matches validated Phase 1 behavior (no gestures active, no offline UI). *Acceptance: Phase 1 device checklist still passes.*
- **Task — Clean flip both ways:** flipping the flag and rebuilding switches implementations with no crash, no leftover state, and no call-site changes. *Acceptance: `App.tsx` and `TemplatesPage.tsx` remain unedited; release build succeeds in both states.*
- **Task — Build-state CI gate:** `tsc --noEmit` clean, full Vitest suite green, and a signed release build produced in both flag states before merge. *Acceptance: all three pass in the PR.*

---

## Detailed Task List
*Priorities: High / Medium / Low. Each major task lists Acceptance Criteria (AC).*

### Gesture Infrastructure — High Priority
- **Gesture surface setup.** Add a `GestureDetector` layer (Pan, Pinch, Rotation; simultaneous where needed) over the Mapbox view and arbitrate with the map's own pan/zoom (disable map gestures during edits via `lockPanDrag`/`lockZoom`).
  - **AC:** while an item/boundary is being edited, the map does not pan/zoom; when not editing, normal map pan/zoom works; no "fighting" gestures observed on device.
- **Screen↔geo conversion module.** Wrap Mapbox `getCoordinateFromView` (screen→[lon,lat]) and `getPointInView` ([lon,lat]→screen) in typed helpers built on `toMapboxCoord`/`fromMapboxCoord`.
  - **AC:** round-trip screen→geo→screen is within ≤2 px at field zoom; helpers have unit tests with mocked inputs; no use of raw `[lat,lon]`/`[lon,lat]` swaps outside this module.
- **Pure utility functions (no Mapbox/React; unit-tested).** pixel-delta→metre-delta (north/east), group centroid, rotate/scale a point set about a centroid, indent-clamp, snap-distance check, and extract `pickPlanFeatureAt` from the current tap handler.
  - **AC:** each function has unit tests covering normal, zero, negative, and edge cases; `pickPlanFeatureAt` reproduces current selection results (point 2.0 m / line 3.5 m thresholds) in tests.
- **Live preview system.** During an active gesture, render in-progress geometry from a dedicated preview `ShapeSource`/Reanimated state; commit to parent (`onUpdatePlacedItems`/`onMoveBoundary`) only on gesture end (or rAF-coalesced).
  - **AC:** dragging updates visuals at ≥30 fps without calling the parent setter every frame; exactly one commit per completed gesture; releasing mid-drag commits the final position.
- **Gesture state machine.** Explicit states (idle → selecting → dragging → pinching) to prevent conflicting gestures and accidental deselects.
  - **AC:** starting a drag never deselects; switching from drag to pinch is seamless; tapping empty space deselects only when no drag occurred.

### Item Features — High Priority
- **Single-item drag.** Gesture → metre delta → preview → commit.
  - **AC:** a selected item follows the finger 1:1 in ground units; final `item.x/y` matches the drop location within ≤0.1 m; matches legacy result for the same drag.
- **Multi-select drag.** Move all selected items by the same delta, preserving relative positions.
  - **AC:** all selected items translate equally; relative spacing unchanged; single commit with all updated items.
- **Pinch-scale.** Scale selected item(s) about the group centroid; update `scale`, `width`, `height`.
  - **AC:** scaling is centered on the centroid (centroid stays put); width/height update proportionally; matches legacy scale factor for an equivalent pinch.
- **Rotate.** Rotate about the centroid; update `rotation`.
  - **AC:** rotation is centered on the centroid; angle change matches finger rotation; combined pinch+rotate behaves correctly.
- **Respect `multiTouchMode`.** Honor `both` / `scale` / `rotate`.
  - **AC:** in `scale` mode rotation is ignored and vice-versa; in `both` both apply.
- **Indent clamping on item edits.** Prevent drag/scale beyond the boundary indent (legacy parity).
  - **AC:** an item cannot be moved or scaled outside the indent region; clamped position matches legacy clamp math at all four edges.

### Boundary Features — High Priority
- **Boundary drag.** Move the whole boundary (and its handle) → lat/lon delta → metres → `onMoveBoundary`.
  - **AC:** the boundary follows the finger 1:1; committed position matches the drop point within ≤0.1 m; items clamp correctly as the boundary moves.
- **Snap-to-rover.** When a control point comes within ~3 m of the rover, snap and highlight (reuse `activeSnapPointId` visuals).
  - **AC:** snapping engages at ≤3 m and releases beyond it; the active point shows the pulsing highlight; snapped boundary position aligns the control point to the rover.
- **Place-rover-at-point.** Confirm `onPlaceRoverAtPoint` works via native control-point taps.
  - **AC:** tapping a control point invokes the callback with the correct point id and local coordinates.

### Offline Support — High/Medium Priority
- **Strategy confirmation (High).** Verify `offlineManager.createPack` against `satellite-streets-v12` on the installed SDK.
  - **AC:** a small test pack downloads and renders offline; the exact API signature/options are confirmed and documented.
- **Download a field (High).** Compute bounds from plan/boundary extent (reuse `collectFitCoords`), choose min/max zoom, create the pack.
  - **AC:** the downloaded region covers the full plan/boundary with chosen zoom range; completes with a success state; pack is listed afterward.
- **Pack management (Medium).** List packs (name, size, status), delete, re-download/refresh.
  - **AC:** list reflects on-disk packs with accurate size; delete frees storage and updates the list; re-download works.
- **Offline verification (High).** Confirm cached tiles render with connectivity disabled.
  - **AC:** with airplane mode on, the downloaded area renders tiles (no blank map) at the cached zoom levels.
- **Guardrails (Medium).** Cap max zoom, estimate/warn on large downloads, handle quota/storage errors gracefully.
  - **AC:** downloads above a size threshold prompt a warning; quota/storage errors show a clear message and do not crash.

### UI/UX — Medium Priority (Offline-focused)
- **Download progress UI.** Bar/percentage, cancel, success/error with retry.
  - **AC:** progress updates smoothly to 100%; cancel stops and cleans up; errors offer retry.
- **Manage Downloads screen/panel.** List of regions with size and delete; reachable from map/settings.
  - **AC:** screen lists all packs with size; delete works with confirmation; reachable in ≤2 taps.
- **Pre-download warning dialog.** Show estimated size and zoom range before starting.
  - **AC:** dialog shows estimate; proceeding starts download; cancelling does nothing.
- **Offline status indicator.** Badge when using cached tiles / offline.
  - **AC:** badge appears when offline or using cached tiles and hides when online.
- **Edit-mode affordance.** Clear visual cue when item/boundary editing is active vs view-only.
  - **AC:** users can tell at a glance whether editing is active.

### Code Quality & Refactoring — Medium Priority
- **Split `MapViewNative.tsx`** (~950 lines) into a folder: GeoJSON builders, gesture handlers, camera controller, offline controller, render tree.
  - **AC:** no single file > ~400 lines; behavior unchanged; `tsc` + tests green.
- **Consolidate projection math** onto canonical `visualAlignment.ts` (note the third duplicate in `designTransform.ts`).
  - **AC:** native MapView imports the shared helpers; no duplicate equirectangular math added.
- **Shared geometry/gesture utils module** (centroid, clamp, screen↔geo) with tests.
  - **AC:** utilities live in one tested module reused by item + boundary features.
- **Clean up event types** (replace the local `ShapeSourcePressEvent` mirror if a cleaner exported type exists).
  - **AC:** no loss of type safety; `tsc` clean.

### Performance & Optimization — Medium/Low Priority
- **Gesture-time rendering** via preview source/Reanimated (no full item-source thrash).
  - **AC:** dragging holds ≥30 fps on the test tablet with a representative plan.
- **Throttle commits** to parent (on release or rAF-coalesced).
  - **AC:** parent setter called once per gesture (or ≤1/frame), verified by instrumentation/log.
- **Re-verify telemetry isolation** once gesture state is added.
  - **AC:** a rover tick does not re-run item/boundary GeoJSON builders (confirmed via logging/profiling).
- **Load test** (simultaneous gesture + telemetry + optional download).
  - **AC:** no dropped-frame stutter or crash under combined load.

### Testing & Validation — High Priority
- **Unit tests (pure helpers):** pixel↔metre delta; centroid; rotate/scale about centroid; indent clamp (inside/at-edge/outside); snap-distance threshold; `pickPlanFeatureAt`.
  - **AC:** all pass in Vitest; meaningful edge coverage.
- **Logic tests:** gesture state transitions; commit-on-release; `multiTouchMode` restrictions.
  - **AC:** deterministic and green.
- **On-device gesture tests:** single drag; multi drag; pinch-scale; rotate; combined pinch+rotate; clamp at all four edges; boundary drag; snap trigger/release; map-pan vs item-drag arbitration.
  - **AC:** each scenario behaves correctly and is checked off a written device test sheet.
- **On-device parity tests:** compare each operation against legacy Leaflet.
  - **AC:** results match legacy within tolerance; differences documented and approved.
- **Offline tests:** download; go offline + confirm tiles; delete; low-storage; cancel mid-download; re-download.
  - **AC:** all paths handled without crash; offline rendering confirmed.
- **Regression gates:** `tsc --noEmit` clean, full Vitest suite, signed release build — in both flag states — after each milestone.
  - **AC:** all green before merge.

---

## Recommended Implementation Order
1. Complete **Phase 1 device sign-off + resolve parity nuances** (prerequisite gate).
2. **Gesture stack spike** + screen↔geo module + pure utils (with unit tests).
3. **Single-item drag** end-to-end (reference pipeline).
4. **Multi-select drag + indent clamping.**
5. **Pinch-scale + rotate** (with `multiTouchMode`).
6. **Boundary drag + snap-to-rover.**
7. **Gesture performance pass** (preview rendering, throttled commits).
8. **Offline core** (download → verify offline), then **offline UI/UX** (progress, manage, warnings).
9. **Refactor/split `MapViewNative`** once behavior has settled.
10. **Full test + parity + release build**; run the **Rollback & Safety** checks; ship **Milestone 2a (gestures)** and **2b (offline)** separately.

## Risks & Challenges
- **Multi-touch math is the hardest part** of the migration — matching legacy simultaneous pan+pinch+rotate about a centroid with indent clamping pixel-faithfully is fiddly; expect iteration and possible overruns.
- **Gesture vs map-pan conflict:** the map's native pan/zoom must be cleanly arbitrated with editing.
- **Screen↔geo accuracy/latency** during fast drags (async coordinate conversion).
- **Offline UX edge cases:** quota limits, large/partial/cancelled downloads, storage pressure.
- **New-Architecture interplay** between gesture-handler/Reanimated and the Mapbox view (reason for the upfront spike).
- **Validation depends on the physical tablet** — no emulator/CI device available.
- **Phase 1 device bugs take precedence** and will push timelines.

## Estimated Effort (Rough, Conservative — Low Confidence)
- Gesture spike + screen↔geo + pure utils: ~2–3 days
- Single + multi drag + clamping: ~3–5 days
- Pinch-scale + rotate (with mode handling): ~2–4 days
- Boundary drag + snap-to-rover: ~1–2 days
- Gesture performance pass: ~1–2 days
- Offline core + UI/UX (progress, manage, warnings): ~4–6 days
- Refactor + full testing + parity + rollback checks + release: ~2–3 days
- **Total: ~3–4 weeks** of focused work, assuming Phase 1 is signed off first. Recommend splitting into **Milestone 2a — Gestures (~2–2.5 wks)** and **Milestone 2b — Offline (~1–1.5 wks)**, each independently validated and shippable. Treat the upper bound as more likely given gesture complexity.

---

*Official Phase 2 plan. Assumes Phase 1 device validation lands cleanly; any Phase 1 device bugs take precedence and will shift these timelines.*
