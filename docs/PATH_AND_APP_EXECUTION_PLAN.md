# Path + app robustness — execution plan

**Date:** 2026-08-13  
**Status:** Ready to implement. No product code in this pass.  
**Supersedes for execution order:**  
Antigravity `implementation_plan.md` (25ce73b0) **and** `docs/FIELD_PATH_AND_APP_ROBUSTNESS_2026-08-13.md`.  
The diagnosis doc remains the evidence record. This file is the work order.

**Field evidence:** `UI/` 2026-08-13 shots (2-pt 132.51 m OK; 58-pt straight+curve first point dropped; x2 batch → Plan Segments 1/1; beige map).

---

## 0. Verdict on the Antigravity plan

### Keep (correct)

| Claim | Verdict |
|---|---|
| `splitByJumpDistance` uses median spacing; a 132 m 2-pt straight is fine alone; adding a dense curve drops the median to ~1 m and the 132 m leg looks like a jump | **True.** This is RC-P1. |
| Add a unit test: 130 m 2-pt straight + 1 m-spaced curve must stay one connected group | **True, necessary, not sufficient.** |
| Defer heavy work until after the tap paints | **True.** Start already does `yieldToUi()`; Upload does not. |
| Root re-renders on telemetry / selection make the app sticky | **True** as a symptom. The proposed Zustand rewrite is the wrong first move. |

### Reject or rewrite

| Antigravity proposal | Why it is not the execution path |
|---|---|
| “Cap the minimum median” or “increase the jump threshold” | Blind threshold change re-bridges two real roads ~30 m apart. Existing test `splits on an abnormal jump` must stay green. |
| “Flag to disable heuristic jump splitting when the path is guaranteed to be a single feature” | Operators do not set that flag. Default-off also breaks multi-feature CSVs. Policy must be geometric, not a hidden switch. |
| “Zustand / new Context for App.tsx global state” | No Zustand in the repo. A store already exists (`telemetryStore` + `useTelemetrySelector`). A god-component rewrite is a multi-week risk and is **not** what made connection/Fields slow. |
| Memoize `GeometryViewport` | **Dead code.** `GeometryViewport.tsx` is not imported anywhere. The operator path is Mapbox (`MapViewNative` via `PlanPreview` / `ModernHomeUI`). |
| InteractionManager as the performance plan | Useful as a tap-yield tactic. Does not fix: eager Mapbox on connection, Fields remounting a second map, last-file-wins export, silenced max-update-depth, discovery `/24` sweep. |
| Manual “launch the app and see if it feels faster” as the only perf gate | Not an exit criterion. Geometry has vitest gates. Perf PRs need named before/after checks (see §6). |

### What the Antigravity plan missed entirely (must be in the work order)

1. **1-point groups are silently dropped** (`buildPlanLineForGroup` → `null`). Pin 1 still draws. That is the isolated south pin.
2. **`assignPathCodes` / Send re-runs the same jump-split.** Preview-only fix regresses after Load (`1.02.00`, Plan Segments 1/1).
3. **Last-file-wins.** `setLocalCsvPreview(data)` + `buildSurveyCsvExport(localCsvPreview)`. Pins and rover export see only the last CSV.
4. **`mergeLocalPointCsvResults` already exists and is tested — and is never called.** Upload loops files and fires `onLocalCsvParsed` per file. The `_x2.csv` name is cosmetic.
5. **Pins vs stroke vs FROM are three frames** (raw GPS / fitted+Auto Origin / live rover).
6. **Connection screen statically imports Mapbox.** Lazy Fields does not help first paint.
7. **Home map unmounts when Fields opens.** Second `MapView` → beige canvas.
8. **`LogBox.ignoreLogs(["Maximum update depth exceeded"])`** is a live loop, not a warning to ignore.
9. Working tree **removed** telemetry rAF coalesce. Do not pile grouping on that revert in the same commit.

---

## 1. Locked product decisions (Antigravity open questions — closed)

