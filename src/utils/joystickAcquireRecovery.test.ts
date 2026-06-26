import { describe, expect, it } from "vitest";

import {
  connectedJoystickState,
  isBackendJoystickInactive,
  normalizeJoystickError,
  normalizeSocketError,
  requiresReacquireAfterJoystickError,
  resolveAcquireErrorState,
  shouldAcceptJoystickReleased,
  shouldClearLeaseForJoystickError,
  shouldRecoverFromInactiveTelemetry,
} from "./joystickFrontendSafety";

describe("acquire error recovery", () => {
  it("mission_active during ACQUIRING maps to BLOCKED_BY_MISSION", () => {
    expect(resolveAcquireErrorState("mission_active", true)).toBe("BLOCKED_BY_MISSION");
  });

  it("joystick_active during ACQUIRING maps to AVAILABLE", () => {
    expect(resolveAcquireErrorState("joystick_active", true)).toBe("AVAILABLE");
  });

  it("manual_control_disabled during ACQUIRING maps to ERROR", () => {
    expect(resolveAcquireErrorState("manual_control_disabled", true)).toBe("ERROR");
  });

  it("unknown acquire error never stays ACQUIRING", () => {
    const next = resolveAcquireErrorState("unexpected_error", true);
    expect(next).not.toBe("ACQUIRING");
    expect(next).toBe("AVAILABLE");
  });

  it("unknown acquire error with socket down maps to DISCONNECTED", () => {
    expect(resolveAcquireErrorState("unexpected_error", false)).toBe("DISCONNECTED");
  });

  it("does not use shouldClearLease to end acquire attempts", () => {
    expect(shouldClearLeaseForJoystickError("mission_active")).toBe(false);
    expect(resolveAcquireErrorState("mission_active", true)).toBe("BLOCKED_BY_MISSION");
    expect(requiresReacquireAfterJoystickError("mission_active", true)).toBe(false);
  });
});

describe("socket_error recovery", () => {
  it("normalizes unauthorised socket_error", () => {
    expect(normalizeSocketError({ reason: "unauthorised" })).toEqual({
      code: "unauthorised",
      message: "Authentication failed",
    });
  });

  it("maps unauthorised socket_error to ERROR state via acquire resolver", () => {
    expect(resolveAcquireErrorState("unauthorised", true)).toBe("ERROR");
  });
});

describe("release gating helpers", () => {
  it("accepts joystick_released for matching lease", () => {
    expect(
      shouldAcceptJoystickReleased({ lease_id: "lease-a" }, "lease-a", "RELEASING")
    ).toBe(true);
  });

  it("rejects joystick_released for foreign lease", () => {
    expect(
      shouldAcceptJoystickReleased({ lease_id: "lease-b" }, "lease-a", "RELEASING")
    ).toBe(false);
  });

  it("accepts broadcast release without lease_id when RELEASING", () => {
    expect(shouldAcceptJoystickReleased({}, null, "RELEASING")).toBe(true);
  });

  it("rejects broadcast release without lease_id when idle", () => {
    expect(shouldAcceptJoystickReleased({}, null, "AVAILABLE")).toBe(false);
  });
});

describe("telemetry recovery", () => {
  const inactiveTelemetry = {
    joystick_active: false,
    joystick_state: "inactive",
    control_owner: "idle",
  };

  it("detects backend joystick inactive", () => {
    expect(isBackendJoystickInactive(inactiveTelemetry)).toBe(true);
  });

  it("recovers RELEASING when backend is inactive and no local lease", () => {
    expect(shouldRecoverFromInactiveTelemetry("RELEASING", false)).toBe(true);
    expect(connectedJoystickState(true)).toBe("AVAILABLE");
  });

  it("recovers BLOCKED_BY_MISSION after mission completes", () => {
    expect(shouldRecoverFromInactiveTelemetry("BLOCKED_BY_MISSION", false)).toBe(true);
  });

  it("does not recover DISABLED from inactive telemetry", () => {
    expect(shouldRecoverFromInactiveTelemetry("DISABLED", false)).toBe(false);
  });

  it("does not recover while local lease is still held", () => {
    expect(shouldRecoverFromInactiveTelemetry("RELEASING", true)).toBe(false);
  });
});

describe("joystick error normalization", () => {
  it("normalizes joystick_error payloads", () => {
    expect(
      normalizeJoystickError({
        type: "joystick_error",
        code: "not_armed",
        message: "Vehicle must be armed",
      })
    ).toEqual({
      type: "joystick_error",
      code: "not_armed",
      message: "Vehicle must be armed",
    });
  });
});