# CSV road-marking workflow — summary & verification

Scope: **Fields → road-marking Select File (.csv) only**. DXF import/align is out of scope and intentionally unchanged.

---

## 1. Goals

| Goal | Status |
|------|--------|
| Parse CSV **on-device** (no rover upload/preview APIs) | Done |
| Place GPS points at **exact lat/lon** on the map | Done |
| Show **path line + survey pins** | Done |
| Road marking only: **straights + curves**, **no polygons** | Done |
| **No sharp corners** on preview path (fillets) | Done |
| Remove flood of **blue selection vertex dots** | Done |
| Keep survey pins as **raw CSV truth** | Done |
| Multiple features/roads in one CSV render as **separate paths**, never bridged | Done |
| Real curves stay smooth on **noisy real-world GPS data**, not just clean synthetic input | Done |

---

## 2. End-to-end data flow

```
User picks .csv (Fields → Upload / Select File)
        │
        ▼
UploadAndPreviewStep
  • read file as text
  • parseLocalPointCsv(text, fileName)
  • onLocalCsvParsed(parsed)
        │
        ▼
App.handleLocalCsvParsed
  • setLocalCsvPreview(data)
  • clear backend path selection (no GET /api/path/.../preview)
  • lines = localCsvPointsToPlanLines(points)
      ├─ splitIntoOpenPathGroups (feature/road column, or jump-distance fallback)
      └─ buildRoadMarkingPreviewPoints PER GROUP (straights + arcs, open path)
  • setSelectedLineId(lines[0]?.id ?? null)   // first group keeps id "local-csv-path"
  • GPS: set verified origin from first row (anchor)
        │
        ▼
FieldsPage
  • localCsvMapPins = localCsvToMapPins(preview)  // raw points, max 1000
  • always pass pins as selectedPoints (not Align-only)
  • renderPlanPreview(lines + pins)
        │
        ▼
MapViewNative
  • plan stroke from refined preview_points
  • gold pins from selectedPoints (lat/lon direct for GPS)
  • no blue corner dots for road_marking CSV
  • closedRing forced off for road_marking
```

**Backend (parse/preview):** Fields CSV Select File does **not** call parse-point / upload / path preview while previewing. Related `pathApi` helpers stay deprecated for this flow.

**Backend (send to rover):** everything above is a local *preview*. Committing it to the
controller is a separate, explicit step — see §3.8.

---

## 3. What was implemented

### 3.1 Local parse (`src/utils/localPointCsv.ts`)

| Input | Behavior |
|--------|----------|
| Headers `lat`/`lon` (aliases: latitude, longitude, lng, long) | GPS |
| Headers `north`/`east` (northing, east_m, …) | Local NED |
| Headerless numeric rows | Treated as **lat,lon** (same as guide CSV) |
| Optional `dwell_s`, `mark` | Parsed when present |
| Optional grouping column (`feature`, `road`, `track`, `segment`, `route`, `path`) | Tags each point with `.group`; drives one PlanLine per feature (§3.3). Deliberately excludes `name` — see the cardinality guard below. Ignored entirely if its values don't actually repeat (avg < 2 rows per value) — protects against a raw survey export's unique per-point ID/name column (e.g. Emlid Reach `Name`) being mistaken for a feature label, which would split every point into its own 1-point "path" and silently drop every line |
| Invalid rows | Skipped; warnings capped (~50) |

GPS handling:

- Anchor = **first valid GPS row**
- Each row keeps **original lat/lon**
- Local NED via `projectGpsToLocalMeters` for plan math
- Frame: `GPS_SURVEYED` or `LOCAL_NED`

### 3.2 Map pins (`localCsvToMapPins`)

- Built from **raw** survey points (not filleted path)
- Even sampling, max **`LOCAL_CSV_MAX_MAP_PINS = 1000`**
- GPS pins include `lat`/`lon` so MapView draws **directly** (no wrong origin reproject)
- Always shown while local CSV is loaded (not gated on Align)

### 3.3 Path line (`localCsvPointsToPlanLines`)

- **One open plan line per detected feature/road** (see §3.5 `splitIntoOpenPathGroups`) —
  a CSV bundling multiple named features (e.g. two roundabouts, two streets) now produces
  multiple separate `PlanLine`s instead of one line with a straight teleport segment
  bridging the gap between them.
