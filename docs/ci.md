# Continuous integration and release governance

Macro uses two GitHub Actions workflows with deliberately different cost profiles.

## Local validation gate

GitHub Actions confirms changes on clean remote runners; it is not a development
loop. Every clone should install the tracked hooks once:

```bash
bun run hooks:install
```

Before a push, `.githooks/pre-push` compares the complete proposed integration
range and runs a fast, path-aware guard. It reports the remote profile that
GitHub will execute, but deliberately leaves exhaustive validation to the pull
request workflow:

| Change | Fast local checks |
| --- | --- |
| Every push | Whitespace errors in the pushed range, version manifests, and tracked-binary policy |
| JavaScript or TypeScript | ESLint on changed files plus changed, sibling, and direct-relative-importing test files |
| Rust | `cargo fmt --check` when an existing Rust source changes |
| Workflows or CI scripts | Workflow syntax and repository Actions policy |
| Bun manifests or lockfile | Frozen lockfile consistency, without installing packages |
| Locales or i18n tooling | Translation audit |
| Updater manifests or tooling | Updater configuration preflight |

The hook never installs dependencies, type-checks the whole application, builds
the frontend, or runs a complete frontend or Rust suite. If a selected check
needs missing dependencies, it exits with an instruction to run `bun install`
once. Use `bun run ci` whenever an exhaustive local rehearsal is useful. GitHub
is the merge authority and runs the full shared profiles on clean runners.

Those full profiles typecheck once and build with Vite only; `tsc` is not run a
second time inside the build step. Frontend tests use bounded parallelism and
per-file isolation, and coverage instrumentation stays opt-in. Native and full
profiles use `cargo test --all-targets` so examples, binaries, and library tests
share one compilation; the separate documentation-test pass reuses those
artifacts.

`bun run test:coverage` clears stale reports before running. It merges exact
application line counts into `coverage/lcov.info` and writes global, per-domain,
missing-report, and never-instrumented-file details to `coverage/summary.json`.
On a filtered coverage run, the never-instrumented list applies only to that
subset and is labeled as such in the console. The command still writes a partial
summary when a test fails. Bun 1.3.14 LCOV reports do not identify functions or
branches, so the summary marks those metrics as unavailable.

The successful result is cached outside the worktree for the exact HEAD, target
base, platform, Bun version, and planned command list. Running
`bun run ci:pre-push` manually immediately before `git push` therefore does not
repeat the checks. A dirty worktree is rejected because it would make file-based
lint and tests differ from the commits actually sent.

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

The `Release` workflow is tag-only. A stable tag named exactly `v<package version>` must point to a commit contained in `origin/main`. Cheap metadata, lockfile, frontend, bundle, sidecar, and Rust checks complete before the release build matrix starts.

The build matrix creates a signed and notarized universal macOS DMG, an intentionally Authenticode-unsigned Windows x64 NSIS installer, and Linux x64 AppImage, DEB, and RPM packages. Tauri signs every supported automatic-update artifact independently of platform code signing. The workflow verifies the documented signing state or package contents, refuses missing artifacts, and uploads short-lived build artifacts. The final job calculates SHA-256 sums and creates a draft GitHub release only. Publishing the draft is always a manual owner action.
### Stable and Preview update channels

The application reads channel manifests from the orphan `updates` branch. Each
platform has a stable pointer and a preview pointer under `channels/`. The
branch contains JSON manifests only. Installers remain GitHub Release assets.

Publishing a stable release advances the stable pointers after the owner
publishes the draft. The `Preview` workflow builds `develop` every night at
02:17 UTC, but only after `v0.1.0` exists as a published stable release. It
skips scheduled builds when `develop` has not changed. A manual run can publish
either a nightly or an explicit `x.y.z-rc.n` release candidate.

All preview assets live on the mutable `preview` tag in one GitHub prerelease
named `Macro Preview`. Asset names include the semantic version, so an existing
manifest always addresses the matching signed binary while a new preview is
uploaded. The workflow moves the `preview` tag to the validated `develop`
commit and records that commit in the release notes. Stable releases still use
immutable `v*` tags and remain eligible for GitHub's `Latest` badge.

The application checks the selected channel immediately after the user changes
it. Returning from a prerelease to Stable enables Tauri's downgrade option for
that check. Tauri still verifies the updater signature before installation.

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
- no access from pull request jobs.

The build matrix declares this environment, so it waits for approval before consuming costly platform minutes or receiving signing secrets. Do not authorize a release until the validation job and tag provenance have been reviewed.

### Protected `preview` environment

Create an environment named `preview`, allow deployments from the default
`main` branch, and copy the Tauri updater and Apple signing secrets used by the
release build. GitHub starts scheduled workflows from the default branch; the
workflow itself checks out and records the exact `develop` commit that it
builds. Do not require a reviewer for scheduled nightlies. Pull request
workflows never reference this environment. The workflow needs no personal
access token or second repository.

An administrator can still create many commits or tags and can bypass some repository controls. Branch rules, the tag ruleset, restricted credentials, and the protected environment are therefore essential parts of the design, not optional workflow hardening.
