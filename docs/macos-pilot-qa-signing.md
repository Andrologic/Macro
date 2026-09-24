# macOS Pilot QA signing

The Pilot QA app is a separate local macOS build for exercising the stable-signature path. Its fixed Tauri bundle identifier is `com.macro.desktop.qa.pilot`; this identifier is also the contract for the native Pilot keychain namespace. The native namespace must derive from the application's trusted identity. Frontend input must not be able to choose it.

Tauri uses the separate identifier for the app's macOS preferences and application data directories. The desktop app uses that Tauri configuration directory by default. `MACRO_CONFIG_DIR` explicitly overrides it, so unset that variable when launching QA. Do not copy the normal Macro profile, its configuration, or any secret references into this QA profile. The QA bundle is named `Macro Pilot QA`, creates no updater artifacts, has no configured updater endpoints, and builds only an `.app` bundle. It does not publish or deploy an artifact, and its updater cannot contact the production channel.

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
unset MACRO_CONFIG_DIR
export MACOS_QA_SIGNING_IDENTITY=0123456789ABCDEF0123456789ABCDEF01234567
bun run tauri:build:macos:qa -- --output /tmp/macro-pilot-qa-run-1/Macro.app
```

Replace the sample fingerprint with the identity's actual fingerprint. After the first build, make one temporary local edit to `src-tauri/tauri.qa.conf.json`: change `app.windows[0].title` from `Macro Pilot QA` to `Macro Pilot QA recipe B`. Keep `identifier`, `productName`, the signing fingerprint, and all profile settings unchanged. Build the second bundle:

```sh
bun run tauri:build:macos:qa -- --output /tmp/macro-pilot-qa-run-2/Macro.app
```

Restore the title to `Macro Pilot QA` before continuing. The title change is the recipe variation; it does not change the product version or need a commit. Compare the saved bundles:

```sh
bun run tauri:verify:macos:qa-signing -- --bundles /tmp/macro-pilot-qa-run-1/Macro.app --bundles /tmp/macro-pilot-qa-run-2/Macro.app
```

The verifier resolves both paths to ensure they name separate bundles, runs `codesign --verify` against each, extracts each bundle's public signing certificate, and requires its SHA-1 fingerprint to equal `MACOS_QA_SIGNING_IDENTITY`. It checks the `com.macro.desktop.qa.pilot` identifier, requires the designated code requirements to match exactly, and reads the `arm64` CDHash only after signature verification. The CDHashes must differ, so identical bundle copies fail even if their signature requirement matches. This control proves that the two bundles contain different signed code under the same signer and requirement; it does not prove access to the keychain or restoration of a Pilot session. A first access may still require macOS authorization, and subsequent keychain behavior must be checked in the native recipe.

The script checks only the QA bundle signature inputs. It does not inspect, migrate, or copy the normal Macro profile. The native keychain namespace implementation is a separate change and must use the fixed bundle identifier above.
