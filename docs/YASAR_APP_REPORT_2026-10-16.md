# App field-blocker investigation and implementation plan — 2026-10-16

**From:** Vetri (rover owner) · **Prepared:** 15 Oct 2026 · **Repo:** `Three_Wheel_v2` · **Base:** `Client`

## Purpose and evidence rules

This is an investigation and implementation plan. It does not mark a field report as a code bug until the report is reproduced or the relevant artifact/log proves the failing code path.

Use these labels in the handover:

- **CONFIRMED-CODE:** the cause is demonstrated in the checked-out source with a focused regression test.
- **CONFIRMED-ARTIFACT:** a saved mission artifact or log demonstrates the incorrect payload/lifecycle.
- **FIELD-REPORTED:** observed on a tablet/rover but not yet reproduced from retained evidence.
- **NOT-A-BUG:** current behavior matches the documented safety/product policy.
- **NEEDS-ROVER:** app-side evidence is correct and the remaining check requires controller, bench, or field evidence.

Do not infer geometry semantics from a flattened flag list alone. Preserve coordinates, run boundaries, run types, app commit/version, rover version, mission ID, request IDs, and timestamps.

## How to work

1. Start from `Client` commit `9f45812` (`fix(entry): stage the entry leg on the first mark's line`) unless `Client` advances. Record the actual base hash before changing code.
2. Create `fix/app-field-blockers-2026-10-16` in a separate worktree.
3. Before each fix, add or capture a failing reproduction. If required field evidence is unavailable, stop that item at `FIELD-REPORTED`; do not guess a cause.
4. Use one commit per item and include the item ID in the commit subject. Each behavioral commit must contain its focused regression test.
5. Do not change the rover path format, flag bits, API contract, staging distance, or staging-angle threshold without an agreed cross-repository change.
6. Before handover:
   - `npx tsc --noEmit` passes.
   - `npx vitest run` passes. The verified base result is 121 files / 1407 tests.
   - There is currently no repository `lint` script. Do not claim an ESLint comparison unless a lint command/config is separately established.
   - Report focused-test names and the final full-suite result.
7. Create `docs/handover/2026-10-16_yasar_app_items.md` if it does not exist. For every item record:
   - evidence status;
   - reproduction inputs and observed result;
   - root cause or why the evidence is insufficient;
   - commit hash and test name, when changed;
   - remaining bench/field checks.
8. Do not merge into `Client`, build an APK, or install it. The reviewed branch will be merged and built separately.

## Priority 0 — correctness and blocked workflows

### APP-16 — verify whether the first mark run loses spray

**Field report:** On 2026-10-13, `1_Aug`, mission 2, the first expected painted leg did not spray.

**Available claim:** Artifact `4f849e34…dyx3path` reportedly contains flags `2 2 3 3 3`; another reported example contains `2 0 2 3 3 3 2`. Bit 0 is spray intent and bit 1 is must-hit.

**Important ambiguity:** `2 2 3 3 3` can represent a two-point unpainted entry-travel run followed by a three-point painted mark run. The flags alone do not prove that a mark run was sent unpainted. The referenced artifacts are not currently in this repository.

**Current-code invariant:** `appPlannedMissionBuilder` assigns spray to every emitted point of a `mark` run and no spray to a `travel` run. Commit `9f45812` adds an intermediate entry-staging point but does not change that flag policy.

**Required investigation:**

1. Obtain the complete `1_Aug` source plan and at least one original `.dyx3path` artifact, not a shortened flag list.
2. Rebuild it at `9f45812` with the recorded rover pose and extension configuration.
3. Compare source geometry → trajectory runs → request payload → stored artifact by coordinate and run type.
4. Identify which physical segment was expected to paint. Confirm whether it belongs to `travel`, PRE/AFT extension, or `mark` in the request.
5. If every mark point already carries bit 0, classify the app payload as `NOT-A-BUG` or `NEEDS-ROVER`; do not change flags.
6. If a source mark segment is reclassified as travel or loses bit 0, fix that exact transition without painting the rover-entry or staging leg.

**Required tests:**

