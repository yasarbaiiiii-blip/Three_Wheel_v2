import assert from "node:assert/strict";
import test from "node:test";

import {
  backgroundJoystickState,
  canAcquireJoystick,
  cleanupPlanForJoystick,
  connectedJoystickState,
  joystickIntentDeadman,
  joystickIntentIsCentered,
  resolveAcquireErrorState,
  shouldRecoverFromInactiveTelemetry,
  telemetryInactiveClearsLocalLease,
} from "./joystickFrontendSafety.ts";

test("stale inactive telemetry does not cancel ACQUIRING", () => {
  assert.equal(telemetryInactiveClearsLocalLease("ACQUIRING"), false);
});

test("inactive telemetry clears held active and releasing local leases", () => {
  assert.equal(telemetryInactiveClearsLocalLease("HELD"), true);
  assert.equal(telemetryInactiveClearsLocalLease("ACTIVE"), true);
  assert.equal(telemetryInactiveClearsLocalLease("RELEASING"), true);
});

test("background uses suspended state instead of disconnected", () => {
  assert.equal(backgroundJoystickState(), "SUSPENDED");
});

test("acquire is blocked during mission or joystick ownership states", () => {
  assert.equal(
    canAcquireJoystick({ missionRunning: false, frontendState: "AVAILABLE", backendJoystickActive: false, controlOwner: "idle" }),
    true
  );
  assert.equal(
    canAcquireJoystick({ missionRunning: true, frontendState: "AVAILABLE", backendJoystickActive: false, controlOwner: "idle" }),
    false
  );
  assert.equal(
    canAcquireJoystick({ missionRunning: false, frontendState: "HELD", backendJoystickActive: false, controlOwner: "idle" }),
    false
  );
  assert.equal(
    canAcquireJoystick({ missionRunning: false, frontendState: "AVAILABLE", backendJoystickActive: true, controlOwner: "joystick" }),
    false
  );
  assert.equal(
    canAcquireJoystick({ missionRunning: false, frontendState: "AVAILABLE", backendJoystickActive: false, controlOwner: "mission" }),
    false
  );
});

test("move-to-activate requires an acquired lease and non-centred intent", () => {
  assert.equal(joystickIntentDeadman(false, { throttle: 0.1, steering: 0 }), false);
  assert.equal(joystickIntentDeadman(true, { throttle: 0, steering: 0 }), false);
  assert.equal(joystickIntentDeadman(true, { throttle: 0.1, steering: 0 }), true);
  assert.equal(joystickIntentDeadman(true, { throttle: 0, steering: -0.1 }), true);
});

test("centre and touch-end intent stop driving", () => {
  assert.equal(joystickIntentIsCentered({ throttle: 0, steering: 0 }), true);
  assert.equal(joystickIntentDeadman(true, { throttle: 0, steering: 0 }), false);
});

test("release cleanup forces neutral release stop and local clear", () => {
  assert.deepEqual(cleanupPlanForJoystick("release", true), {
    forceNeutral: true,
    releaseLease: true,
    stopScheduler: true,
    clearLocalControl: true,
    nextState: "AVAILABLE",
  });
});

test("acquire rejection always leaves ACQUIRING via resolveAcquireErrorState", () => {
  const cases = [
    ["mission_active", "BLOCKED_BY_MISSION"],
    ["joystick_active", "AVAILABLE"],
    ["manual_control_disabled", "ERROR"],
    ["transport_unavailable", "AVAILABLE"],
    ["mode_unavailable", "AVAILABLE"],
    ["malformed", "AVAILABLE"],
    ["unexpected_error", "AVAILABLE"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(resolveAcquireErrorState(code, true), expected, code);
    assert.notEqual(resolveAcquireErrorState(code, true), "ACQUIRING", code);
  }
});

test("release confirmation recovery uses AVAILABLE when socket is connected", () => {
  assert.equal(connectedJoystickState(true), "AVAILABLE");
  assert.equal(shouldRecoverFromInactiveTelemetry("RELEASING", false), true);
});

test("background disconnect and unmount cleanup stay distinct", () => {
  assert.deepEqual(cleanupPlanForJoystick("background", true), {
    forceNeutral: true,
    releaseLease: true,
    stopScheduler: true,
    clearLocalControl: true,
    nextState: "SUSPENDED",
  });
  assert.deepEqual(cleanupPlanForJoystick("disconnect", false), {
    forceNeutral: true,
    releaseLease: false,
    stopScheduler: true,
    clearLocalControl: true,
    nextState: "DISCONNECTED",
  });
  assert.deepEqual(cleanupPlanForJoystick("unmount", true), {
    forceNeutral: true,
    releaseLease: true,
    stopScheduler: true,
    clearLocalControl: true,
    nextState: null,
  });
});
