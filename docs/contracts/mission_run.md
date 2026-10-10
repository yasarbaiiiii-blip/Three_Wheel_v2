# Contract: mission run, app side (mission contract v2)

**Producer of commands:** the operator tablet app (`Three_Wheel_v2`).
**Consumer:** the rover backend (`dyx3_backend`, `docs/contracts/backend.md` sections 1c and 4) and, behind it, `dyx3_mission` (`docs/contracts/dyx3_mission.md`).
**Upload** (store the mission) is `app_planned_mission.md`. This document is what happens after: start, watch, pause, resume, stop.

The operator flow is: **upload -> preview -> Start -> watch progress -> Pause / Resume / Stop**, with E-stop always available.
The rover arms itself, switches to OFFBOARD, drives, releases OFFBOARD and disarms. **The operator never arms and never changes mode for a mission.** There is no "Load" step: upload stores the mission, Start does everything else.

## 1. Rules

1. **Status comes from WebSocket events only.** REST is for commands. No polling loop reads mission state, and a command's answer is an acknowledgement, never the new state.
2. **One implementation.** No flags, no fallback to older routes.

## 2. Commands (`src/api/prodClient.ts`, wrapped by `src/features/mission/missionCommands.ts`)

| Operator action | Route | Body | Answer |
|---|---|---|---|
| Start | `POST /api/missions/{sha}/start` | `{"request_id": "<id>"}` | **202** `{ok, accepted, execution: {mission_id, request_id, duplicate, gate_reason_code}, data}` |
| Pause | `POST /api/mission/pause` | none | 200 `{ok, code, reason, delivered, data}` |
| Resume | `POST /api/mission/resume` | none | 200, same shape |
| Stop | `POST /api/mission/abort` | `{"reason": "operator"}` | 200, same shape |
| E-stop | `POST /api/estop` / Socket.IO `estop` | `{"asserted": bool}` | unchanged, never gated |

Types: `src/contract/prod/rest.ts` (`StartMissionResponse`, `GatewayVerdictResponse`).

### Start and the request id (`src/features/mission/startTap.ts`)

- **One user tap = one `request_id`** (1-64 of `A-Za-z0-9._:-`, `app-<time>-<counter>-<random>`). The rover treats a repeated id as the same execution and starts nothing new (`duplicate: true`).
- A send whose outcome is **unknown** (no answer in time, or the link dropped: `delivered: null`) is repeated once **with the same id**. A refusal or a "not delivered" error is final for that tap and is never repeated.
- A **new tap always gets a new id**; reusing one would make a deliberate second Start look like a duplicate.
- **202 is an acknowledgement.** The app does not set "running" from it. `duplicate: true` is reported to the operator as "nothing new was started".
- The app first checks that the lifecycle allows a start (section 4) and that the entry leg can be built from a fresh pose from the socket telemetry. If the entry leg needs the rover's current position, the mission is re-uploaded (a new sha) before the start.

### Errors -> operator messages (`describeCommandError`)

Error bodies are `{ok:false, code, reason, delivered, data}` (gateway verdicts), `{ok:false, code, reason}` (mission store) or FastAPI's `{detail}` (401 / 403 / 422). `delivered` is `true` (the rover answered), `false` (**not delivered**, nothing happened) or `null` (**unknown**).

| Situation | Operator message |
|---|---|
| `rejected` (409) + `data.reason_code` | the mission node's refusal in words. Start: 1 invalid id, 2 BUSY (still running or releasing the previous one), 3 SAFETY_GATE (+ the guard gate named by `gate_reason_code`), 4 invalid request id. Pause: 1 not running, 2 safety. Resume: 1 not paused, 2 safety, 3 no longer armed or in OFFBOARD (stop and start again), 4 GPS reference changed (stop and start again). Stop: 1 nothing active |
| `GatewayUnavailable` / `service_unavailable` / `busy` (503) | "did not reach the mission controller, nothing was changed" |
| `timeout` / `GatewayTimeout` (504), app timeout, network error | "may have run, watch the status before sending anything else" |
| 401 / 403 | not signed in / operator role required |
| `bad_id`, `invalid_request_id`, 422, `invalid_command` | app/rover mismatch, report it |
| `not_found` | the mission is not stored on the rover, send it again |

