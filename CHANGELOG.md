# Changelog

All notable changes to Macro will be documented in this file.

The format is based on Keep a Changelog, and this project uses versions from `package.json` as the source of truth.

## Unreleased

No unreleased changes.

## 0.1.0-rc.6

### Added

- Open source readiness documents for security, support, contribution, conduct, and release notes.

### Changed

- Public package metadata now identifies Macro for open source distribution under `Andrologic/Macro`.
- JavaScript dependency pins and targeted overrides were refreshed for the 0.1 release candidate.
- Test DOM setup was updated for `happy-dom` 20 compatibility.

### Security

- Documented the security reporting process through GitHub Security Advisories.
- Resolved the remaining `bun audit` finding from Mermaid's `lodash-es` transitive dependency with a targeted `lodash-es` override.
- `bun audit` reports no known vulnerabilities for this release candidate.

### Known Limitations

- This is still a release candidate, not the final 0.1 stable release.
- The 0.1 release line is focused on the local-first desktop workflow.
- Signed and notarized release artifacts currently target macOS Apple Silicon.
- Auto-update is intentionally disabled; users update by downloading a newer release manually.
- Linux, Windows, weekly builds, remote transport, and headless kernel workflows are best-effort unless called out in a specific release.

## 0.1.0-rc.5

### Added

- Release-candidate baseline for the 0.1 desktop application.
- Architect, Implement, and Chat workflows for local agentic development.
- Local Tauri backend with Git, workspace, terminal, provider, and metadata services.
- macOS release automation for signed and notarized Apple Silicon builds.

### Security

- Provider secrets are stored through the operating system keyring when available.
- Local development secret overrides are kept outside Git through ignored `dev/ai-keys.local.json`.

### Known Limitations

- The release candidate is not the final 0.1 stable release.
- Auto-update is intentionally disabled; users update by downloading a newer release manually.
