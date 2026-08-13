# Field path + app robustness — remediation artifact

**Date:** 2026-08-13  
**Status:** Diagnosis only. **No code changes in this pass.**  
**Evidence:** `UI/` screenshots from the same session + current `Runtime_Path` source.  
**Scope:** (1) CSV path generation is not robust on mixed straight/curve surveys. (2) The app does not load or respond instantly.  
**Out of scope here:** DXF re-fit, rover-side planner rewrite, Play Store packaging.

Related existing docs (do not contradict without updating them):

- `docs/csv-road-marking-workflow.md` §3.5 (jump-split)
- `docs/CSV_GEOMETRY_ROBUSTNESS_PLAN.md`
- `docs/PATH_PRIMITIVES_ROBUST_PLAN_VERIFIED.md`
- `docs/CSV_PATH_FITTING_V2_CORRIDOR_SMOOTHER.md`

---

## 1. What the screenshots actually show

All five frames have **Auto Origin ON**. That matters: the fitted plan can be shifted to the rover while gold pins stay on raw GPS.

| File | What is on screen | Verdict |
|---|---|---|
| `UI/WhatsApp Image 2026-08-13 at 1.02.04 PM.jpeg` | `Aug-13-Madhavaram_2pts.csv`, **2 points**, **132.51 m** blue line, pin 1 at FROM, pin 2 at the far end | **Correct.** Sparse 2-point straight is one LINE. |
| `UI/WhatsApp Image 2026-08-13 at 12.39.12 PM.jpeg` | Same site, `Aug_13_Madhavaram-Straight & Curve…`, 58 pts, GPS_SURVEYED. Satellite is up. Only a short green stroke from FROM. Path Order still collapsed | **Incomplete first paint.** Either the fitted path has not committed yet, or only rover-heading / a partial stroke is visible. 2 s later the next frame has the orange path. |
| `UI/WhatsApp Image 2026-08-13 at 12.39.14 PM.jpeg` | Same 58-pt file. Gold pins: isolated **1** far south; a disconnected blob around **18 / FROM**; a separate curve (~**45.04 m**) ending at **58** | **First point not on the path.** The long first straight is missing. The curve is a second disconnected group. |
| `UI/WhatsApp Image 2026-08-13 at 1.02.00 PM.jpeg` | Batch `…_2pts_x2.csv`, “2 files in mission · 2 verified”. Pins start at **2**. Path starts at 2. **Plan Segments 1/1**. FROM is next to the path, not on it | **Combined mission lost the 132.51 m line.** Only the curve remains. First survey pin is off-screen or dropped. |
| `UI/WhatsApp Image 2026-08-13 at 1.02.01 PM.jpeg` | Same batch, Ref points off. Blue polyline with a kink. FROM clearly **not** on the start. Basemap is flat beige | **Same geometry bug + map tiles not loaded.** |

Operator report, restated against this evidence:

> A 132.51 m two-point line connects. When a straight + curve + curve-straight is added, the first point is not connected.

That is confirmed. It is not a camera/zoom illusion.

---

## 2. Target operator contract

These are the rules the next implementation must make true. They are the acceptance tests, not slogans.

| Situation | Required behaviour |
|---|---|
| 2 GPS points, any length (including 132 m) | One open LINE. Both pins sit on the line. Length label ≈ surveyed distance. |
| One file: long sparse straight, then dense curve, then curve-to-straight | **One continuous painted path.** Vertex 1 is an endpoint of the first LINE. The curve starts where that LINE ends. No invented transit across a real surveyed leg. |
| Two files in one mission (2-pt straight + 58-pt curve) | Both paths stay on the map. If they meet, they join or get an explicit transit. **Never silently drop the first file after Load.** |
| Gold pins vs blue/orange stroke | Every survey pin that belongs to a painted group lies on (or within paint budget of) the stroke. A pin with no stroke is an error, surfaced in the Upload panel. |
| App cold start → connection screen | First paint in one frame. No Mapbox native init. No subnet sweep before the form is interactive. |
| Connect → Home / Fields | Map chrome appears immediately. Satellite may stream in, but the canvas is not blank beige without a “loading tiles” state. Navigating Fields must not tear down and rebuild the map. |
| Button / accordion / layer / upload | Press feedback in <50 ms. Heavy work (parse, fit, GeoJSON, Send) starts after a paint, with a busy flag. No “tap did nothing”. |