## 3. Realtime: `rover_event` (`src/api/prodSocket.ts`, `src/features/telemetry/roverEventStore.ts`)

The app listens to two events: `telemetry` (the periodic snapshot) and **`rover_event`**:
`{kind, seq, gateway_seq, t_mono_s, t_wall_ms, coalesced, replay, data}`.
Kinds: `mission_state`, `operator_link`, `fcu_link`, `estop`, `gateway_link`. The old `gateway` event and any `mission_event` are not listened to.

- **Per kind, the highest `seq` is current.** An event whose `seq` is not above the stored one of its kind is a duplicate and is dropped, including a `replay: true` copy that raced a newer live event.
- **Replay on connect** (`replay: true`, original `seq`) fills the kinds in `seq` order; nothing is polled.
- **Stale is a transition.** `data = {"fresh": false}` makes that kind **unknown**, never the last value.
- **`gateway_link` `{connected:false}` makes every other kind unknown** and drops them, so they cannot reappear as live before the gateway replays them (new `seq`).
- **The socket going down forgets every kind** (nothing is known while the link is down). A new connection starts a new `seq` space, so a restarted backend (`seq` from 1) is heard.
- Unknown is shown as unknown: grey chips and "Mission status unknown", never a green "OK" or the last state.

The link strip on the mission screen shows gateway, operator link, flight controller and E-stop from these kinds (`describeRoverLinks`). `gatewayConnected`, `operatorAlive`, the E-stop flag and the adapted `mission_state` of the telemetry store are derived from them.

## 4. Lifecycle on screen (`src/features/mission/missionLifecycle.ts`)

`mission_state.data` carries `state`, `mission_id` (the execution id), `run_index`, `point_index`, `reason_code`, `gate_reason_code`, `waiting_on`, `reason_detail`, `request_id`, `source_artifact_sha256`, `path_artifact_sha256`, `state_entered`.

```
LOADING 1 -> PLACING 8 -> ARMING 9 -> ENGAGING 10 -> READY 2 -> RUNNING 3 -> COMPLETED 5
RUNNING <-> PAUSED 4;  any step before RUNNING -> ERROR 7;  active -> ABORTED 6;  IDLE 0 = no execution yet
```

The screen shows the six steps (LOADING ... RUNNING) with done / active / failed, the headline, `waiting_on` ("Waiting for the rover to confirm arming", also "Releasing OFFBOARD control" / "Disarming the rover" after the end), then for COMPLETED / ABORTED / ERROR (and for a PAUSED with a cause) the reason text for `reason_code` 0..17 and the rover's own `reason_detail`. A failure marks the failing step only when the reason names it unambiguously (arm, OFFBOARD, placement, load, path-follower ack).

### Buttons (`missionControls`)

| State | Start | Pause | Resume | Stop |
|---|---|---|---|---|
| unknown (gateway down, stale, no socket) | off | off | off | **on** (stopping is always safe to try) |
| IDLE, COMPLETED, ABORTED, ERROR | on (a mission is stored) | off | off | off |
| LOADING, PLACING, ARMING, ENGAGING, READY | off | off | off | on |
| RUNNING | off | on | off | on |
| PAUSED | off | off | on | on |

All four are off while a command is in flight. Resume is never automatic: only the explicit button. E-stop is always shown on the mission screen.

## 5. Where it lives

| Concern | Code |
|---|---|
| Commands, request id | `src/api/prodClient.ts`, `src/features/mission/startTap.ts`, `src/features/mission/missionCommands.ts` |
| Event store, link strip | `src/features/telemetry/roverEventStore.ts`, `roverLinkStatus.ts`, derived values in `prodTelemetryStore.ts` |
| Lifecycle text and buttons | `src/features/mission/missionLifecycle.ts` |
| Screen | `src/components/ModernHomeUI.tsx` (Mission Control panel), handlers in `App.tsx` |
| Separate debug tool (arm / OFFBOARD buttons live only here) | `src/screens/DebugDriveScreen.tsx` |
