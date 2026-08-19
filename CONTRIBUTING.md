# Contributing to Macro

Thanks for helping improve Macro. The project is open to issues and pull requests, with a little structure around larger changes so the 0.1 line stays stable.

## Before You Start

Open an issue or discussion before working on changes that affect:

- security boundaries or tool approval behavior;
- architecture across React, Tauri, Rust, stores, or services;
- Git/worktree/metadata workflows;
- AI provider behavior, model routing, or prompt/tool execution;
- persistence, migrations, provider secret storage, or local files;
- licensing, bundled runtimes, or third-party notices.

Small bug fixes, docs improvements, tests, and narrowly scoped UI fixes can usually go straight to a pull request.

## Local Setup

Macro uses Bun for frontend scripts and Rust for the Tauri backend.

```bash
bun install
bun run hooks:install
bun run tauri:dev
```

For provider keys during local Tauri development, copy the example file and keep real secrets out of Git:

```bash
cp dev/ai-keys.local.example.json dev/ai-keys.local.json
```

## Required Checks

Use Bun 1.3.14 and the Rust toolchain pinned in `rust-toolchain.toml`. Install
the repository hooks once per clone. Before every push, run the differential
local gate; the `pre-push` hook runs the same command again and reuses the
successful result for the exact commit range:

```bash
bun run ci:pre-push
```

The gate compares the complete pull request range against `origin/develop` for
feature branches and against `origin/main` for release and hotfix branches. It
uses the same classifier as GitHub Actions. Documentation stays lightweight;
frontend changes run frontend tests and builds; native or configuration changes
run the complete frontend and Rust profiles. On Windows, full local CI also
checks every native target.

Use `bun run ci` when a full validation is explicitly required regardless of
the changed paths. Use `bun run ci:workflows` after editing workflow policy.

If a check cannot run on your machine, mention the exact command and reason in
the pull request. Do not bypass hooks with `--no-verify`. Do not use GitHub
Actions as a development loop: agents and contributors must validate locally,
then push one consolidated pull request update after the local checks pass.
After a remote failure, make and validate a local correction before pushing
again. An unchanged failed job may be rerun once only when its logs demonstrate
a transient infrastructure failure.

## CI Cost Model

The change classifier always reports a check. Draft pull requests and documentation-only changes stop there. Frontend changes add one Linux job; Rust, Tauri, sidecar, workflow, manifest, lockfile, and build-script changes also add a focused Windows native check. macOS and full desktop installers are reserved for authorized release tags.

See [`docs/ci.md`](docs/ci.md) for path classification details, required branch and tag rules, and protected release-environment setup.

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

Keep a pull request in draft while work is incomplete. Mark it ready only after
`bun run ci:pre-push` succeeds for its current HEAD. Before creating a release
tag, run `bun run release:preflight` from a clean `main` checkout matching
`origin/main`.

By contributing, you agree that your contribution will be licensed under the repository license, AGPL-3.0-or-later.
