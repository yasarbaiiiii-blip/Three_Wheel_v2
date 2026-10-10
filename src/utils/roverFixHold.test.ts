import { describe, expect, it } from "vitest";
import { resolveRoverMarker } from "./roverFixHold";

type C = [number, number];

describe("resolveRoverMarker", () => {
  it("draws a live fix as fresh and remembers it", () => {
    const r = resolveRoverMarker<C>({ center: [80, 13], heading: 90 }, null);
    expect(r.marker).toEqual({ center: [80, 13], heading: 90, stale: false });
    expect(r.last).toEqual({ center: [80, 13], heading: 90 });
  });

  it("keeps the last fix, flagged stale, when telemetry goes missing", () => {
    const first = resolveRoverMarker<C>({ center: [80, 13], heading: 90 }, null);
    const r = resolveRoverMarker<C>({ center: null, heading: null }, first.last);
    expect(r.marker).toEqual({ center: [80, 13], heading: 90, stale: true });
  });

  it("draws nothing only when the rover has never been seen", () => {
    expect(resolveRoverMarker<C>({ center: null, heading: null }, null).marker).toBeNull();
  });

  it("recovers to fresh as soon as a new fix arrives", () => {
    const stale = resolveRoverMarker<C>({ center: null, heading: null }, { center: [1, 2], heading: 10 });
    const back = resolveRoverMarker<C>({ center: [3, 4], heading: 20 }, stale.last);
    expect(back.marker).toEqual({ center: [3, 4], heading: 20, stale: false });
  });

  it("keeps the previous heading when a fresh position has no valid heading", () => {
    const r = resolveRoverMarker<C>({ center: [3, 4], heading: null }, { center: [1, 2], heading: 135 });
    expect(r.marker?.heading).toBe(135);
    expect(r.marker?.stale).toBe(false);
  });
});
