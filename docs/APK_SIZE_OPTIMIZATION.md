# APK size optimization (strong profile)

## Why the APK was ~190 MB

Release intermediate **native libraries alone** were ~250+ MB **per ABI** before packaging (New Architecture `libreactnative.so` ~100 MB, Reanimated, Expo modules, Mapbox). A fat APK with 4 ABIs multiplies that.

## Strong size profile (applied)

| Lever | Setting | Effect |
|---|---|---|
| ABI | `arm64-v8a` only | Drops 32-bit + emulator ABIs from store/APK |
| Compress `.so` | `expo.useLegacyPackaging=true` | Smaller APK file (extracts on install) |
| R8 minify | `android.enableMinifyInReleaseBuilds=true` | Shrinks Java/Kotlin |
| Resource shrink | `android.enableShrinkResourcesInReleaseBuilds=true` | Drops unused resources |
| JS bundle compression | `android.enableBundleCompression=true` | Smaller embedded Hermes bundle |
| GIF Fresco | `expo.gif.enabled=false` | Drops unused animated-gif dependency |
| ABI filters + splits | `build.gradle` | Enforces architecture list; multi-ABI → per-ABI APKs |

## Expected size (order of magnitude)

| Artifact | Rough expectation vs old ~190 MB fat (4 ABI) |
|---|---|
| Release APK **arm64-only** + compress + R8 | Often **~55–95 MB** (device/build dependent) |
| Play **AAB** download per device | Often **smaller than fat APK** (one ABI) |
| Debug APK | Still large (not optimized) |

**Not a guarantee of “68 MB”** — measure after rebuild.

## Build (local)

```bash
cd android
# clean intermediates from old multi-ABI builds
./gradlew clean
./gradlew assembleRelease
```

Output:

`android/app/build/outputs/apk/release/app-release.apk`

Override ABIs if needed:

```bash
# 32-bit + 64-bit phones
./gradlew assembleRelease -PreactNativeArchitectures=armeabi-v7a,arm64-v8a

# Android emulator
./gradlew assembleDebug -PreactNativeArchitectures=x86_64
```

## What we did **not** change (keeps app working)

- Mapbox stays (map is core; removes tens of MB only if map is dropped)
- New Architecture stays on (disabling can shrink more but risks Mapbox/Reanimated)
- Feature set / mission flows unchanged

## If still too large

1. Prefer **AAB** on Play (`eas build --profile production`).
2. Revisit **arm64-only** vs keeping `armeabi-v7a` for very old devices.
3. Profile with Android Studio **APK Analyzer** after rebuild.
4. Only as last resort: evaluate New Architecture / Mapbox tradeoffs with QA.
