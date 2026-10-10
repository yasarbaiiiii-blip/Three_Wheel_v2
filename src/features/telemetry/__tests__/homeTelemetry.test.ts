import { describe, it, expect, beforeEach } from "vitest";
import {
  applyProdTelemetrySnapshot,
  clearProdTelemetry,
  getAdaptedTelemetrySnapshot,
} from "../prodTelemetryStore";
import {
  batteryPercentOrNull,
  entryAgeMs,
  gpsFixSeverity,
  positiveOrNull,
  rppBlockedReason,
  usableData,
} from "../telemetryDerive";
import type { RoverTelemetrySnapshot, SnapshotEntry } from "../../../contract/prod/realtime";

function entry<T>(data: T, over: Partial<SnapshotEntry<T>> = {}): SnapshotEntry<T> {
  return { age_s: 0.1, fresh: true, data, ...over };
}

function baseSnapshot(over: Partial<RoverTelemetrySnapshot> = {}): RoverTelemetrySnapshot {
  return {
    vehicle_state: entry({
      position_valid: true,
      velocity_valid: true,
      attitude_valid: true,
      north_m: 1,
      east_m: 2,
      down_m: 0,
      velocity_north_mps: 0.3,
      velocity_east_mps: 0.4,
      heading_rad: Math.PI / 2,
      yaw_rate_radps: 0,
      arming_state: 2,
      nav_state: 14,
      failsafe: false,
    }),
    estimator_health: null,
    rtk_status: entry({
      fix_type: 6,
      corrections_fresh: true,
      correction_age_s: 0.2,
      horizontal_accuracy_m: 0.012,
      satellites_used: 24,
    }),
    gnss_report: entry({
      valid: true,
      fix_type: 6,
      horizontal_accuracy_m: 0.012,
      satellites_used: 24,
      heading_rad: 0,
      latitude_deg: 13.0,
      longitude_deg: 80.0,
      altitude_msl_m: 10,
      hdop: 0.8,
    }),
    ntrip_status: null,
    px4_link: entry({
      session_alive: true,
      handshake_ok: true,
      offboard_heartbeat_active: false,
      failing_to_zero: false,
      fault: 0,
      stale_topics_mask: 0,
      worst_topic_age_s: 0,
      session_resets: 0,
      timesync_valid: true,
      timesync_offset_us: 0,
      timesync_round_trip_us: 0,
      rtcm_chunks_accepted: 0,
      rtcm_chunks_dropped: 0,
    }),
    safety_gate: null,
    emergency_stop: null,
    motion_guard: null,
    rpp: entry({
      state: 1,
      mission_id: 1,
      run_index: 0,
      cross_track_right_m: 0.02,
      commanded_speed_mps: 0.5,
      loop_jitter_max_us: 0,
      loop_overrun_count: 0,
    }),
    mission: null,
    last_point_result: null,
    spray: null,
    recorder: null,
    ...over,
  };
}

function adapted(snap: RoverTelemetrySnapshot) {
  applyProdTelemetrySnapshot(snap);
  const out = getAdaptedTelemetrySnapshot();
  expect(out).not.toBeNull();
  return out!;
}

