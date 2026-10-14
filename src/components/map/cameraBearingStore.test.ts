import { describe, expect, it, vi } from "vitest";
import { bearingDeltaDegrees, createCameraBearingStore } from "./cameraBearingStore";

describe("camera bearing store", () => {
  it("uses circular angular distance", () => {
    expect(bearingDeltaDegrees(359.6, 0.2)).toBeCloseTo(0.6);
  });

  it("skips sub-degree changes and keeps map instances isolated", () => {
    const a = createCameraBearingStore();
    const b = createCameraBearingStore();
    const heard = vi.fn();
    a.subscribe(heard);
    a.set(0.5);
    expect(heard).not.toHaveBeenCalled();
    a.set(2);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(a.getSnapshot()).toBe(2);
    expect(b.getSnapshot()).toBe(0);
  });
});
