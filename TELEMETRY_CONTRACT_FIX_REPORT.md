# Production telemetry contract fixes

## Scope and checkout

Backend reference: `Vetri2425/DYX_3WD`, `hardening/2026-10-10`, `9babf60` (read-only).
Requested frontend base: `apk-optimization`, `4096af9`.
The shared checkout advanced to `0bb7282` and then changed to branch `Trajectory` during this task.
Those existing changes were preserved. Change 1 is commit `0b1f22a`; Change 2 follows it on the same branch.
No push, backend change, APK build, or rover operation was performed.

## Phase 0 findings, reported before implementation

`backend/src/dyx3_backend/realtime/hub.py` forwards `{snapshot, age_s}` for every gateway push.
`gateway/client.py` stamps each received gateway envelope with its backend monotonic clock;
the envelope age is elapsed time since that receipt. REST additionally reports gateway `connected`.

The source ages are generated earlier by `ros2_ws/src/dyx3_system_gateway/src/telemetry_snapshot.cpp`.
Each source is cached independently. Its `age_s` is elapsed time since the gateway received that ROS
source, and `fresh` compares that age with the gateway's configured `snapshot_fresh_s` (default 1 s).
The gateway continues emitting snapshots even when their constituent sources have stopped publishing.
Vehicle `position_valid`, `velocity_valid`, and `attitude_valid` gate their respective measurements;
GNSS `valid` gates GNSS data. Neither packet receipt nor operator heartbeat proves source validity.

These ages represent successive time intervals. The implemented effective source age is:

`source.age_s * 1000 + envelope.age_s * 1000 + monotonicNow - receivedAt`

Clock domains are never directly compared. Snapshot observation time on the frontend clock is
`receivedAt - envelopeAgeMs`; a source's observation time is that minus its reported source age.
Raw source age/freshness/validity are retained in the snapshot. Negative, missing, or non-finite ages
are unknown; backend `fresh:false` cannot be overridden by a small numeric age.

Preserved thresholds and policy:

| Existing rule | Value |
|---|---|
| LIVE / source usable | effective age <= 1,000 ms |
| STALE | age > 1,000 ms and <= 2,500 ms |
| DISCONNECTED | age > 2,500 ms, or unknown |
| Entry cache maximum receipt age | 3,000 ms |
| Planner pose-age limit | 5,000 ms |
| GPS-origin entry | finite lat/lon and fix type >= 3 |
| Local-NED entry | finite north/east; no GPS-fix requirement |
| Freshness ticker | 250 ms |
| Recovery polling interval | 2,500 ms |

The new source-usability check enforces the existing LIVE threshold; it does not change the cache or
planner constants. There is no RTK-fixed-only Start gate. Heading already uses
`wrap360(radToDeg(heading_rad))`, yielding [0, 360) compass degrees. That conversion was preserved;
invalid or non-finite headings become null before conversion.

## Changes

Change 1 adds one tagged socket/REST ingestion function, monotonic receive and observation timestamps,
source aging and validity gates, schema validation, and one `evaluateMissionStartTelemetry()` function.
Socket reconnect and app resume invalidate trust. The ticker changes a render revision, never receipt
timestamps or raw packet data. Start reads the store's ingestion-only cache directly; the duplicate
App pose cache and its ticker-driven timestamp writes were removed.
Both production pose sources and the final Start dispatch use the shared eligibility check.
Existing test fixtures were updated to include the gateway schema actually emitted by the backend.

Change 2 replaces telemetry/status recovery routes with the production client, rejects stale REST
responses using request/session/socket sequence tokens, and replaces loaded-path inspection with
authoritative mission identity plus the production mission path. Geometry is discarded if the mission
changes during recovery. Disconnect and silence recovery remain active. Gateway, Operator, and Vehicle
health are shown separately in the existing HUD and debug status areas. The pure entry selector also
checks reported source age, instead of trusting receipt age alone.

Files changed span `App.tsx`, production socket/client contracts, `missionApi.ts`, the production store,
staleness utilities, entry-pose selection, existing telemetry HUD components, DebugDriveScreen, and
telemetry/lifecycle/recovery/mission tests. `telemetryRecovery.ts` contains the replacement REST recovery.

## Validation

- Before implementation, the contract suite reported 8 failures / 1 pass. The existing newer commit
  already handled invalid measurement flags. One concrete failure exposed cached north=12 with
  source age 0.6 s plus envelope age 0.5 s; it should have been null. Schema-warning checks also failed.
  The other failures exposed the missing lifecycle, gate, and request-ordering APIs.
- The new recovery tests initially failed because the replacement recovery module did not exist.
- The pure entry-selector regression initially accepted a 1,001 ms-old source with a current receipt
  timestamp; it now rejects it.
- Latest targeted run: **65 passed across 9 files**, including all 8 original store/transport tests.
  Coverage includes frozen sources, backend freshness flags, local aging, validity flags, ticker receipt
  stability, reconnect/resume wiring, schema mismatch, distinct connection failures, GPS fix policy,
  REST/socket ordering, and mission geometry races.
- TypeScript (`npx tsc --noEmit`) and whitespace (`git diff --check`) checks passed.
- Final full-suite run: **1,057 passed / 1 failed across 106 files**. The failure is
  `roadMarkingCsvPath.test.ts`, "never closes into a polygon ring", expecting gap > 0.04 and receiving 0.
  Both the geometry implementation and its test are identical to `0bb7282`; they have no telemetry
  runtime imports. This unrelated geometry failure was left outside scope.
- **Recorded-log replay not performed:** no SITL or real telemetry recording was available in either
  checkout, and none was supplied after the path request. Unit fixtures are not presented as recorded
  evidence. Replay remains a required verification step before claiming complete acceptance.
- No live rover verification or APK bench run was possible in this task.

## Open decisions

No thresholds were retuned. Requiring RTK FLOAT or FIXED rather than the existing GPS fix >= 3 is a
separate policy decision. Bench evidence should guide any future threshold changes. A recorded
telemetry file is still needed for the requested replay.

## APK bench checklist

Use a supervised bench setup and monitor the backend snapshot alongside the app.

1. Stop vehicle-state publication while gateway packets continue: position/heading/speed become
   unavailable after the existing source limit, Vehicle leaves LIVE, and Start rejects stale pose.
2. Stop GNSS publication: GPS-origin Start rejects unavailable GNSS. Local-NED eligibility retains
   its existing independent policy. Stop RTK publication separately and verify stale RTK is not
   displayed as a current fix; valid GNSS fallback follows the existing policy.
3. Toggle each vehicle validity flag and GNSS validity: affected values become dashes, never zero,
   NaN, or the previous measurement. Invalid position blocks the corresponding entry frame.
4. Disconnect the gateway: Gateway reports DISCONNECTED and Start rejects it. Reconnect with cached
   old sources: Start stays blocked until a valid fresh pose and operator heartbeat are present.
5. Stop tablet/operator heartbeats while telemetry continues: Operator becomes UNAVAILABLE separately
   from Gateway. Start reports the operator-heartbeat reason.
6. Silence the app socket: age increases without receive timestamps changing; telemetry passes through
   the existing STALE/DISCONNECTED thresholds, recovery attempts REST, and a disconnected socket
   cannot gain Start permission through REST alone.
7. Background/resume and reconnect the app: pre-resume/reconnect poses cannot authorize Start.
8. Delay REST responses across newer socket samples and across a mission change: newer state wins;
   old geometry and telemetry are discarded.
9. Supply incompatible gateway schema: a loud warning is emitted and Start remains disabled.
