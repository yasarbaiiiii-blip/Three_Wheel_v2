# Contract — App-Planned Mission Ingest (`POST /api/missions/plan`)

**Status:** Frozen specification for GAP-04.  
**Version:** `1.0.0` (v:1).  
**Consumer:** Rover Backend (`DYX_3WD`, `dyx3_backend.mission`).  
**Producer:** Operator Client App (`Three_Wheel_v2`).  
**Authority:** The operator app is the sole authority for path shape, order, extensions, collinearity, and must-hit points. The rover backend validates and stores into content-addressed `DYX3PATH 1` artifacts; it **never** re-plans.

---

## 1. Overview & Context

In the DYX 3WD architecture, road marking requires sub-centimeter geometric precision, directional painting rules, pre/post paint extensions, lead-in/lead-out runs, and operator-defined stroke sequencing. 

The existing `POST /api/missions` endpoint accepts raw CAD DXF/CSV files and executes server-side path planning via `dyx3_backend.path_engine`. However, for production field operations:
1. The operator app already provides an interactive visual canvas where the operator previews, offsets, reorders, aligns, and extends markings with live visual feedback.
2. The rover backend must never override, simplify away, or re-order what the operator verified and approved on screen.
3. To bridge this without duplicating planning algorithms, `POST /api/missions/plan` accepts an explicit sequence of planned runs containing coordinates in metres in the local NED frame.
4. The backend compiles the submitted runs directly into the canonical ASCII `DYX3PATH 1` artifact format (contract: `docs/contracts/path_artifact.md`) and stores it content-addressed by its SHA-256 hash.

---

## 2. HTTP Endpoint Specification

- **Method:** `POST`
- **Path:** `/api/missions/plan`
- **Authentication:** `Authorization: Bearer <token>`
- **Authorization Role:** `operator` (or higher)
- **Headers:** `Content-Type: application/json`, `Accept: application/json`

---

## 3. Request Payload Schema (`application/json`)

```json
{
  "client": "Three_Wheel_v2",
  "client_version": "1.0.0",
  "name": "Job_Runway_Marking_A",
  "frame": "local_ned",
  "origin_ne_m": [0.0, 0.0],
  "runs": [
    {
      "type": "travel",
      "points": [
        [0.0, 0.0, 2],
        [2.5, 0.0, 0],
        [5.0, 0.0, 2]
      ]
    },
    {
      "type": "mark",
      "points": [
        [5.0, 0.0, 3],
        [10.0, 0.0, 1],
        [15.0, 0.0, 3]
      ]
    }
  ]
}
```

### 3.1 Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `client` | `string` | YES | Identifier of the planning software, e.g. `"Three_Wheel_v2"`. |
| `client_version` | `string` | YES | SemVer of the client app, e.g. `"1.0.0"`. |
| `name` | `string` | NO | Optional human-readable name of the mission job or CAD file. Max 128 characters. |
| `frame` | `string` | YES | MUST be `"local_ned"`. Coordinate convention: North (X, metres), East (Y, metres). Down is implicitly 0.0 m on the ground plane. |
| `origin_ne_m` | `[number, number]` | NO | Origin offset `[north_m, east_m]` in local NED frame. Default `[0.0, 0.0]`. |
| `runs` | `Array<PlanRun>` | YES | Sequential list of planned runs executed in strict array order. |

### 3.2 `PlanRun` Structure

```json
{
  "type": "mark" | "travel",
  "points": [
    [north_m, east_m, flags]
  ]
}
```

- `type`:
  - `"mark"`: An active line marking run where paint spraying is intended.
  - `"travel"`: A transit or repositioning run between marks (no paint).
- `points`:
  - Array of 3-element tuples: `[north_m, east_m, flags]`
  - `north_m`: Local North coordinate in metres (`float`).
  - `east_m`: Local East coordinate in metres (`float`).
  - `flags`: Integer bitmask in range `0..3` (`int`):
    - `bit 0` (`0x01`): **Spray Intent**. `1` = Spray ON, `0` = Spray OFF.
    - `bit 1` (`0x02`): **Must-Hit Point**. `1` = Critical geometry vertex / extension vertex that must never be simplified away by RPP conditioner; `0` = intermediate polyline step.

