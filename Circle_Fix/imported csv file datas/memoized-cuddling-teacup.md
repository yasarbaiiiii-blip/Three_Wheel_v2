# Road Marking: a second, parallel workflow on the Fields page

## Context

The Fields page today is a single linear workflow ("Field Marking"): Upload → Bounding Box → Align DXF → Path Order & Spray/Load, all driven by `useFieldsWorkflow`'s `activeStep` (`FieldsStepId`) and rendered as a 4-card accordion in `FieldsPage.tsx`'s right-hand panel. It's built entirely around DXF/CAD-style plan geometry (entities with `entity_id`s registered server-side, least-squares/visual alignment of a whole rigid plan, etc.).

The user wants a **second workflow, "Road Marking,"** selectable alongside Field Marking, for a materially different authoring flow: upload a CSV of GPS reference points → see them on the map → **Draw** straight lines connecting them in order → **Bend** those lines into curves with a pen-tool-style drag → **Confirm** to finalize the curve geometry → a lightweight **Alignment** review (the path is already GPS-true, since every point came from real lat/lon) → then the same Path Order / Spray / Load / Start Mission tail the existing flow already has, with real-time meter distances visible throughout.

Research (two parallel `Explore` passes + spot-verification of the highest-risk claims) found that most of the *pieces* already exist in the codebase — CSV→GPS-point parsing, the map's line-rendering chokepoint, length-label rendering, coordinate-transform primitives — but the specific "connect with lines, then bend into curves" interaction is genuinely new, and two of the "reuse as-is" assumptions from the initial ask turned out to be more nuanced once verified (see Corrections in §5 and §6). This plan is scoped to build Road Marking as an **additive, independent** workflow that reuses those existing seams without touching Field Marking's behavior.

