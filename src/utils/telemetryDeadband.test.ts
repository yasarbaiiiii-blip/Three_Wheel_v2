import { describe, expect, it } from "vitest";
import {
  mergeTelemetrySnapshot,
  mergeSystemHealthFromTelemetry,
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
});
