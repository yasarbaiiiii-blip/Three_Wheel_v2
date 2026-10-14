# Performance robustness bench

How to measure whether telemetry still re-renders the map or pages. The counters live in
`src/utils/perfCounters.ts` and do nothing unless both conditions hold:

- a development build (`__DEV__`), and
- Metro started with `EXPO_PUBLIC_PERF_COUNTERS=1`, for example
  `EXPO_PUBLIC_PERF_COUNTERS=1 npx expo start --dev-client`.

Every 5 s the app logs one line such as
`[perf] 5.0s MapViewNative.render=0 (0.0/s) RoverLayer.render=50 (10.0/s) ...`.

## Counters

| Counter | Counts |
|---|---|
| `MapViewNative.render` | Full map body renders (every plan ShapeSource re-serializes its GeoJSON) |
| `RoverLayer.render` | Rover icon / range / target renders |
| `SharedMapHost.render` | Shared map host renders |
| `sharedMap.publish` / `sharedMap.notify` | Screen publishes into the shared map / publishes that reached the map |
| `HomeView.render`, `ModernHomeUI.render` | Home renders |
| `SectionPages.render`, `FieldsPage.render`, `TemplatesPage.render` | Page renders |
| `CsvPathOrderStep.render`, `CsvStageAndLoadPanel.render` | Path Order / Stage panel renders |
| `trajectory.build` | `buildOrderedTrajectory` runs from the Fields panels |
| `fitCache.hit` / `fitCache.miss` | Road-marking fit cache lookups |
| `PlanLayer.<group>.render` | Memoized plan layer group renders |

## Procedure

1. Record: commit, device model and Android version, build type, telemetry rate, and the plan
   file (name, size, lines/entities/points).
2. Load the plan, connect the rover, wait 10 s, then log 60 s with nothing touched.
3. Repeat on Home, Fields (Path Order open) and Templates.
4. Soak: leave Home connected for 30 minutes; navigation and Fields sections must still
   respond immediately.

## Acceptance targets (telemetry-only, nothing touched)

| Counter | Target |
|---|---|
| `MapViewNative.render` | 0/s |
| `PlanLayer.*.render` | 0/s |
| `sharedMap.notify` | 0/s |
| `RoverLayer.render` | Only when position, heading, mission state or segment changes |
| `SectionPages.render`, `FieldsPage.render`, `TemplatesPage.render` | 0/s while the rover is parked |
| `trajectory.build` | 0/s; 1 per order or plan change |

## Results

| Date | Commit | Device | Plan | Screen | MapViewNative/s | RoverLayer/s | sharedMap.notify/s | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
