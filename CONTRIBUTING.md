# Contributing to Macro

Thanks for helping improve Macro. The project is open to issues and pull requests, with a little structure around larger changes so the 0.1 line stays stable.

## Before You Start

Open an issue or discussion before working on changes that affect:

- security boundaries or tool approval behavior;
- architecture across React, Tauri, Rust, stores, or services;
- Git/worktree/metadata workflows;
- AI provider behavior, model routing, or prompt/tool execution;
- persistence, migrations, keyring storage, or local files;
- licensing, bundled runtimes, or third-party notices.

Small bug fixes, docs improvements, tests, and narrowly scoped UI fixes can usually go straight to a pull request.

## Local Setup

Macro uses Bun for frontend scripts and Rust for the Tauri backend.

```bash
bun install
bun run tauri:dev
```

For provider keys during local Tauri development, copy the example file and keep real secrets out of Git:

```bash
cp dev/ai-keys.local.example.json dev/ai-keys.local.json
```

## Required Checks

Run these before opening a pull request:

```bash
bun run version:check
bun run repo:check-binaries
bun run typecheck
bun run lint
bun run i18n:audit
bun run test
cargo test --manifest-path src-tauri/Cargo.toml
```

If a check cannot run on your machine, mention that in the pull request.

## Development Guidelines

- Keep changes scoped to the issue or pull request.
- Prefer existing services, stores, Tauri IPC wrappers, and Rust command patterns over new abstractions.
- Add or update tests for behavior changes, especially around Git, tool execution, security policy, persistence, and review flows.
- Do not commit generated release artifacts, local databases, provider keys, signing material, build output, or large binaries.
- Keep user-facing strings routed through the existing i18n patterns when applicable.
- Use the shared notification system for user-facing notifications.

## Pull Requests

Pull requests should include:

- a short summary of the user-visible or developer-visible change;
- test commands run locally;
- screenshots or recordings for meaningful UI changes;
- notes for any limitations, follow-up work, or intentionally deferred checks.

By contributing, you agree that your contribution will be licensed under the repository license, AGPL-3.0-or-later.