- First group keeps the legacy id **`local-csv-path`** (and label `CSV path (N pts)` when
  unnamed); subsequent groups get `local-csv-path-2`, `local-csv-path-3`, … and use the
  CSV's own feature/road name in the label when available (e.g. `Egmore Roundabout - West
  circle (146 pts)`).
- Entity type `LWPOLYLINE`, `geometry.closed: false`, `geometry.road_marking: true` on
  every line — `MapViewNative`'s road-marking rendering rules (§3.7) key off
  `geometry.road_marking === true`, so they apply uniformly regardless of which group a
  line came from.
- `preview_points` = **refined** road-marking path (not raw connect-the-dots only)
- Pin markers still use raw CSV via `localCsvToMapPins`

### 3.4 Road-marking geometry (`src/utils/roadMarkingCsvPath.ts`)

Preview pipeline (per group, after §3.5 splits the raw points):

1. **Dedupe** near-duplicate points, **`ensureOpenPath`** (first≈last → drop last, **never a
   closed polygon ring**)
2. **`estimateAdaptiveTolerance`** — derive the line/arc fit tolerance from this path's own
   measured noise instead of a single fixed value, unless the caller pins one explicitly.
   Chord residuals are measured at **two window sizes** and the noise separated from the
   curvature by how each scales (`c = (r₂ − r₁)/3`, `noise = r₁ − c`), ×2.5, clamped to
   0.05–1.5 m. A single window cannot tell the two apart and silently discarded real
   geometry on sparsely-sampled surveys — see §3.9
3. **`rejectPathSpikes`**, **`dampenOppositeJogs`** — outlier/GPS-spike rejection and
   short S-jog collapsing
4. **`tryWholeLoopFit`** — fast path for a near-closed loop (roundabout, small track): fit
   ONE circle to the whole group up front, skipping steps 5–7 entirely, so a real loop
   doesn't fragment into many small arcs
5. Otherwise, **`segmentIntoPrimitives`** — greedy longest **line** or **circular arc** fit
   per window (Hyper circle fit for arcs)
6. **`mergeAdjacentPrimitives`** — split-and-merge cleanup: collapses adjacent same-kind
   primitives the greedy pass fragmented, **`dropNegligibleArcs`** — reclassifies a
   large-radius/negligible-sagitta "arc" (a window-boundary artifact, not real curvature)
   back to a line, **`absorbSandwichedCornerArcs`** — reclassifies a short arc flanked by
   two real corners on both sides (conflicting joint-fillet trims) back to a line; each
   followed by another merge pass
7. **`tessellatePrimitivesWithJointFillets`** — geometric fillets at remaining primitive
   joints (turns ≥ `sharpCornerDeg`), preferring a **data-fit local circle radius** over the
   pure tangent/segment-length heuristic when the raw points support one (never larger than
   the heuristic, only ever more faithful to the data); densify (~0.35 m samples). At any
   joint two primitives actually share (i.e. not the two termini of the whole path), the
   shared boundary sample is anchored to the exact point the neighbor also uses — a fitted
   circle only approximates its window (residual up to `fitToleranceM`), so reconstructing
   an arc's endpoint from angle+radius instead of reusing the raw/fillet-tangent point the
   neighbor already uses can land a few cm sideways of it, showing up as a small sharp
   "notch" right at the seam (see the arc/line joint bug below). The two open-path termini
   (very first/last sample of the whole tessellation) are deliberately left as the fitted
   circle's own smooth reconstruction — there is no neighbor there to match, and snapping to
   the noisy raw endpoint would reintroduce the same kind of notch one point earlier.
8. Open-path check again

> **Why the pipeline changed:** a Douglas-Peucker-style collinear simplify used to run
> before step 5. It deleted the point density `segmentIntoPrimitives` needs to satisfy
> `minArcPoints`, so on real (noisy, non-mathematically-exact) survey data — like a
> roundabout with a few centimetres of GPS jitter — real curves collapsed into a raw
> jagged polyline of trivial 2-point line primitives instead of being recognized as arcs.
> Confirmed against the real `roundabout_coordinates.csv` test fixture: the West circle
> loop went from **44 primitives / 0 arcs / 125 of 534 points showing a visible facet**
> to **1 fitted circle / 0 visible facets**, max turning angle 80° → 1.7°.

> **Arc/line joint "notch" bug (fixed):** confirmed against the real `roads_coordinates.csv`
> test fixture. A gently-curving real road segments into a large-radius ("nearly straight")
> arc primitive followed by a line primitive, joined with no fillet because the real turn is
> well under `sharpCornerDeg`. The arc side used to reconstruct its shared endpoint from
> angle+radius on its own fitted circle rather than reusing the exact raw point the line side
> starts at — a ~3 cm mismatch, read as a sharp corner. **Haddows Road max turning angle:
> 90.0° → 11.0°; College Road: 94.8° → 10.9°; both files' count of ≥12° turns: multiple →
> zero.** Whole-loop-fit paths (roundabout, `curve_6_points.csv`) were never affected — a
> single primitive spanning the whole path has no internal joints — confirmed unchanged
> (roundabout max turn 1.7–1.8°, `curve_6_points.csv` 8.2°, before and after).

> **"Minor edges" on tight curves and sub-`sharpCornerDeg` joints (fixed):** three compounding
> issues, all confirmed against the real `curve_6_points.csv` / `roads_coordinates.csv`
> fixtures:
> 1. **Radius-blind sampling.** `sampleArc` paced samples by a fixed arc length
>    (`sampleSpacingM`, 0.35 m) only — radius-blind. A large-radius arc (roundabout, ~11.5 m)
>    lands ~1.7°/step "for free"; a tight-radius real curve (`curve_6_points.csv`, ~2.37 m; a
>    typical street curve/intersection) landed 8-11°/step at the same spacing — visible
>    facets, even though the primitive is a single perfect circle. Fixed by also capping the
>    **angle** a sample step may subtend (`MAX_ARC_SAMPLE_ANGLE_RAD`, ~3°), taking whichever
>    constraint (length or angle) needs more samples. `curve_6_points.csv`: 8.2° → 2.9°.
> 2. **Bare sub-`sharpCornerDeg` joints.** `sharpCornerDeg` (12°) alone left every joint
>    below it completely unrounded — and a real, gentle road bend routinely segments into
>    several short line primitives each turning *less* than 12° (`fitLineOrCircle`
>    deliberately prefers "line" over a fragile short/shallow-sweep arc), so a chain of these
>    reads as a series of small "minor edges." Fixed by flooring the fillet gate to
>    `min(sharpCornerDeg, MIN_VISIBLE_TURN_DEG≈3°)` — a caller-configured *smaller*
>    `sharpCornerDeg` (more aggressive smoothing) is still honored.
> 3. **Offset skip → floor.** A joint whose geometrically-derived tangent offset landed
>    marginally under the 2 cm minimum-fillet-offset guard was skipped outright, even when the
>    turn itself was clearly visible (confirmed: a real ~11° College Road joint had
>    offset=0.0188 m, just under the 0.02 m guard). Fixed by flooring the offset up to the
>    minimum instead of skipping, as long as it still fits the joint's own trim budget.
>
> Two smaller supporting fixes, needed once (1)-(3) made joints noticeably finer-grained:
> forcing an arc-boundary sample to an exact neighbor point (the earlier "notch" fix, above)
> now tapers that correction across a few samples (`blendArcBoundary`,
> `BOUNDARY_BLEND_SAMPLES`) instead of dumping it into one segment; and the tessellation
> dedupe threshold dropped from 1.5 cm to 3 mm (`TESSELLATION_DEDUPE_M`) — 1.5 cm sat right in
> the range the angle cap's own fine samples land at for a small-radius fillet, so it was
> silently discarding roughly every other one of them, undoing fix (1) exactly where it
> mattered most. **Haddows Road max turning angle: 11.0° → 2.95°.** **College Road: 94.8°
> (original) → 10.9° (notch fix) → 10.1° (this pass)** — one narrow remaining edge case (a
> ~0.5 m primitive immediately flanked by both a very-large-radius arc transition *and* a
> real corner) documented in §9; not chased further given the risk/effort of a new
> primitive-merging pass for one location in one file.

Defaults (tunable via options; `fitToleranceM` is now adaptive unless explicitly set):

| Parameter | Default | Role |
|-----------|---------|------|
| `fitToleranceM` | *adaptive* (was fixed 0.08 m) | Line/arc residual |
| `sharpCornerDeg` | 12° | Fillet threshold |
| `filletRadiusFraction` | 0.4 | Of shorter leg (heuristic fallback only) |
| `maxFilletRadiusM` | 8 m | Fillet cap (heuristic fallback only) |
| `sampleSpacingM` | 0.35 m | Preview density |
| `minArcPoints` | 4 | Min for arc fit, and for the data-aware fillet local fit |
| `maxArcRadiusM` | 5000 m | Larger → treat as straight |

### 3.5 Path grouping (`splitIntoOpenPathGroups`, in `roadMarkingCsvPath.ts`)

Splits one CSV's points into independent open paths on two signals, applied in order:

1. **Explicit group key** — the CSV's feature/road/name/track/segment/route/path column
   (§3.1). Any change in key starts a new group; rows sharing a key are never bridged with
   rows from a different key, however close together they are.
2. **Jump-distance fallback** — within each key-group (or across the whole file when no
   grouping column exists at all), a gap far larger than that group's own typical point
   spacing (`> max(5 m, 20 × median spacing)`) also starts a new group. Catches multiple
   unrelated features bundled with no name column, and a real GPS dropout mid-survey —
   showing two separate paths with a visible gap is the safe failure mode, not a fabricated
   straight line bridging missing data.

**Known limitation:** two genuinely unrelated paths that happen to end/start close together
(below the jump threshold) with no grouping column will still be bridged into one path.
A real feature/road column always resolves this correctly; there is no reliable way to
detect it from geometry alone without risking false splits on legitimate dense data.

#### Transit connectors between groups (`buildCsvTransitLines`, in `localPointCsv.ts`)

When a CSV splits into more than one group path (§3.5 above), a straight, unsmoothed
`layer: "transit"` `PlanLine` is drawn between the end of one group's path and the start of
the next — FROM = `planLines[i].to`, TO = `planLines[i + 1].from`, in file order (CSV has no
TSP route optimizer to reorder groups). Skipped when the gap is under 2 cm (the two paths
already touch).

This mirrors the backend's own plan-time TRANSIT connector convention exactly
(`path_engine`'s `_insert_transit_connectors_between_segments`, already exposed to this
app's **DXF** upload flow via `buildRuntimeTransitOverlayFromPlan` / the `transit_preview`
fallback in `App.tsx`) — same `layer: "transit"` tag, same straight/never-curve-fit
geometry (corner smoothing only ever applies to the marking path, never to a transit leg),
same reasoning: show how the rover gets from one path to the next instead of a silent gap.
Reusing the existing `layer: "transit"` tag means no new rendering/exclusion logic was
needed — map color, length-label exclusion, snap-point exclusion, resize-handle exclusion,
and the Path Order list's transit row all already key off that tag generically.

### 3.5 App wiring (`App.tsx` → `handleLocalCsvParsed`)

- Stores `localCsvPreview`
- Builds plan lines (`localCsvPointsToPlanLines`) + transit connectors between groups
  (`buildCsvTransitLines`) + selects `local-csv-path`
- Does **not** set mission file from backend CSV
- GPS: alignment origin = first CSV row; stages alignment as verified for local GPS CSV

### 3.6 Fields UI (`FieldsPage.tsx`)

- `isLocalCsvFlow` adjusts Align-centric DXF assumptions where appropriate
- Step 3 is **"Send to Rover"** (`CsvStageAndLoadPanel`) — see §3.8
- Summary: point count, path count, GPS/NED, frame, anchor, pin sample note
- Map: **refined path** + **gold pins**, replaced by the rover's planned geometry once staged

### 3.9 Preview robustness — working on ANY file, not just dense road surveys

The preview never hardcoded anything file-specific, but it was *implicitly* calibrated to
densely-sampled road-scale surveys and degraded silently outside that regime. Four fixes,
each measured:

**1. The tolerance confused noise with curvature.** `estimateAdaptiveTolerance` measured one
chord residual per point, which mixes measurement noise and the real bend of the path. On a
sparse survey the residual is mostly curvature (sagitta ≈ `d²/8R`), so the "noise" estimate
inflated, the segmenter treated real geometry as noise, and the path collapsed:

| 23 m ring | tolerance | preview |
|---|---|---|
| 146 points | 0.075 | 23.0 × 23.1 m ✅ |
| 60 points | 0.210 | **1.2 × 0.1 m** ❌ |
| 40 points | 0.408 | **1.8 × 0.15 m** ❌ |
| r = 50 m, 40 points | 1.500 (clamped) | **7.8 m of a 100 m ring** ❌ |

The two terms separate by how they scale with the window: doubling it leaves noise unchanged
and quadruples curvature, so measuring at k = 1 and k = 2 recovers both
(`c = (r₂ − r₁)/3`, `noise = r₁ − c`). Dense and straight paths have `r₂ ≈ r₁` and reproduce
the old estimate exactly, so only mis-measured files change.

**2. The whole-loop test compared the wrong quantities.** It rejected unless every point sat
within the *noise floor* of the fitted circle — a max over N points judged against a
per-point value, which gets stricter the more points a loop has. A surveyed ring is never a
perfect circle (the real Egmore rings sit 11–13 cm off theirs), so correcting the projection
in Phase 3 pushed both past the threshold and the roundabout preview went 1.73° → 6.25°.
Now judged against `MAX_FIT_DEVIATION_M` (15 cm — the same budget, and the same number, the
rover uses for `MAX_ARC_DEVIATION_M`). Genuinely non-circular shapes still fall through.

**3. The loop gap test punished coarse surveys.** A ring shot every 1.8 m has ends ~1.8 m
apart however perfectly closed it is, so a fixed 15 cm gap limit rejected it, and the
fallback path cannot tessellate a near-full circle from its endpoint angles. The limit now
also scales with the survey's own median sample step.

**4. Nothing verified the output.** All of the above failed *silently*. The pipeline now
checks the refined path still covers the surveyed bounding box (≥ 90 % per axis) and returns
the raw polyline if it does not. A jagged preview is visibly worse; a truncated one is a
wrong mission. Plus a `PREVIEW_SAMPLE_TARGET` (8000) so arc-length pacing cannot ask for
~18k vertices on a kilometre-scale survey.

Result across rings from r = 0.5 m to r = 200 m at 20–146 points: extent retained 97–100 %,
max step turn ≤ 3°. The three real files are unchanged where they were already correct, the
roundabout is restored to 1.74° / 1.78°, and **the exported CSV is byte-identical** — these
are preview-only fixes and the rover receives exactly what it did before.

Remaining scale assumptions (general thresholds, not file-specific): `JUMP_SPLIT_MIN_M = 5`
and `WHOLE_LOOP_GAP_MIN_M = 0.15` assume a road/vehicle-scale ground survey.

### 3.8 Send to Rover (`surveyCsvExport.ts`, `csvMissionStaging.ts`, `CsvStageAndLoadPanel.tsx`)

The rover plans a CSV mission from a file in its own missions dir; there is no endpoint that
accepts a waypoint array for a line mission. So the handoff is: re-emit the parse as a
canonical survey CSV, upload it, let the rover plan it, and redraw the map from the rover's
answer before committing.

```
CsvStageAndLoadPanel  ("Send to Rover & Load")
  • buildSurveyCsvExport(localCsvPreview)     → Name,Code,Latitude,Longitude
  • POST /api/path/upload                     (cache file on native, Blob on web)
  • POST /api/path/{name}/plan-and-stage      { optimize: true, include_waypoints: true,
                                                line_spacing?: 0.1|0.15 for large surveys }
  • GET  /api/path/staged/{mission_id}
  • setLines(sprayRunsToPlanLines(plan.merged_waypoints, plan.spray_flags))   ← rover truth
  • App.loadMissionOnBackend(mission_id)      → load-to-controller + verify
      + re-hydrate map with sprayRunsToPlanLines (not collinear splitter)
      + navigate Home
