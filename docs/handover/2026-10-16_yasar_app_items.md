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

## APP-15 — plan POSTed twice per start; Socket.IO re-created

- **Status:** CODE-DONE (Start: structure locked, no defect found; socket: one real race fixed)
- **Plan POSTs, by construction:** (1) Send (`CsvStageAndLoadPanel`) uploads the plan without entry; (2) Start re-uploads once with the live entry leg (`restageAppTrajectoryWithLiveEntry`, `App.tsx` Start); (3) a third upload only if the rover moved > `LIVE_ENTRY_RECHECK_MOVE_M` (1.0 m) during (2). Two different artifacts with the second one started (Yasar's observation) is therefore the normal Send + Start-with-entry sequence; the drift retry is a third. `prodClient` never retries POSTs (header rule 4). `startMissionOnBackend` has a single caller (`onStartPlan`), no effect re-fires it, and the old guard (ref check-and-set before any `await`) already blocked double taps.
- **Change:** drift logic moved out of `App.tsx` into `restageWithDriftRecheck` (`appPlannedStartSnapshot.ts`): first upload, then at most one more, only on drift; the Start guard is now `createInFlightGate` (`inFlightGate.ts`) held in a ref. Behaviour unchanged, now testable.
- **Socket cause (real):** one `io(` call site (`prodSocket.ts:95`), one `ProdSocketManager` singleton, so screens cannot create sockets. But `connectSelectedWebsocket` (App.tsx) checked `connectInFlightRef` and only set it AFTER `await getSavedTokenFor(...)`, so a manual Connect tap and the auto-connect effect could both pass the check and each call `AppTransportService.connect`, which `forceNew`s a socket and disconnects the previous one (the first caller's promise then never settles). Fix: claim the in-flight slot before the first await (App.tsx) and make `AppTransportService.connect` join an in-flight connect for the same host+token.
- **Tests:** `startSingleFlight.test.ts` (no drift -> 1 upload; at 0.99 m -> 1; no pose -> 1; > 1.0 m -> 2 with the new pose; continuous drift -> max 2; failed first upload -> no recheck; double press -> 1 POST; re-render closure -> 1 POST; gate releases after success/failure). `appTransport.singleSocket.test.ts` (concurrent same-rover connects -> 1 `io()` call; sequential reconnect replaces and disconnects the old one; manager singleton) and `singleSocketClient.source.test.mts` (only `prodSocket.ts` creates a client). FAILED BEFORE the fix: `two concurrent connects to the same rover create exactly one socket` (2 sockets created, first connect never resolved -> timeout). The drift/gate tests are lock-in tests of existing behaviour (pass on the old logic).
- **Tablet check:** Start once and read the backend log: expect Send POST, Start POST (entry), and a third only if the rover moved > 1 m during the upload (`START_LIVE_ENTRY driftRetry:true`). On the connect screen tap Connect while a beacon auto-connect is firing: one `WS_CONNECT`, one socket connection in the backend log.

## APP-03 — Fields/import freeze

- **Status:** FIELD-REPORTED; no speculative performance change
- **Needed:** release-tablet phase timings and heartbeat/socket timeline using the retained field file.

## APP-02 — rover-ahead warning

- **Status:** CODE-DONE
- **Change:** `src/utils/startEntryAheadWarning.ts` — `roverAheadOfFirstMark` / `startEntryAheadWarning` / `firstMarkPointsForEntry`. Marked `// DERIVED — NOT FROM V1 SPEC`: ahead = along-track projection onto the first mark's direction > 0 and lateral offset <= `ENTRY_STAGING_M` (0.5 m); a rover within `ENTRY_TRANSIT_SKIP_M` of the start counts as at the start (the planner omits the entry there). Only when the plan starts with a mark (a leading PRE run-up routes the rover anyway). No new constants; `entryStagingPoint` untouched.
- **Where shown:** Mission Control panel (`ModernHomeUI`), as a hint line under the Start Mission button next to the existing `startBlockedReason` hint; non-blocking (Start stays enabled). Wired through `App.tsx` (`startEntryMarkPoints` memo, same layer scoping as Start) and `HomeView` (live throttled telemetry).
- **Tests:** `startEntryAheadWarning.test.ts` — ahead on line -> warning; lateral limit; behind -> none; off line -> none; at start -> none; diagonal; no pose/mark -> none; run-up leading -> none; plan still builds/sends with staging behind. (New module: the tests could not run on `c999c59`, nothing existed to fail or pass.)
- **Tablet check:** Send a plan, drive/place the rover ~1-2 m past the first mark start on its line: warning appears under Start Mission; move behind or 1 m sideways: it disappears; Start works in both cases.

