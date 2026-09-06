# Release validation

Macro separates source validation, native recovery checks, packaging, and
publication. Passing one stage does not imply that the later stages ran.

## Distributed artifacts

Stable and preview workflows build these artifacts:

| Platform | Architectures | Packages | Operating-system signature |
| --- | --- | --- | --- |
| macOS | Apple Silicon and Intel in one universal build | app archive and DMG | Developer ID signature, notarization, and stapling |
| Windows | x64 and ARM64 | NSIS installer | No Authenticode signature in the 0.1 release line |
| Linux | x64 | AppImage, deb, and rpm | No distribution-specific package signature |

The updater archive signature is a different control. Tauri produces a detached
minisign-compatible signature, and Macro verifies that signature before activation
on every platform. An updater signature must never be described as Authenticode,
Apple code signing, Linux repository signing, or notarization.

Scheduled previews are nightly builds from `develop`. A manually dispatched
preview may instead use an `x.y.z-rc.n` release-candidate version. Stable releases
come only from annotated `vX.Y.Z` tags on `main` and are created as drafts for
manual review before publication.

## Native recovery checks

`.github/workflows/ci.yml` runs the full native profile on Linux. Native or release
configuration changes also select small Windows and macOS jobs. Those jobs run the
exact tests listed in `dev/ci/native-recovery-smoke.mjs`:

- updater state replacement preserves the old usable file when final replacement fails;
- an existing baseline database receives the current migration;
- startup rolls back an interrupted profile restoration.

The jobs exercise filesystem and SQLite behavior on the native operating system.
They do not build installers and do not replace the release matrix. Linux package
inspection, Windows PE architecture inspection, Windows unsigned-installer checks,
and macOS signing and notarization remain release-workflow responsibilities.

## Local preflight

Run `bun run release:toolchain:diagnose` before investigating a failed local
package build. It reports the tools resolved from `PATH`, the pinned Rust version,
installed Rust targets, and the prerequisites used by the current platform.
`bun run release:preflight` invokes this diagnostic first and stops if it fails.
All existing branch, tag, CI, updater, and packaging gates still run afterward.