```

**Why re-emit instead of uploading the operator's file.** The rover's survey parser
(`path_engine/parsers/survey_csv.py`) is stricter and differently spelled than ours:

| | Our parse | Rover parse | Effect of re-emitting |
|---|---|---|---|
| Header | headerless `lat,lon` accepted | needs a NAMED coordinate pair | headerless files stop being read as metres |
| Grouping | `feature`/`road`/`track`/… + jump distance | `Code`/`Description`/… | `Code` now carries OUR grouping |
| Order | file order | numeric `Name` within a code | `Name` now carries OUR order |

Coordinates are written **straight from the source rows**, never from `north_m`/`east_m`.
On-device preview metres use **ellipsoidal** `metresPerDegree` (rover `georef` parity);
export still sends degrees so the rover projects itself and `analyze_mission.py` §8 can
re-read Latitude/Longitude as ground truth. The shared map helper
`projectGpsToLocalMeters` remains spherical for guide CSV / visual alignment.

**`optimize` must stay true.** It is not a routing preference: the explicit transit-connector
pass is gated behind path extensions (off for CSV), so the route optimiser is the *only* pass
that inserts dead-head legs. Measured on the real files:

| File | `optimize:false` | `optimize:true` |
|---|---|---|
| `roads_coordinates.csv` | runs `[MARK 44292, TRANSIT 1]`, max step turn **101.7°** | `[MARK 15864, TRANSIT 4267, MARK 28428]`, **42.2°** |
| `roundabout_coordinates.csv` | `[MARK 2853, TRANSIT 1]`, **167.0°** | `[MARK 1447, TRANSIT 174, MARK 1406]`, **0.3°** |

With it off the separate paths merge into one continuous sprayed run — the rover would paint
straight across the 642 m gap between Haddows Road and College Road. Reordering is safe
because the map is redrawn from the planner's own waypoints before anything is committed.

`origin_gps` is deliberately **not** sent: a lat/lon survey CSV carries its own geographic
origin, which the planner turns into `GPS_SURVEYED` placement. A north/east CSV has no
georeference and correctly stages as `LOCAL_NED` (the panel says so).

`sprayRunsToPlanLines` (not the existing `waypointsToPlanLines`) hydrates the confirmation
map: the planner tessellates at ~10 cm with ~0.5° of turn per step, so the collinear splitter
would turn one 70 m curve into ~700 two-point lines. Grouping by spray state keeps it at one
stroke per path.

### 3.7 Map display (`MapViewNative.tsx`)

| Feature | CSV road-marking behavior |
|---------|---------------------------|
| Path stroke | Open line from refined `preview_points` |
| `closedRing` | **False** when `road_marking` or not explicitly `geometry.closed` |
| Blue selection stroke | Still on when path selected |
| **Blue corner dots** | **Suppressed** for `local-csv-path` / `road_marking` (dense samples no longer flood the map) |
| Gold pins | Survey samples (numbered) |
| Start / FROM | Path start marker |

---

## 4. Files

| File | Role |
|------|------|
| `src/utils/localPointCsv.ts` | Parse, pins, plan line build + road-marking hook |
| `src/utils/localPointCsv.test.ts` | Parse / pin / plan tests |
| `src/utils/roadMarkingCsvPath.ts` | Open path, fillets, line/arc tessellation |
| `src/utils/roadMarkingCsvPath.test.ts` | Geometry tests |
| `src/utils/surveyCsvExport.ts` | Canonical survey CSV the rover's parser reads (§3.8) |
| `src/utils/surveyCsvExport.test.ts` | Header / Code / Name / precision tests |
| `src/utils/csvMissionStaging.ts` | upload → plan-and-stage → inspect chain |
| `src/utils/csvMissionStaging.test.ts` | Step ordering and failure-surface tests |
| `src/utils/stagedMissionHydration.ts` | `sprayRunsToPlanLines` — one stroke per spray run |
| `src/components/fields/panels/CsvStageAndLoadPanel.tsx` | Step 3 "Send to Rover" UI |
| `App.tsx` | `handleLocalCsvParsed`, state, Fields props |
| `src/screens/FieldsPage.tsx` | Pins always on; local CSV UI |
| `src/components/fields/panels/UploadAndPreviewStep.tsx` | Local file read + parse |
| `src/components/MapViewNative.tsx` | No closed ring for road marking; no blue vertex flood |
| `src/api/pathApi.ts` | Deprecated notes for server CSV path APIs |
| `docs/csv-road-marking-workflow.md` | This document |

DXF import / plan-import modules were **not** redesigned for this work.

---

## 5. What appears on the map

| Visual | Meaning | Source |
|--------|---------|--------|
| Continuous path (straight + curved look) | Road-marking stroke | Refined `preview_points` |
| Gold/amber dots + numbers | Survey samples | Raw CSV (≤1000 pins) |
| Thicker blue stroke | Path selected | Selection layer |
| ~~Many small blue dots~~ | ~~Every densified vertex~~ | **Removed** for CSV road marking |
| Orange/red FROM | Start of path | Start marker |

**Not shown:** filled polygons, closed polygon rings for this CSV path.

---

## 6. Automated verification

```bash
npx vitest run src/utils/localPointCsv.test.ts src/utils/roadMarkingCsvPath.test.ts \
  src/utils/surveyCsvExport.test.ts src/utils/csvMissionStaging.test.ts \
  src/utils/stagedMissionHydration.sprayRuns.test.ts
