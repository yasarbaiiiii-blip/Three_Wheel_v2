# CSV Point Edit Mode — Execution Plan

Scope: **CSV workflow only.** After a CSV is uploaded the operator can select points on the
map, delete them from the working plan, and undo / redo (and "Restore all"). The original CSV
and its parse result are never modified. DXF and template flows are untouched.

Companion review: `Unknown/Review CSV Point Editing Mode Plan.pdf` (every point in it is
resolved below under "Decisions").

---

## 1. Ground truth about the current code (verified)

| Fact | Where |
|---|---|
| Per-file parse results are kept immutable in `localCsvParsesRef` (matched to files **by fileName**, which is weak). | `App.tsx` `handleLocalCsvParsed` |
| `source_index` = the 1-based CSV **row number**, skipped/invalid rows counted. Stable per file. `mergeLocalPointCsvResults` **renumbers** it, so merged results can't be used as IDs. | `localPointCsv.ts` parse + merge |
| Lines are built **once at upload**: `localCsvPointsToPlanLines` → `chainMarkLinesByGeometry` → `buildCsvTransitLines` → `integrateAnchoredLines` (rebase to shared origin + `prefix__` ids). There is no rebuild path. | `App.tsx:2146-2239` |
| Standalone local-NED CSV lines are **not prefixed**. GPS CSV lines are `prefix__…`. | `App.tsx:2160-2185` |
| Groups with < 2 points yield **no** line (`buildPlanLineForGroup` → `null`). | `localPointCsv.ts:1003-1012` |
| Anchor, Offset, Move/Rotate **bake** into `lines`; Anchor splits lines and changes ids. | `handleConfirmAnchor`, `handleApplyOffset` |
| Path Order re-seeds when `anchorAppliedToken` changes and rebuilds transit + extension lines via `applyCsvOrderToPlanLines`. | `FieldsPage.tsx:1505-1533` |
| Map pins are capped at `LOCAL_CSV_MAX_MAP_PINS = 1000` (sampled). Anchor selection already uses a **ShapeSource of ALL raw points** with `onPress` + 40 px hitbox — no cap, no spatial index needed. | `MapViewNative.tsx:1087-1119, 3318-3342` |
| Staged-mission invalidation = `demoteWorkflowAfterBatchChange` (nulls `stagedMissionId`). No revision counter, so an in-flight Send can still land after an edit. | `App.tsx:1964` |
| `planLocked = missionRunning`. | `App.tsx:1012` |

## 2. Decisions (answers to the PDF's open questions)

**D1 — IDs.** `pointId = ${fileId}:${source_index}` taken from the **per-file** parse, never
from a merged result. Deleted state is `Record<fileId, Set<pointId>>`. Points are immutable.

**D2 — One builder.** New pure `buildCsvFileLines({ parse, deletedIds, prefix, sharedOrigin, … })`
is the *only* code that turns a CSV parse into plan lines. Upload calls it with an empty
deleted set; edits call it with the real set. "Preview == sent" is therefore structural, not
just tested. `handleLocalCsvParsed` is refactored onto it, guarded by a golden test
(empty deleted set ⇒ output identical to the old inline code).

**D3 — Anchor.** The frozen anchor is `parse.anchor` (set once at parse by `robustGpsAnchor`).
Filtering points never touches it, so delete / undo / redo cannot move the origin or the
shared origin. Asserted by test. If the user deletes row 1, the anchor stays where it was.

