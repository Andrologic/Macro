# Continuous integration and release governance

Macro uses two GitHub Actions workflows with deliberately different cost profiles.

## Local validation gate

GitHub Actions confirms changes on clean remote runners; it is not a development
loop. Every clone should install the tracked hooks once:

```bash
bun run hooks:install
```

Before a push, `.githooks/pre-push` compares the complete proposed integration
range, runs `dev/ci/classify-changes.mjs`, and selects a shared local profile:

| Change | Local profile |
| --- | --- |
| Documentation only | Version manifests and tracked-binary policy |
| Frontend | Locked install, workflow policy, typecheck, tests, Vite build, and bundle budget |
| Native or configuration | Complete frontend validation plus Rust tests for every target and doc tests |
| Focused Windows job | Sidecar build plus `cargo check --all-targets` |

Every local profile prints the duration of each step and of the whole run.
Frontend profiles typecheck once and build with Vite only; `tsc` is not run a
second time inside the build step. Frontend tests run with bounded parallelism
and per-file isolation, and coverage instrumentation stays opt-in so ordinary
runs pay no coverage cost. Native and full profiles use `cargo test
--all-targets` so examples, binaries, and library tests share one compilation;
the separate documentation-test pass reuses those artifacts.

The successful result is cached outside the worktree for the exact HEAD, target
base, platform, and profile. Running `bun run ci:pre-push` manually immediately
before `git push` therefore does not duplicate the expensive work. A dirty
worktree is rejected because it would make the validation differ from the
commits actually sent.

The workflow files invoke the same `dev/ci/run-checks.mjs` profiles. Workflow
syntax and repository security policy are checked locally by
`bun run ci:workflows`, including immutable action pins, explicit permissions,
job timeouts, credential-free checkouts, tag-only releases, and the protected
release environment.

## Pull request and branch CI

The ordinary `CI` workflow runs for pull requests targeting `develop` or `main`, and as a safety net for direct pushes to those two branches. Feature-branch pushes do not trigger a second push workflow. A stable concurrency key per pull request cancels obsolete runs.

The always-present `Classify changes` check compares pull requests from their merge base, examines both paths of renames, and also sees deleted files. For pull requests it runs the classifier stored on the trusted target revision, so proposed code cannot falsify which required jobs may be skipped. The first pull request introducing the classifier cannot trust a base copy, so it forces every validation instead. Direct branch pushes use the exact pushed range, while a newly created ref is classified conservatively. It selects the remaining checks as follows:

| Change | Checks |
| --- | --- |
| Draft pull request | `Classify changes` only |
| Documentation or issue templates only | `Classify changes` only |
| Frontend or shared UI code | Classification and `Linux validation` |
| Rust, Tauri, or AI sidecar code | Classification, `Linux validation`, and `Windows native check` |
| Workflows, manifests, lockfiles, or build scripts | All three checks, conservatively |
| Unclassified path | All three checks, conservatively |

`Linux validation` keeps frontend checks in one runner and adds Rust checks only when native or configuration files are involved. `Windows native check` performs a focused `cargo check`; it does not duplicate frontend tests or build an installer. Ordinary CI never uses a macOS runner.

All actions are pinned to immutable commits, checkouts do not persist credentials, jobs have timeouts, and ordinary CI has read-only repository permissions. Pull requests from forks therefore receive the same validation without repository write access or release secrets.

## Release workflow

The `Release` workflow is tag-only. A stable tag named exactly `v<package version>` must point to a commit contained in `origin/main`. Cheap metadata, lockfile, frontend, bundle, sidecar, and Rust checks complete before the signed build matrix starts.

The build matrix creates a universal macOS DMG, a Windows x64 NSIS installer, and Linux x64 AppImage, DEB, and RPM packages. It verifies platform signatures or package contents, refuses missing artifacts, and uploads short-lived build artifacts. The final job calculates SHA-256 sums and creates a draft GitHub release only. Publishing the draft is always a manual owner action.

Before a release tag is created or pushed, `bun run release:preflight` requires
a clean checkout whose HEAD exactly matches `origin/main`, verifies the stable
version and tag availability, runs full local CI, and builds the native package
for the current operating system. The tag push hook applies the same gate.

Agents must not push repeatedly while using Actions results as their test loop.
After a remote failure they must first reproduce or explain it locally, apply a
focused correction, and pass the relevant local profile. An unchanged job may
be rerun once only for a demonstrated transient runner, service, or network
failure.

## Required GitHub settings

Repository administrators must apply the following settings manually. Workflow files alone cannot enforce them.

### Branch rules

For `develop`:

- require a pull request and resolved conversations;
- require `Classify changes`, `Linux validation`, and `Windows native check`;
- require the job checks themselves (job-level `skipped` conclusions are acceptable; do not add workflow-level path filters that leave checks pending);
- block direct pushes except, if desired, a narrowly scoped administrator break-glass account;
- block force-pushes and deletion.

For `main`:

- require a pull request from a release or hotfix branch and resolved conversations;
- require the same three checks;
- block all direct pushes, force-pushes, and deletion.

Use GitHub rulesets or equivalent branch protection. Confirm the exact check names after the workflows have run once on an authorized pull request.

### Release tags

Create a ruleset for `refs/tags/v*` that restricts tag creation, update, and deletion to named release maintainers. Generic agent or automation accounts must not be allowed to create release tags. The workflow requires annotated tags, and the ruleset must keep them immutable after creation.

### Protected `release` environment

Create an environment named `release` and configure:

- the repository owner as a required reviewer, with self-review prevented where appropriate;
- deployment restricted to protected `v*` tags;
- macOS signing and notarization secrets only in this environment;
- the authorized Apple Team ID as `APPLE_TEAM_ID`, used to verify the signed bundle identity;
- Windows certificate and password secrets only in this environment;
- no access from pull request jobs.

The build matrix declares this environment, so it waits for approval before consuming costly platform minutes or receiving signing secrets. Do not authorize a release until the validation job and tag provenance have been reviewed.

An administrator can still create many commits or tags and can bypass some repository controls. Branch rules, the tag ruleset, restricted credentials, and the protected environment are therefore essential parts of the design, not optional workflow hardening.
