import { afterEach, describe, expect, it } from "vitest";
// @ts-ignore
const withAndroidMapboxToken = require("../../../plugins/withAndroidMapboxToken");

const ENV = "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN";
const original = process.env[ENV];

async function runStringsMod(strings: unknown[]) {
  const cfg = withAndroidMapboxToken({ name: "x", slug: "x" });
  const out = await cfg.mods.android.strings({
    ...cfg,
    modResults: { resources: { string: strings } },
    modRequest: { platform: "android", introspect: false },
  });
  return out.modResults.resources.string as Array<{ $: { name: string }; _: string }>;
}

describe("withAndroidMapboxToken Expo config plugin", () => {
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("refuses to prebuild without a Mapbox public token (the app would crash when a map opens)", async () => {
    delete process.env[ENV];
    await expect(runStringsMod([])).rejects.toThrow(ENV);
    process.env[ENV] = "sk.secret";
    await expect(runStringsMod([])).rejects.toThrow(ENV);
  });

  it("writes the token as the native mapbox_access_token string resource", async () => {
    process.env[ENV] = "pk.test";
    const strings = await runStringsMod([{ $: { name: "app_name" }, _: "DYX" }]);
    expect(strings.find((s) => s.$.name === "mapbox_access_token")?._).toBe("pk.test");
    expect(strings.find((s) => s.$.name === "app_name")?._).toBe("DYX");
  });

  it("replaces an existing token entry instead of duplicating it", async () => {
    process.env[ENV] = "pk.new";
    const strings = await runStringsMod([{ $: { name: "mapbox_access_token" }, _: "pk.old" }]);
    expect(strings.filter((s) => s.$.name === "mapbox_access_token")).toHaveLength(1);
    expect(strings[0]._).toBe("pk.new");
  });
});
