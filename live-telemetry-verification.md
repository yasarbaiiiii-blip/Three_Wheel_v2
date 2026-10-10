# Live telemetry verification

Captured 2026-10-10T11:47:56.439Z from http://192.168.3.150:8000, rover dyx3-916baa908b. GET /api/ping, /api/health and /api/telemetry returned 200. Captured 49 Socket.IO telemetry events over ten seconds, with no connection errors. No control or heartbeat events were emitted. Token is excluded from artifacts.

| Field | Samples containing field (REST + Socket.IO) |
|---|---:|
| battery | 0/50 |
| vertical_accuracy_m | 0/50 |
| heading_error_rad | 0/50 |
| tick_state | 0/50 |
| rtk_reason | 0/50 |
| dist_to_goal_m | 0/50 |

No along/cross path-speed fields were present in vehicle_state or RPP data. North/east velocity was present. GNSS and RPP entries were fresh; RPP was idle during this capture.

Source review supports omissions of vertical_accuracy_m, heading_error_rad, tick_state and rtk_reason in gateway JSON serialization. Captured absence of battery cannot prove absence of all hardware/ROS battery data. The controller does calculate distance to goal internally (rpp_core.cpp:907); RppStatus and gateway do not expose dist_to_goal_m. The claim that the controller never calculates this is incorrect. Frontend mappings exist for battery, VRMS, heading error, distance and diagnostics, but this capture does not prove zero frontend bugs or end-to-end UI correctness.

At capture time RTK fix_type was 3, corrections_fresh false, NTRIP streaming false, emergency stop asserted, RPP idle.
