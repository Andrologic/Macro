# macOS Pilot QA signing

The Pilot QA app is a separate local macOS build for exercising the stable-signature path. Its fixed Tauri bundle identifier is `com.macro.desktop.qa.pilot`; this identifier is also the contract for the native Pilot keychain namespace. The native namespace must derive from the application's trusted identity. Frontend input must not be able to choose it.

Tauri uses the separate identifier for the app's macOS preferences and application data directories. Do not copy the normal Macro profile, its configuration, or any secret references into this QA profile. The QA bundle is named `Macro Pilot QA`, creates no updater artifacts, has no configured updater endpoints, and builds only an `.app` bundle. It does not publish or deploy an artifact, and its updater cannot contact the production channel.

## Prerequisite

Use an existing, stable code-signing identity installed on the Mac. An Apple Development identity is suitable for local development. A stable local test identity can also be used if it is already configured. This workflow does not create or import certificates, change keychain access controls, or reveal private keys.

List available valid identities with:

```sh
security find-identity -v -p codesigning
```

Set `MACOS_QA_SIGNING_IDENTITY` to the 40-character SHA-1 fingerprint printed for the intended identity. The build script checks for an exact match in the valid identity list and passes that fingerprint as `APPLE_SIGNING_IDENTITY`. It refuses an absent, malformed, ad hoc, or unlisted identity. Existing generic local test commands that explicitly use `APPLE_SIGNING_IDENTITY="-"` remain unchanged; they are not the stable QA build.

## Build and compare two bundles

Run each build from the repository root. Use a fresh absolute output path outside the repository for each one. The paths below are examples under the system temporary directory.

```sh
export MACOS_QA_SIGNING_IDENTITY=0123456789ABCDEF0123456789ABCDEF01234567
bun run tauri:build:macos:qa -- --output /tmp/macro-pilot-qa-run-1/Macro.app
bun run tauri:build:macos:qa -- --output /tmp/macro-pilot-qa-run-2/Macro.app
bun run tauri:verify:macos:qa-signing -- --bundles /tmp/macro-pilot-qa-run-1/Macro.app --bundles /tmp/macro-pilot-qa-run-2/Macro.app
```

Replace the sample fingerprint with the identity's actual fingerprint. The verifier resolves both paths to ensure they name separate bundles, runs `codesign` against each, checks that each uses `com.macro.desktop.qa.pilot` and has a designated requirement pinned to a leaf certificate or certificate anchor, then requires those requirements to match exactly. This is a repeatable signature-requirement check; by itself it does not prove access to the keychain or restoration of a Pilot session. A first access may still require macOS authorization, and subsequent keychain behavior must be checked in the native recipe.

The script checks only the QA bundle signature inputs. It does not inspect, migrate, or copy the normal Macro profile. The native keychain namespace implementation is a separate change and must use the fixed bundle identifier above.