```

| Result | Count |
|--------|--------|
| Test files | 5 |
| Tests | 130 (parse, pins, open path, fillets, arcs, plan tags, grouping, adaptive tolerance, whole-loop fit, merge/reclassify passes, arc/line joint continuity, transit connectors, arc angular resolution, sub-sharpCornerDeg joint fillet floor, preview robustness across arbitrary files, survey-CSV export, staging chain, spray-run hydration) |

Expected: all tests pass (exit code 0).

Coverage includes:

- GPS / NED / headerless lat,lon parse
- Anchoring and pin lat/lon
- Pin sampling cap
- Open path (no closed ring)
- Sharp corner fillet reduces max turn
- Straight residual / arc fit smoke
- Plan line tags: `closed: false`, `road_marking: true`
- Grouping column → multiple PlanLines, no cross-feature bridge (§3.5)
- Jump-distance fallback grouping with no grouping column
- Adaptive tolerance: stays near the historical default on clean data, relaxes on noisy data, clamp bounds respected
- **Robustness across arbitrary files** (see §3.9): tolerance separates noise from curvature; whole-loop fit judged against the fit budget and tolerant of coarse sampling; preview extent retained ≥ 90 % and max turn ≤ 4° across rings from r = 0.5 m to r = 200 m at 20–146 points; sampling bounded on a 1 km-radius survey
- Whole-loop circle fast path: fits a noisy near-closed loop, rejects non-circular closed shapes and open paths
- `mergeAdjacentPrimitives` repairs fragmentation without ever bridging a real corner
- `dropNegligibleArcs` / `absorbSandwichedCornerArcs` regression tests for the two latent classification bugs the removed `simplifyCollinear` pass used to mask
- End-to-end regression against a realistically-noisy synthetic roundabout (mirrors the real `roundabout_coordinates.csv` bug): 0 visible facets, max turning angle < 20°
- Survey-CSV export: named header emitted, ORIGINAL lat/lon written (never projected metres), `Name` increasing, `Code` per drawn path, feature labels preserved and de-duplicated across a jump split, commas stripped, filename sanitised, 8-dp precision kept
- Staging chain: step order, plan body invariants (`optimize:true`, no `origin_gps`), adaptive `line_spacing` for large surveys, and each failure surface (upload reject, planner 422, missing mission id, staged read-back 404, network throw, empty error body)
- Ellipsoidal GPS projection for CSV parse (shorter north than sphere at ~13° lat)
- Spray-run hydration: one line per run, full polyline preserved, polyline length, junction continuity, independent mark/transit numbering, invalid-point rejection

**Cross-checked against the real rover code** (`D:\projects\Three_Wheel_V2_Backend`), not just
mocks — the generated files for all three CSVs were fed to the actual
`survey_csv.read_survey_csv` and `PathEngine.plan_file`:

| File | Rover-parsed segments | Points |
|---|---|---|
| `curve_6_points.csv` | `csv:path_1` | 8 (2 re-stationed shots collapsed) |
| `roads_coordinates.csv` | `csv:Haddows Road`, `csv:College Road` | 844 / 1631 |
| `roundabout_coordinates.csv` | `csv:Egmore Roundabout - West circle`, `… - East circle` | 146 / 142 |

Identical segmentation, point counts, `geo_origin` and names to parsing the operator's raw
file — i.e. the normalisation is lossless where the rover could already read the file, and
corrective where it could not.

---

## 7. Manual verification checklist (device)

### Setup

1. Same Wi‑Fi or USB: `adb reverse tcp:8081 tcp:8081`
2. `npx expo start` (or project start script)
3. Open Fields → Upload / Select File

### CSV formats to try

**A. GPS with header**

```csv
lat,lon
24.713600,46.675300
24.713650,46.675350
24.713700,46.675400
```

**B. Headerless (lat,lon)**

```csv
24.713600,46.675300
24.713650,46.675350
```

**C. Optional mark/dwell**

```csv
lat,lon,dwell_s,mark
24.7136,46.6753,0,1
24.7137,46.6754,0,1
```

**D. Multiple features (grouping column)**

```csv
feature,lat,lon
Roundabout A,24.713600,46.675300
Roundabout A,24.713650,46.675350
Roundabout B,24.720000,46.680000
Roundabout B,24.720050,46.680050
```

### Expected results

| Check | Pass criteria |
|-------|----------------|
| Parse | Summary shows point count · GPS/NED · frame |
| Position | Path/pins sit on real map location (GPS) |
| Line | Single continuous open stroke per feature (not N separate sticks within one feature) |
| Curves/straights | Dense survey bends look smooth; long collinear runs look straight |
| No polygon | Path does not close into a loop outline |
| No sharp corner | Hard 90° kinks in raw data softens when legs allow fillet |
| No blue cloud | No dense small blue vertex dots |
| Gold pins | Present; if N&gt;1000, UI notes sampled pins + full path |
| No backend stage | Mission not auto-loaded from rover CSV APIs |
| Multi-feature file (format D) | Two separate smooth strokes appear, joined only by a distinct gray **transit** connector (§3.5 Transit connectors) — never bridged as if it were one continuous marking path |

### Regression (sanity)

- DXF upload/align still works as before
- Guide/ref CSV import path unchanged except shared lat/lon header conventions

---

## 8. Design decisions

1. **Local-only CSV** — mission Select File must not depend on rover connectivity for preview.
2. **Pins = raw, stroke = refined** — map truth for survey points vs paint-like continuous path.
3. **Open path only** — road marking is not a filled/closed polygon entity.
4. **Circular arcs + lines** — practical production approximation; not clothoids.
5. **Fillet sharp corners** — matches “road marking has no hard corners.”
6. **Hide selection corners on dense CSV** — selection highlight is the blue **line**, not hundreds of dots.
7. **Never bridge unrelated features** — a CSV bundling multiple named paths splits into
   multiple `PlanLine`s (§3.5) rather than drawing a straight line across the real-world
   gap between them.
8. **Tolerance adapts to the data, not the other way round** — real survey noise ranges
   from a few cm (RTK) to tens of cm (consumer/vehicle GPS); a single fixed tolerance
   either over-fragments clean data or fails outright on noisier real data.

---

## 9. Known limits

| Limit | Detail |
|-------|--------|
| Fillet needs room | Very short legs may keep a kink |
| Arc model | Circular only; residual up to ~fitToleranceM; a true variable-radius spiral/clothoid gets approximated as several fixed-radius arcs |
| Path-terminus reconstruction | The very first/last sample of the whole tessellated path (open-path end, or either end of a single whole-loop-fit arc) is the fitted circle's own angle+radius reconstruction, not the raw survey point — by design, so it stays smooth/on-circle with its neighbors — so it can differ from the raw endpoint by up to `fitToleranceM`. Internal joints between two primitives do not have this gap (fixed; see §3.4) |
| Very short primitive flanked by a large-radius arc and a real corner | One documented edge case in `roads_coordinates.csv` (College Road): a ~0.5 m primitive sandwiched between a very-large-radius ("nearly straight") arc transition and a real corner still shows a ~10° kink after the §3.4 smoothing-floor fixes — the two adjacent joints' fillets interact in a way the per-joint budget model doesn't fully resolve. Down from 94.8° (unfixed) / 10.9° (notch fix only); not chased further via a new primitive-merging pass given the narrow, single-location scope |
| Pin cap | Max 1000 gold markers; full path still drawn |
| NED CSV | No lat/lon → not absolute Earth placement like GPS; stages as `LOCAL_NED` and is placed relative to where the rover stands (the Send-to-Rover panel warns) |
| Preview vs driven geometry | The on-device refined path is an **approximation** of what the rover will drive. The rover re-plans with its own fitter (Kåsa, fixed 2.5 cm tolerance, 15 cm max deviation) where ours uses Hyper with a per-file adaptive tolerance, and it tessellates denser. Map is redrawn from the plan (`sprayRunsToPlanLines`) before and after load. GPS→NED preview scale is ellipsoidal (Phase 3 scoped); fitter parity is still Phase 2 |
| Rover-side corner handling | CSV Send posts `line-config` with `fillet_corners_m: 0` (surveyed corners kept sharp — marking-spec default). Preview still fillets for map cosmetics. Backend arc fit now uses Hyper + adaptive tolerance + 3° angular sample cap (Phase 2) |
| `mark` column | When any row is `mark=false`, export writes a `Mark` column; the rover parser splits into MARK/TRANSIT runs. Files without the column stay all-MARK |
| Uploaded files accumulate | Each send writes `<name>.csv` into the rover's missions dir (re-sending the same file overwrites). **Clear Plan / Clear local CSV** best-effort `DELETE /api/path/{filename}` for that survey name; other leftover uploads are not swept |
| Metro/network | Device must reach packager (subnet/USB/tunnel) — unrelated to CSV logic |
| Grouping false-negative | Two genuinely unrelated paths with no grouping column whose ends happen to land close together (below the jump-distance threshold) still get bridged into one path — a real feature/road column always resolves this; there's no reliable geometry-only way to detect it without risking false splits on legitimate dense data |
| Grouping column name collisions | Only `feature`/`road`/`track`/`segment`/`route`/`path` are recognized, and only when their values actually repeat (avg ≥ 2 rows/value) — a raw survey export's unique-per-point `Name`/`Point Name`/`ID`-style column is correctly never treated as a feature grouping. If a future export format uses one of the recognized alias words for a per-point ID instead, the cardinality guard still catches it, but an unrecognized alias word used as a genuine multi-feature grouping column would not be detected |
| Scrambled point order | The pipeline never reorders rows — a CSV whose rows aren't in real path-traversal order will not self-correct |

---

## 10. Re-verify commands

```powershell
# Unit tests (CSV + road-marking geometry)
npx vitest run src/utils/localPointCsv.test.ts src/utils/roadMarkingCsvPath.test.ts

# Dev client
adb reverse tcp:8081 tcp:8081
npx expo start
```

---

## 11. Sign-off summary

**Fields CSV is parsed fully on-device, split into one open road-marking path per detected
feature/road (never bridged with a straight line across unrelated features), drawn as
straights + filleted/fitted curves (no polygons) with a tolerance derived from each file's
own measured noise, with gold pins at exact survey lat/lon (sampled), without the blue
dense-vertex selection clutter.**
