# Telemetry "stale coordinate" investigation

Date: 2026-07-04
Scope: `Three_Wheel_v2` (React Native / Expo app) telemetry consumption, cross-referenced against `PX4_DXP` backend (`server/`).

## Symptom reported

Live telemetry on the app appears to show the same GPS/position coordinate for
a stretch of time (observed as "partial coordinates" / a value that looks
stuck for around 2 seconds) instead of updating continuously.

## Backend telemetry surfaces (for reference)

Two distinct surfaces exist on the PX4_DXP backend, both reading from the same
underlying `RosBridgeNode.get_state()` snapshot:

1. **`GET /api/telemetry/latest`** — REST, auth-protected
   (`server/routes/telemetry.py`). One-shot snapshot per request.
2. **Socket.IO `"telemetry"` event** — pushed continuously by
   `_telemetry_loop()` in `server/main.py` at **10 Hz**
   (`TELEMETRY_HZ = 10` in `server/config.py`).

Neither surface nulls out or flags `lat`/`lon` (or any other field) when the
underlying ROS callback hasn't fired recently — `get_state()` only *adds* age
metrics (`gps_fix_age_ms`, `global_position_age_ms`, etc.) alongside the
value; the value itself is always whatever was last received, however old.

## How Three_Wheel_v2 actually connects — verified in `App.tsx`

- **Live/continuous updates come exclusively from the Socket.IO WebSocket**,
  not REST. On connect (`App.tsx:1166`):
  ```js
  nextSocket = io(target, {
    transports: ["websocket"], // Use websocket ONLY - polling is unreliable in APK builds
    timeout: 20000,
    forceNew: true,
    auth: { token: session.token },
  });
  ```
  It subscribes to `socket.on("telemetry", ...)` (`App.tsx:1188`) and that
  handler is what drives `pos_n/pos_e/lat/lon/speed/...` on screen.

- **`GET /api/telemetry/latest` is used only for one-shot refreshes.** The app
  calls it via `refreshTelemetryPanel()` (`App.tsx:2031`, fetch URL at
  `App.tsx:2088`). Every call site of `refreshTelemetryPanel()` (~10 of them)
  fires **immediately after a specific user/API action** — mission loaded,
  mission started/stopped, etc. (e.g. `App.tsx:2339`, `2360`, `2450`, `2634`,
  `2696`, `2727`, `2759`, `2793`, `2827`, `2879`). None of them are wrapped in
  a `setInterval`/polling loop. REST is a "get me a fresh snapshot right now"
  call, not a live feed.

## Root cause of the "stale-looking" symptom — found in the frontend

The socket `"telemetry"` handler does the following on **every** incoming
message (`App.tsx:1219-1253`):

```js
setTelemetrySnapshot((prev) => {
  if (!prev) return data;
  // Optimize updates: only set state if keys have actually changed
  if (
    prev.pos_n === data.pos_n &&
    prev.pos_e === data.pos_e &&
    prev.lat === data.lat &&
    prev.lon === data.lon &&
    prev.heading_ned_deg === data.heading_ned_deg &&
    prev.xtrack_m === data.xtrack_m &&
    prev.heading_err_deg === data.heading_err_deg &&
    prev.dist_to_goal_m === data.dist_to_goal_m &&
    prev.speed_m_s === data.speed_m_s &&
    prev.measured_speed_m_s === data.measured_speed_m_s &&
    prev.along_track_speed_mps === data.along_track_speed_mps &&
    prev.cross_track_speed_mps === data.cross_track_speed_mps &&
    prev.rpp_state === data.rpp_state &&
    prev.rpp_state_name === data.rpp_state_name &&
    prev.armed === data.armed &&
    prev.mode === data.mode &&
    prev.battery_pct === data.battery_pct &&
    prev.gps_fix === data.gps_fix &&
    prev.gps_fix_name === data.gps_fix_name &&
    prev.gps_sat === data.gps_sat &&
    prev.hrms === data.hrms &&
    prev.vrms === data.vrms &&
    prev.joystick_state === data.joystick_state &&
    prev.joystick_active === data.joystick_active &&
    prev.control_owner === data.control_owner &&
    prev.joystick_last_valid_cmd_age_ms === data.joystick_last_valid_cmd_age_ms
  ) {
    return prev; // <-- React state is NOT updated; no re-render
  }
  return { ...prev, ...data };
});
```

This is a deliberate render-optimization: if this specific field list is
bit-for-bit identical to the previous socket message, `setTelemetrySnapshot`
returns the same object reference, so React skips the re-render. Data is
still arriving from the backend at 10 Hz the whole time — but if the
underlying value (rover stationary, or the ROS topic upstream stalled and
kept re-sending the same last-known value, see Backend section above) doesn't
change between ticks, the screen shows the *exact same numbers* for as long
as that holds. That reads to an operator as "telemetry only shows partial /
stuck coordinates."

## What this is NOT

- It is **not** a 2-second timer in the backend. The only 2.0 s watchdog in
  the backend (`server/ros_node.py:230`, `_MAVROS_STATE_TIMEOUT_S = 2.0`)
  overrides the `connected` flag when `/mavros/state` goes stale — it has no
  effect on `lat`/`lon` and is unrelated to this symptom.
- It is **not** caused by REST polling contention — REST is not polled on an
  interval in this app at all.

## Follow-up (not yet done)

- Confirm with the operator whether the "stuck" window they observed
  coincided with a period where the rover was genuinely stationary (expected,
  benign) or with an active ROS-topic stall on the backend (would need a
  fresh field capture + `tools/capture_telemetry.py` cross-check, since no
  ROS-level GPS gap over 0.5 s was found in the one bag inspected so far —
  see `PX4_DXP/docs/stg_circle_cause.md`).
- If the intent is "show the operator when data is actually stale" rather
  than "avoid redundant re-renders," the equality guard should be paired with
  a separate staleness indicator (e.g. surface `gps_fix_age_ms` /
  `global_position_age_ms` from the payload) rather than removed outright —
  removing it would just increase re-render frequency without fixing the
  underlying appearance of a frozen value during a genuine upstream stall.
