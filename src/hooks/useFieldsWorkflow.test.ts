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
  it("hides transit and extension during orderAndSpray step", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "orderAndSpray");
    expect(result.transit).toBe(false);
    expect(result.extension).toBe(false);
    expect(result.marking).toBe(true);
  });

  it("hides transit and extension during legacy pathOrder step", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "pathOrder");
    expect(result.transit).toBe(false);
    expect(result.extension).toBe(false);
    expect(result.marking).toBe(true);
  });

  it("hides transit and extension during legacy sprayVerify step", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "sprayVerify");
    expect(result.transit).toBe(false);
    expect(result.extension).toBe(false);
  });

  it("keeps all layers for other steps like align or upload", () => {
    expect(getEffectiveLayerVisibility(baseVisibility, "align")).toEqual(baseVisibility);
    expect(getEffectiveLayerVisibility(baseVisibility, "upload")).toEqual(baseVisibility);
    expect(getEffectiveLayerVisibility(baseVisibility, "alignDxf")).toEqual(baseVisibility);
  });
});