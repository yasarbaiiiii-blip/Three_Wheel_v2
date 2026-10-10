import { describe, it, expect, afterEach } from "vitest";
import { applyProdTelemetrySnapshot, clearProdTelemetry } from "../prodTelemetryStore";
import {
  setTelemetrySnapshot,
  snapshotsEquivalent,
  subscribeTelemetry,
} from "../telemetryStore";
import type { TelemetrySnapshot } from "../../../types/plan";

const entry = (data: unknown) => ({ age_s: 0.05, fresh: true, data });

function pushPacket(northM: number, arming = 1) {
  applyProdTelemetrySnapshot(
    {
      gateway: { schema: 1, operator_alive: true, clients: 1 },
      vehicle_state: entry({
        position_valid: true,
        velocity_valid: true,
        attitude_valid: true,
        north_m: northM,
        east_m: 2,
        down_m: 0,
        velocity_north_mps: 0,
        velocity_east_mps: 0,
        heading_rad: 0,
        yaw_rate_radps: 0,
        arming_state: arming,
        nav_state: 0,
        failsafe: false,
      }),
    } as never,
    true
  );
}

afterEach(() => {
  clearProdTelemetry();
  setTelemetrySnapshot(null);
});

describe("snapshotsEquivalent", () => {
  const base: TelemetrySnapshot = { pos_n: 1, pos_e: 2, armed: false, pose_age_ms: 100 };

  it("treats a pure pose-age tick as unchanged", () => {
    expect(snapshotsEquivalent(base, { ...base, pose_age_ms: 140 })).toBe(true);
  });

  it("sees a real value change", () => {
    expect(snapshotsEquivalent(base, { ...base, pos_n: 1.01 })).toBe(false);
    expect(snapshotsEquivalent(base, { ...base, armed: true })).toBe(false);
  });

  it("sees a value going stale (nulled by the adapter)", () => {
    expect(snapshotsEquivalent(base, { ...base, pos_n: null, pos_e: null })).toBe(false);
  });

  it("sees age crossing a bucket", () => {
    expect(snapshotsEquivalent(base, { ...base, pose_age_ms: 700 })).toBe(false);
  });

  it("handles null on either side", () => {
    expect(snapshotsEquivalent(null, null)).toBe(true);
    expect(snapshotsEquivalent(base, null)).toBe(false);
    expect(snapshotsEquivalent(null, base)).toBe(false);
  });
});

describe("telemetry store emits", () => {
  it("does not emit on the 250 ms ageing ticker when nothing changed", async () => {
    pushPacket(1);
    let emits = 0;
    const unsub = subscribeTelemetry(() => emits++);
    await new Promise((r) => setTimeout(r, 900));
    unsub();
    // Before the fix this was ~3-4 (one per ticker tick). Allow the single
    // half-second pose-age bucket crossing, nothing more.
    expect(emits).toBeLessThanOrEqual(2);
  });

  it("still emits when a packet changes the pose", async () => {
    pushPacket(1);
    let emits = 0;
    const unsub = subscribeTelemetry(() => emits++);
    pushPacket(5);
    unsub();
    expect(emits).toBeGreaterThanOrEqual(1);
  });
});
