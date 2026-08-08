import { describe, expect, it } from "vitest";

import { bearingFromOffset } from "./compassDialMath";

describe("bearingFromOffset", () => {
  it("straight up -> 0 deg (north)", () => {
    expect(bearingFromOffset(0, -10)).toBeCloseTo(0, 6);
  });

  it("straight right -> 90 deg (east)", () => {
    expect(bearingFromOffset(10, 0)).toBeCloseTo(90, 6);
  });

  it("straight down -> 180 deg (south)", () => {
    expect(bearingFromOffset(0, 10)).toBeCloseTo(180, 6);
  });

  it("straight left -> 270 deg (west)", () => {
    expect(bearingFromOffset(-10, 0)).toBeCloseTo(270, 6);
  });

  it("northeast intercardinal -> 45 deg", () => {
    expect(bearingFromOffset(10, -10)).toBeCloseTo(45, 6);
  });

  it("southwest intercardinal -> 225 deg", () => {
    expect(bearingFromOffset(-10, 10)).toBeCloseTo(225, 6);
  });

  it("normalizes negative atan2 results into [0,360)", () => {
    const b = bearingFromOffset(-1, 0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
    expect(b).toBeCloseTo(270, 6);
  });

  it("is magnitude-independent -- same bearing at any distance from center", () => {
    const near = bearingFromOffset(1, -1);
    const far = bearingFromOffset(100, -100);
    expect(near).toBeCloseTo(45, 6);
    expect(far).toBeCloseTo(45, 6);
  });

  it("dead-center touch resolves to a deterministic finite bearing, not NaN", () => {
    // The exact value at (0,0) is an IEEE-754 atan2(+0,-0) edge case (=180 deg) and isn't
    // meaningful on its own -- CompassDial guards real dead-center taps with its own
    // dead-zone before calling this. What matters here is determinism, not the value.
    const b = bearingFromOffset(0, 0);
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBe(bearingFromOffset(0, 0));
  });
});