---

## 3. Path generation — verified root causes

### RC-P1 (primary): jump-split treats a sparse first straight as a GPS dropout

`splitByJumpDistance` in `src/utils/roadMarkingCsvPath.ts`:

```ts
const JUMP_SPLIT_MIN_M = 5;
const JUMP_SPLIT_SPACING_MULTIPLE = 20;
// threshold = max(5 m, 20 × median spacing)
// only runs when the group has ≥ 3 points
```

This is applied **before** `buildRoadMarkingFittedPath`, from `localCsvPointsToPlanLines`.

How the Madhavaram files hit it:

1. Operator marks the long approach with **two points** (the 132.51 m style they already proved works).
2. Then they walk the curve densely (~1 m median).
3. One 58-point file therefore has: `P1 —132 m→ P2 —~1 m→ P3 … P58`.
4. Median spacing is the **curve** (~1 m). Threshold = `max(5, 20) = 20 m`.
5. 132 m > 20 m → new group at P2.
6. Groups: `[P1]` and `[P2…P58]`.

The 2-point file alone never enters this function (`points.length < 3` returns the pair unsplit). That is why 132.51 m looks perfect in isolation.

**This is the exact mixed-density workflow the product advertises** (waypoint straights + surveyed curves). The heuristic is calibrated only for “two unrelated dense features in one CSV”.

Documented in `docs/csv-road-marking-workflow.md` §3.5 as a *safe* failure mode. On this field file it is an **unsafe** false split.

### RC-P2: 1-point groups are dropped with no warning

`buildPlanLineForGroup` returns `null` when the fitted (or fallback) polyline has `< 2` points. `localCsvPointsToPlanLines` skips those groups.

So `[P1]` produces:

- **No** plan line
- **No** transit connector (`buildCsvTransitLines` only walks surviving lines)
- **No** Upload warning
- Gold pin **still drawn**, because `localCsvToMapPins` uses the **raw** CSV, not the split groups

That is the isolated **1** south of the T-junction in `12.39.14`.

### RC-P3: pins and stroke are different pipelines

| Layer | Source | Frame |
|---|---|---|
| Gold numbered pins | `localCsvToMapPins(activeCsvPreview)` → raw lat/lon | Survey GPS |
| Blue/orange stroke | `entity.preview_points` after split + fit + optional Auto Origin shift | Plan / rover frame |
| FROM marker | live telemetry, else `getPlanStartPoint` | Rover |

Consequences visible in the shots:

- Pin 1 can exist with no stroke (RC-P1 + RC-P2).
- After Auto Origin, the stroke can sit on the rover while pins stay on GPS. In `1.02.00` / `1.02.01` FROM is next to the start, not on it.
- Pin numbers are `index + 1` over **whichever preview is active**, not over the combined mission.

### RC-P4: multi-file mission is last-file-wins for preview, export, and pins

`handleLocalCsvParsed` **appends** plan lines (good) but always `setLocalCsvPreview(data)` (last file only).

Then:

- Fields pins = last file only. In the x2 batch, that is the 58-pt curve → pin **1** of that file is the isolated south point (off-screen in `1.02.00`), so the visible series starts at **2**.
- `CsvStageAndLoadPanel` exports `buildSurveyCsvExport(localCsvPreview)` — **last file only**.
- After Send/Load the map is hydrated from the rover answer. Badge says **LOADED**, **Plan Segments 1/1**. The 132.51 m line from file 1 is gone.

The `_x2.csv` name is only a display stem from `UploadAndPreviewStep` (`${firstStem}_x${n}.csv`). It is not a merged survey.

