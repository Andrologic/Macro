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
- `Macro_<version>_macOS_universal.app.tar.gz` and its `.sig` file
- `Macro_<version>_Windows_x64_setup.exe`
- `Macro_<version>_Windows_x64_setup.exe.sig`
- `Macro_<version>_Linux_x64.AppImage`
- `Macro_<version>_Linux_x64.AppImage.sig`
- `Macro_<version>_Linux_x64.deb`
- `Macro_<version>_Linux_x64.rpm`
- `latest.json`, the signed updater manifest consumed by Macro
- `SHA256SUMS.txt`
- GitHub's automatic source archives.

Review the draft release in GitHub before publishing it manually.

## Tauri updater

Macro checks the published stable release at startup. It downloads a signed
update in the background, then waits for the user to restart the app. The
updater endpoint is:

```text
https://github.com/Andrologic/Macro/releases/latest/download/latest.json
```

The draft release is not visible at this endpoint. Publish it only after
checking `latest.json`, every `.sig` file, the tag-pinned URLs, and
`SHA256SUMS.txt`.

Tauri uses a separate signing key for updater artifacts. Generate it once on a
trusted machine and keep the private key outside the repository:

```bash
bun tauri signer generate -w ~/.tauri/macro-updater.key
```

Put the generated public key in `src-tauri/tauri.conf.json`. Store the private
key content and its password in the protected GitHub `release` environment as:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Keep an encrypted backup of the private key. Losing it prevents installed
versions from accepting future updates. Never commit the key, its password, or
generated updater bundles.

For a local signed bundle, expose the private key path and password only for
the lifetime of the packaging shell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\secure\macro-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password>"
bun run tauri:build
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Validate the endpoint, updater configuration, plugin versions, and lockfile
before a push or a release tag:

```bash
bun run release:updater:check
```

After downloading a draft's assets, validate the manifest, all updater files,
and their checksums locally:

```bash
bun run release:updater:verify -- \
  --manifest release-assets/latest.json \
  --asset-root release-assets \
  --checksums release-assets/SHA256SUMS.txt
```

After publishing, validate the public endpoint without downloading the
bundles:

```bash
bun run release:updater:verify -- \
  --manifest https://github.com/Andrologic/Macro/releases/latest/download/latest.json
```

The release workflow generates `latest.json` from the four required targets:
`windows-x86_64`, `linux-x86_64`, `darwin-x86_64`, and `darwin-aarch64`. The two
macOS targets point to the same universal `.app.tar.gz` archive.

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

## In-app Release Notes

Each stable application version must have an English and French entry in
`src/services/releaseNotes.ts`. The body is Markdown rendered by the same secure
renderer as chat messages. Raw HTML is ignored.

Store release media under `public/release-notes/<version>/` so that images and
videos remain available offline. Use root-relative paths in the Markdown:

```markdown
![Workspace overview](/release-notes/0.2.0/workspace.webp "Workspace overview")

![video: Task execution demo](/release-notes/0.2.0/task-demo.webm)
```

Image titles become visible captions. Files ending in `.mp4`, `.webm`, `.ogv`,
or `.mov` render as videos with native controls. The `video:` prefix also marks
a media URL without a recognizable extension as a video. Compress media before
committing it and keep the release dialog usable without media playback.

## Release Runbook

1. Finish the feature branch and run the smallest relevant local checks.
2. Run `bun run ci:pre-push` before updating the pull request.
3. Bump to a stable `x.y.z` version and add the matching localized user-facing
   entry to `src/services/releaseNotes.ts`.
4. Confirm `bun run version:check` and the release notes tests pass. The tests
   reject a package version that has no bundled release note.
5. Merge to `main`, fetch the resulting remote state, and run
   `bun run release:preflight` from a clean checkout exactly matching
   `origin/main`.
6. Create and push an annotated matching `vX.Y.Z` tag
   from that history using an authorized release-maintainer account.
7. Review the cheap validation job, then approve the protected `release`
   environment when the tag and version are correct.
8. Wait for `.github/workflows/release.yml` to create the draft release.
9. Run `bun run release:updater:check` and check the draft assets, signatures,
   `latest.json`, notes, and checksums in GitHub.
10. Publish the draft manually when it is ready for users.
11. From an older installed version, verify that the published
    `/releases/latest/download/latest.json` is reachable and that the updater
    offers the new version before announcing the release.

## Recovering a faulty release

If the problem is found while the release is still a draft, keep it unpublished,
fix the source, recreate the tag from the corrected release commit, and let the
workflow rebuild every asset. Never reuse a signature for changed content.

If the release has already been published:

1. Immediately convert it back to a draft so `/releases/latest/` resolves to the
   previous stable release for clients that have not downloaded the update.
2. Fix the problem and publish a higher patch version signed with the same
   updater key. Do not replace tag-pinned assets in place.
3. Validate the new public `latest.json` and test the update from the previous
   stable installation before announcing recovery.
4. Provide the new installer for a manual repair if the faulty application can
   no longer start. An already installed higher version cannot automatically
   downgrade to the previous release.

Do not rotate the updater key for an ordinary faulty release. Rotate it only
after a confirmed key compromise; installations that trust only the old public
key will then require a manual migration path.
