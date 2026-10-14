import { describe, expect, it } from "vitest";
import type { TelemetrySnapshot } from "../../types/plan";
import { hasRoverFix, roverCenterFromSnapshot, roverTelemetryEqual, selectRoverTelemetry } from "./roverLayerModel";

const snap = (patch: Partial<TelemetrySnapshot> = {}) => ({ lat: 13, lon: 80, ...patch }) as TelemetrySnapshot;

describe("rover layer telemetry", () => {
  it("ignores fields that do not draw the rover", () => {
    expect(roverTelemetryEqual(selectRoverTelemetry(snap({ speed_m_s: 1 })), selectRoverTelemetry(snap({ speed_m_s: 9, pose_age_ms: 500 })))).toBe(true);
  });

  it.each(["lat", "lon", "ekf_lat", "ekf_lon", "heading_ned_deg", "mission_state", "projection_segment_index"] as const)("reacts to %s", (field) => {
    expect(roverTelemetryEqual(selectRoverTelemetry(snap()), selectRoverTelemetry(snap({ [field]: 1 } as Partial<TelemetrySnapshot>)))).toBe(false);
  });

  it("prefers a complete EKF pair and falls back atomically to GNSS", () => {
    expect(roverCenterFromSnapshot(snap({ ekf_lat: 13.1, ekf_lon: 80.1 }))).toEqual({ lat: 13.1, lon: 80.1 });
    expect(roverCenterFromSnapshot(snap({ ekf_lat: 13.1, ekf_lon: null }))).toEqual({ lat: 13, lon: 80 });
  });

  it("rejects non-finite and out-of-range coordinates", () => {
    expect(hasRoverFix(snap({ lat: NaN }))).toBe(false);
    expect(hasRoverFix(snap({ lat: 91 }))).toBe(false);
    expect(hasRoverFix(snap({ lon: 181 }))).toBe(false);
  });
});
