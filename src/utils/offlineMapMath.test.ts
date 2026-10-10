import { describe, expect, it } from "vitest";
import {
  estimateTileCount,
  isValidBounds,
  padBounds,
  planZoomRange,
  tilesAtZoom,
  type MapBounds,
} from "./offlineMapMath";

// ~250 m x ~170 m site near Chennai.
const SITE: MapBounds = [
  [80.2602, 13.0612],
  [80.2578, 13.0597],
];

describe("offlineMapMath", () => {
  it("one tile covers a tiny area at low zoom, more at high zoom", () => {
    expect(tilesAtZoom(SITE, 12)).toBe(1);
    expect(tilesAtZoom(SITE, 19)).toBeGreaterThan(tilesAtZoom(SITE, 16));
  });

  it("whole-world bounds at zoom 2 need 16 tiles (4 x 4)", () => {
    expect(tilesAtZoom([[179.9, 85], [-179.9, -85]], 2)).toBe(16);
  });

  it("a site-sized pack at z12-19 is far under the 6000-tile limit", () => {
    const n = estimateTileCount(SITE, 12, 19);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(500);
  });

  it("keeps full detail when the area is small", () => {
    const plan = planZoomRange(SITE);
    expect(plan.maxZoom).toBe(19);
    expect(plan.capped).toBe(false);
  });

  it("backs off detail for a large area so the pack never exceeds the budget", () => {
    // ~25 km x ~25 km
    const big: MapBounds = [[80.4, 13.2], [80.15, 12.97]];
    const plan = planZoomRange(big, { tileBudget: 5500 });
    expect(plan.capped).toBe(true);
    expect(plan.maxZoom).toBeLessThan(19);
    expect(plan.tiles).toBeLessThanOrEqual(5500);
    // And it is the HIGHEST zoom that fits: one more level would blow the budget.
    expect(estimateTileCount(big, plan.minZoom, plan.maxZoom + 1)).toBeGreaterThan(5500);
  });

  it("never returns a max zoom below the min zoom", () => {
    const huge: MapBounds = [[170, 80], [-170, -80]];
    const plan = planZoomRange(huge, { tileBudget: 10 });
    expect(plan.maxZoom).toBeGreaterThanOrEqual(plan.minZoom);
  });

  it("padBounds grows the box on every side and stays valid", () => {
    const p = padBounds(SITE, 0.25);
    expect(p[0][0]).toBeGreaterThan(SITE[0][0]);
    expect(p[0][1]).toBeGreaterThan(SITE[0][1]);
    expect(p[1][0]).toBeLessThan(SITE[1][0]);
    expect(p[1][1]).toBeLessThan(SITE[1][1]);
    expect(isValidBounds(p)).toBe(true);
  });

  it("rejects bounds that are inverted, non-finite or missing", () => {
    expect(isValidBounds(null)).toBe(false);
    expect(isValidBounds([[1, 1], [2, 2]])).toBe(false); // ne below/left of sw
    expect(isValidBounds([[Number.NaN, 1], [0, 0]])).toBe(false);
    expect(isValidBounds(SITE)).toBe(true);
  });
});
