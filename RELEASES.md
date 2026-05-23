# Releases

`package.json` is the source of truth for the Macro application version.

## Version Manifests

The following manifests are synchronized from `package.json`:

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `flake.nix`

Check version consistency with:

```bash
bun run version:check
```

Sync secondary manifests with:

```bash
bun run version:sync
```

## Version Bumps

Use the version helper:

```bash
bun run version:bump patch
bun run version:bump rc
bun run version:bump weekly
bun run version:bump weekly 20260325
```

Release channels:

- stable releases use `major`, `minor`, and `patch`;
- release candidates use `bun run version:bump rc`;
- weekly releases use `bun run version:bump weekly`.

## Build Outputs

Build the desktop app:

```bash
bun run tauri:build
```

Desktop bundles are written to:

```text
src-tauri/target/release/bundle/
```

Build a native macOS DMG:

```bash
bun run tauri:build:dmg
```

The DMG is written to:

```text
src-tauri/target/release/bundle/dmg/
```

The macOS DMG presentation intentionally stays minimal and native: app on the
left, `Applications` shortcut on the right, no custom background image.

## Apple Silicon Runtime Sidecar

Desktop builds compile an auxiliary AI runtime sidecar into `src-tauri/binaries/`
before packaging.

- Local macOS Apple Silicon builds emit
  `macro-ai-runtime-aarch64-apple-darwin`.
- Tauri embeds the final packaged sidecar as `macro-ai-runtime` inside the app
  bundle.
- The sidecar uses macOS entitlements compatible with Bun's JavaScript runtime.

## Weekly Releases

Weekly releases are automated through:

```text
.github/workflows/weekly-release.yml
```

The workflow:

- runs only from the repository default branch;
- bumps the app to the next weekly prerelease;
- commits the version files;
- tags `v<version>`;
- publishes a signed Apple Silicon GitHub prerelease.

Release candidates remain manual and should be cut locally with:

```bash
bun run version:bump rc
```

## Stable macOS Releases

Stable macOS releases are published through:

```text
.github/workflows/release-macos.yml
```

The current stable release workflow:

- targets Apple Silicon only (`aarch64-apple-darwin`);
- builds notarized `.app` and `.dmg` artifacts;
- keeps auto-update disabled, so users update by downloading a newer release;
- expects Apple signing and notarization secrets in GitHub Actions.

## macOS Release Runbook

1. Ensure `bun run ci` passes locally.
2. Bump and sync the version in `package.json`.
3. Confirm Apple signing secrets are configured in GitHub Actions:
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`,
   `APPLE_API_KEY`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_P8`.
4. Trigger `.github/workflows/release-macos.yml`.
5. Wait for the workflow to build, sign, notarize, staple, and validate the
   Apple Silicon `.app` and `.dmg`.
6. Smoke test on a clean Apple Silicon Mac: app launch from Finder, terminal
   commands, Git access, AI runtime startup, provider secret storage, and
   notifications.