### RC-P5: the same jump-split is baked into rover export codes

`assignPathCodes` in `surveyCsvExport.ts` calls `splitIntoOpenPathGroups` again. Even if preview were patched, Send would still tell the rover “P1 is its own path”. A 1-point rover segment is then dropped or ignored. Load comes back as one curve.

Fixing preview without fixing export will look correct until Load, then regress — which is what `1.02.00` already looks like.

### RC-P6: the fitter itself is not the first-point bug

Once a group of ≥2 points reaches `buildRoadMarkingFittedPath`:

- 2 points → `sampleLine` (the good 132.51 m case).
- Sparse → waypoint fillets / `trySparseArcFit`.
- Dense (58 pts, median ≤ 1.5 m) → `segmentIntoPrimitives` (line + Hyper arc).

I1 already snaps dense open-path termini back onto `cleanedSource[0]` / last. `validateFittedPath` already flags `start endpoint drift`.

So: **if the first straight is not split off, the existing fitter can represent straight + curve + curve-straight.** The robustness hole is **grouping + silent drop + last-file export**, not “arcs cannot follow lines”.

Secondary fitter risks still worth hardening (not the screenshot cause):

- A second mid-file jump (the 18 / FROM blob vs the 45 m curve) — same heuristic, same file.
- Direction-canonical reverse (`buildRoadMarkingFittedPath`) rewrites warning indices; operators then think “point 1” is the other end.
- `rejectPathSpikes` / `dampenOppositeJogs` can still nibble a noisy first vertex on a *dense* first straight. Need a must-keep-endpoints invariant.

### RC-P7: no operator-visible “this point is not on the path” check

Nothing in Upload / Path Order says:

- “1 survey point was not turned into a path”
- “path starts 132 m from pin 1”
- “2 files verified, 1 mark segment after Load”

The UI shows **Verified** + **LOADED** on a geometrically incomplete mission.

---

## 4. App load / map / interaction — verified root causes

### RC-A1: connection screen is not a small app

`App.tsx` is **~6,700 lines**. `AppRoot` always mounts and pulls a large eager graph even when `page === "connection"`:

- `MapView` → `MapViewNative` → `@rnmapbox/maps` + `initMapbox()` at module load
- `SecondaryPages` (Swozi / Status / Positioning / Settings / HowTo / About) — **not** lazy
- `lucide-react-native` icon set, SVG, SecureStore, DocumentPicker, Network, FileSystem
- Almost every mission / CSV / trajectory / alignment util

`FieldsPage` / `TemplatesPage` / `ModernHomeUI` are lazy. That is not enough. Hermes still has to parse the App module and its static imports before the connection form can paint. That is the “app should load instantly” miss.

### RC-A2: leaving connection remounts Mapbox; Fields remounts it again

`ModernHomeUI` mounts `<MapView>` only when `currentPage === "home"`.  
`SectionPages` mounts a **second** `PlanPreview` → `MapView` when `page === "fields"`.

Flow the operator used:

1. Connect → Home map native init + `satellite-streets-v12` download.
2. Open Fields → **Home map unmounts**, Fields map mounts, style loads **again**.
3. Upload / add files / toggle Ref points rebuilds `ShapeSource` / camera fit.

`1.02.01` (flat beige, no imagery) is the map **instance or style** not finished. There is no “tiles loading” chrome. `onDidFinishLoadingMap` only then autocenters. Until that fires, the operator sees an empty canvas and assumes the app is stuck.

### RC-A3: CSV import + fit run synchronously on the JS thread

`UploadAndPreviewStep.importLocalCsvFiles`:

1. `setIsUploading(true)` (does not paint until this function yields).
2. `readPickedFileText` (cache copy of `content://`).
3. `parseLocalPointCsv` (sync).
4. `onLocalCsvParsed` → `localCsvPointsToPlanLines` → **full fit** (sync) → `setLines`.
5. Fields rebuilds GeoJSON, pins, camera `fitToPlan`.