**Q1. Which screens are the most sluggish?**  
From the shots + code, in order: (1) cold start → connection, (2) Connect → Fields (map remount + tiles), (3) Upload / Add more files (sync parse+fit), (4) any tap while 10 Hz telemetry is live. GeometryViewport is not in this path.

**Q2. Should a 132 m 2-pt straight + dense curve always connect? Do we still split real GPS jumps?**

| Case | Decision |
|---|---|
| Long first/last leg that is collinear with the next (or previous) travel heading, turn ≪ 120° | **Always keep.** This is a sparse waypoint straight, not a dropout. |
| Two dense clusters, gap ≫ 20× median, heading at the join is a reversal or unrelated | **Still split.** Feature/road column still always splits. |
| A split that would leave a 1-point group | **Do not split.** Attach or refuse the cut. Never drop pin 1 silently. |
| Operator “disable jump-split” flag | **Not in v1.** Geometry policy only. |

Do **not** invent a TRAVEL connector across a surveyed 132 m straight.

---

## 2. Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Fix grouping **before** any App.tsx / Mapbox work | Pure TS, testable, is the screenshot bug. Mixing it with a map remount makes field triage impossible. |
| D2 | Jump-split policy is heading + singleton-safe, not a bigger multiple | Preserves the two-circle split test; keeps mixed-density roads. |
| D3 | Preview, export codes, and Load verification share one grouping function | Otherwise Load undoes the preview fix. |
| D4 | Wire `mergeLocalPointCsvResults` (already written) instead of a new batch type in PR1–2 | Smallest multi-file fix. |
| D5 | No Zustand. Use `telemetryStore` / `useTelemetrySelector` / refs | Library not present; store already does the job. |
| D6 | Do not touch `GeometryViewport` | Unreferenced. |
| D7 | One Mapbox instance for Home+Fields; lazy MapView off the connection graph | That is the load delay, not SVG memoization. |
| D8 | Restore telemetry rAF coalesce **only after** Start/auto-origin read `getTelemetrySnapshot()` | That is why coalesce was reverted. |
| D9 | Delete `LogBox.ignoreLogs(["Maximum update depth exceeded"])` in the same PR that kills the loop | Ignoring it is the tap delay. |
| D10 | Working-tree telemetry/runtimeGuards stay a **separate** commit from geometry | Orthogonal and partly opposed to D8. |

---

## 3. Execution DAG

```
PR0  fixtures + failing tests          (no product change)
  │
  ├─► PR1  jump-split + never-drop     [BLOCKS field correctness]
  │     │
  │     └─► PR2  multi-file merge + Load verify + endpoint contract
  │
  └─► PR3  connection lazy + one map + tile chrome     (parallel after PR0)
        │
        └─► PR4  telemetry coalesce + yield on Upload + kill render loop
```

PR1 and PR3 may be parallel **after** PR0. Do not mix them.  
PR2 depends on PR1 (same grouping function).  
PR4 depends on PR3 only if it touches MapView props; otherwise it can follow PR1.

---

## 4. PR Plan

### PR0 — Failing fixtures (half day)

**Title:** `test: Madhavaram mixed-density fixtures (red)`  
**Depends on:** nothing  
**Product change:** none

**Files**

- `CSV - Plan/Field_Test_Files/Aug-13-Madhavaram_2pts.csv` (operator copy if available; else synthetic 2-pt 132.51 m)
- `src/utils/roadMarkingCsvPath.mixedDensity.test.ts` (new)
- `src/utils/localPointCsv.batch.test.ts` (new or extend existing)

**Tests that must be RED today**

1. `splitIntoOpenPathGroups(P1—(132.51 m)—P2 + ~56-pt quarter-circle from P2)`  
   - Today: `groups[0].length === 1`.  
   - After PR1: one group, or two groups with **0 m** join and no singleton.