**D4 — History.** Per-action delta `{ kind: "delete" | "restore", fileId, ids[] }`, undo and
redo stacks, cap 50 (oldest dropped). A new delete clears redo. History is **global across
files** (one stack) and survives adding another CSV. It is pruned (deltas of that file only)
on file removal and fully cleared on Clear plan / new import batch. Exiting edit mode keeps
deletions and keeps Undo/Redo available. **"Restore all"** = one undoable delta. Not persisted
across app restart (plan itself isn't).

**D5 — Interaction with Anchor / Offset / Move.** A rebuild re-derives that file from its
original CSV, so any Anchor / Offset / Move previously baked into *that file's* lines would be
lost. Track a per-file `geometryTouched` flag (set by anchor confirm, offset apply, plan
move/rotate for the files in scope). On the first edit of a touched file show a confirm:
"Editing points redraws this file from the original CSV and resets its Anchor/Offset."
On confirm: rebuild, clear flag, clear `preOffsetSnapshot`, bump Path Order reseed token.

**D6 — Selection.** Tap = nearest point; if several points coincide within 2 cm (stacked
duplicates) they are selected together (they are indistinguishable on the map). Tap toggles.
Plus **range select** ("from this point to that point along the path", by row order, same
file) as the cheap large-file tool. Selection is cleared after delete and after exiting edit
mode; after undo the restored points are selected; stale ids are pruned on every state change.
Mutual exclusion with Anchor mode goes through one mode switch; switching drops the pending
selection.

**D7 — Group / connector rules.**
- Group with < 2 points ⇒ no path (as today); listed in the panel as "points-only", never silent.
- Transit connectors are derived from remaining lines only ⇒ endpoints that vanish never leave
  dangling connectors.
- Deleting a gap into a path may legitimately split it (existing large-jump grouping); the panel
  reports "paths: before → after".
- Whole affected file is rebuilt (never patched).
- CSV paths are open by design; deleting the first or last of a duplicated closing point just
  leaves an open path. Tested.
- All points deleted ⇒ file's lines removed, file stays listed as "0 of N", **Send blocked**
  with an explicit message, Restore all available.

**D8 — Race safety.** `planRevision` counter bumped by every edit (delete / undo / redo /
restore all). Send captures it; if it changed when the upload returns, the result is discarded
and the operator is told. Start refuses when the staged revision ≠ current. Undo/Redo/Delete
are disabled while `planLocked` (running **and** paused).

**D9 — Performance.** One rebuild per action, only for the affected file. Selection set kept in
a ref + a small "selected" ShapeSource so a tap doesn't rebuild the 50k-feature layer. Group
level memo (key = remaining point ids + group context) so unaffected groups aren't re-fitted.
Gate: 50k points rebuild measured in a vitest timing test; if over budget, yield to the UI
thread (`InteractionManager`) with a "Rebuilding…" state.

## 3. Phases

Each phase ends green (`npm test`, `npx tsc --noEmit` for touched files) before the next starts.

### Phase 0 — Safety net
- Golden fixture: a mixed CSV (several groups, one < 2-point group, duplicate row, skipped bad
  row). Snapshot current `localCsvPointsToPlanLines + chain + transit` output.
- Files: `src/utils/csvFileLines.test.ts` (golden section).
- Exit: snapshot recorded against **unmodified** code.

### Phase 1 — Pure logic (no UI)
- `src/utils/csvPointEdit.ts`: `csvPointId`, `pointsRemaining`, edit-state reducer
  (`applyDelete`, `applyUndo`, `applyRedo`, `applyRestoreAll`, `pruneFile`, cap 50), selection
  helpers (`selectNearest` with 2 cm duplicate rule, `selectRange`, `pruneSelection`),
  `groupStats` (points-only groups, path counts).
- `src/utils/csvFileLines.ts`: `buildCsvFileLines` (D2).
- Tests: `csvPointEdit.test.ts`, `csvFileLines.test.ts`:
  - ids stable, skipped rows counted; second file added doesn't alter ids
  - delete → undo → redo restores identical output; order/group membership return
  - **golden equivalence:** edited dataset ≡ CSV physically lacking those rows (same anchor)
  - anchor identical across delete / undo / redo (incl. deleting row 1)
  - 51st action drops oldest; new delete clears redo; restore-all undoable
  - delete a whole group; delete everything; points-only group; closed-loop first/last
  - selection across two files in one action; stale-id pruning
  - 50k-point timing test

### Phase 2 — Wire state into App.tsx (no new UI yet)
- Add `csvParsesByFileId` ref beside `localCsvParsesRef` (keep the array for merge compat).
- Refactor `handleLocalCsvParsed` (GPS + standalone NED branches) onto `buildCsvFileLines`.
- State: `csvEdits` (deleted sets + history), `planRevision` (state + ref), `csvEditMode`,
  `csvSelection`, `geometryTouched`.
- Handlers: `handleCsvDeleteSelected`, `handleCsvUndo`, `handleCsvRedo`, `handleCsvRestoreAll`,
  `rebuildCsvFile(fileId)` → `replacePrefixedLines` (+ unprefixed NED branch) → sweep stale
  transit/extension lines → `demoteWorkflowAfterBatchChange` → bump `planRevision` and
  `anchorAppliedToken` (Path Order reseed) → refresh `localCsvPreview` / pins from remaining
  points.
- Hook every clear/remove path (`handleClearLocalCsv`, `handleBeginLocalImportBatch`,
  `handleRemoveUploadedFile`, the reset at ~3115) to clear/prune edit state.
- Exit: app behaves **identically** with no edits (golden + manual upload check).

### Phase 3 — Map layer
- `MapViewNative`: edit-mode ShapeSource (remaining points, id/file props), second small
  ShapeSource for selected points, optional dim ghost of deleted points; `onCsvEditPointPress`
  returns the pressed feature + tap coordinate. Reuse the anchor-candidates pattern/hitbox.
- Types in `mapViewTypes.ts`; props threaded `App → FieldsPage → renderPlanPreview → MapViewNative`.

### Phase 4 — Panel UI
- `CsvPointEditPanel.tsx` next to `AnchorPanel` in the Path Order footer:
  Edit toggle · Delete (n) · Undo · Redo · Select range · Restore all · "N removed of M" ·
  points-only / path-count notices · "Plan changed — re-Send" notice.
- Disabled states: `planLocked`, empty selection, empty stacks, no CSV.
- Confirm dialog for `geometryTouched` (D5). Blocked-Send message when 0 points remain.

### Phase 5 — Race + gating
- `planRevision` plumbed into `CsvStageAndLoadPanel`: capture at Send, discard stale result,
  Start refuses stale revision. Test with a simulated delayed upload.

### Phase 6 — Hardening
- Group-level memo (D9) if the 50k timing gate fails.
- Full verification matrix (section 4), then on-device smoke test of a 5k+ CSV.

## 4. Verification matrix

Automated (vitest): everything listed under Phase 1, plus golden refactor equivalence, revision
race, stale transit sweep, NED-unprefixed branch, multi-file (delete in A leaves B byte-identical),
Path Order reseed token bump.

Manual on device: upload CSV → Edit → tap a point → Delete → count/path update → Undo → Redo →
Restore all → Anchor then Edit (confirm dialog) → Send → edit during/after Send → Start blocked
until re-Send → 2 CSVs, remove one → other's history intact → 5k–50k point file select/delete
timing.

## 5. Risks

| Risk | Mitigation |
|---|---|
| `App.tsx` is large and already has uncommitted changes from other work. | Minimal, additive diffs; logic lives in new util files; no commits made. |
| Rebuild loses Anchor/Offset for that file. | D5 flag + confirm; documented. |
| Stale transit/extension lines survive a rebuild. | Explicit sweep + test. |
| Fitting 50k points blocks the JS thread. | Timing gate, group memo, yield + spinner. |
| Edit during in-flight Send. | `planRevision` (D8). |
| Rollback | Empty deleted set ⇒ unchanged behavior; feature entry point is a single panel — remove it and the rest is inert. |

## 6. Out of scope (v1)
Box/lasso selection, persistence across restart, editing DXF/template geometry, moving points.

---

## 7. Implementation status (updated after build)

| Phase | Status | Where |
|---|---|---|
| 0 Golden safety net | Done — upload now runs through the shared builder and is asserted identical to the old inline pipeline | `csvFileLines.test.ts` |
| 1 Pure logic | Done — 49 tests | `csvPointEdit.ts`, `csvFileLines.ts`, `csvPointEditStatus.ts` (+ tests) |
| 2 App wiring | Done | `App.tsx`, `src/hooks/useCsvPointEdit.ts` |
| 3 Map layer | Done, **not yet verified on a device** | `MapViewNative.tsx`, `PlanPreview.tsx`, `mapViewTypes.ts` |
| 4 Panel UI | Done, **not yet verified on a device** | `CsvPointEditPanel.tsx`, `FieldsPage.tsx` |
| 5 Race + gating | Done (revision stamp, empty-plan block, planLocked) | `CsvStageAndLoadPanel.tsx` |
| 6 Hardening | Partly: fit memo done; large single-group cost remains (below) | `localPointCsv.ts` `RoadMarkingFitCache` |

### Deviations from the plan above
- **Path Order**: order and skip flags are kept on a normal edit; they are reset only when a file's
  *path count* changes (line ids get renumbered, so old flags would land on the wrong paths).
  Added `resetToken` to `CsvPathOrderStep` for this.
- **Stale connectors**: Path Order only re-emits transit/extension lines when its order changes, so
  `FieldsPage` rebuilds them itself after every edit (keyed on `planRevision`).
- **Rebuild is synchronous** (after painting an "Updating path…" state), not deferred. A deferred
  rebuild would leave stale `lines` visible to Anchor/Offset/Send for a moment; synchronous cannot.

### Measured performance (dev machine; a tablet will be slower)
The road-marking fit is the cost and it is super-linear in points *per group*:
10 groups × 500 pts ≈ 2.6 s · 1 group × 2,000 pts ≈ 4.3 s · 1 group × 5,000 pts ≈ 21 s.
Upload already pays this. Edits now refit only the group that changed (fit memo, tested), so
multi-group files edit quickly; **a single very large group still refits in full on each edit**.
Range-select + one Delete keeps that to one refit per cleanup. A faster fitter would be the next step.

### Still to verify on a device
Tap hit-testing vs line selection, 5k–50k point selection feel, Anchor→Edit confirm dialog,
two-CSV batch with one file removed, Send raced against an edit.