There is **no** `yieldToUi()` on this path (unlike Start). On a 58-point mixed file the jump-split + Hyper fit + Mapbox source update all hitch the same frame as the tap. Accordion / layer / “Add more files” feel dead until that stack finishes.

`12.39.12` → `12.39.14` (same second, +2 s) is this hitch: file already “LOADED” in the card, path not on the map yet.

### RC-A4: telemetry still re-renders the god tree

Working tree **removed** rAF coalescing in `telemetryStore.ts` (comment: coalescing caused stale Start / auto-origin). `applyTelemetryPacket` now `emit()`s immediately.

`AppRoot` still does `useTelemetrySnapshot()` and passes the snapshot through Home → Fields → PlanPreview → MapView. Any pose change past the 2 cm / 0.3° deadband re-renders that entire tree, including Fields workflow and Mapbox `ShapeSource` memos.

That is the “every button is sticky while connected” feel. Coalescing was the right idea; the bug was that Start / live-entry read React state instead of `telemetrySnapshotRef` / `getTelemetrySnapshot()`.

### RC-A5: a render loop is being **ignored**, not fixed

```ts
LogBox.ignoreLogs(["Maximum update depth exceeded"]);
```

in `App.tsx`. That is a live infinite-update. Typical fuel in this tree:

- `FieldsPage` builds `selectedPoints: []` or `refPoints.map(...)` **inline** when there is no CSV preview → new array every render.
- MapViewNative effects keyed on `selectedPoints` / `fitToPlan` identity.
- Auto Origin + `[CANVAS] frame` `console.log` on every telemetry tick (`App.tsx` ~1350).
- `[AlignDXF][Map] Yellow ref-point dots` log when pin lists change.

A silenced max-update-depth **is** the tap delay. Find and delete the loop; do not keep the ignore.

### RC-A6: subnet discovery fights first paint and the radio

On the connection page, a `/24` sweep (hosts 1–254, concurrency 24, every 5 s) starts immediately. There is a “known target” fast path, but the default `192.168.1.102:5001` still probes, and a miss falls through to the full sweep.

That delays “Connect is ready”, saturates a field hotspot, and can stall the later Socket.IO + Mapbox tile fetch (same radio the beige map needs).

### RC-A7: Send / Start already know how to stay responsive; Upload / nav do not

`startLoadedMission` sets busy, toasts, `await yieldToUi()`, then works. Upload, Path Order expand, layer pills, Add more files, and page switches do not.

`handleLocalCsvParsed` also does several `setState`s in one turn (`lines`, preview, uploadedFiles, workflow). Combined with Fields `setMissionCsvPreview` + accordion reset, one tap schedules a large commit.

---

## 5. How the two bug families interact

The operator does not experience “a fitter bug” and “a React bug” separately.

1. Tap Add / Upload → JS thread blocked (RC-A3) → “app not loading”.
2. Fit finally commits a **split** path (RC-P1) → first pin isolated (RC-P2).
3. Map remount / style reload (RC-A2) → beige canvas (RC-A2) while pins appear first (raw GPS is cheap).
4. Auto Origin + live rover (RC-P3, RC-A4) → FROM not on pin 1.
5. Add the 2-pt file or Send/Load (RC-P4, RC-P5) → 132.51 m line disappears, Plan Segments 1/1, still **Verified**.

Fixing only the fitter leaves the delays. Fixing only the delays leaves the disconnected first point. Both have to land.

---

## 6. Remediation plan (do not implement in this pass)

### Phase 0 — Proof artifacts (half day, no product change)

1. Check the two field CSVs into `CSV - Plan/Field_Test_Files/` as  
   `Aug-13-Madhavaram_2pts.csv` and `Aug-13-Madhavaram-Straight-Curve.csv` (operator copies).
