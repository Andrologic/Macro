# Changelog

All notable changes to Macro will be documented in this file.

The format is based on Keep a Changelog, and this project uses versions from `package.json` as the source of truth.

## Unreleased

## 0.1.1

### Added

- Added native Windows ARM64 installers and a matching ARM64 AI runtime.
- Added stable and preview update manifests for every supported platform.

### Changed

- Release publication now verifies signed updater archives, checksums, immutable asset URLs, and all five platform manifests before advancing an update channel.
- Multimodal context estimation now uses image dimensions and model-specific or provider-specific visual token formulas instead of treating Base64 transport data as text.
- Image-only pressure may trigger preventive compaction but cannot cause a permanent pre-provider block on its own.

### Fixed

- Fixed the missing update-channel files that caused Macro to report that it could not fetch a valid release JSON.
- Fixed duplicate image representations in visible messages and provider payloads inflating context estimates.
- Fixed tool failures that could be presented to agents as successful results, improving recovery after invalid arguments, unavailable tools, and native execution errors.
- Preserved the shipped database migration version during startup checks.

## 0.1.0

### Added

- Added an in-app release notes modal with rich Markdown, offline images, and native video playback that appears once for each newly installed version.
- Added the production headless runtime example with explicit workspace roots, authentication outside loopback, and restrictive CORS controls.
- Added broader regression coverage for task orchestration, provider state, chat streaming, file review, preferences, accessibility, and workspace recovery.

### Changed

- Promoted the application manifests and release documentation from the release-candidate line to the stable `0.1.0` release.
- Hardened task and plan lifecycle handling so active operations cannot race with archive, deletion, cancellation, or worktree cleanup.
- Made database migrations atomic and enabled SQLite foreign-key enforcement on every connection.
- Made local CI deterministic by running filesystem-sensitive Rust tests serially.

### Fixed

- Fixed fragmented UTF-8 and incomplete-event handling in OpenAI-compatible and ChatGPT SSE streams.
- Fixed OAuth state validation and secret rollback when ChatGPT session persistence fails.
- Fixed Copilot runtime installation recovery and request identifier validation.
- Fixed workspace path confinement through symbolic links and canonicalized headless mounts under explicitly allowed roots.
- Fixed stale provider, preference, shortcut, skill, and tool hydration from overwriting newer local state.

### Security

- Headless bearer authentication is mandatory when binding outside loopback.
- Workspace reads, writes, and headless mounts reject paths that escape their authorized roots through symbolic links.

## 0.1.0-rc.8

### Added

- Added conversation compaction surfaces in chat, including transcript boundaries, in-progress compaction status, context-window diagnostics, manual compaction controls, and persisted compaction metadata for long sessions.
- Added assistant replay safeguards for code changes, including checkpoints, staged/committed change detection, and replay trimming protections.
- Added integrated terminal URL detection, clickable URL opening, and terminal search.

### Changed

- Refactored the chat runtime and `useChatStore` into dedicated orchestration, persistence, session, compaction, replay, and runtime modules.
- Hardened context budgeting with model/provider context limits, serialized payload estimates, image token estimates, source fingerprints, provider payload pruning, overflow recovery, and manual/automatic compaction decisions.
- Moved compaction status into the conversation transcript, refined the compaction timeline animation/layout, and reduced noisy live context labels.
- Refactored branch worktree handling, task preparation, metadata hydration, service runtime, smart commit drafts, and commit message generation flows.
- Updated the 0.1 documentation source of truth around the local-first desktop scope, local provider storage, and release guidance.

### Fixed

- Fixed OpenAI-compatible reasoning/tool-call replay for Kimi, DeepSeek, OpenRouter, Mistral, Claude-like, and LiteLLM providers, including OpenCode Go Kimi preserved-thinking requests after tool calls.
- Fixed commit message generation from diff context and refined the instructions used for generated commit messages.
- Fixed File Changes panel hover/focus action overlap and related review diff interactions.
- Fixed worktree hydration, metadata sanitization, context policy defaults, non-authoritative fallback handling, post-compaction hard stops, and provider payload double-counting.
- Fixed chat scroll pinning when tool accordions expand.

### Security

- Provider API keys and ChatGPT sessions continue to use Macro's private local app data file, with the documentation updated to match the 0.1 behavior.
- Added assistant Git stage/commit guard coverage as part of the release candidate hardening.

### Removed

- Removed legacy runtime mocks, mock provider data paths, legacy AGENT instructions, and obsolete archived API documentation.
- Removed temporary provider debug console/Rust instrumentation added while diagnosing OpenCode Go errors.

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
- Linux, Windows, and weekly builds are best-effort unless called out in a specific release. Remote transport and headless workflows are not product features in 0.1.

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