- Exact retained `1_Aug` fixture: every source mark segment maps to a sprayed mark run.
- Entry and staging points remain spray-off.
- The shared travel/mark boundary preserves the intended run types and flags.
- PRE/AFT extensions remain spray-off.

### APP-17 — DXF extensions disappear after alignment/navigation

**Evidence status:** `CONFIRMED-CODE` for the reported closed-loop path.

**Confirmed cause:**

1. DXF import seeds `DXF_EXTENSION_CONFIG`, including `perLine: true`.
2. `FieldsPage` owns the extension configuration as local component state initialized from `DEFAULT_CSV_EXTENSION_CONFIG`, where `perLine: false`.
3. Leaving/remounting Fields after alignment can therefore lose the DXF mode and restore CSV chain-end mode.
4. Chain-end mode intentionally returns no extensions for a closed non-curve mission, so the UI reports a closed loop and generates nothing.

**Required behavior:**

- Extension configuration has one mission-level owner and survives Fields remounts, alignment navigation, section changes, and enable/disable toggles.
- A DXF import starts in per-line mode. A closed DXF made of independent sides receives eligible PRE/AFT extensions per side.
- CSV keeps its existing chain-end default unless the operator explicitly selects a different policy.
- Clearing the mission or starting a genuinely new import resets configuration once, using the new import type—not incidental component mounting.
- Closed-loop suppression remains valid in chain-end mode and the UI explains that policy; do not remove the safety guard globally.

**Required tests:**

- Import closed-square DXF → align → leave/remount Fields → enable extensions: per-line mode and expected extensions remain.
- Enable → disable → enable preserves `perLine` and distances.
- Closed-square DXF in per-line mode receives eligible PRE/AFT edges.
- Closed loop in explicit chain-end mode remains suppressed with the correct explanation.
- Open, joined, short, first, and last legs follow their documented eligibility rules.
- Runtime entry staging does not remove or duplicate the first eligible extension.

### APP-TBD-TEMPLATE-EMPTY — place a template before uploading a file

**Evidence status:** `CONFIRMED-CODE` for the block.

**Confirmed cause:** `FieldsPage` requires an existing mission/map frame before template placement. On an empty plan there is no uploaded geometry, shared origin, or verified alignment, so `canPlaceTemplates` is false.

**Required behavior:**

- The operator may create and place a template in an empty local workspace without first uploading CSV/DXF geometry.
- Placement must not invent a GPS origin or silently make the mission sendable.
- The placed template establishes editable local geometry. Send/Start remains blocked until the operator establishes a valid GPS/map anchor through the normal anchoring workflow.
- If an unaligned metric DXF is already present, template placement remains blocked until that DXF is aligned, preventing a later double transform.
- Clear/remove actions must remove both template geometry and any derived workflow state deterministically.

**Required tests:**

- Empty Fields → choose template → place/edit/remove succeeds without an uploaded file.
- Empty template plan cannot Send before a valid origin exists and shows a precise reason.
- After anchoring, the same template plan becomes eligible for Path Order/Send.
- Pending unaligned DXF still blocks placement.
- Adding a later file does not move an already anchored template twice.

### APP-TBD-TEMPLATE-WAIT — template action stays busy forever

**Evidence status:** `FIELD-REPORTED`; exact UI/build must be identified first.

**Current-source fact:** At `9f45812` the Templates page button is `Use in Fields`, showing `Working...` while `isParsing` is true. Its synchronous DXF generation/import is wrapped in `try/finally`. The current mission flow has Send → Start and no separate rover-side Load step.

**Required investigation:**

1. Record the installed APK version/commit and the exact button text. If it literally says `Load`, reproduce on an APK built from the current branch before modifying current code; a stale APK is not fixed by changing unrelated source.
2. If the current button is `Use in Fields`/`Working...`, capture whether generation, DXF parsing, import callbacks, alert dismissal, navigation, or Fields mounting is the last completed phase.
3. Reproduce both from an empty workspace and after an uploaded/aligned file.
4. Measure JS-thread time and retain the thrown error/log if present.
5. Fix the owning state transition. Do not add an arbitrary timeout that hides a blocked synchronous operation.

**Required behavior and tests:**