2. Add a **failing** vitest that encodes the screenshot:
   - Build `P1=(0,0)`, `P2=(132.51,0)`, then a quarter-circle of ~56 pts, radius ~25–40 m, starting at P2.
   - `splitIntoOpenPathGroups` today: 2 groups, first length 1.
   - `localCsvPointsToPlanLines` today: 1 line, start ≠ P1.
   - **Required after the fix:** 1 group (or 2 groups that are then joined as LINE+ARC with a **0 m** gap), `preview_points[0] === P1`, polyline length ≥ 132.51 + arc length − 0.15 m.
3. Second failing test: two parsed files, `handleLocalCsvParsed` equivalent — both mark lines survive a fake export+hydrate, pins union both files.
4. Turn `LogBox.ignoreLogs(["Maximum update depth exceeded"])` into a tracked bug: reproduce which setter loops (React Native LogBox stack). Do not “fix” by keeping the ignore.

Exit: tests red, loop source named, field CSVs in-repo.

---

### Phase 1 — Mixed-density grouping (the first-point bug)

**File:** `src/utils/roadMarkingCsvPath.ts` (`splitByJumpDistance` / `splitIntoOpenPathGroups`).  
**Callers to keep in lockstep:** `localCsvPointsToPlanLines`, `assignPathCodes`.

Policy (replace the single median test):

1. **Never split a 2-point group** (already true). Keep it.
2. A gap is a *candidate* jump only if it is large **and** the points on **both** sides fail a collinear / same-feature test:
   - If `P[i-1] → P[i]` is longer than `K × median` **but** the incoming heading at `P[i]` matches the outgoing heading within ~8–12°, it is a **sparse straight**, not a dropout. Keep in the same group.
   - If the long leg is the **first** or **last** interval of the file, default to **keep** (operator start/end waypoint). Only split if the next (or previous) 3+ points are a different cluster **and** the heading at the join is a reversal (≥ 120°, existing `MAX_INTERIOR_TURN_DEG`).
3. Hard floor: do not create a group with `< 2` points. If a split would isolate a singleton, **do not split** (or attach the singleton to the nearer neighbour and emit a warning).
4. Keep the current “two dense blobs 30 m apart, no feature column” split — that test already exists (`splitIntoOpenPathGroups` “abnormal jump” case). Do not regress it.

Suggested implementation shape (not code):

- Compute per-interval length + heading.
- `isSparseStraightLeg(i)` = long interval ∧ small heading change at both ends ∧ not a 150°+ reversal.
- Split only when `!isSparseStraightLeg(i) && length > threshold`.
- After split, `mergeSingletonGroups(groups)` so no group has length 1.

**Do not** raise `JUMP_SPLIT_SPACING_MULTIPLE` blindly to 200. That would re-bridge two real roads 50 m apart.

Exit:

- Phase 0 synthetic: 1 connected path, start = P1.
- Existing `splitIntoOpenPathGroups` tests still pass (key-column split, two circles 30 m apart, uniform 0.5 m path).
- `path_zig_zag.csv`, `2x2_square.csv`, `curve_6_points.csv` unchanged.

---

### Phase 2 — Never silent-drop; surface grouping in the UI

1. `buildPlanLineForGroup`: if a group has 1 point after cleanup, return a **non-paintable** degenerate marker **or** (preferred after Phase 1) this branch is unreachable.
2. `localCsvPointsToPlanLines` / parse warnings:
   - `Dropped N isolated survey point(s) at rows …` if any remain.
   - `Split into G paths (gaps at … m)` when G > 1.
3. `CsvWarningsPanel`: show those strings. **Verified** must not mean “we ignored pin 1”.
4. After fit, compute `maxSourceDeviationM` including **all** source points of the file (not only the surviving group). If pin 1 is > 0.15 m from the stroke, warning + do not mark paintable until acknowledged.

Exit: a screenshot-class file shows a yellow warning naming point 1 if it is still off the path; happy path has zero such warnings.

---

### Phase 3 — Multi-file preview, pins, export, Load

