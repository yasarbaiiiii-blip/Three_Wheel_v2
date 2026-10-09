import { describe, it, expect } from "vitest";
import {
  radToDeg,
  degToRad,
  wrapPi,
  wrap360,
  formatHeadingDeg,
  mpsToKph,
  formatSpeedMps,
  formatDistanceM,
} from "./units";

describe("Production contract - unit conversions", () => {
  it("converts radians to degrees accurately", () => {
    expect(radToDeg(0)).toBeCloseTo(0);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90);
    expect(radToDeg(Math.PI)).toBeCloseTo(180);
    expect(radToDeg(-Math.PI / 2)).toBeCloseTo(-90);
    expect(radToDeg(2 * Math.PI)).toBeCloseTo(360);
  });

  it("converts degrees to radians accurately", () => {
    expect(degToRad(0)).toBeCloseTo(0);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2);
    expect(degToRad(180)).toBeCloseTo(Math.PI);
    expect(degToRad(-90)).toBeCloseTo(-Math.PI / 2);
    expect(degToRad(360)).toBeCloseTo(2 * Math.PI);
  });

  it("handles non-finite numbers safely", () => {
    expect(radToDeg(NaN)).toBe(0);
    expect(radToDeg(Infinity)).toBe(0);
    expect(degToRad(NaN)).toBe(0);
    expect(wrapPi(NaN)).toBe(0);
    expect(wrap360(NaN)).toBe(0);
  });

  it("wraps radians to [-pi, pi]", () => {
    expect(wrapPi(0)).toBeCloseTo(0);
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapPi(-Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapPi(2.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI);
    expect(wrapPi(-2.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI);
  });

  it("wraps degrees to [0, 360)", () => {
    expect(wrap360(0)).toBe(0);
    expect(wrap360(360)).toBe(0);
    expect(wrap360(450)).toBe(90);
    expect(wrap360(-90)).toBe(270);
    expect(wrap360(-360)).toBe(0);
    expect(wrap360(-450)).toBe(270);
  });

  it("formats heading degrees correctly", () => {
    expect(formatHeadingDeg(null)).toBe("--");
    expect(formatHeadingDeg(undefined)).toBe("--");
    expect(formatHeadingDeg(NaN)).toBe("--");
    expect(formatHeadingDeg(0)).toBe("0.0°");
    expect(formatHeadingDeg(Math.PI / 2)).toBe("90.0°");
    expect(formatHeadingDeg(-Math.PI / 2)).toBe("270.0°");
    expect(formatHeadingDeg(Math.PI)).toBe("180.0°");
  });

  it("converts m/s to km/h", () => {
    expect(mpsToKph(1)).toBeCloseTo(3.6);
    expect(mpsToKph(10)).toBeCloseTo(36.0);
    expect(mpsToKph(0)).toBe(0);
  });

  it("formats speed and distance", () => {
    expect(formatSpeedMps(null)).toBe("--");
    expect(formatSpeedMps(1.234)).toBe("1.23 m/s");
    expect(formatDistanceM(null)).toBe("--");
    expect(formatDistanceM(5.678)).toBe("5.68 m");
  });
});
