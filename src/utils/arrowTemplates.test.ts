import { describe, expect, it } from "vitest";

import { generateArrowLines, templateBoundsM } from "./arrowTemplates";

describe("generateArrowLines", () => {
  it("builds a finite north arrow with length near the requested size", () => {
    const lines = generateArrowLines("up", 2);
    expect(lines.length).toBeGreaterThan(0);
    const b = templateBoundsM(lines);
    expect(b.heightM).toBeGreaterThan(1.5);
    expect(b.heightM).toBeLessThan(2.2);
    expect(lines.every((l) => Number.isFinite(l.from.x) && Number.isFinite(l.to.y))).toBe(true);
  });

  it("east and west arrows are wider than tall", () => {
    const east = templateBoundsM(generateArrowLines("right", 2));
    expect(east.widthM).toBeGreaterThan(east.heightM);
  });
});