1. Replace single `localCsvPreview` with `localCsvPreviews: LocalPointCsvResult[]` (or derive from `uploadedFiles`).
2. Pins = concatenation of every GPS preview (stable numbering: file-local or mission-global; pick one and label it in the HUD).
3. `buildSurveyCsvExport` accepts the **batch** (or export from current `lines` + `source_points`, which already survived integrate/prefix). Prefer exporting **what the map is showing**, not the last parse.
4. After Load / hydrate, assert mark-line count ≥ uploaded CSV mark-line count (unless the operator skipped a Path Order row). If the rover returns 1 segment for 2 files, fail Load verification with a named reason — do not paint **LOADED** + **1/1**.

Exit: the x2 batch still shows the 132.51 m line **and** the curve, before and after Load.

---

### Phase 4 — Endpoint + continuity invariants (fit layer)

Add to `validateFittedPath` / a new `assertRoadMarkingContract(source, fitted)`:

| Check | Limit |
|---|---|
| `fitted[0]` vs `source[0]` | ≤ 1 cm (already 1 cm in I1; make it fail paintable, not just warn) |
| `fitted[last]` vs `source[last]` | ≤ 1 cm |
| every `source[i]` distance to polyline | ≤ 15 cm, **except** intentional fillet cut at classified corners |
| no interior gap > 5 cm in `fitted` | continuity |
| length ratio | keep `[0.75, 1.25]` |

Must-hit: first and last source vertices are always must-hit (already true for 2-pt; extend to mixed).

Exit: Phase 0 synthetic + `roadMarkingCsvPath.robustness.test.ts` cover the contract.

---

### Phase 5 — Instant first paint (connection)

1. **Do not** statically import `MapView` / `MapViewNative` / `SecondaryPages` from `App.tsx`. Lazy them the same way as Fields.
2. Connection route should import only `ConnectionView`, auth, discovery, `runtimeGuards`.
3. Defer `/24` sweep: show the form + last-known host first; sweep on Refresh or after 1.5 s idle, never on first paint.
4. Keep Mapbox `setAccessToken` on first map mount (already the comment); make the module graph match the comment.

Exit: cold start traces (Hermes / Flashlight) show connection interactive before Mapbox/native map JS loads.

---

### Phase 6 — One map instance; tiles have a state

1. Keep a single `MapViewNative` mounted for Home **and** Fields (lift to `HomeView` / a `MapHost`). Fields overlays (workflow card, pins) are siblings, not a second map.
2. Navigating Home ↔ Fields must not change `styleURL` or unmount the view.
3. Until `onDidFinishLoadingMap` **and** first imagery tile (or a 2 s timeout): show a dimmer + “Loading map…” on the canvas. Never leave unexplained beige.
4. `fitToPlan` after CSV import: one-shot after style-ready, not on every `selectedPoints` identity change.
5. Stop passing a fresh `[]` / `.map()` into `selectedPoints` every Fields render — memoize.

Exit: Fields open is a React commit, not a Mapbox init. Adding a CSV does not flash beige.

---

### Phase 7 — Interaction: paint first, work second

1. Restore telemetry **rAF coalesce**, but make Start / auto-origin / live-entry read `getTelemetrySnapshot()` / the existing `telemetrySnapshotRef` (already written on every packet). That removes the reason coalescing was reverted.
2. `useTelemetrySelector` for MapView (pose only) and HUD (battery / fix). `AppRoot` must not subscribe to the full snapshot.
3. Upload / Add more files / Replace all / Path Order toggle / layer pills: `setBusy` + `await yieldToUi()` before parse/fit/GeoJSON.
4. Move `parseLocalPointCsv` + `localCsvPointsToPlanLines` off the tap stack (`InteractionManager.runAfterInteractions`, or a worker later). 58 points is small; the issue is **contention** with Mapbox + telemetry, not O(n).
5. Delete `LogBox.ignoreLogs(["Maximum update depth exceeded"])` once Phase 0 names the loop. If it still fires, that is a release blocker.
6. Remove or gate `[CANVAS] frame` and `[AlignDXF][Map]` `console.log` on every tick — they jank low-end devices.

