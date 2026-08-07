# Releases

`package.json` is the source of truth for the Macro application version.
Official GitHub releases use stable SemVer only: `major.minor.patch`.
Prerelease versions such as `-rc`, `-weekly`, or `-beta` are not published.

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

Use stable bumps for official releases:

```bash
bun run version:bump patch
bun run version:bump minor
bun run version:bump major
```

The release checks reject any version that is not strict `x.y.z`. Before the
next official release, `0.1.0-rc.8` must become a stable version such as
`0.1.0`.

## GitHub Releases

GitHub Actions release automation is currently suspended and
`.github/workflows/release.yml` is intentionally absent. Prepare official
releases manually from a clean, validated branch.

The release should contain:

- `Macro_<version>_macOS_universal.dmg`
- `Macro_<version>_Windows_x64_setup.exe`
- `Macro_<version>_Linux_x64.AppImage`
- `Macro_<version>_Linux_x64.deb`
- `Macro_<version>_Linux_x64.rpm`
- `SHA256SUMS.txt`
- GitHub's automatic source archives.

Review every artifact and checksum in GitHub before publishing the release.

## Build Outputs

Build the desktop app locally:

```bash
bun run tauri:build
```

Desktop bundles are written to:

```text
src-tauri/target/release/bundle/
```

Build a universal macOS DMG for both Apple Silicon and Intel Macs:

```bash
bun run tauri:build:dmg:mac-universal:test
```

Universal macOS bundles are written under:

```text
src-tauri/target/universal-apple-darwin/release/bundle/
```

## macOS Release Requirements

macOS release builds are universal (`arm64 + x86_64`), signed, notarized, and
stapled. A signed release build requires these secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY_P8`

Desktop builds compile the Macro AI runtime sidecar into `src-tauri/binaries/`
before packaging. Universal macOS builds combine the Apple Silicon and Intel
sidecars with `lipo`, then Tauri embeds the packaged sidecar as
`macro-ai-runtime` inside the app bundle.

## Release Runbook

1. Finish the feature branch and run the smallest relevant local checks.
2. Bump to a stable `x.y.z` version and confirm `bun run version:check` passes.
3. Merge to the release branch and build the desktop packages on each supported platform.
4. Create the `v<version>` tag and GitHub Release manually.
5. Check the release assets, notes, and checksums in GitHub.
6. Publish the release manually when it is ready for users.
