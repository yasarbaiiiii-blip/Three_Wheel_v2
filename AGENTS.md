# DXF_Three_Wheel — Rover Three Wheel Native

Expo SDK 54 / React Native 0.81 (TypeScript, NativeWind) Android app.
Main entry: `App.tsx`. New Architecture + Hermes enabled.

## Build the release APK (Android)

This is an Expo app — the native `android/` folder is generated (gitignored), not committed.

```bash
# one-time, from repo root, if android/ is missing:
npm install
npx expo prebuild --platform android

# build (env vars are already in ~/.zshrc):
cd android
./gradlew assembleRelease
```

Output APK: `android/app/build/outputs/apk/release/app-release.apk`

### Toolchain (installed locally on this machine)
- JDK 17: `/opt/homebrew/opt/openjdk@17` (Homebrew `openjdk@17` formula)
- Android SDK: `~/Library/Android/sdk` — platform-tools, `platforms;android-36`, `build-tools;36.0.0`
- NDK `27.1.12297006` (required by New Architecture), CMake `3.22.1`
- Env vars (`JAVA_HOME`, `ANDROID_HOME`, PATH) are set in `~/.zshrc`
- Note: machine is on Node 26 (newer than Expo SDK 54 officially supports); worked, but Node 20 LTS is the safe fallback.

### Flaky network tip
Dependency/SDK downloads may time out. Gradle caches successful downloads, so just re-run
`./gradlew assembleRelease` — it resumes and only retries the missing jars.

## Release signing (keystore)

Release builds are signed with a self-signed project keystore.

- Keystore file: `android/app/release.keystore`
- Store password: `rover12345`
- Key alias: `rover`
- Key password: `rover12345`
- Validity: 10,000 days

Signing config lives in `android/app/build.gradle` (`signingConfigs.release`), with overridable
gradle properties: `ROVER_STORE_FILE`, `ROVER_STORE_PASSWORD`, `ROVER_KEY_ALIAS`, `ROVER_KEY_PASSWORD`.

⚠️ Back up `release.keystore` + these passwords. If this app is ever published to the Play Store,
every future update MUST be signed with this exact keystore. The password is weak — change it
before any real/public distribution.

⚠️ `expo prebuild --clean` regenerates `android/` and will wipe the signing edits and require the
keystore to be re-added. A plain `./gradlew assembleRelease` rebuild is safe.
