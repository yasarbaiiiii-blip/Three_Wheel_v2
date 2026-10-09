/**
 * Fails the native build early when the Mapbox public token is missing.
 *
 * Expo inlines EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN (from .env, which is gitignored) into the JS bundle.
 * A build without it still compiles, but the app crashes with MapboxConfigurationException the
 * moment a map mounts (right after connecting to a rover). That crashing release was installed on a
 * tablet on 2026-10-09. Refusing to build is better than shipping that APK.
 */
const MAPBOX_ENV = "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN";

function assertMapboxToken(env = process.env) {
  const token = (env[MAPBOX_ENV] || "").trim();
  if (!token.startsWith("pk.")) {
    throw new Error(
      `${MAPBOX_ENV} is not set (or is not a public pk. token). ` +
        "Copy .env.example to .env and add the Mapbox public token before building; " +
        "without it the app crashes when a map opens."
    );
  }
}

module.exports = function withRequiredMapboxToken(config) {
  assertMapboxToken();
  return config;
};
module.exports.assertMapboxToken = assertMapboxToken;