- One press starts one import and one navigation.
- Busy state clears on success, parser failure, callback failure, navigation failure, and component unmount.
- A generated template is transferred exactly once; existing uploaded geometry is preserved or replaced only according to an explicit product choice.
- Long generation/parsing work must not starve connection heartbeat; chunk, defer, or move it off the render path if profiling confirms blocking work.
- No legacy rover-side Load step is reintroduced.

## Priority 1 — start/session reliability

### APP-15 — distinguish duplicate planning from the intentional drift retry

**Field report:** A start produced two `POST /api/missions/plan` responses with different artifacts, and the second artifact was started. Socket.IO also appeared to connect more than once.

**Current-code fact:** Start intentionally re-uploads the live-entry mission once, then may upload it one additional time if the rover moved more than 1.0 m during the first upload. Double taps are guarded. Socket ownership is a singleton, while Socket.IO itself performs automatic reconnects.

**Required investigation:**

1. Correlate both POSTs using the start tap/request ID, `START_PHASE`, `START_LIVE_ENTRY`, `driftRetry`, mission hashes, timestamps, and both rover poses.
2. Classify the second POST as intentional drift retry, duplicate caller, or network/application retry.
3. Count client socket object creation separately from transport reconnect/connect events. Multiple server connection IDs do not by themselves prove multiple app socket instances.
4. For the post-mission tablet-link drop, record whether it occurs immediately after `COMPLETE`, report loading, app background/foreground, heartbeat failure, or an explicit disconnect.

**Required behavior and tests:**

- Stationary rover: one live-entry plan POST and one start command per tap.
- Rover movement greater than 1.0 m during upload: exactly one controlled rebuild/re-upload, and the second hash is the one started.
- No third plan POST even if the rover continues moving; surface a safe operator outcome instead.
- Rapid double tap still produces one start sequence.
- One socket manager/socket object per session; screen navigation and mission completion do not create another object.
- Automatic reconnect remains enabled and is reported separately from object creation.

## Priority 2 — performance and operator warning

### APP-03 — Fields/import UI freeze and connection starvation

**Evidence status:** `FIELD-REPORTED`; device measurement required.

The app already preloads lazy screens and yields once before local import parsing. CSV/DXF parsing and geometry construction still contain synchronous JavaScript work, so a large input can remain a plausible cause, but it is not proven.

**Required investigation and acceptance:**

- Capture release-build timings on the target tablet for opening Fields and importing the retained field file.
- Instrument file read, parse, geometry conversion, state commit, render, storage reads, and map update separately.
- Record heartbeat/socket gaps on the same timeline.
- Fix the measured blocking phase through memoisation, bounded chunking, deferred work, or a worker/native path appropriate to React Native.
- Report median and worst observed time before/after using the same file/device/build.
- Add a focused performance regression or operation-count test where deterministic; keep the tablet benchmark as the final acceptance check.

### APP-02 — warn when the rover is already ahead of the first mark start

**Status:** `9f45812` added entry staging. The non-blocking operator warning is still absent.

**Required behavior:**

- Define “ahead” using signed along-track projection onto the first non-degenerate mark direction plus an agreed lateral-distance tolerance.
- Put the along-track and lateral tolerances in named, documented constants; agree their values before implementation.
- Show the warning before Start when the rover is ahead and sufficiently close to the mark line.
- Do not show it merely because the rover is off to the side, behind the start, or within positional tolerance.
- The warning is advisory and must not bypass or weaken existing telemetry/start safety gates.

**Required tests:** ahead/on-line, behind/on-line, near-zero boundary, ahead/off-line, degenerate first segment, reversed first mark, and unavailable/stale pose.

## Out of scope for this batch

- Do not tune the `9f45812` staging values (0.5 m and 2°); those require bench/field validation.
- Do not change shared flag bits, path format, or API contracts on the app side alone.
- Do not remove closed-loop extension protection globally.
- APP-10…14 remain later work unless one is explicitly promoted by the rover owner.

## Handover gate

An item is ready for review only when its evidence status, reproduction, root cause, focused test, full-suite result, and remaining rover/tablet check are all recorded. A passing unit suite is necessary but does not replace artifact comparison or field validation for geometry, controller behavior, connectivity, or tablet performance.
