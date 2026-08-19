import { describe, expect, it } from "vitest";
import {
  mergeTelemetrySnapshot,
  mergeSystemHealthFromTelemetry,
  normalizeTelemetryPacket,
  withinDeadband,
  POSITION_DEADBAND_M,
} from "./telemetryDeadband";
import type { TelemetrySnapshot } from "../types/plan";

describe("telemetryDeadband", () => {
  it("withinDeadband treats tiny position noise as equal", () => {
    expect(withinDeadband(1, 1 + POSITION_DEADBAND_M / 2, POSITION_DEADBAND_M)).toBe(true);
    expect(withinDeadband(1, 1 + POSITION_DEADBAND_M * 2, POSITION_DEADBAND_M)).toBe(false);
  });

  it("mergeTelemetrySnapshot returns prev when only noise changed", () => {
    const prev = {
      pos_n: 10,
      pos_e: 20,
      armed: false,
      mode: "MANUAL",
    } as TelemetrySnapshot;
    const next = {
      ...prev,
      pos_n: 10 + POSITION_DEADBAND_M / 3,
      pos_e: 20 - POSITION_DEADBAND_M / 3,
    };
    expect(mergeTelemetrySnapshot(prev, next)).toBe(prev);
  });

  it("mergeTelemetrySnapshot updates on armed change even if position is equal", () => {
    const prev = { pos_n: 1, pos_e: 2, armed: false, mode: "MANUAL" } as TelemetrySnapshot;
    const next = { ...prev, armed: true };
    const merged = mergeTelemetrySnapshot(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged.armed).toBe(true);
  });

  it("mergeSystemHealthFromTelemetry preserves mission_state", () => {
    const prev = { mission_state: "running", armed: false, mode: "AUTO" };
    const data = { armed: true, mode: "AUTO", connected: true } as TelemetrySnapshot & {
      connected?: boolean;
    };
    const health = mergeSystemHealthFromTelemetry(prev, data);
    expect(health.mission_state).toBe("running");
    expect(health.armed).toBe(true);
  });

  it("does not wipe last-known pose when a sparse packet omits or nulls it", () => {
    const prev = {
      pos_n: 12.3,
      pos_e: -4.1,
      lat: 25.1,
      lon: 55.2,
      armed: true,
      mode: "AUTO",
    } as TelemetrySnapshot;
    const merged = mergeTelemetrySnapshot(prev, {
      armed: true,
      mode: "AUTO",
      pos_n: null,
      lat: undefined,
    } as TelemetrySnapshot);
    expect(merged.pos_n).toBe(12.3);
    expect(merged.lat).toBe(25.1);
    expect(merged.pos_e).toBe(-4.1);
  });

  it("applies discrete mission_state even when pose is unchanged", () => {
    const prev = { pos_n: 1, pos_e: 2, mission_state: "idle" } as TelemetrySnapshot;
    const merged = mergeTelemetrySnapshot(prev, {
      pos_n: 1,
      pos_e: 2,
      mission_state: "running",
    });
    expect(merged.mission_state).toBe("running");
  });
});

describe("normalizeTelemetryPacket", () => {
  it("reads aliases and unwraps a nested telemetry envelope", () => {
    const packet = normalizeTelemetryPacket({
      telemetry: {
        north: 3.5,
        east: -1.25,
        latitude: 25.2,
        longitude: 55.3,
        heading: 90,
        speed: 0.4,
      },
    });
    expect(packet).toMatchObject({
      pos_n: 3.5,
      pos_e: -1.25,
      lat: 25.2,
      lon: 55.3,
      heading_ned_deg: 90,
      speed_m_s: 0.4,
    });
  });

  it("returns null for empty junk and omits missing numeric fields", () => {
    expect(normalizeTelemetryPacket(null)).toBeNull();
    const packet = normalizeTelemetryPacket({ armed: true, mode: "MANUAL" });
    expect(packet).toEqual({ armed: true, mode: "MANUAL" });
    expect(packet && "pos_n" in packet).toBe(false);
  });

  it("keeps root pose when a nested telemetry object has no position", () => {
    const packet = normalizeTelemetryPacket({
      pos_n: 12.5,
      pos_e: -3.1,
      lat: 13.08,
      lon: 80.27,
      telemetry: { battery_pct: 88, mode: "AUTO" },
    });
    expect(packet).toMatchObject({
      pos_n: 12.5,
      pos_e: -3.1,
      lat: 13.08,
      lon: 80.27,
    });
  });

  it("prefers root pose over a nested telemetry pose", () => {
    const packet = normalizeTelemetryPacket({
      pos_n: 1,
      pos_e: 2,
      telemetry: { north: 99, east: 98 },
    });
    expect(packet).toMatchObject({ pos_n: 1, pos_e: 2 });
  });
});
