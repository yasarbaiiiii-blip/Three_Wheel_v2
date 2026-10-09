const { withStringsXml } = require("@expo/config-plugins");

// Mapbox creates its native view before an asynchronous JS setAccessToken call
// can finish. Give Android the public token at view creation time.
module.exports = (config) =>
  withStringsXml(config, (config) => {
    const token = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim();
    if (!token || !token.startsWith("pk.")) {
      throw new Error("Set EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN to a Mapbox public token before Android prebuild.");
    }

    const strings = config.modResults.resources.string ?? [];
    const entry = { $: { name: "mapbox_access_token", translatable: "false" }, _: token };
    const index = strings.findIndex((item) => item.$?.name === "mapbox_access_token");
    if (index >= 0) strings[index] = entry;
    else strings.push(entry);
    config.modResults.resources.string = strings;
    return config;
  });