describe("Home telemetry derivation", () => {
  beforeEach(() => clearProdTelemetry());

  it("fills the Home values from fresh sections", () => {
    const t = adapted(baseSnapshot());
    expect(t.gps_fix_name).toBe("RTK FIXED");
    expect(t.gps_sat).toBe(24);
    expect(t.hrms).toBeCloseTo(0.012);
    expect(t.lat).toBe(13.0);
    expect(t.lon).toBe(80.0);
    expect(t.xtrack_m).toBeCloseTo(0.02);
    expect(t.speed_m_s).toBeCloseTo(0.5);
    expect(t.rpp_state_name).toBe("TRACKING");
    expect(t.fcu_connected).toBe(true);
  });

  it("reports pose age of the vehicle pose, not of the packet", () => {
    const t = adapted(
      baseSnapshot({ vehicle_state: { ...baseSnapshot().vehicle_state!, age_s: 0.8 } })
    );
    expect(t.pose_age_ms).toBeGreaterThanOrEqual(800);
    expect(t.pose_age_ms).toBeLessThan(900);
  });

  it("treats a stale section as unknown", () => {
    const base = baseSnapshot();
    const t = adapted(
      baseSnapshot({
        rpp: { ...base.rpp!, fresh: false },
        rtk_status: { ...base.rtk_status!, fresh: false },
        gnss_report: { ...base.gnss_report!, fresh: false },
        vehicle_state: { ...base.vehicle_state!, fresh: false },
      })
    );
    expect(t.xtrack_m).toBeNull();
    expect(t.rpp_state_name).toBeNull();
    expect(t.gps_fix).toBeNull();
    expect(t.gps_fix_name).toBe("NO DATA");
    expect(t.gps_sat).toBeNull();
    expect(t.hrms).toBeNull();
    expect(t.lat).toBeNull();
    expect(t.pos_n).toBeNull();
    expect(t.speed_m_s).toBeNull();
  });

  it("treats accuracy 0 as unknown and a missing vertical accuracy as null", () => {
    const base = baseSnapshot();
    const t = adapted(
      baseSnapshot({
        rtk_status: entry({ ...base.rtk_status!.data, horizontal_accuracy_m: 0 }),
        gnss_report: entry({ ...base.gnss_report!.data, horizontal_accuracy_m: 0 }),
      })
    );
    expect(t.hrms).toBeNull();
    expect(t.vrms).toBeNull();
  });

  it("reads vertical accuracy when the gateway sends it", () => {
    const base = baseSnapshot();
    const t = adapted(
      baseSnapshot({ gnss_report: entry({ ...base.gnss_report!.data, vertical_accuracy_m: 0.02 }) })
    );
    expect(t.vrms).toBeCloseTo(0.02);
  });

  it("hides position when the receiver says it is invalid or NaN", () => {
    const base = baseSnapshot();
    const invalid = adapted(
      baseSnapshot({ gnss_report: entry({ ...base.gnss_report!.data, valid: false }) })
    );
    expect(invalid.lat).toBeNull();
    expect(invalid.lon).toBeNull();

    clearProdTelemetry();
    const nan = adapted(
      baseSnapshot({ gnss_report: entry({ ...base.gnss_report!.data, latitude_deg: NaN }) })
    );
    expect(nan.lat).toBeNull();
  });

  it("FCU is connected only when the PX4 link is alive and fresh", () => {
    const base = baseSnapshot();
    expect(adapted(baseSnapshot({ px4_link: null })).fcu_connected).toBe(false);

    clearProdTelemetry();
    expect(
      adapted(baseSnapshot({ px4_link: entry({ ...base.px4_link!.data, session_alive: false }) }))
        .fcu_connected
    ).toBe(false);

    clearProdTelemetry();
    expect(
      adapted(baseSnapshot({ px4_link: entry({ ...base.px4_link!.data, handshake_ok: false }) }))
        .fcu_connected
    ).toBe(false);

    clearProdTelemetry();
    expect(
      adapted(baseSnapshot({ px4_link: { ...base.px4_link!, fresh: false } })).fcu_connected
    ).toBe(false);
  });

  it("never invents a battery value", () => {
    const none = adapted(baseSnapshot());
    expect(none.battery_pct).toBeNull();
    expect(none.battery_v).toBeNull();
    expect(none.battery_a).toBeNull();

    clearProdTelemetry();
    const some = adapted(
      baseSnapshot({ battery: entry({ voltage_v: 25.1, current_a: 3.4, remaining_pct: 82 }) })
    );
    expect(some.battery_pct).toBe(82);
    expect(some.battery_v).toBe(25.1);
    expect(some.battery_a).toBe(3.4);
  });

  it("reads heading error, distance to goal and the RPP block reason when sent", () => {
    const base = baseSnapshot();
    const t = adapted(
      baseSnapshot({
        rpp: entry({
          ...base.rpp!.data,
          heading_error_rad: Math.PI / 6,
          dist_to_goal_m: 12.5,
          tick_state: 4,
          rtk_reason: 6,
        }),
      })
    );
    expect(t.heading_err_deg).toBeCloseTo(30, 1);
    expect(t.dist_to_goal_m).toBe(12.5);
    expect(t.rpp_blocked_reason).toBe("RTK WAIT · accuracy too large");
  });

  it("leaves heading error and distance null when the gateway does not send them", () => {
    const t = adapted(baseSnapshot());
    expect(t.heading_err_deg).toBeNull();
    expect(t.dist_to_goal_m).toBeNull();
    expect(t.rpp_blocked_reason).toBeNull();
  });

  it("does not show a block reason while RPP is idle", () => {
    const base = baseSnapshot();
    const t = adapted(
      baseSnapshot({ rpp: entry({ ...base.rpp!.data, state: 0, tick_state: -1, rtk_reason: 1 }) })
    );
    expect(t.rpp_blocked_reason).toBeNull();
  });
});

