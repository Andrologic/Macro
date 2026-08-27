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

The release workflow rejects any version that is not strict `x.y.z`. Version
`0.1.1` is the first supported public release. The earlier `0.1.0` build remains
an internal updater-test source and is not a supported distribution.

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
- `Macro_<version>_Windows_ARM64_setup.exe`
- `Macro_<version>_Windows_ARM64_setup.exe.sig`
- `Macro_<version>_Linux_x64.AppImage`
- `Macro_<version>_Linux_x64.AppImage.sig`
- `Macro_<version>_Linux_x64.deb`
- `Macro_<version>_Linux_x64.rpm`
- `latest.json`, the signed updater manifest consumed by Macro
- `SHA256SUMS.txt`
- GitHub's automatic source archives.

Review the draft release in GitHub before publishing it manually.

## Tauri updater

Macro checks the selected update channel at startup. It downloads a signed
update in the background, then waits for the user to restart the app. Tauri
replaces `{{target}}` with the channel-prefixed native target, such as
`stable-windows-x86_64` or `stable-windows-aarch64`. The endpoint is:

```text
https://raw.githubusercontent.com/Andrologic/Macro/updates/channels/{{target}}.json
```

The release workflow attaches `latest.json` to the draft as the complete source
manifest. Publishing the draft triggers the stable-channel workflow, which
creates the five per-target pointers on the orphan `updates` branch. Publish
only after checking `latest.json`, every `.sig` file, the tag-pinned URLs, and
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

Ordinary local builds use `src-tauri/tauri.local.conf.json` and do not create
updater artifacts, so they do not need the private key. For a local signed
updater bundle, expose the private key path and password only for the lifetime
of the packaging shell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\secure\macro-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password>"
bun run tauri:build:updater
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

After publishing, validate the complete release manifest without downloading
the bundles:

```bash
bun run release:updater:verify -- \
  --manifest https://github.com/Andrologic/Macro/releases/latest/download/latest.json
```

The release workflow generates `latest.json` from five required targets:
`windows-x86_64`, `windows-aarch64`, `linux-x86_64`, `darwin-x86_64`, and
`darwin-aarch64`. The two macOS targets point to the same universal
`.app.tar.gz` archive. Windows x64 and Windows ARM64 use separate native NSIS
installers and updater signatures.

### End-to-end updater test

Use a disposable VM or machine. Keep the previous signed installer so the test
can start from a real installed version rather than a development server.

1. Leave the new GitHub release as a draft and download all its assets.
2. Run `release:updater:verify` against the downloaded `latest.json`, updater
   bundles, signatures, and `SHA256SUMS.txt`.
3. On native Windows on ARM, install the ARM64 NSIS package from the draft.
   Confirm that Macro launches and that a minimal Macro AI request exercises the
   bundled ARM64 sidecar without falling back to x64 emulation.
4. Install and open the previous stable Macro version on the x64 test machine.
5. Publish the draft without announcing it. Draft releases are intentionally
   invisible to the updater, so the network path cannot be tested earlier.
6. Restart the old app. Confirm one automatic check occurs, the footer reports
   download progress, and the app remains open after the update becomes ready.
7. First test the normal restart path with no active work. Confirm the new
   version launches and its release-note dialog appears once.
8. Restore the old VM snapshot and repeat with a streaming conversation and an
   active Implement command. Confirm `Wait` is focused, both activities are
   listed, and only `Restart anyway` proceeds without cancelling them.
9. Restart the updated app again. Confirm the release-note dialog does not open
   a second time and the footer reports that Macro is current.
10. On the ARM64 installation, confirm that Tauri selects
    `stable-windows-aarch64.json` and that the update check reads the expected
    version without a release-JSON error.
11. Verify all five public `stable-*.json` files on the `updates` branch, then
   run `release:updater:verify` against the public `/releases/latest/` manifest.

Version `v0.1.1` is the first supported public release. Use the internal
`v0.1.0` build only to prove the real `v0.1.0` to `v0.1.1` updater path on a
disposable x64 test machine. Test Windows ARM64 with a native `v0.1.1` install,
then prove its first automatic update with the next signed Preview or stable
build. No compatibility repair for unofficial `v0.1.0` installations is
required.

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

Build Linux packages (AppImage, deb, rpm):

