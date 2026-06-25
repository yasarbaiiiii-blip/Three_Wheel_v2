# Audit Report — React Native Virtual Joystick V2 Wiring Guide

**Audit date:** 2026-06-25  
**Subject:** `docs/REACT_NATIVE_JOYSTICK_V2_WIRING_GUIDE.md`  
**Backend reference:** `PX4_DXP/server`, commit `e0e3debef91726309b6bac02570aa8208b78fd9f`  
**Scope:** Five specific corrections raised against the wiring guide — each verified against the authoritative backend implementation.

**Result:** All five corrections are **CONFIRMED** against the backend code. The guide contains each of the five defects described. Sections below provide the exact evidence, impact, and the precise guide locations that need revision.

---

## Correction 1 — Release Does Not Switch to OFFBOARD

**Status:** ✅ CONFIRMED — defect present in the guide.

### Backend evidence

`server/joystick_controller.py`, `release()` method (lines 229–253):

```python
async def release(self, sid=None, *, session_id=None, lease_id=None,
                   reason="explicit", force=False):
    # ...
    self._stop_reason = reason
    async with self._arbiter.hold():
        self._state = JoystickState.RELEASING
        self._arbiter.mark_releasing()
    self._stop_watchdog()
    await asyncio.to_thread(self._gateway.deactivate_neutral)
    async with self._arbiter.hold():
        self._clear_local(reason=reason)
    return {"type": "joystick_released", "state": self._state.value, "reason": reason}
```

**No call to `set_mode_async("OFFBOARD")` exists anywhere in `release()`.** The method:
1. Stops the watchdog
2. Sends neutral frames through the gateway
3. Clears all local ownership state (owner_sid, session_id, lease_id)
4. Sets state to INACTIVE

The vehicle **remains in MANUAL mode** after release. Only `mission_start` (via `OffboardController.start_async()`) may transition to OFFBOARD. This is the approved safety policy: release = neutral + remain MANUAL.

`server/emergency.py:62-63` confirms the pattern for E-stop:
```python
ok, why = await self._node.set_mode_async("MANUAL")
```
E-stop switches to MANUAL, not OFFBOARD. No automatic OFFBOARD transition occurs on any joystick release path.

### Guide locations with the defect

| Location | Current text | Issue |
|----------|-------------|-------|
| Section 7.3, Bench test B24 (line ~1190) | "Verify mode transitions (MANUAL acquire, OFFBOARD on release)" | "OFFBOARD on release" is incorrect. Should be "MANUAL + neutral on release". |
| Section 3.2, State transition table (line ~347–349) | Several transitions imply mode switching on release | The "Release → OFFBOARD" assumption pervades the state machine documentation. |
| Section 3.3, Dead-man table (line ~391) | "Dead-man released → Immediate deadman=false frame" | Correct for the command, but no mention that mode stays MANUAL. |
| Section 6.2, Disconnect rule (line ~1200) | "Stop command timer, clear local lease, force neutral" | Missing explicit statement: "Mode remains MANUAL; do not request OFFBOARD." |

### Required fix

Remove all references to "OFFBOARD on release" from the guide. Add an explicit statement in Section 1.2 (release event docs) and Section 6 (safety rules):

> "Release leaves the vehicle in MANUAL mode with neutral commands. Only mission_start transitions to OFFBOARD."

---

## Correction 2 — Acquire Success Should Initially Be HELD, Not Driving ACTIVE

**Status:** ✅ CONFIRMED — defect present in the guide.

### Backend evidence

`server/joystick_controller.py`, `acquire()` method (lines 166–173):

```python
lease_id = uuid.uuid4().hex
self._lease_id = lease_id
now = time.monotonic()
self._last_valid_cmd_mono = now
self._last_rate_mono = None
self._state = JoystickState.ACTIVE          # ← Backend sets ACTIVE
self._arbiter.mark_joystick_active(session_id, lease_id)
self._start_watchdog()
```

**The backend sets `JoystickState.ACTIVE` immediately after acquire succeeds.** This is the backend's internal state (lease live, commands accepted), not a statement about driving. Backend `ACTIVE` means "ready to accept commands" — commands with `deadman=false` are accepted but forced to neutral (lines 204–208).

### The guide's contradiction

The guide defines its **frontend** state `ACTIVE` as (Section 3.1, line ~325):
> "ACTIVE — lease held, deadman pressed, sending commands"

But the state transition table (Section 3.2, line 341) immediately contradicts this:
> "ACQUIRING | joystick_acquired received | ACTIVE | Store lease, start deadman listener"

**The deadman has NOT been pressed at this point.** The acquire response carries no deadman press — the operator hasn't touched the dead-man button yet. Sending the frontend to `ACTIVE` (which the guide itself defines as "deadman pressed") is semantically wrong and could mislead the operator into thinking the vehicle is ready to drive.

