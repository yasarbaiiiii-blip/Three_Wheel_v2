const { withAppBuildGradle } = require("@expo/config-plugins");

/**
 * Expo config plugin to configure Android release signing using DYX keystore credentials
 * from ~/.gradle/gradle.properties or environment variables (DYX_RELEASE_*).
 *
 * Ensures:
 * 1. signingConfigs.release is properly configured with DYX release keystore.
 * 2. buildTypes.release uses signingConfig signingConfigs.release (never debug keys).
 * 3. Safe fallback: explicit GradleException if release build is requested without keys.
 */
const withAndroidReleaseSigning = (config) => {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents;

    if (!buildGradle.includes("DYX_RELEASE_STORE_FILE")) {
      const releaseSigningSnippet = `        release {
            def storeFilePath = findProperty('DYX_RELEASE_STORE_FILE') ?: System.getenv('DYX_RELEASE_STORE_FILE')
            def storePasswordProp = findProperty('DYX_RELEASE_STORE_PASSWORD') ?: System.getenv('DYX_RELEASE_STORE_PASSWORD')
            def keyAliasProp = findProperty('DYX_RELEASE_KEY_ALIAS') ?: System.getenv('DYX_RELEASE_KEY_ALIAS')
            def keyPasswordProp = findProperty('DYX_RELEASE_KEY_PASSWORD') ?: System.getenv('DYX_RELEASE_KEY_PASSWORD')

            if (storeFilePath && storePasswordProp && keyAliasProp && keyPasswordProp) {
                def keystoreFile = file(storeFilePath)
                if (!keystoreFile.exists()) {
                    throw new GradleException("DYX release keystore not found at: \${storeFilePath}")
                }
                storeFile keystoreFile
                storePassword storePasswordProp
                keyAlias keyAliasProp
                keyPassword keyPasswordProp
            } else {
                def isReleaseRequested = gradle.startParameter.taskNames.any {
                    it.toLowerCase().contains("release")
                }
                if (isReleaseRequested) {
                    throw new GradleException("Release build requested but DYX_RELEASE_* keystore credentials are not set in ~/.gradle/gradle.properties or environment. Release builds must not use debug keys.")
                }
            }
        }\n`;

      // Insert inside signingConfigs { ... }
      buildGradle = buildGradle.replace(
        /(signingConfigs\s*\{[\s\S]*?)(debug\s*\{[\s\S]*?\n\s*\})/,
        `$1$2\n${releaseSigningSnippet}`
      );

      // In buildTypes.release, point to signingConfigs.release instead of signingConfigs.debug
      buildGradle = buildGradle.replace(
        /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
        `$1signingConfig signingConfigs.release`
      );

      config.modResults.contents = buildGradle;
    }

    return config;
  });
};

module.exports = withAndroidReleaseSigning;