```bash
bun run tauri:build:linux-packages
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

Windows NSIS release builds are intentionally not Authenticode-signed for the
initial release channel. Windows can therefore display an `Unknown publisher`
or SmartScreen warning during the first installation. The Tauri updater archive
and its `.sig` file remain cryptographically signed, so installed clients reject
tampered automatic updates. `SHA256SUMS.txt` covers the initial installer and
all other release assets.

The release matrix verifies the signed universal macOS bundle and its expected
Apple Team ID. On native Windows x64 and ARM64 runners, it verifies the PE
architecture of Macro and its AI sidecar, then checks that each NSIS installer
exists and remains unsigned as documented. It also inspects AppImage/deb/rpm
contents.
The macOS verification checks the Copilot runtime, manifest, license, and the
absence of `macro-headless`.

## Update Channels

Macro exposes `Stable` and `Preview` in General Settings. Stable follows
published `vX.Y.Z` releases. Preview follows one rolling GitHub prerelease named
`Macro Preview` on the mutable `preview` tag. The same `Andrologic/Macro`
repository hosts both channels.

The orphan `updates` branch stores only per-platform channel manifests under
`channels/`. Stable publication advances `stable-*.json`. A successful Preview
workflow advances `preview-*.json` after it uploads every signed updater asset.
Switching from Preview to Stable may offer an older stable version; the client
asks for confirmation and enables Tauri's signed downgrade path for that check.

Scheduled previews start only after the public stable `v0.1.1` release exists.
They build `develop` once per night when its commit changed. Use the manual
Preview workflow with an `x.y.z-rc.n` version for a release candidate. Configure
the `preview` GitHub environment with the same Tauri updater and Apple signing
secrets as the `release` environment. No second repository or personal access
token is involved.

Desktop builds compile the Macro AI runtime sidecar into `src-tauri/binaries/`
before packaging. Universal macOS builds combine the Apple Silicon and Intel
sidecars with `lipo`, then Tauri embeds the packaged sidecar as
`macro-ai-runtime` inside the app bundle.

## In-app Release Notes

Automatic updates preserve the Markdown notes from `latest.json` before
installation. After the relaunch, the release-note dialog reads that local copy
and removes it once the user closes the dialog. This avoids a source-code change
for every updater release. `src/services/releaseNotes.ts` keeps localized notes
for releases that should show an offline fallback after a manual installation.
Raw HTML is ignored.

Place a reviewed user-facing note in `dev/release/notes/<version>.md` before a
stable tag. The release workflow uses it for both the GitHub Release and
`latest.json`, so the download page and the post-update modal describe the same
changes. If the file is absent, the workflow falls back to GitHub's generated
notes. Keep a localized bundled fallback in `src/services/releaseNotes.ts` when
a first installation should also show the note offline. When that localized
fallback exists, the post-update modal prefers it over the release's default
English Markdown.

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
3. Bump to a stable `x.y.z` version and review the user-facing notes that GitHub
   will place in `latest.json`. Keep implementation-only details out of PR titles.
4. Confirm `bun run version:check` and the release notes tests pass.
5. Merge to `main`, fetch the resulting remote state, and run
   `bun run release:preflight` from a clean checkout exactly matching
   `origin/main`.
6. Create and push an annotated matching `vX.Y.Z` tag
   from that history using an authorized release-maintainer account.
7. Review the cheap validation job, then approve the protected `release`
   environment when the tag and version are correct.
8. Wait for `.github/workflows/release.yml` to create the draft release.
9. Download the draft assets and run `release:updater:verify` with the asset
   directory and `SHA256SUMS.txt`. Install the ARM64 NSIS package on native
   Windows on ARM, launch Macro, and exercise the bundled AI runtime.
10. Publish the draft without announcing it. If the stable-channel workflow
    does not run, relaunch it manually with the exact published tag.
11. Verify that all five raw `stable-*.json` endpoints contain the expected
    version, embedded signature, and tag-pinned asset URL.
12. From the internal `v0.1.0` x64 installation, verify that Macro offers and
    installs `v0.1.1`. Install the ARM64 package on native Windows on ARM and
    verify launch, the bundled AI runtime, and update checking.
13. Announce the release only after these checks pass. If native ARM64 validation
    fails while the release is still a draft, leave the tag and draft immutable,
    fix the defect in a higher patch version, and do not advertise ARM64 support.

## Recovering a faulty release

If the problem is found while the release is still a draft, keep it unpublished.
Release tags are immutable, so do not move or recreate the tag. Fix the source,
bump to the next patch version, create a new annotated tag, and let the workflow
rebuild every asset. Never reuse a signature for changed content.

If the release has already been published:

1. Revert the faulty `stable-*.json` update on the `updates` branch to the
   previous supported manifests. For the first supported release, remove the
   faulty stable pointers until a replacement exists.
2. Mark the faulty GitHub release clearly and stop announcing it. Do not move
   its immutable tag or replace its assets.
3. Fix the problem and publish a higher patch version signed with the same
   updater key. Do not replace tag-pinned assets in place.
4. Validate the new public channel manifests and test the update from the previous
   stable installation before announcing recovery.
5. Provide the new installer for a manual repair if the faulty application can
   no longer start. An already installed higher version cannot automatically
   downgrade to the previous release.

Do not rotate the updater key for an ordinary faulty release. Rotate it only
after a confirmed key compromise; installations that trust only the old public
key will then require a manual migration path.
