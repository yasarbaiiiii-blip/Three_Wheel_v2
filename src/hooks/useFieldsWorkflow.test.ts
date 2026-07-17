import { describe, expect, it } from "vitest";

import { getEffectiveLayerVisibility, getEffectiveLayerVisibilityLegacy } from "./useFieldsWorkflow";

const baseVisibility = {
  boundary: true,
  marking: true,
  center: true,
  transit: true,
  extension: true,
};

describe("getEffectiveLayerVisibility", () => {
  it("keeps the full plan (including transit + extension) during orderAndSpray", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "orderAndSpray");
    expect(result).toEqual(baseVisibility);
    expect(result.transit).toBe(true);
    expect(result.extension).toBe(true);
  });

  it("keeps the full plan during legacy pathOrder step", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "pathOrder");
    expect(result.transit).toBe(true);
    expect(result.extension).toBe(true);
    expect(result.marking).toBe(true);
  });

  it("keeps the full plan during legacy sprayVerify step", () => {
    const result = getEffectiveLayerVisibility(baseVisibility, "sprayVerify");
    expect(result.transit).toBe(true);
    expect(result.extension).toBe(true);
  });

  it("keeps all layers for other steps like align or upload", () => {
    expect(getEffectiveLayerVisibility(baseVisibility, "align")).toEqual(baseVisibility);
    expect(getEffectiveLayerVisibility(baseVisibility, "upload")).toEqual(baseVisibility);
    expect(getEffectiveLayerVisibility(baseVisibility, "alignDxf")).toEqual(baseVisibility);
  });

  it("does not revive layers the operator already turned off", () => {
    const hiddenTransit = { ...baseVisibility, transit: false, extension: false };
    expect(getEffectiveLayerVisibility(hiddenTransit, "orderAndSpray")).toEqual(hiddenTransit);
  });
});

describe("getEffectiveLayerVisibilityLegacy", () => {
  it("matches the full-plan policy for pathOrder accordion", () => {
    expect(getEffectiveLayerVisibilityLegacy(baseVisibility, "pathOrder")).toEqual(baseVisibility);
  });
});
