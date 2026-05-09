# Changelog

All notable changes to Macro will be documented in this file.

The format is based on Keep a Changelog, and this project uses versions from `package.json` as the source of truth.

## Unreleased

## 0.1.0-rc.7

### Added

- Added task-level Architect checklists so generated plans can carry concrete todos into Implement mode.
- Added a compact Implement header dropdown for viewing the current task checklist without taking over the workspace.
- Added visible plan-finalization status in Architect graphs and Implement queues.
- Added conversation compaction boundaries and clearer loading state for long-running chats.

### Changed

- Reworked Architect task planning around one branch per task, task dependencies, and checklist progress.
- Refactored branch worktree handling and smart commit/draft flows for more reliable production use.
- Switched provider secrets from the macOS Keychain/system keyring to Macro's private local app data file to avoid repeated macOS password prompts.
- Switched Tauri and TypeScript build scripts to project-local CLIs so builds are less sensitive to global toolchain issues.
- Improved provider send latency with shared timeline instrumentation across ChatGPT, Copilot, OpenAI-compatible, and streaming IPC paths.
- Updated task badges, blocked-task states, and tool activity rendering to be calmer and easier to scan.

### Fixed

- Fixed commit message generation paths used by Implement task flows.
- Hardened task completion and plan finalization guards around open todos and legacy plans.
- Stabilized metadata repair, orphan cleanup, repository refresh backoff, and `Too many open files` / `EMFILE` handling.
- Improved integrated terminal behavior: complete PTY environment, clear/interrupt controls, user shell detection, live theme matching, and no macOS zsh migration warning.
- Prevented transient CMD/PowerShell windows on Windows background operations while keeping user-requested terminals visible.
- Hardened provider diagnostics for OpenCode Go and Copilot runtime classification.
- Stabilized native macOS traffic light positioning after fullscreen transitions.

### Security

- Provider API keys and ChatGPT sessions are now stored in a private local Macro data file with atomic writes and private Unix permissions.
- Existing OS-backed provider secrets are not imported automatically; users may need to reconnect providers or re-enter API keys once.

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
