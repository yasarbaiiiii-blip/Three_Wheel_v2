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

- **Status:** FIELD-REPORTED; no code change
- **Reason:** the referenced `1_Aug` source and `.dyx3path` artifacts are not present. Flattened flags such as `2 2 3 3 3` are insufficient to distinguish an unpainted entry run from a mark-run error.
- **Needed:** original source, full artifact with coordinates/run boundaries, recorded rover pose, and extension configuration.

## APP-15 — two plan POSTs / socket reconnects

- **Status:** FIELD-REPORTED; no code change
- **Reason:** current Start intentionally permits one second plan upload when rover pose moves more than 1.0 m during the first upload. Socket.IO also reconnects a singleton socket automatically.
- **Needed:** correlate request IDs, `driftRetry`, hashes, timestamps, poses, and socket-object creation separately from reconnect events.

## APP-03 — Fields/import freeze

- **Status:** FIELD-REPORTED; no speculative performance change
- **Needed:** release-tablet phase timings and heartbeat/socket timeline using the retained field file.

## APP-02 — rover-ahead warning

- **Status:** NOT IMPLEMENTED
- **Reason:** along-track and lateral tolerances require product/field agreement. Staging values from `9f45812` were not changed.