### Decisions already made with the user
- **Bend interaction**: one draggable handle per straight segment (at its midpoint); dragging it bends that segment into a single quadratic Bézier curve. (Not a full per-anchor two-handle pen tool — simpler and more touch-robust, per user's choice.)
- **Alignment step**: lightweight "Review & Confirm" only — no drag-to-fit UI. The CSV's GPS coordinates already make the path GPS-true, so this step just shows the anchor and confirms.
- **Workflow chooser**: a persistent segmented-control toggle pinned above the step accordion in the right panel, switchable anytime, with each workflow's progress preserved independently.

---

## 1. Types & state

**`Three_Wheel_v2/src/types/fieldsWorkflow.ts`** — additive, don't touch `FieldsStepId`:
```ts
export type FieldsWorkflowKind = "fieldMarking" | "roadMarking";
export type RoadMarkingStepId = "upload" | "path" | "align" | "orderAndSpray";
export type RoadMarkingPathPhase = "empty" | "drawn" | "bending" | "confirmed";
```

**`activeWorkflow` state lives locally in `FieldsPage.tsx`**, the same tier as today's `activeStep`/`refPoints`/`alignmentMethod` (lines ~246-267) — not lifted to `App.tsx`, since it's purely "which step-set is visible," unlike `stagedWorkflow`/`stagedMissionId` which model the one resident backend mission and stay shared regardless of authoring workflow.

**New hook, `Three_Wheel_v2/src/hooks/useRoadMarkingWorkflow.ts`**, mirroring `useFieldsWorkflow.ts`, instantiated unconditionally alongside it in `FieldsPage.tsx` (hooks can't be conditional). This is what makes switching the toggle non-destructive: `FieldsStepCard` unmounts a collapsed card's body (`FieldsStepCard.tsx:125-149`), so — exactly like Field Marking already does for `refPoints`/`alignmentMethod` — all Road Marking WIP state must live in this hook, not inside the step-panel components themselves.

```ts
export type RoadMarkingPoint = { id: string; north: number; east: number; lat: number; lon: number; dwellS: number; mark: boolean };
export type RoadMarkingSegment = { id: string; fromId: string; toId: string; controlPoint: { north: number; east: number } | null };

export function useRoadMarkingWorkflow() {
  const [activeStep, setActiveStep] = useState<RoadMarkingStepId>("upload");
  const [anchor, setAnchor] = useState<{ lat: number; lon: number } | null>(null);
  const [points, setPoints] = useState<RoadMarkingPoint[]>([]);
  const [segments, setSegments] = useState<RoadMarkingSegment[]>([]);
  const [pathPhase, setPathPhase] = useState<RoadMarkingPathPhase>("empty");
  const [isAlignmentConfirmed, setIsAlignmentConfirmed] = useState(false);
  // ...setters + derived confirmedLines (see §4)
}
```

## 2. Workflow toggle component

**New file: `Three_Wheel_v2/src/components/fields/WorkflowToggle.tsx`** — a two-segment pill row (no existing segmented-control component to reuse anywhere in `src/`, confirmed by search), styled with `FIELDS_COLORS` (`fieldsTheme.ts`) following `FieldsStepCard`'s existing active/inactive color convention.

```ts
type WorkflowToggleProps = {
  value: FieldsWorkflowKind;
  onChange: (next: FieldsWorkflowKind) => void;
  disabled?: boolean; // e.g. while a mission is resident/protected
};
```

Placed in `FieldsPage.tsx`'s side panel (the `View` at lines 808-828), as a new child directly after `<FieldsClearBar/>` (line 829) and before the step-accordion container — pinned above both accordions. Switching it only flips which step-card set renders; it never resets either hook's state.

## 3. Road Marking step cards

Draw / Bend / Confirm are **sub-states of one step card ("Path")**, not three separate cards — they're a tight single-screen loop over the same map geometry (the Bend UI needs to stay visible while dragging, which the one-card-expanded-at-a-time accordion would disrupt if split up). This mirrors how `UploadAndPreviewStep.tsx` already inlines multiple sub-actions in one card body.

| # | Title | Component | Notes |
|---|---|---|---|
| 1 | Upload | `UploadAndPreviewStep.tsx` (extended) | Reuse as-is; thread a new `onRoadMarkingCsvParsed` callback alongside the existing `onGpsPointMissionParsed`, so `FieldsPage` picks which one to pass based on `activeWorkflow`. Its GPS-CSV branch (`detectPointCsvKind` → `pathApi.parsePointGpsCsv`) already returns exactly what's needed (`anchor`, NE-meter `point_mission_points`). |
| 2 | Path (Draw/Bend/Confirm) | `RoadMarkingPathStep.tsx` (new) | Sub-state machine driven by `RoadMarkingPathPhase`; renders Draw / Bend / Confirm buttons depending on phase |
| 3 | Alignment (Review & Confirm) | `RoadMarkingAlignStep.tsx` (new) | No backend call — see §7 |
| 4 | Path Order & Load | `PathOrderAndSprayStep.tsx` (reuse, conditional) | See §6 Correction — needs a Phase 5 backend-compatibility spike |

Use `pathApi.parsePointGpsCsv` (the backend round-trip), not the client-only `refPointsCsv.ts` parser — the backend response already carries NE-meters in the same local frame `PlanLine.from.x/from.y` uses everywhere else, and registers a `pathName` needed later for staging.

## 4. Data model: points → segments → PlanLine[]

Before Confirm, the path is a lightweight WIP model, not `PlanLine[]`:
```ts
// Draw: one segment per consecutive point pair, straight (controlPoint = null)
segments = points.slice(0, -1).map((p, i) => ({
  id: `seg-${i}`, fromId: p.id, toId: points[i + 1].id, controlPoint: null,
}));
// Bend: dragging a segment's handle sets only that segment's controlPoint
```

On **Confirm**, tessellate every segment into a real `PlanLine`, matching the exact shape the rest of the app expects (`DxfEntity` fields are all non-optional — `types/plan.ts:36-52` — so every field must be populated):
```ts
{
  id: `road-seg-${i}`, label: `Segment ${i+1}`, layer: "marking",
  from: { id: i*2+1, x: seg.from.north, y: seg.from.east },
  to:   { id: i*2+2, x: seg.to.north,   y: seg.to.east },
  width: 0.1,
  entity: {
    entity_id: `road-seg-${i}`, entity_type: "line", layer: "marking", color: 1,
    is_mark: true, length_m: <arc length>, geometry: null,
    preview_points: <tessellated points>,
  },
}
```
`entity_type: "line"` must stay one of `PRIMARY_ENTITY_TYPES` (`pathWorkflow.ts:19`) or `PathOrderAndSprayStep`'s list-building filter (`isPrimaryEditableLine`) silently drops it.

## 5. New quadratic-Bézier module

**New file: `Three_Wheel_v2/src/utils/roadMarkingCurves.ts`** — kept separate from `curveGeometry.ts` (that file is scoped to circular ARC/CIRCLE math with its own adaptive-step machinery; Bézier is a different curve family, and this avoids bloating an already-load-bearing 525-line file).

```ts
export type BezierPoint = { north: number; east: number };
export function sampleQuadraticBezier(p0: BezierPoint, control: BezierPoint, p1: BezierPoint, steps?: number): DxfPoint[];
export function approximateBezierLengthM(p0: BezierPoint, control: BezierPoint, p1: BezierPoint, steps?: number): number;
export function defaultMidpointControl(p0: BezierPoint, p1: BezierPoint): BezierPoint;
```
`steps = 24` default is plenty for typical waypoint-spaced segments without per-frame drag cost; revisit only if Confirm shows visible faceting on unusually long bent segments.

**Why this needs zero changes to the map-rendering pipeline**: `getPlanLineRenderPoints` (`curveGeometry.ts:422-449`) already prefers `entity.preview_points` (when length ≥ 2) over the straight `from/to` fallback, with no `entity_type` check gating that preference — so populating `preview_points = sampleQuadraticBezier(...)` on Confirm is sufficient for correct map rendering with **no `MapViewNative.tsx`/`curveGeometry.ts` edits**. Likewise `getLineLengthM` (`pathWorkflow.ts:142-154`) prefers `entity.length_m` before falling back to Euclidean `from`/`to` distance — so `entity.length_m` must be set to `approximateBezierLengthM(...)` on Confirm, or length labels will silently report the straight chord distance instead of the true bent length (no type error, easy to miss).

Before Confirm, real-time meters during Draw/Bend are computed directly from the WIP `RoadMarkingSegment[]`/`RoadMarkingPoint[]` (straight: `Math.hypot`; bent: `approximateBezierLengthM`) in a dedicated map-side builder (§6) — independent of the `PlanLine` pipeline, recomputed only for the actively-dragged segment per frame, not all segments.

## 6. `MapViewNative.tsx` changes

**Verified correction to the original assumption**: the existing OBB resize/rotate handle system (`ShapeSource id="plan-resize-handles"`, `buildHandlesFC`) is **not a generic per-line-handle facility** — confirmed by reading the code: `buildHandlesFC`/`buildRotateHandlesFC` both hard-filter `for (const item of items) { if (item.id !== "plan-editing-group") continue; ... }` (`MapViewNative.tsx:1367,1421,1452`), and the whole gesture stack is gated by `hasEditableSelection` (line 1200), itself driven by `mode === "templates" && selectedItemIds?.length > 0` — this system moves/scales/rotates one whole-plan rigid transform, with no notion of "one handle per line segment." **This is good news for risk**: Road Marking's per-segment bend handles need a wholly new, additive pipeline, which means they're never wired into `placedItems`/`hasEditableSelection` at all — Field Marking's existing drag/rotate/resize is untouched by construction, not just by careful gating.

**New props — `Three_Wheel_v2/src/components/mapViewTypes.ts`** (additive):
```ts
roadMarkingSegments?: Array<{ id: string; from: DxfPoint; to: DxfPoint; controlPoint: DxfPoint | null }>;
roadMarkingBendModeActive?: boolean;
onRoadBendHandleDragBegin?: (segmentId: string) => void;
onRoadBendHandleDragMove?: (segmentId: string, control: DxfPoint) => void;   // RAF-coalesced preview
onRoadBendHandleDragCommit?: (segmentId: string, control: DxfPoint) => void;
```

**New, independent `ShapeSource`s** (placed near the existing `plan-length-labels`/`plan-resize-handles` block, ~line 2565-2601, but sourced from `roadMarkingSegments`, not `placedItems`):
- `road-bend-handles` + `CircleLayer` — one feature per segment simultaneously, via new `buildRoadBendHandlesFC(segments)`, styled distinctly from `plan-resize-handles`.
- `road-length-labels` + `SymbolLayer` — mirrors `plan-length-labels` styling, via new `buildRoadLengthLabelsFC(segments)`, always populated whenever segments exist (straight or bent) — this is what satisfies "meters visible throughout."

**The path itself needs no new `ShapeSource`**: feed WIP-tessellated `PlanLine[]` into the same `lines` prop `MapViewNative` already renders via `ShapeSource id="plan-lines"` — this part of the original reuse assumption holds exactly as expected.

**Gesture wiring — extend the existing single-recognizer switch, don't add a second `GestureDetector`.** `composedGesture` (`MapViewNative.tsx:2063-2078`) already special-cases `manualDrawingEnabled` by short-circuiting to a disabled pan (line 2065-2067). Add a parallel, higher-priority branch:
```ts
if (roadMarkingBendModeActive) return roadBendGesture;
if (manualDrawingEnabled) return Gesture.Pan().enabled(false);
/* ...existing OBB gesture logic... */
```
This guarantees exactly one gesture recognizer is ever live, eliminating an entire class of "two recognizers competing for the same pan" bug. **This is the single highest-risk integration point** — flag explicitly for manual regression testing of Field Marking's drag/rotate/resize once this lands.

Hit-testing reuses the *pattern*, not the code: `findNearestHandle(cursor, handles, radiusM)` (`planResizeHandles.ts:404-419`) is generic (`WorldPoint` in/out, no OBB assumption) and works unmodified for nearest-segment-handle lookup.

*Out of scope, flagged not silently skipped*: `App.tsx`'s non-Mapbox SVG fallback render path (`react-native-svg`, used when `mapViewEnabled` is false) won't get bend handles/live meters in this plan — only the live Mapbox path is covered.

## 7. Alignment step (lightweight)

**`RoadMarkingAlignStep.tsx` makes no backend call.** This exact pattern already exists for the current GPS-point flow: `handleGpsPointMissionParsed` (`App.tsx:~2794-2818`) treats a CSV's anchor as sufficient alignment with zero `/align` round-trip — `setVerifiedAlignmentRequest({ origin_gps: [anchor.lat, anchor.lon], rotation_deg: 0 })`, using the `origin_gps` field `pathApi.AlignPathRequest` already supports (`pathApi.ts:94-99`). Road Marking's Alignment step:
- Displays `anchor.lat`/`anchor.lon` (carried in `useRoadMarkingWorkflow` state since Upload).
- "Confirm" calls the same `setVerifiedAlignmentRequest` setter already threaded through `FieldsPageProps`, then `onWorkflowStep?.("alignment", "verified")`.
- No `pathApi.alignPath` call — that endpoint is DXF-ref-points-specific (`AlignDxfPanel.tsx:367`), correctly out of scope here.

## 8. Connecting points → lines

**New file: `Three_Wheel_v2/src/utils/roadMarkingHydration.ts`** (kept separate from `stagedMissionHydration.ts`, which hydrates an already-*staged backend mission* back into `PlanLine[]` — a different lifecycle/caller than this pre-Confirm client-side edit model):
```ts
export function roadPointsToPlanLines(points: RoadMarkingPoint[], segments: RoadMarkingSegment[]): PlanLine[]
```
Verified this is purely additive: `pointMissionPointsToPlanLines` (`stagedMissionHydration.ts:105-117`, deliberately zero-length lines, comment explains why) has exactly 2 call sites, both in `App.tsx`, both serving the existing `isGpsPointFlow` single-marker preview — left untouched.

## 9. Phased build order

1. **Scaffolding** — types, `useRoadMarkingWorkflow`, `WorkflowToggle`, branch `FieldsPage.tsx`'s step-card list on `activeWorkflow` with placeholder Road Marking cards. Verify: toggle switches cleanly, Field Marking is a zero-diff regression.
2. **Upload + Draw (straight) + real-time meters** — thread `onRoadMarkingCsvParsed`, `roadPointsToPlanLines` (straight-only), `road-length-labels` `ShapeSource` (no handles yet), Draw button (`empty → drawn`). Verify: CSV → dots → Draw → straight connected lines + correct per-segment meters, no gesture-code touched yet.
3. **Bend + Bézier + live meters** (highest risk) — `roadMarkingCurves.ts`, `road-bend-handles`, `roadBendGesture`, the `composedGesture` branch insertion. Requires an explicit manual regression pass on Field Marking's Move/Rotate/Resize afterward, since this phase is the one that touches the shared gesture switch.
4. **Confirm + Alignment review** — bake `preview_points`/`length_m` via the Bézier sampler, transition WIP → final `PlanLine[]`, build `RoadMarkingAlignStep`. Verify: Confirm locks curves in, map renders identically via unmodified `getPlanLineRenderPoints`, Alignment shows the right anchor with no network call.
5. **Path Order / Spray / Load wiring** — see Correction below; resolve with a backend spike before wiring the final step.

## 10. Open risk requiring a Phase-5 spike (verified, not assumed)

`PathOrderAndSprayStep`'s load handler (`pathApi.loadToController`, `pathApi.ts:332-426`) calls `saveEntityOrder`/`saveEntityOverrides` (confirmed at `pathApi.ts:201`, `193`) — both `POST /api/path/{pathName}/entities/...`, keyed by `entity_id` strings the backend must already recognize as registered against that `pathName` (how DXF parsing registers entities server-side). Road Marking's segments have **client-invented** `entity_id`s (`road-seg-0`, …), and the CSV was parsed via `parsePointGpsCsv`, which has no `entity_id` concept at all.

Strong existing-code evidence this doesn't work for point-sourced paths today: `isGpsPointFlow` (`FieldsPage.tsx:490`) **deliberately skips** Path Order & Spray entirely (guards confirmed at `FieldsPage.tsx:948,1000`) and replaces both with one "Load to Controller" button (`FieldsPage.tsx:1048-1091`) whose handler calls `pathApi.planAndStage` **directly** with `point_source_frame: "GPS_SURVEYED"` + `point_mission_points`, bypassing the entity-order/override endpoints completely. If those endpoints already worked against point-CSV paths, this bypass wouldn't need to exist.

**Spike first, then pick a fallback if needed** (both frontend-only):
- (A) Add a `pointMissionSubmit` mode to `PathOrderAndSprayStep`'s load handler that, when present, calls `pathApi.planAndStage` directly (mirroring the existing `handleStageAndLoadGpsPointMission`, `App.tsx:~2826-2893`) instead of `pathApi.loadToController` — while still reusing the same presentational `PathOrderUnifiedList` for drag-reorder/spray-toggle UI (it only needs `PathOrderRow[]`, no entity_id-backend dependency of its own).
- (B) A dedicated `RoadMarkingOrderAndSprayStep.tsx` if branching inside the existing component gets messy.

## 11. Other risks / edge cases

- **1-2 point CSVs**: 1 point → 0 segments, Draw/Bend must no-op gracefully. 2 points → exactly 1 segment/handle — must still work.
- **Large point counts**: N-1 simultaneous handles + labels could get visually crowded for large CSVs. Consider reusing `buildPlanLengthLabels`'s existing `maxLabels` cap pattern (default 80) as a starting point; not a blocker for initial build.
- **`isGpsPointFlow`'s fate**: Road Marking is a strict superset of what the current GPS-point single-button flow does. Recommend **coexistence** for the initial ship (lower risk, zero behavior change for the existing flow) — plain upload of a `lat,lon` CSV outside the new toggle keeps today's single-button behavior; Road Marking is reached only via the new top toggle with its own upload entry point. Treat fully replacing/retiring the old fork as a separate follow-up decision, not part of this plan.

---

## Critical files
- New: `src/hooks/useRoadMarkingWorkflow.ts`, `src/components/fields/WorkflowToggle.tsx`, `src/components/fields/panels/RoadMarkingPathStep.tsx`, `src/components/fields/panels/RoadMarkingAlignStep.tsx`, `src/utils/roadMarkingCurves.ts`, `src/utils/roadMarkingHydration.ts`
- Edit: `src/screens/FieldsPage.tsx`, `src/components/MapViewNative.tsx`, `src/components/mapViewTypes.ts`, `src/types/fieldsWorkflow.ts`, `src/components/fields/panels/UploadAndPreviewStep.tsx`, `src/components/fields/panels/PathOrderAndSprayStep.tsx` (Phase 5, pending spike outcome)
- Reference only (do not modify): `src/utils/curveGeometry.ts`, `src/utils/planResizeHandles.ts`, `src/utils/pathWorkflow.ts`, `src/utils/stagedMissionHydration.ts`, `src/api/pathApi.ts`, `App.tsx`

## Verification
- After each phase, manually regression-test Field Marking end-to-end (Upload → Bounding Box → Align DXF → Path Order/Spray/Load) — the toggle and new hook must be zero-diff for the existing flow.
- Phase 3 specifically needs a manual pass on Field Marking's Move/Rotate Plan and Multi-Point Fit resize handles, since it's the one phase touching the shared `composedGesture` switch.
- End-to-end Road Marking walkthrough on device/simulator (via the project's `/run` skill or `npx expo start`, since gesture feel isn't verifiable by unit tests alone): upload GPS CSV → points appear → Draw → straight lines + live meters → Bend → drag a segment handle → curve appears + label updates live → Confirm → curves lock in → Alignment shows correct anchor → Path Order/Spray → Load → confirm mission stages/loads on a real or simulated backend → Start Mission.
- Before Phase 5, run the backend spike (attempt `saveEntityOrder`/`saveEntityOverrides` against a `pathName` sourced from `parsePointGpsCsv`) to settle which of fallback (A)/(B) is needed, rather than discovering it mid-implementation.
