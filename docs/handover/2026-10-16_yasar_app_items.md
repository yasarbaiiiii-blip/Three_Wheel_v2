# Yasar app items — implementation handover

**Base:** `9f45812` · **Working tree:** uncommitted · **Verification:** `npx tsc --noEmit`; `npx vitest run` — 123 files / 1414 tests passed

## APP-17 — DXF extension policy lost after navigation

- **Status:** CODE-DONE / CONFIRMED-CODE
- **Cause:** `FieldsPage` was conditionally mounted and owned extension state locally. Remounting restored CSV chain-end mode (`perLine:false`), whose closed-loop guard correctly suppresses extensions.
- **Change:** extension state is now mission-owned by `AppRoot`; DXF/CSV import transitions are explicit and clearing a mission resets the policy. The upload component no longer independently overwrites the source policy.
- **Tests:** `mission extension import policy`; existing `dxfExtensionEndToEnd` and `pendingDxfPreview` regressions.
- **Field check:** closed-square DXF → align → leave/re-enter Fields → enable extensions; confirm per-side PRE/AFT remain visible.

## APP-TBD-TEMPLATE-EMPTY — template-first Fields workflow

- **Status:** CODE-DONE / CONFIRMED-CODE
- **Cause:** placement required a pre-existing mission/map frame even though template geometry can safely exist in a local frame.
- **Change:** an empty workspace may place/edit/remove templates. A pending unaligned metric DXF remains a blocker. Template-only Send still requires a real GPS origin and shows a template-specific explanation; no origin is invented.
- **Tests:** `allows a template to start an empty local plan`; `blocks placement only while an existing metric DXF still needs alignment`.
- **Tablet check:** place a template with no uploaded file, edit it, attempt Send (must be blocked for missing GPS origin), then add a GPS-anchored source and verify normal Send readiness.

## APP-TBD-TEMPLATE-WAIT — generated template remains busy

- **Status:** CODE-DONE for current-source hardening; FIELD-REPORTED symptom still needs APK confirmation
- **Cause in current code:** no permanent busy-state path was found, but generation/parsing ran synchronously before the busy state could reliably paint, and a rapid second press could enter before React updated `disabled`.
- **Change:** generated-template handoff yields to the UI before heavy work, has an immediate single-flight guard, commits only after successful parse, clears busy in `finally`, cleans navigation timers on unmount, and catches navigation failure.
- **Tests:** `importGeneratedTemplateToFields` success ordering/single commit and failure/no mutation.
- **Tablet check:** record exact installed build/button. Current source says `Use in Fields` / `Working...`; a literal `Load` button means the tablet is running an older APK. Test both empty and existing-plan entry paths.

## APP-16 — first expected mark did not spray

- **Status:** NOT A BUG (app output is correct; cause is not in the app's flags)
- **Evidence:** `Recorder/13-10-2026/Run_09/plans/4f849e34…dyx3path` and `Run_08/plans/*.dyx3path` (source `1_Aug`). DYX3PATH encodes spray per **incoming** stretch (`DYX_3WD/docs/contracts/path_artifact.md`: point `i` owns the stretch ending at `i`). `2 2 3 3 3` = unpainted entry stretch (rover→(0,0)), must-hit start vertex, then three painted stretches; the first mark leg (0,0)→(2.166,0.049) is owned by the point with flag 3. `2 0 2 3 3 3 2` is the same with an extra travel point and a trailing exit stretch. The conditioned file `Run_09/plans/2abfb368…dyx3cond` (outgoing-stretch convention) confirms: run 0 (entry) flag 0, the first mark run flag 1. So the plan the app sent painted the first leg; a non-spraying first leg must come from the rover/spray side, not the app artifact.
- **Code check:** entry fold (`foldEntryTransitIntoRuns`) always puts rover/staging points in a separate `travel` run; mark runs keep every point sprayed (builder R1). No path turns the first mark leg into an unpainted approach.
- **Tests (new, lock the invariant):** `missionTrajectory.firstMarkSpray.test.ts` — all mark points sprayed / no entry point sprayed / stored incoming flags paint first leg / staging point on the entry run, for three rover poses. They pass on `c999c59` (nothing to fail before: no defect found).
- **Field check:** if it recurs, capture the DYX3COND and spray-side logs for that run; look at rover spray gating at the first mark vertex (ownership of the leg right after a travel→mark boundary).

## APP-15 — two plan POSTs / socket reconnects

- **Status:** FIELD-REPORTED; no code change
- **Reason:** current Start intentionally permits one second plan upload when rover pose moves more than 1.0 m during the first upload. Socket.IO also reconnects a singleton socket automatically.
- **Needed:** correlate request IDs, `driftRetry`, hashes, timestamps, poses, and socket-object creation separately from reconnect events.

## APP-03 — Fields/import freeze

- **Status:** FIELD-REPORTED; no speculative performance change
- **Needed:** release-tablet phase timings and heartbeat/socket timeline using the retained field file.

## APP-02 — rover-ahead warning

- **Status:** CODE-DONE
- **Change:** `src/utils/startEntryAheadWarning.ts` — `roverAheadOfFirstMark` / `startEntryAheadWarning` / `firstMarkPointsForEntry`. Marked `// DERIVED — NOT FROM V1 SPEC`: ahead = along-track projection onto the first mark's direction > 0 and lateral offset <= `ENTRY_STAGING_M` (0.5 m); a rover within `ENTRY_TRANSIT_SKIP_M` of the start counts as at the start (the planner omits the entry there). Only when the plan starts with a mark (a leading PRE run-up routes the rover anyway). No new constants; `entryStagingPoint` untouched.
- **Where shown:** Mission Control panel (`ModernHomeUI`), as a hint line under the Start Mission button next to the existing `startBlockedReason` hint; non-blocking (Start stays enabled). Wired through `App.tsx` (`startEntryMarkPoints` memo, same layer scoping as Start) and `HomeView` (live throttled telemetry).
- **Tests:** `startEntryAheadWarning.test.ts` — ahead on line -> warning; lateral limit; behind -> none; off line -> none; at start -> none; diagonal; no pose/mark -> none; run-up leading -> none; plan still builds/sends with staging behind. (New module: the tests could not run on `c999c59`, nothing existed to fail or pass.)
- **Tablet check:** Send a plan, drive/place the rover ~1-2 m past the first mark start on its line: warning appears under Start Mission; move behind or 1 m sideways: it disappears; Start works in both cases.

