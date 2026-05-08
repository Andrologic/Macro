# Changelog

All notable changes to Macro will be documented in this file.

The format is based on Keep a Changelog, and this project uses versions from `package.json` as the source of truth.

## Unreleased

### Fixed

- Supplied a complete PTY environment for integrated terminal shells and exposed clear/interrupt controls so commands like `clear` work without restarting the session.
- Updated integrated terminal launches to follow the user's configured Unix shell instead of forcing `bash`, avoiding the macOS zsh migration warning on new sessions.
- Paused automatic repository change refreshes while implementation tasks are awaiting a user response, including pending questionnaires, to avoid noisy background retries.
- Added backoff and stable notification handling for `Too many open files` / `EMFILE` workspace errors so Macro reports one temporary resource-pressure issue instead of repeated generic task alerts.
- Added typed resource-pressure, workspace-state, and plan-metadata error handling so missing or corrupt plan metadata is presented as a repairable state instead of generic attention alerts.
- Added conservative plan metadata health inspection and orphan cleanup for runtime-only plan directories left behind after failed persistence.
- Reduced filesystem watcher pressure by skipping ignored cache, build, dependency, agent workspace, and generated worktree directories before registering watchers.
- Added notification center cleanup for legacy duplicated `Too many open files` and `Plan not found` alerts.
- Preserved local `AwaitingResponse` task state when plan metadata persistence is temporarily unavailable, keeping the user question as the active next step.
- Prevented transient CMD/PowerShell windows on Windows when Macro runs background provider, Git, terminal, Copilot runtime, and launcher commands.

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
