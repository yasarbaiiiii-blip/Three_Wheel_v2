import { describe, it, expect } from "vitest";
// @ts-ignore
const { assertMapboxToken } = require("../../../plugins/withRequiredMapboxToken");

describe("withRequiredMapboxToken Expo config plugin", () => {
  it("refuses to build without a Mapbox public token (the app would crash when a map opens)", () => {
    expect(() => assertMapboxToken({})).toThrow(/EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN/);
    expect(() => assertMapboxToken({ EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "  " })).toThrow();
    expect(() => assertMapboxToken({ EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "sk.secret" })).toThrow(/pk\./);
  });

  it("accepts a public pk. token", () => {
    expect(() => assertMapboxToken({ EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.abc" })).not.toThrow();
  });
});
