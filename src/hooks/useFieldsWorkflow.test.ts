import { describe, expect, it } from "vitest";

import { getEffectiveLayerVisibility } from "./useFieldsWorkflow";

const baseVisibility = {
  boundary: true,
  marking: true,
  center: true,
  transit: true,
  extension: true,
};

describe("getEffectiveLayerVisibility", () => {
  it("hides transit and extension during path order", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "pathOrder");
    expect(result.transit).toBe(false);
    expect(result.extension).toBe(false);
    expect(result.marking).toBe(true);
  });

  it("hides transit and extension during spray verification", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "sprayVerify");
    expect(result.transit).toBe(false);
    expect(result.extension).toBe(false);
  });

  it("keeps all layers for other accordions", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "alignDxf");
    expect(result).toEqual(baseVisibility);
  });
});