describe("telemetryDerive helpers", () => {
  it("gpsFixSeverity: fixed ok, float and dgps warn, rest bad", () => {
    expect(gpsFixSeverity("RTK FIXED")).toBe("ok");
    expect(gpsFixSeverity("RTK Fixed")).toBe("ok");
    expect(gpsFixSeverity("RTK FLOAT")).toBe("warn");
    expect(gpsFixSeverity("DGPS")).toBe("warn");
    expect(gpsFixSeverity("3D FIX")).toBe("bad");
    expect(gpsFixSeverity("NO FIX")).toBe("bad");
    expect(gpsFixSeverity("NO DATA")).toBe("bad");
    expect(gpsFixSeverity(null)).toBe("bad");
  });

  it("positiveOrNull rejects 0, negatives, NaN and non-numbers", () => {
    expect(positiveOrNull(0.01)).toBe(0.01);
    expect(positiveOrNull(0)).toBeNull();
    expect(positiveOrNull(-1)).toBeNull();
    expect(positiveOrNull(NaN)).toBeNull();
    expect(positiveOrNull("1")).toBeNull();
    expect(positiveOrNull(undefined)).toBeNull();
  });

  it("usableData and entryAgeMs", () => {
    expect(usableData(null)).toBeNull();
    expect(usableData({ age_s: 0, fresh: false, data: 1 })).toBeNull();
    expect(usableData({ age_s: 0, fresh: true, data: 1 })).toBe(1);
    expect(entryAgeMs({ age_s: 0.5, fresh: true, data: 1 }, 100)).toBe(600);
    expect(entryAgeMs(null, 100)).toBeNull();
    expect(entryAgeMs({ age_s: 0.5, fresh: true, data: 1 }, Infinity)).toBeNull();
  });

  it("rppBlockedReason names only blocking states", () => {
    expect(rppBlockedReason(4, 0)).toBe("RTK WAIT");
    expect(rppBlockedReason(5, null)).toBe("JUMP SKIP");
    expect(rppBlockedReason(-1, 2)).toBe("STALE · RTK stale");
    expect(rppBlockedReason(1, 0)).toBeNull();
    expect(rppBlockedReason(undefined, undefined)).toBeNull();
    expect(rppBlockedReason(1, 3)).toBe("fix below minimum");
  });

  it("batteryPercentOrNull clamps and rejects unknown", () => {
    expect(batteryPercentOrNull(82)).toBe(82);
    expect(batteryPercentOrNull(140)).toBe(100);
    expect(batteryPercentOrNull(-3)).toBe(0);
    expect(batteryPercentOrNull(null)).toBeNull();
    expect(batteryPercentOrNull(NaN)).toBeNull();
  });
});
