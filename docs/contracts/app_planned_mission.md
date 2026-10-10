# Contract: app-planned mission upload, v2 (`POST /api/missions/plan`)

**Version:** 2.0 (supersedes `app_planned_mission_v1.md`, which is removed).
**Producer:** the operator tablet app (`Three_Wheel_v2`).
**Consumer:** the rover backend (`dyx3_backend.mission.app_plan`).
**Backend contract (authoritative for the wire format):** `docs/contracts/app_planned_mission.md` in the DYX_3WD repository.

## 1. Division of responsibility

| Layer | Owns |
|---|---|
| Tablet | Parsing the file, the trajectory geometry, order, run split (mark / travel), must-hit flags, dashes, and the geodetic anchor. It is the single geometry author. |
| Backend | Admission only: validation, a lossless 5 m densify and a 10 mm boundary snap. It never re-plans. |
| Rover | Places the trajectory with the anchor; its controller (RPP) owns corner policy. |

The app therefore sends raw vertices with spray and must-hit flags. It does **not** fillet sharp corners, insert pivot legs or teardrop loops, and has no point / stake-out mode (no dwell, no arrival tolerance).

Scope: straight-line tracking and curve drawing.

## 2. Request

`POST /api/missions/plan`, header `Authorization: Bearer <operator token>`, sent through the authenticated production client (`src/api/prodClient.ts`). Built by the one builder `src/utils/appPlannedMissionBuilder.ts`.

```json
{"client": "Three_Wheel_v2", "client_version": "2.0.0", "name": "Pitch_A",
 "frame": "local_ned", "anchor": {"lat": 48.137154, "lon": 11.576124},
 "runs": [{"type": "travel", "points": [[0.0, 0.0, 2], [12.0, 0.0, 2]]},
          {"type": "mark",   "points": [[12.0, 0.0, 3], [14.0, 0.0, 1], [16.0, 0.0, 3]]}]}
```

- `frame` is always `local_ned`. `origin_ne_m` is **absent**: the anchor is the origin.
- `anchor` is the WGS84 position of the trajectory's local origin (degrees, finite, `|lat| <= 90`, `|lon| <= 180`). The app sends no `alt`.
- Points are **true ground metres north / east of the anchor** in a WGS84 local tangent plane. The rover converts them on the ellipsoid, so the app uses the same maths: every lat/lon to metre conversion goes through `src/utils/geoProjection.ts` (exact ENU through ECEF on the WGS84 ellipsoid; inverse = plane point at u = 0 to ECEF to geodetic, as the rover places it; error below 0.1 mm over 1 km against the Vincenty geodesic).
- `flags`: bit0 = spray, bit1 = must-hit.
- Coordinates are within +-10,000 m. At most 50,000 points are submitted; at most 200,000 are stored.

**No GPS origin: the app refuses** with a clear operator error (`ANCHOR_REQUIRED`). EKF-local (`ekf_local_ned`) is never sent by the operator flow.

## 3. Run rules (enforced by the builder and again by `validateAppPlannedMissionRequest`)

1. **R1** every point of a mark run has bit0 set; every point of a travel run has it clear.
2. **R2** runs alternate. The builder merges neighbouring runs of the same type.
3. **R3** each run starts exactly where the previous one ended. A gap of up to 10 mm is snapped by the app; a larger gap is bridged with an explicit travel run.
4. **R4** the shared boundary point is must-hit when either copy is (run endpoints always are).
5. No step above 5 m: the app densifies to 5 m itself with equal collinear sub-steps (no must-hit on inserted points), so the payload is exactly what is stored.

## 4. Must-hit rules

A point carries bit1 when it is a run endpoint, a vertex whose turn exceeds 25 degrees, or one of the fewest interior points that keep the retained polyline within 15 mm of every skipped sample (Douglas-Peucker). Collinear fill is never declared. Travel runs declare only their endpoints. A sharp corner is a plain vertex with must-hit set.

## 5. Dashes

A dashed line is expressed in the app as alternating mark / travel runs: each mark run restarts with a dash (ON length, OFF length, both 0.05 to 100 m), cut at exact positions along the polyline. The pattern is set in Settings, applied at Send and frozen in the Start snapshot.

## 6. Response and verification

`201 {ok, mission: {sha256, engine_id, num_points, num_spray_points, mark_length_m, transit_length_m, bbox_ne_m, source}, normalisation: {densified_steps, max_boundary_snap_m}}`.

The app computes the expected stored mission from its own payload (R4 merge) and blocks Load unless:

- `mission.sha256` is a 64-hex id;
- `normalisation` is `0` and `0.0` (the app already densified and snapped);
- `num_points`, `num_spray_points`, `mark_length_m`, `transit_length_m` and `bbox_ne_m` equal the payload's;
- at Send, `GET /api/missions/{sha}/path` returns the same frame, anchor, points and flags.

There is no fabricated run echo.

## 7. Errors

`{ok:false, code, reason}`. The app maps every code to an operator message (`src/utils/appPlannedMissionErrors.ts`): `INVALID_PAYLOAD` (400); 422 `INVALID_FRAME`, `ANCHOR_REQUIRED`, `INVALID_ANCHOR`, `ORIGIN_WITH_ANCHOR`, `INVALID_RUN_TYPE`, `INVALID_FLAGS`, `NON_FINITE_COORDINATE`, `OUT_OF_BOUNDS`, `EMPTY_MISSION`, `RUN_TOO_SHORT`, `POINTS_LIMIT_EXCEEDED`, `mixed_spray_in_run`, `adjacent_runs_same_type`, `runs_not_contiguous`; plus `too_large` (413), `ARTIFACT_FAILED`, 401 / 403 and transport failures.

App-side pre-send checks use the same codes, plus `STEP_NOT_DENSIFIED` and `INVALID_DASH` (app bugs / bad settings, never sent).

## 8. Types

`src/contract/prod/missionPlan.ts`.