#### Flag Combinations Reference:
- `0` (`0b00`): Travel run, intermediate waypoint.
- `1` (`0b01`): Mark run, intermediate waypoint (spray ON).
- `2` (`0b10`): Travel run, must-hit vertex / corner (spray OFF).
- `3` (`0b11`): Mark run, must-hit vertex / extension boundary (spray ON).

---

## 4. Geometric & Planning Rules

1. **Extensions Included:** Pre-extensions (lead-in distance before paint trigger) and post-extensions (runout distance after paint trigger) are already calculated and embedded into the points by the client app.
2. **Strict Ordering:** The rover backend preserves the exact run order and point order within each run.
3. **No Backend Re-Planning:** The backend does not run collinear simplification or alter path tangents. It only validates safety bounds and writes the `DYX3PATH 1` artifact.

---

## 5. Client & Backend Validation Limits

The backend MUST validate the following limits and reject invalid payloads with `422 Unprocessable Entity`:

| Check | Constraint | Error Code |
|---|---|---|
| Payload formatting | Valid JSON, required fields present | `INVALID_PAYLOAD` (400) |
| Coordinate frame | `frame == "local_ned"` | `INVALID_FRAME` (422) |
| Run types | All runs must be `"mark"` or `"travel"` | `INVALID_RUN_TYPE` (422) |
| Flags range | `0 <= flags <= 3` and integer | `INVALID_FLAGS` (422) |
| Coordinate values | All `north_m` and `east_m` must be finite numbers (`!isNaN`, `isFinite`) | `NON_FINITE_COORDINATE` (422) |
| Total point count | `1 <= total_points <= 50000` | `EMPTY_MISSION` / `POINTS_LIMIT_EXCEEDED` (422) |
| Step distance | Distance between consecutive points in any run $\le 5.0$ metres | `STEP_TOO_LARGE` (422) |
| Spatial envelope | All coordinates must satisfy $-10000.0 \le north\_m \le 10000.0$ and $-10000.0 \le east\_m \le 10000.0$ | `OUT_OF_BOUNDS` (422) |

---

## 6. Backend Compilation to `DYX3PATH 1` Artifact

The rover backend implements this endpoint by compiling the submitted runs directly into the existing `DYX3PATH 1` format (`pa.encode`):

1. **Points Flattening:**
   ```python
   flat_points = [
       (p[0], p[1], int(p[2]))
       for run in body.runs
       for p in run.points
   ]
   ```
2. **Metrics Computation:**
   - `total_mark_length_m`: Euclidean sum along consecutive points where `flags & 1 != 0`.
   - `total_transit_length_m`: Euclidean sum along consecutive points where `flags & 1 == 0`.
   - `bbox_ne_m`: `[min(n), min(e), max(n), max(e)]`.
3. **Meta Object Assembly:**
   ```python
   meta = {
       "origin_ne_m": body.origin_ne_m or [0.0, 0.0],
       "total_mark_length_m": float(total_mark_length_m),
       "total_transit_length_m": float(total_transit_length_m),
       "num_waypoints": len(flat_points),
       "source": {
           "type": "app_planned",
           "client": body.client,
           "client_version": body.client_version,
           "name": body.name or "app_planned_mission",
           "num_runs": len(body.runs)
       }
   }
   ```
4. **Encoding & Storage:**
   - Call `pa.encode(flat_points, engine_id="app_v1", meta=meta)`.
   - Store bytes into `/var/lib/dyx3/missions/<sha256>.dyx3path` via `pa.store`.
   - Idempotent: uploading the identical plan yields the exact same SHA-256 digest.

---

## 7. Response Schema

### 7.1 Success Response (`201 Created`)

The response shape strictly matches the existing `POST /api/missions` response:

```json
{
  "ok": true,
  "mission": {
    "sha256": "4b5d6f1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "engine_id": "app_v1",
    "num_points": 120,
    "num_spray_points": 80,
    "mark_length_m": 45.2,
    "transit_length_m": 12.8,
    "bbox_ne_m": [0.0, 0.0, 30.0, 15.0],
    "source": {
      "type": "app_planned",
      "client": "Three_Wheel_v2",
      "client_version": "1.0.0",
      "name": "Job_Runway_Marking_A",
      "num_runs": 2
    }
  }
}
```

### 7.2 Error Response (`400 / 401 / 403 / 422 / 500`)

```json
{
  "ok": false,
  "code": "STEP_TOO_LARGE",
  "reason": "Step between points 14 and 15 is 6.20m, exceeding maximum limit of 5.00m"
}
```