2. `localCsvPointsToPlanLines` on that set: `preview_points[0]` equals P1; length ≥ 132.51 + arc − 0.15 m.
3. Two parsed files (2-pt + curve) through the **current** `handleLocalCsvParsed` equivalent: last preview wins; document that as the failing contract for PR2.
4. Existing suite stays green (`npm test`).

**Exit:** tests committed red. No heuristic change yet.

---

### PR1 — Mixed-density jump-split + never silent-drop

**Title:** `fix(csv): keep sparse waypoint straights across dense curves`  
**Depends on:** PR0  
**Risk:** geometry (preview + rover codes)

**Files**

- `src/utils/roadMarkingCsvPath.ts` — `splitByJumpDistance`, `splitIntoOpenPathGroups`, export any new helper
- `src/utils/localPointCsv.ts` — `buildPlanLineForGroup` / `localCsvPointsToPlanLines` warnings
- `src/utils/surveyCsvExport.ts` — no new split; it already calls `splitIntoOpenPathGroups` (must inherit PR1)
- `src/utils/roadMarkingCsvPath.test.ts` — keep the four existing grouping tests
- `src/utils/roadMarkingCsvPath.mixedDensity.test.ts` — turn PR0 reds green
- `docs/csv-road-marking-workflow.md` §3.5 — rewrite the “safe failure mode” paragraph

**Algorithm (implement this, not a bigger `JUMP_SPLIT_SPACING_MULTIPLE`)**

```
threshold = max(JUMP_SPLIT_MIN_M, JUMP_SPLIT_SPACING_MULTIPLE * median)  # keep numbers

for each interval i:
  if length <= threshold: keep
  else if isSparseStraightLeg(i): keep
  else: candidate split

isSparseStraightLeg(i):
  long interval
  AND heading change at the join < ~12°
      (use incoming of the long leg vs outgoing of the next short legs;
       first interval: compare long-leg heading to heading of points i..i+2)
  AND |turn| < MAX_INTERIOR_TURN_DEG (120°)
  AND first or last interval of the file is keep-by-default unless the join is a reversal

after candidates:
  mergeSingletonGroups — never emit a group with length < 2
  if a split would isolate a point, cancel that split and push a warning
```

**Warnings** (parse / `fit_warnings`)

- `Kept a {N} m sparse straight at the start (mixed-density survey).`
- `Split into G paths (gap {m} m at row {i}).` only when a real split remains.

**Do not**

- Raise `ADAPTIVE_TOLERANCE_MAX_M` or `maxArcRadiusM`.
- Add `kind: "corner"` here.
- Touch App.tsx.

**Exit**

- PR0 mixed-density tests green.
- Existing: key-column split, two circles 30 m apart → 2 groups, uniform 0.5 m path → 1 group, close-end bridge limitation test **unchanged**.
- `2x2_square.csv`, `curve_6_points.csv`, `path_zig_zag.csv` still produce today’s primitive counts (spot-check in `pathPrimitives.v2.test.ts` / robustness tests).
- `assignPathCodes` on the mixed file emits **one** code, not `path_1` + `path_2` with a 1-pt first path.

---

### PR2 — Multi-file is one mission + endpoint contract

**Title:** `fix(csv): merge batch preview/export and refuse incomplete Load`  
**Depends on:** PR1  
**Risk:** workflow / Send / Load

**Files**

- `src/components/fields/panels/UploadAndPreviewStep.tsx` — parse all, then **one** `mergeLocalPointCsvResults` + one `onLocalCsvParsed` (or keep append but pass the merge into preview)
- `App.tsx` `handleLocalCsvParsed` — stop last-file-wins for pins/export; store merged preview (or `localCsvPreviews[]` derived into one merge)
- `src/components/fields/panels/CsvStageAndLoadPanel.tsx` — export the merge / map `source_points`, not `localCsvPreview` of the last file
- `src/utils/localPointCsv.ts` — already has merge; add file-level pin union if still needed
- `src/utils/roadMarkingCsvPath.ts` — `assertRoadMarkingContract` or tighten `validateFittedPath` (start/end ≤ 1 cm is paintable-fail)
- `src/utils/stagedMissionHydration.ts` + tests — Load mark-line count ≥ uploaded CSV mark groups unless Path Order skipped a row
- `src/screens/FieldsPage.tsx` — memoize `selectedPoints`; pins from **merged** preview
- `src/components/fields/CsvWarningsPanel.tsx` — show drop/split/deviation warnings; **Verified** cannot hide them

