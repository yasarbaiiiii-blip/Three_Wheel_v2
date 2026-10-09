import { describe, it, expect } from "vitest";
// @ts-ignore
const withAndroidReleaseSigning = require("../../../plugins/withAndroidReleaseSigning");

describe("withAndroidReleaseSigning Expo config plugin", () => {
  const sampleBuildGradle = `
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
        }
    }
  `;

  it("injects release signingConfig and points buildTypes.release to signingConfigs.release", async () => {
    const mockExpoConfig: any = {
      name: "Rover Test",
      slug: "rover-test",
    };

    const transformedConfig = withAndroidReleaseSigning(mockExpoConfig);
    expect(typeof transformedConfig.mods?.android?.appBuildGradle).toBe("function");

    // Execute the action created by withAppBuildGradle
    const modResult = await transformedConfig.mods.android.appBuildGradle({
      ...transformedConfig,
      modResults: { contents: sampleBuildGradle },
    });

    const output = modResult.modResults.contents;

    // Verify release signing block presence in transformed output
    expect(output).toContain("DYX_RELEASE_STORE_FILE");
    expect(output).toContain("DYX_RELEASE_STORE_PASSWORD");
    expect(output).toContain("DYX_RELEASE_KEY_ALIAS");
    expect(output).toContain("DYX_RELEASE_KEY_PASSWORD");

    // Verify debug signingConfig is preserved
    expect(output).toContain("storeFile file('debug.keystore')");

    // Verify buildTypes.release uses release config
    expect(output).toContain("signingConfig signingConfigs.release");
    expect(output).not.toMatch(/buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?signingConfig\s+signingConfigs\.debug/);

    // Verify fail closed message
    expect(output).toContain("Release builds must not use debug keys.");
  });

  it("is idempotent when applied to already-configured build.gradle", async () => {
    const mockExpoConfig: any = {
      name: "Rover Test",
      slug: "rover-test",
    };

    const transformedConfig = withAndroidReleaseSigning(mockExpoConfig);

    const firstPass = await transformedConfig.mods.android.appBuildGradle({
      ...transformedConfig,
      modResults: { contents: sampleBuildGradle },
    });

    const secondPass = await transformedConfig.mods.android.appBuildGradle({
      ...transformedConfig,
      modResults: { contents: firstPass.modResults.contents },
    });

    // Content should not duplicate release signing block
    const releaseConfigBlocks = (secondPass.modResults.contents.match(/signingConfigs\s*\{[\s\S]*?release\s*\{/g) || []).length;
    expect(releaseConfigBlocks).toBe(1);
  });
});
