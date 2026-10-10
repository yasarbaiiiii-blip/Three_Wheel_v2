import { describe, it, expect, beforeEach } from "vitest";
import {
  applyProdTelemetrySnapshot,
  clearProdTelemetry,
  getProdTelemetryState,
} from "../prodTelemetryStore";
import {
  getTelemetrySnapshot,
  getSystemHealth,
  applyTelemetryPacket,
} from "../telemetryStore";
import type { RoverTelemetrySnapshot } from "../../../contract/prod/realtime";
import { fcuLinkData, liveRover, missionData, pushRoverEvent } from "../../../test/roverEvents";

describe("Unified Telemetry Store", () => {
  beforeEach(() => {
    clearProdTelemetry();
    liveRover();
  });

  it("syncs from prodTelemetryStore into legacy telemetryStore with adapted fields", () => {
    const mockSnap: RoverTelemetrySnapshot = {
      gateway: { schema: 1, operator_alive: true, clients: 1 },
      vehicle_state: {
        age_s: 0.1,
        fresh: true,
        data: {
          position_valid: true,
          velocity_valid: true,
          attitude_valid: true,
          north_m: 12.34,
          east_m: 56.78,
          down_m: -0.5,
          velocity_north_mps: 1.0,
          velocity_east_mps: 0.0,
          heading_rad: 1.5707963, // 90 deg
          yaw_rate_radps: 0.0,
          arming_state: 2, // ARMED
          nav_state: 14, // OFFBOARD
          failsafe: false,
        },
      },
      estimator_health: null,
      rtk_status: {
        age_s: 0.1,
        fresh: true,
        data: {
          fix_type: 6, // RTK FIXED
          corrections_fresh: true,
          correction_age_s: 0.2,
          horizontal_accuracy_m: 0.012,
          satellites_used: 28,
        },
      },
      gnss_report: {
        age_s: 0.1,
        fresh: true,
        data: {
          valid: true,
          fix_type: 6,
          horizontal_accuracy_m: 0.012,
          satellites_used: 28,
          heading_rad: 1.5707963,
          latitude_deg: 37.7749,
          longitude_deg: -122.4194,
          altitude_msl_m: 15.0,
          hdop: 0.8,
        },
      },
      ntrip_status: null,
      px4_link: null,
      safety_gate: null,
      emergency_stop: {
        age_s: 0.1,
        fresh: true,
        data: {
          asserted: false,
          source: "",
        },
      },
      motion_guard: null,
      rpp: {
        age_s: 0.1,
        fresh: true,
        data: {
          state: 1, // TRACKING
          mission_id: 1,
          run_index: 0,
          cross_track_right_m: -0.03,
          commanded_speed_mps: 0.8,
          loop_jitter_max_us: 120,
          loop_overrun_count: 0,
        },
      },
      // Mission progress is read from mission_state rover events, not from the snapshot.
      mission: null,
      last_point_result: null,
      spray: null,
      recorder: null,
    };

    pushRoverEvent("mission_state", missionData({ state: 3, mission_id: 1, point_index: 4, path_artifact_sha256: "abc" }));
    applyProdTelemetrySnapshot(mockSnap);

    const legacySnap = getTelemetrySnapshot();
    expect(legacySnap).not.toBeNull();
    expect(legacySnap?.pos_n).toBe(12.34);
    expect(legacySnap?.pos_e).toBe(56.78);
    expect(legacySnap?.heading_ned_deg).toBeCloseTo(90, 0);
    expect(legacySnap?.armed).toBe(true);
    expect(legacySnap?.mode).toBe("OFFBOARD");
    expect(legacySnap?.gps_fix_name).toBe("RTK FIXED");
    expect(legacySnap?.rpp_state_name).toBe("TRACKING");
    expect(legacySnap?.mission_state).toBe("running");
    expect(legacySnap?.connected).toBe(true);

    const health = getSystemHealth();
    expect(health?.armed).toBe(true);
    expect(health?.mode).toBe("OFFBOARD");
    expect(health?.rpp_state).toBe("TRACKING");
    expect(health?.mission_state).toBe("running");
  });

  it("ignores prototype applyTelemetryPacket to prevent legacy pollution", () => {
    applyTelemetryPacket({
      pos_n: 999,
      pos_e: 888,
    });
    // Still null because applyTelemetryPacket was ignored
    expect(getTelemetrySnapshot()).toBeNull();
  });
});
