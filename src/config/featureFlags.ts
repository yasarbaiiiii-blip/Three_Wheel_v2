/**
 * Build-time feature flags for the Mapbox migration.
 *
 * These are plain module constants (not runtime state) so flipping one is a
 * deliberate, rebuild-required change — which keeps React hook ordering stable
 * even where a flag guards an early return.
 */

/**
 * Phase 1 rollout switch for the map renderer.
 *
 *   false (DEFAULT) → legacy Leaflet WebView  (MapViewLeaflet)
 *   true            → native @rnmapbox/maps    (MapViewNative)
 *
 * ── ENABLE the native map for on-device testing ──
 *   1. Set this to `true`
 *   2. Rebuild: `cd android && ./gradlew assembleRelease`  (or run a dev client)
 *
 * ── ROLL BACK to the legacy map (instant) ──
 *   1. Set this back to `false`
 *   2. Rebuild
 *
 * No other code changes are needed — both implementations satisfy the same
 * `MapViewProps`, and `src/components/MapView.tsx` dispatches between them.
 * Keep this `false` on `main` until native parity is verified on device.
 */
export const USE_NATIVE_MAPBOX = true;

/**
 * TEMPORARY (Phase 0.1): when `true`, the app renders only `<MapboxHelloMap />`
 * full-screen for an on-device basemap smoke test. Leave `false` in normal use;
 * remove this flag and its mount once the smoke test is confirmed.
 */
export const SMOKE_TEST_MAPBOX = false;

/** Real field coordinate for the smoke test, [longitude, latitude]. */
export const SMOKE_TEST_CENTER: [number, number] = [77.5946, 12.9716]; // Bangalore

/**
 * CSV mission planner routing (CSV_APP_PLANNED_TRAJECTORY_PLAN Phase 8).
 *
 * - `"rover"` (DEFAULT until plan-trajectory is bench-signed): today's flow —
 *   survey CSV upload → plan-and-stage with optimize:true.
 * - `"app"`: offline geometry via buildTrajectory → POST /api/path/plan-trajectory
 *   → verify run_echo before Load.
 *
 * Flip to `"app"` only after backend asks 1–4 and Phase 7 differential check.
 * `"rover"` restores the file path with no other code changes.
 */
export type CsvPlannerMode = "app" | "rover";
/**
 * App-planned path required for CSV PRE/AFT extensions (explicit travel runs).
 * Flip back to `"rover"` only if plan-trajectory is unavailable.
 */
export const CSV_PLANNER: CsvPlannerMode = "app";

/**
 * DXF mission planner routing (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 5 / 8).
 *
 * - `"rover"`: today's parse-dxf → entities → align → plan-and-stage flow.
 * - `"app"`: offline parseLocalDxf → local align → plan-trajectory → verify.
 *
 * Flip to `"app"` only after Phase 7 differential bench. `"rover"` restores
 * the file path with no other code changes.
 */
export type DxfPlannerMode = "app" | "rover";
/**
 * App-planned DXF: parseLocalDxf on device, no POST /parse-dxf.
 * Flip to `"rover"` only to restore the legacy upload → entities flow.
 */
export const DXF_PLANNER: DxfPlannerMode = "app";

/**
 * Path primitives V2 rollout (PATH_PRIMITIVES_EXECUTION_PLAN).
 *
 * - `"off"`: legacy greedy segment + 1° must-hit
 * - `"must_hit"`: Track A only (error-budget must-hit)
 * - `"segment"`: Track A + top-down segment + refuse
 * - `"full"`: + corner primitive + sharp handling
 */
export type PathPrimitivesV2Mode = "off" | "must_hit" | "segment" | "full";
export const PATH_PRIMITIVES_V2: PathPrimitivesV2Mode = "full";

/** True when top-down segmentation (Track B) is active. */
export function pathPrimitivesV2TopDownSegment(): boolean {
  return PATH_PRIMITIVES_V2 === "segment" || PATH_PRIMITIVES_V2 === "full";
}