The backend's acquire response (lines 174–183) reports `"state": "active"` — but this is the **backend** state, not a UI directive. The frontend owns the operator-facing state machine. The frontend should decode `"active"` from the backend as "lease granted, awaiting deadman" — which maps to a neutral/non-driving state.

### Guide locations with the defect

| Location | Current text | Issue |
|----------|-------------|-------|
| Section 3.1, State definitions (line ~325) | ACTIVE = "lease held, deadman pressed, sending commands" | Definition is correct but cannot be the post-acquire destination. |
| Section 3.2, Transition table (line 341) | "ACQUIRING → joystick_acquired → ACTIVE" | This transition violates the ACTIVE definition. Deadman is not pressed. |
| Section 5.3, `onAcquired()` code (line ~830) | `setState("ACTIVE");` with comment "Ready, but deadman not pressed yet" | Comment acknowledges the contradiction but the code still sets ACTIVE. |
| Section 3.3, Acquire behavior (line 389) | "Acquire received | No motion. Must press dead-man first." | Correct behavior, but the state name is wrong. |

### Required fix

After `joystick_acquired`, the frontend should enter a state named `HELD` (or `ACQUIRED_NEUTRAL`), NOT `ACTIVE`. The transition to ACTIVE should only occur on the first `deadman=true` command being sent. Update:

1. State definitions: ACTIVE requires deadman press.
2. Transition table: `ACQUIRING | joystick_acquired | HELD | Store lease, start deadman listener, do NOT send commands with non-zero values`
3. Add transition: `HELD | first deadman=true sent | ACTIVE | Resume sending non-zero commands`
4. Code example: `onAcquired` sets `HELD`, not `ACTIVE`.

---

## Correction 3 — Do Not Reconcile ACQUIRING to Inactive Too Early

**Status:** ✅ CONFIRMED — defect present in the guide.

### Backend evidence

`server/joystick_controller.py`, `acquire()` flow (lines 122–187):

```python
async def acquire(self, sid, data):
    # ...
    self._state = JoystickState.ACQUIRING          # Line 130 — set BEFORE any await
    # ...
    try:
        self._check_fcu_ready_for_acquire()         # synchronous
        self._check_transport_healthy()              # synchronous
        self._gateway.activate_neutral()             # synchronous
        await asyncio.to_thread(                     # AWAIT — neutral prestream (0.2s)
            self._gateway.wait_neutral_barrier,
            self._neutral_prestream_s,
        )
        ok, why = await self._ros_node.set_mode_async("MANUAL")  # AWAIT — mode switch
        # ...
        self._state = JoystickState.ACTIVE           # Line 171 — set AFTER all awaits
```

The backend sets `_state = ACQUIRING` at line 130, **before any asynchronous operations**. The telemetry tick (10 Hz in `server/main.py`) reads `joystick_ctrl.snapshot()` which reports `self._state.value`. During the acquire process, the telemetry stream correctly reports `"acquiring"` from line 130 until line 171.

**However**, there's a subtle race: asyncio event loop scheduling. Between `acquire()` being called (line 130, state = ACQUIRING) and the next telemetry tick reading the snapshot, another task could run. If the telemetry tick runs before `acquire()` sets ACQUIRING, it would still see `"inactive"`. This is a narrow window (single asyncio event loop tick) but exists.

More importantly, the **principle** is what matters: the frontend should never auto-clear a pending `ACQUIRING` state based on telemetry alone. The backend is the source of truth, but during a state transition, the frontend must wait for either:
- An explicit `joystick_error` event (which means the backend rejected the acquire)
- An explicit `joystick_acquired` event (which means success)
- A frontend-side acquire timeout
- A socket disconnect
- An explicit cancellation (E-stop, etc.)

### Guide locations with the defect

| Location | Current text | Issue |
|----------|-------------|-------|
| Section 5.7, Telemetry reconciliation code (line ~970) | `if (telem.joystick_state === "inactive" && (stateRef.current === "ACTIVE" \|\| stateRef.current === "HELD" \|\| stateRef.current === "ACQUIRING" \|\| stateRef.current === "RELEASING"))` | Includes ACQUIRING in the clear-on-inactive check. A stale telemetry frame could cancel a valid pending acquire. |
| Section 3.2, Transition table (line 354) | "ACTIVE/HELD | telemetry joystick_state=inactive | AVAILABLE | Clear local lease" | Does not list ACQUIRING, but the code in 5.7 does include it. Inconsistency between table and code. |

### Required fix

Remove `"ACQUIRING"` from the telemetry reconciliation clear condition. ACQUIRING should only be cleared by:

1. Receiving `joystick_acquired` (→ HELD, as per Correction 2)
2. Receiving `joystick_error` (→ AVAILABLE with error display)
3. A frontend-side acquire timeout (e.g., 5 seconds, → AVAILABLE with timeout error)
4. Socket disconnect (→ DISCONNECTED)
5. E-stop or explicit operator cancellation

The reconciliation function should explicitly guard against clearing ACQUIRING:

```typescript
if (
  telem.joystick_state === "inactive" &&
  (stateRef.current === "ACTIVE" || stateRef.current === "HELD" ||
   stateRef.current === "RELEASING")  // ACQUIRING REMOVED
) {
  // Clear local state...
}
```

---

## Correction 4 — Avoid Command-Rate Races

**Status:** ✅ CONFIRMED — defect present in the guide.

### Backend evidence

`server/joystick_controller.py`, `_validate_rate()` (lines 346–351):

```python
def _validate_rate(self, now: float) -> None:
    if (
        self._last_rate_mono is not None
        and now - self._last_rate_mono < self._min_command_interval_s
    ):
        raise JoystickError("rate_exceeded", "joystick command rate exceeded")
```

Where `_min_command_interval_s = 1.0 / JOYSTICK_COMMAND_RATE_HZ` (line 93).

With default `JOYSTICK_COMMAND_RATE_HZ = 20.0` (from `server/config.py:136`), the minimum interval is **50 ms**. Any two commands arriving with less than 50ms between them will be rejected with `rate_exceeded`.

### Two race conditions in the guide's sender

**Race 1 — `setInterval` jitter at exact rate:**

The guide's command sender (Section 5.4) uses:
```typescript
const intervalMs = Math.round(1000 / rateHz);
commandTimerRef.current = setInterval(() => { ... send ... }, intervalMs);
```

At 20 Hz: `intervalMs = 50`. JavaScript `setInterval` is NOT precise — it guarantees execution no sooner than 50ms, but actual timing can drift ±4ms (or more on mobile). The backend uses `time.monotonic()` which is precise. A frontend tick that fires at 50ms, then the next at 99ms (49ms gap) will trigger `rate_exceeded`.

**Race 2 — Immediate deadman frame colliding with interval timer:**

The guide's `sendImmediateNeutralDeadmanFrame()` (Section 5.4) fires a command outside the interval timer:
```typescript
function setDeadman(pressed: boolean): void {
  deadmanRef.current = pressed;
  if (!pressed) {
    sendImmediateNeutralDeadmanFrame();  // ← immediate send
    setState("HELD");
  }
}
```

If the deadman is released at time T=40ms (within a 50ms interval), and the interval timer last fired at T=0ms, the immediate frame at T=40ms will arrive only 40ms after the last command → `rate_exceeded`.

### Additional unaddressed issue — sequence increment in two places

The guide increments `sequence` in both `startCommandSender` (inside `setInterval`) and `sendImmediateNeutralDeadmanFrame` (outside the interval). If both fire within the same window, sequence ordering is non-deterministic — the immediate frame could get a LOWER sequence than the interval frame if the timer fires between the two operations, or vice versa.

### Required fix

1. **Send below the maximum rate:** Use `intervalMs = Math.ceil(1000 / rateHz) + 2` or `intervalMs = Math.ceil(1000 / (rateHz * 0.95))` to provide ~5% margin.

2. **Serialize all sends through one gate function:**
```typescript
let lastSendMonoMs = 0;
const minSendIntervalMs: number; // e.g., ceil(1000/rateHz) + 2

function serializedSend(payload: JoystickCommandRequest): void {
  const now = Date.now();
  if (now - lastSendMonoMs < minSendIntervalMs) return; // Drop, don't reject
  lastSendMonoMs = now;
  payload.sequence = ++sequenceRef.current;  // Single sequence source
  socketRef.current?.emit("joystick_command", payload);
}
```

3. **Reschedule the interval timer after an immediate frame:** After an immediate send, clear and restart the interval timer so the next periodic send is `minSendIntervalMs` after the immediate one.

4. **Sequence increments in ONE place only:** The `serializedSend` function is the single source of truth for sequence numbers.

---

## Correction 5 — Background State Should Not Mean DISCONNECTED

**Status:** ✅ CONFIRMED — defect present in the guide.

### Evidence

The guide's state definitions (Section 3.1) define:
> "DISCONNECTED — socket not connected"

But Section 3.2 transition table (line 351) sends app background → DISCONNECTED:
> "ACTIVE/HELD/ACQUIRING | App background | DISCONNECTED | Send neutral, send release, stop sender"

And Section 5.5 `handleBackground()` code:
```typescript
function handleBackground(): void {
  // ...
  setState("DISCONNECTED");
  // ...
}
```