Exit: while 10 Hz telemetry is live, expanding Path Order and toggling Ref points is immediate. Upload shows a spinner before the hitch.

---

## 7. Suggested PR split

| PR | Phase | Risk | Notes |
|---|---|---|---|
| PR1 | 0 + 1 + 2 | Geometry | Pure TS + tests. Can land without UI. Fixes the 58-pt first-point bug in preview **and** export codes. |
| PR2 | 3 + 4 | Workflow | Multi-file + Load verification. Needs a fixture Send/hydrate test (`stagedMissionHydration`). |
| PR3 | 5 + 6 | Native map | Highest crash risk (`setCamera` before style). Keep the existing style-ready guards. |
| PR4 | 7 | UI jank | Telemetry coalesce + yield. Independent of geometry. |

Do not mix PR1 and PR3. A map remount while changing grouping makes field triage impossible.

---

## 8. Tests that must exist before calling it robust

**Geometry (vitest, no device):**

- Mixed-density Madhavaram synthetic (Phase 0).
- 2-point 132.51 m still one line (`points.length === 2` guard).
- Two dense circles 30 m apart still split (existing test).
- Feature/road column still splits (existing test).
- Singleton never emitted; warning if input would have produced one.
- Batch of 2 files → 2 mark lines → export contains both codes → hydrate count matches.
- `validateFittedPath` fails paintable if start drifts > 1 cm.

**App (device / maestro later, not this pass):**

- Cold start: connection form visible before map logs.
- Connect → Fields: one `onDidFinishLoadingMap` for the session, not two.
- Upload 58-pt file: spinner visible; path includes pin 1; no beige flash without overlay.

Do **not** wait on device tests to land PR1.

---

## 9. What not to do

- Do not “connect” pin 1 with a **transit** across the 132 m surveyed straight. That is a paint-off hop over a real line.
- Do not disable jump-split globally. Multi-feature CSVs still need it.
- Do not treat Auto Origin OFF as the fix. The first point is missing even in plan space.
- Do not raise `ADAPTIVE_TOLERANCE_MAX_M` or `maxArcRadiusM` to hide the gap — that reopens the 119 km circle class of bugs (`CSV_GEOMETRY_ROBUSTNESS_PLAN.md`).
- Do not keep `Maximum update depth exceeded` ignored.
- Do not swallow unhandled rejections again (`runtimeGuards` just stopped doing that; keep it).
- Do not apply Mapbox `initMapbox()` at `App` entry to “speed up” Fields — that makes connection slower.
- Do not implement in this artifact’s PR. This document is the rectification plan only.

---

## 10. Working-tree note (already dirty, not part of this plan)

Current uncommitted edits (`App.tsx`, `telemetryStore.ts`, `runtimeGuards.ts`) are **orthogonal** and partly **opposed** to Phase 7:

- Telemetry rAF coalesce **removed** (will make taps stickier while connected).
- Unhandled-rejection `preventDefault` **removed** (correct; keep).
- `yieldToUi` added and used on Start (good precedent for Phase 7 Upload).

Do not pile grouping fixes on top of that telemetry revert in the same commit.

---

## 11. One-paragraph summary

The 132.51 m two-point line works because a 2-point file never hits jump-split. The 58-point straight + curve + curve-straight file (and the 2-file batch) **does**: the first 132 m leg is classified as a dropout, pin 1 is drawn from raw GPS, and the fitted stroke starts at pin 2. Multi-file preview/export then keep only the last CSV, so Load shows **1/1** and the long line vanishes. Independently, the connection screen still pulls Mapbox and a 6.7k-line `AppRoot`, Fields remounts a second map, CSV fit runs on the tap, and telemetry re-renders the whole tree — so the same session also feels like it “won’t load”. Fix grouping + never-drop + batch export first (PR1–2); then one map instance and paint-before-work (PR3–4). **No product code was changed for this document.**
