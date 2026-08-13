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

The release workflow rejects any version that is not strict `x.y.z`. The
current `0.1.0` version is eligible for an official release once its matching
`v0.1.0` tag is created.

## GitHub Release Workflow

Official releases are prepared by:

```text
.github/workflows/release.yml
```

The workflow runs only when a new stable `vX.Y.Z` tag is created. It has no
manual or scheduled trigger. It rejects updated or deleted tags, tags outside
the history of `origin/main`, and tags that do not exactly match every version
manifest. Release tags must be annotated. The workflow validates the repository before requesting approval through the
protected `release` environment, builds desktop packages for macOS, Windows,
and Linux, then creates a GitHub Release draft named `v<version>`.

The draft contains:

- `Macro_<version>_macOS_universal.dmg`
- `Macro_<version>_Windows_x64_setup.exe`
- `Macro_<version>_Linux_x64.AppImage`
- `Macro_<version>_Linux_x64.deb`
- `Macro_<version>_Linux_x64.rpm`
- `SHA256SUMS.txt`
- GitHub's automatic source archives.

Review the draft release in GitHub before publishing it manually.

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
stapled. The GitHub release workflow requires these secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY_P8`
- `APPLE_TEAM_ID`

Windows release builds are Authenticode-signed with SHA-256 and DigiCert
timestamping. The workflow refuses to publish Windows without:

- `WINDOWS_CERTIFICATE_PFX_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

The release matrix verifies the signed universal macOS bundle and its expected
Apple Team ID, validates that the Windows NSIS Authenticode signer matches the
certificate imported for the release, and inspects AppImage/deb/rpm contents.
The macOS verification checks the Copilot runtime, manifest, license, and the
absence of `macro-headless`.

Desktop builds compile the Macro AI runtime sidecar into `src-tauri/binaries/`
before packaging. Universal macOS builds combine the Apple Silicon and Intel
sidecars with `lipo`, then Tauri embeds the packaged sidecar as
`macro-ai-runtime` inside the app bundle.

## Release Runbook

1. Finish the feature branch and run the smallest relevant local checks.
2. Bump to a stable `x.y.z` version and confirm `bun run version:check` passes.
3. Merge to `main`, then create and push an annotated matching `vX.Y.Z` tag
   from that history using an authorized release-maintainer account.
4. Review the cheap validation job, then approve the protected `release`
   environment when the tag and version are correct.
5. Wait for `.github/workflows/release.yml` to create the draft release.
6. Check the draft assets, signatures, notes, and checksums in GitHub.
7. Publish the draft manually when it is ready for users.