**Behaviour**

- Add more files / multi-pick: both the 132.51 m line **and** the curve stay on the map.
- Pins numbered over the merged set (document the scheme in the HUD: mission-global 1…N).
- Send CSV contains every painted group.
- If rover hydrate returns 1 mark segment for 2 uploaded mark groups → Load **not** verified. Named toast. No **LOADED** + **1/1**.

**Exit**

- `mergeLocalPointCsvResults` used from Upload (grep is non-zero outside tests).
- Test: 2-pt file + curve file → 2 mark lines after parse, 2 codes in export, hydrate mismatch fails.
- `validateFittedPath` fails paintable if start drifts > 1 cm.
- Re-walk of `1.02.00` contract: Plan Segments ≥ 2 when both files are in the mission.

---

### PR3 — Instant chrome: connection lazy + one map + tile state

**Title:** `perf: keep connection off Mapbox; one map for Home and Fields`  
**Depends on:** PR0 (not PR1)  
**Risk:** native Mapbox (`setCamera` before style — existing guards stay)

**Files**

- `App.tsx` — stop static `import { MapView }`; lazy `SecondaryPages`; connection tree = `ConnectionView` + auth + discovery
- `src/components/MapView.tsx` / `ModernHomeUI.tsx` / `App.tsx` `SectionPages` — **one** `MapViewNative` hosted above page switch; Fields overlays are siblings
- `src/components/MapViewNative.tsx` — “Loading map…” until `onDidFinishLoadingMap` (timeout 2 s still shows the chrome, not mute beige)
- `src/components/MapViewNative.tsx` — `fitToPlan` only after style-ready; do not depend on fresh `selectedPoints` identity
- `App.tsx` discovery effect — first paint last-known host; `/24` sweep on Refresh or after 1.5 s idle

**Do not**

- Call `initMapbox()` from `App` entry.
- Change `styleURL` on Home ↔ Fields.
- Memoize or edit `GeometryViewport`.

**Exit**

- Metro/bundle: connection graph does not include `@rnmapbox/maps`.
- Home → Fields does not unmount the map view (no second `onDidFinishLoadingMap` in the session).
- Beige canvas always has an explicit loading overlay or a timeout message.

---

### PR4 — Taps stay alive under telemetry

**Title:** `perf: coalesce telemetry; yield before CSV work; kill max-update-depth`  
**Depends on:** PR3 if MapView props change; else can follow PR1  
**Risk:** Start / auto-origin stale pose (the reason coalesce was removed)

**Files**

- `src/features/telemetry/telemetryStore.ts` — restore rAF emit coalesce
- `App.tsx` — Start, auto-origin, live-entry read `getTelemetrySnapshot()` / `telemetrySnapshotRef` only (already written on every packet)
- `App.tsx` / `MapViewNative` / HUD — `useTelemetrySelector` for pose vs battery; `AppRoot` must not subscribe to the full snapshot
- `src/components/fields/panels/UploadAndPreviewStep.tsx` — `setIsUploading(true); await yieldToUi();` then parse/fit
- `App.tsx` `handleLocalCsvParsed` — same yield if it still does the fit
- `src/screens/FieldsPage.tsx` — memoize `selectedPoints` (`[]` / `.map()` today is a new array every render)
- `App.tsx` — **delete** `LogBox.ignoreLogs(["Maximum update depth exceeded"])` after the loop source is gone
- `App.tsx` / `MapViewNative.tsx` — gate `[CANVAS] frame` and `[AlignDXF][Map]` logs behind `__DEV__` or a flag

