import assert from "node:assert/strict";
import test from "node:test";

import {
  JoystickCommandSerializer,
  safeCommandIntervalMs,
} from "./joystickCommandScheduler.ts";

function session(overrides = {}) {
  return {
    auth: "token",
    sessionId: "session-1",
    leaseId: "lease-1",
    commandRateHz: 20,
    maxThrottle: 0.15,
    maxSteering: 0.5,
    ...overrides,
  };
}

test("safe command interval stays below backend max rate", () => {
  assert.equal(safeCommandIntervalMs(20), 55);
});

test("sequence increments only when a command is emitted", () => {
  const serializer = new JoystickCommandSerializer();
  const first = serializer.build(session(), { deadman: false, throttle: 0, steering: 0 }, 100);
  assert.equal(first.emitted, true);
  assert.equal(first.payload.sequence, 1);
  assert.equal(first.payload.auth, "token");

  const tooSoon = serializer.build(session(), { deadman: true, throttle: 0.1, steering: 0.1 }, 120);
  assert.equal(tooSoon.emitted, false);
  assert.equal(tooSoon.reason, "too_soon");
  assert.equal(serializer.getSequence(), 1);

  const second = serializer.build(session(), { deadman: true, throttle: 0.1, steering: 0.1 }, 155);
  assert.equal(second.emitted, true);
  assert.equal(second.payload.sequence, 2);
});

test("no send without lease and rejected send does not increment sequence", () => {
  const serializer = new JoystickCommandSerializer();
  const result = serializer.build(session({ leaseId: null }), { deadman: true, throttle: 0.1, steering: 0.1 }, 100);
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "no_lease");
  assert.equal(serializer.getSequence(), 0);
});

test("non-finite values are rejected before sequence increment", () => {
  const serializer = new JoystickCommandSerializer();
  const result = serializer.build(session(), { deadman: true, throttle: Number.NaN, steering: 0 }, 100);
  assert.equal(result.emitted, false);
  assert.equal(result.reason, "invalid_value");
  assert.equal(serializer.getSequence(), 0);
});

test("values are clamped to acquired limits", () => {
  const serializer = new JoystickCommandSerializer();
  const result = serializer.build(session(), { deadman: true, throttle: 1, steering: -1 }, 100);
  assert.equal(result.emitted, true);
  assert.equal(result.payload.throttle, 0.15);
  assert.equal(result.payload.steering, -0.5);
});

test("deadman false always emits neutral and prevents stale nonzero frame", () => {
  const serializer = new JoystickCommandSerializer();
  const active = serializer.build(session(), { deadman: true, throttle: 0.12, steering: 0.2 }, 100);
  assert.equal(active.emitted, true);

  const urgentTooSoon = serializer.build(session(), { deadman: false, throttle: 0.12, steering: 0.2 }, 120);
  assert.equal(urgentTooSoon.emitted, false);
  assert.equal(urgentTooSoon.reason, "too_soon");

  const urgent = serializer.build(session(), { deadman: false, throttle: 0.12, steering: 0.2 }, 155);
  assert.equal(urgent.emitted, true);
  assert.equal(urgent.payload.sequence, 2);
  assert.equal(urgent.payload.deadman, false);
  assert.equal(urgent.payload.throttle, 0);
  assert.equal(urgent.payload.steering, 0);
});

test("periodic sends cannot be faster than minimum spacing after urgent neutral", () => {
  const serializer = new JoystickCommandSerializer();
  assert.equal(serializer.build(session(), { deadman: true, throttle: 0.1, steering: 0 }, 100).emitted, true);
  assert.equal(serializer.build(session(), { deadman: false, throttle: 0, steering: 0 }, 155).emitted, true);

  const periodicCollision = serializer.build(session(), { deadman: true, throttle: 0.1, steering: 0 }, 180);
  assert.equal(periodicCollision.emitted, false);
  assert.equal(periodicCollision.reason, "too_soon");

  const nextPeriodic = serializer.build(session(), { deadman: true, throttle: 0.1, steering: 0 }, 210);
  assert.equal(nextPeriodic.emitted, true);
  assert.equal(nextPeriodic.payload.sequence, 3);
});

test("one-finger move emits deadman true motion after acquire", () => {
  const serializer = new JoystickCommandSerializer();
  const move = serializer.build(session(), { deadman: true, throttle: 0.1, steering: -0.2 }, 100);
  assert.equal(move.emitted, true);
  assert.equal(move.payload.deadman, true);
  assert.equal(move.payload.throttle, 0.1);
  assert.equal(move.payload.steering, -0.2);
});

test("touch-end stop emits deadman false neutral after motion", () => {
  const serializer = new JoystickCommandSerializer();
  assert.equal(serializer.build(session(), { deadman: true, throttle: 0.1, steering: 0.1 }, 100).emitted, true);
  const stop = serializer.build(session(), { deadman: false, throttle: 0, steering: 0 }, 155);
  assert.equal(stop.emitted, true);
  assert.equal(stop.payload.deadman, false);
  assert.equal(stop.payload.throttle, 0);
  assert.equal(stop.payload.steering, 0);
});