**AppState=background does NOT mean Socket.IO disconnected.** The connection may still be alive. On return to foreground, the socket may still be usable — setting state to DISCONNECTED conflates two different conditions:

1. **Intentional backgrounding** — app backgrounded, lease released, controls unavailable until explicit re-acquire, but socket may reconnect seamlessly.
2. **Network disconnect** — socket genuinely lost, full reconnect + re-acquire required.

Conflating these causes:
- The operator sees "DISCONNECTED" and may try to restart the connection unnecessarily.
- On foreground, the code can't distinguish "was backgrounded, socket fine" from "genuinely disconnected, socket needs reconnect."
- The user-facing message differs: "App was backgrounded — tap Acquire to resume" vs "Connection lost — check network and reconnect."

### Required fix

1. **Add a new frontend state: `UNAVAILABLE`** (or rename the existing states):
   - `DISCONNECTED` — only when the socket is genuinely disconnected
   - `UNAVAILABLE` — joystick control unavailable (background, E-stop, mission active, etc.) regardless of socket state

2. **Or simpler: use `DISABLED` for background:**
   - `handleBackground()` sets state to `DISABLED` instead of `DISCONNECTED`
   - On foreground, `handleForeground()` checks socket state and transitions to:
     - `AVAILABLE` if socket is connected and telemetry shows idle/inactive
     - `DISABLED` if socket is still disconnected

3. **Update the state transition table (Section 3.2):**
   - Old: `ACTIVE/HELD/ACQUIRING | App background | DISCONNECTED`
   - New: `ACTIVE/HELD/ACQUIRING | App background | DISABLED`
   - Add: `DISABLED | App foreground + socket connected + telemetry healthy | AVAILABLE`

4. **Update Section 5.5 code:** `setState("DISABLED")` instead of `setState("DISCONNECTED")`.

---

## Summary of All Guide Defects

| # | Correction | Severity | Guide Locations Affected |
|---|-----------|----------|--------------------------|
| 1 | Release does not switch to OFFBOARD | **Critical** — incorrect PX4 mode behavior documented | B24 checklist, state transition table, safety rules |
| 2 | Acquire → ACTIVE when deadman not pressed | **High** — operator confusion risk | State definitions, transition table, code example (5.3) |
| 3 | ACQUIRING cleared by stale telemetry | **High** — premature acquire cancellation | Telemetry reconciliation code (5.7), state machine |
| 4 | Command-rate races (jitter + immediate frames) | **High** — rejected commands during normal use | Command sender (5.4), deadman handler |
| 5 | Background sets DISCONNECTED | **Medium** — UX confusion, conflation of states | State definitions, transition table, handleBackground code (5.5) |

## Guide Quality Assessment (Non-Correction Items)

The remaining ~90% of the guide is **accurate and implementation-ready**. Specific strengths:

- **Backend contract (Section 1):** All event names, field names, error codes, telemetry fields match the backend exactly. No invented fields.
- **File-by-file plan (Section 4):** Adapts to the actual React Native project structure (Expo SDK 54, monolith App.tsx). Does not propose unnecessary restructuring.
- **TypeScript examples (Section 5):** Field names in code snippets match the backend Pydantic models and `_parse_command` dict keys.
- **Test plan (Section 7):** Bench tests (B1-B16) are comprehensive and map to hardware-safe procedures (motors depowered).
- **Open questions (Section 8):** Accurately identifies real gaps (auth token delivery, navigation pattern) that cannot be resolved from code alone.

## Recommendation

**Do not give the current guide to Codex for implementation.** Apply the five corrections above to the guide first. The defects are concentrated in ~6 specific sections and can be patched without restructuring the document. Once corrected, the guide will be production-ready for frontend implementation.

## Appendix — Exact Backend Lines Referenced

| Backend File | Lines | What It Proves |
|-------------|-------|----------------|
| `server/joystick_controller.py` | 229–253 | `release()` does not call `set_mode_async("OFFBOARD")` |
| `server/joystick_controller.py` | 170–171 | Backend sets ACTIVE after acquire (before any deadman) |
| `server/joystick_controller.py` | 130, 171 | ACQUIRING state set before async ops, ACTIVE set after |
| `server/joystick_controller.py` | 346–351 | Rate validation: rejects commands < min_interval apart |
| `server/config.py` | 136 | `JOYSTICK_COMMAND_RATE_HZ = 20.0` → 50ms minimum interval |
| `server/joystick_controller.py` | 204–208 | `deadman=false` → throttle/steering forced to 0.0, state → HELD |
| `server/emergency.py` | 62–63 | E-stop switches to MANUAL, not OFFBOARD |
| `server/main.py` | 393–394 | Telemetry merges joystick snapshot at 10 Hz |