**Exit**

- 10 Hz telemetry + expand Path Order / toggle Ref points: press feedback < 50 ms.
- Upload shows spinner **before** the hitch.
- Release/log: no `Maximum update depth exceeded`.
- Start still sees a fresh pose (unit or harness: restage reads the store, not a stale render).

---

## 5. Per-PR implementation checklist (engineer order)

### When starting PR1

1. Do not commit on top of the dirty `telemetryStore` / `runtimeGuards` / `App.tsx` hunks unless those are already committed separately (D10).
2. Implement `isSparseStraightLeg` + `mergeSingletonGroups` next to `splitByJumpDistance`. Keep the public `splitIntoOpenPathGroups` signature.
3. Run `npx vitest run src/utils/roadMarkingCsvPath.test.ts src/utils/roadMarkingCsvPath.mixedDensity.test.ts src/utils/localPointCsv.test.ts src/utils/surveyCsvExport.test.ts src/utils/pathPrimitives.v2.test.ts`.
4. Update `docs/csv-road-marking-workflow.md` §3.5 in the same PR.

### When starting PR2

1. Change Upload to `mergeLocalPointCsvResults(parsed[])` then a single parent callback.
2. Grep `setLocalCsvPreview` — every write must be the merge (or a list that the export reducer merges).
3. Add Load verification next to `verifyStagedLoadedMission` / `hydrateStagedMissionForMap`.

### When starting PR3

1. Confirm `initMapbox` is only in `MapViewNative` / `MapboxHelloMap`.
2. Lift map host first, then lazy the static imports. Two-step commit inside the PR is fine.
3. Keep `mapLoadedRef` / `safeSetCamera` behaviour.

### When starting PR4

1. Re-introduce coalesce **after** grep shows Start/auto-origin do not read `telemetrySnapshot` from React state for decisions.
2. Remove the LogBox ignore only when the loop is gone (search effects that `setState` from `selectedPoints` / `lines` / `displayedLines` without a ref guard).

---

## 6. Verification (stronger than “launch the app”)

### Automated (every PR)

```bash
npx vitest run
```

PR1 extra: mixed-density file + existing grouping tests.  
PR2 extra: merge-from-Upload + export codes + hydrate count.  
PR3 extra: none required in vitest; add a static grep test if useful (`App.tsx` must not `import "./src/components/MapView"`).

### Manual (device, after PR1 and after PR3)

| Step | Expect |
|---|---|
| Upload 2-pt 132.51 m | One line, pins 1–2 on the stroke |
| Upload 58-pt straight+curve (or the synthetic) | Pin 1 on the stroke; one continuous path; length ≈ survey |
| Add more files (2-pt + curve) | Both paths visible; after Send/Load still ≥ 2 mark segments |
| Cold start | Connection form before any Mapbox log |
| Connect → Fields | No beige without “Loading map…”; no second style download |
| Toggle Ref points / Path Order while rover live | Immediate press state |

### What “profile GeometryViewport” is replaced by

- Hermes / Metro: connection bundle must not list `@rnmapbox/maps`.
- React Native LogBox: zero max-update-depth.
- Optional: `systrace` / Flashlight on Upload tap (JS thread busy after first paint, not during it).

---

## 7. Explicit non-goals (this execution)

- Zustand / new global store
- Editing `GeometryViewport.tsx`
- Disabling jump-split via a user flag
- Raising fit tolerances / max arc radius
- DXF re-fit
- Rover planner rewrite
- Combining geometry and Mapbox remount in one PR
- Re-swallowing unhandled rejections

---

## 8. Suggested first command after approval

Start **PR0 + PR1** only. That is the screenshot bug. PR3 can start in a second worktree once PR0 is on the branch.

Do not implement from the Antigravity file. Use this document as the work order.
