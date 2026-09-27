# Release pipeline optimization plan

Status: proposed. This document guides changes to release tooling. Agents
shipping a version must follow `docs/release-agent-runbook.md` and use only
commands that exist on their checked-out commit.

## Outcome

Reduce a normal stable release from a long sequence of repeated checks and
manual API calls to one exhaustive validation per commit, one native package
rehearsal, one protected approval, and the required four-platform GitHub build.

Targets after implementation:

- At most one exhaustive validation for a given release commit and platform.
- A second invocation for the same tag and unchanged state completes metadata
  checks in under 30 seconds.
- Work from a green `main` commit to a public Stable release usually completes
  in 40 to 50 minutes, including the GitHub build matrix.
- Agent intervention outside release notes and required product tests stays
  under 10 minutes.
- Every command is resumable or fails with the next safe action.
- No proof, checkpoint, log, or document contains a secret value.

## Baseline from v0.1.3

The v0.1.3 release exposed four separate costs:

| Stage | Observed cost | Cause |
| --- | ---: | --- |
| Release-branch full CI | about 12 minutes | Exhaustive local rehearsal before integration |
| Exact-main preflight | about 20 minutes | Full CI plus a cold native Windows package build |
| Tag push hook | about 11 minutes | The hook repeated the full preflight and native package build |
| GitHub release workflow | about 28 minutes | Approval wait plus four native builds and draft creation |

The GitHub platform jobs ran in parallel and finished in 20 to 23 minutes after
approval. That work produces the signed and native artifacts and remains
required. The avoidable cost is the repeated local validation and packaging,
plus a few minutes lost before detecting the pending environment approval.

## Invariants

Every implementation phase must preserve these properties:

- A stable tag is annotated, new, immutable, named `vX.Y.Z`, and points to a
  commit contained in `origin/main`.
- The version manifests and release notes come from the tagged commit.
- GitHub builds macOS universal, Windows x64, Windows ARM64, and Linux x64 from
  that commit. Signed updater assets are never copied from another tag.
- The protected environment remains the only source of signing and notarization
  credentials. Pull requests and local proof files never receive them.
- macOS signing and notarization, Windows architecture checks, Linux package
  inspection, updater signatures, checksums, and Stable-channel validation stay
  mandatory.
- A cache miss fails safe by executing the existing validation. A malformed or
  mismatched proof never skips work.
- Agents never bypass hooks to claim a cache hit.

## Phase 1: reusable preflight evidence

This phase removes the largest local duplication. Model it on the existing
exact-input cache in `dev/ci/pre-push.mjs`.

### Design

Add an importable module such as `dev/release/preflight-evidence.mjs`. Store its
files under the Git common directory so every worktree sees the same evidence:

```text
<git-common-dir>/macro-release/preflight/<digest>.json
```

The digest and stored key must include:

- schema version;
- normalized repository identity;
- release version and requested tag;
- `HEAD` and `origin/main` commit IDs;
- operating system and architecture;
- exact Bun and Rust toolchain fingerprints;
- native package command;
- a fingerprint of the preflight policy and command plan;
- validation source, either a successful GitHub run ID for the exact `main` SHA
  or a completed local full profile;
- native package path relative to the worktree and its SHA-256 digest.

Write evidence atomically only after every selected validation and the native
package build pass. Evidence stores identifiers, timestamps, relative paths,
and digests. It stores no environment values, credentials, command output, or
absolute user paths.

On every invocation, `dev/release/preflight.mjs` must still check the clean
worktree, exact `origin/main`, version, annotated local tag when present, and
remote tag availability. It may return after those cheap checks only when the
complete evidence key matches.

### Reuse successful main CI

Extract the GitHub lookup in `dev/ci/find-reusable-ci.mjs` into an importable
module while keeping its CLI. The preflight should accept a successful required
CI run only when it belongs to the exact `origin/main` SHA and every required
job and step passed.

Selection order:

1. Reuse matching local preflight evidence.
2. Otherwise reuse successful GitHub CI for the exact `main` SHA, then build the
   local native package.
3. If GitHub is unavailable or no qualifying run exists, run the current full
   local profile, then build the native package.

Provide `--force` for maintainers who intentionally want a fresh full local
validation. A network failure must select the local fallback rather than
silently weakening the gate.

### Tag hook behavior

Keep `.githooks/pre-push` and `dev/ci/pre-push.mjs` as the entry point. The tag
hook may continue calling `preflight.mjs --tag <tag>`. The second call will run
cheap provenance checks and consume the matching evidence instead of rebuilding
the application.

This is safer than adding a hook-only skip flag because the preflight remains
the single authority for evidence validation.

### Files and tests

Expected changes:

- `dev/release/preflight.mjs`
- new `dev/release/preflight-evidence.mjs`
- new focused evidence tests
- `dev/ci/find-reusable-ci.mjs` and its tests
- `dev/ci/pre-push.test.ts`
- `dev/release/preflight-policy.test.ts`
- `docs/ci.md`, `RELEASES.md`, and `CONTRIBUTING.md`

Tests must prove that changes to the tag, commit, `origin/main`, version,
platform, architecture, toolchain, command plan, policy fingerprint, validation
run, or package digest invalidate reuse. They must also prove atomic writes,
malformed-file fallback, absent-GitHub fallback, and exact evidence reuse by the
tag hook.

### Completion criterion

In a temporary repository, a first preflight performs validation and packaging.
A second preflight for an annotated tag on the same commit performs only cheap
checks. Mutating any keyed input causes the original gate to run again.

## Phase 2: resumable release orchestration

Add one script for the remote state machine, exposed through `package.json` as a
command such as:

```text
bun run release:publish -- --tag vX.Y.Z
```

The exact interface should be fixed by tests before implementation. The command
must infer existing remote state on every run instead of trusting a local
checkpoint.

### States

The orchestrator should detect and advance these states in order:

1. exact-main preflight evidence valid;
2. local annotated tag valid;
3. remote tag created;
4. Release workflow identified;
5. protected environment approved;
6. four platform jobs passed;
7. draft release verified;
8. release published;
9. Stable-channel workflow passed;
10. five public channel manifests verified;
11. scoped Git cleanup complete.

Store only run IDs and last observed states under the Git common directory to
make handoff faster. Treat that file as a hint. GitHub, Git, and the public
manifests remain authoritative.

### Approval boundary

The command should stop with a clear approval URL when the protected environment
waits for a reviewer. It may approve through GitHub only when the caller passes
an explicit approval option and the user already authorized publication. It
must never print environment secrets or enumerate their values.

### Draft contract

Move the stable asset names and target mapping into one importable policy module
used by workflow-generation scripts, the verifier, and the orchestrator. Draft
verification must reject missing, duplicate, empty, or unexpected generated
assets. It must validate `latest.json`, signatures, tag-pinned URLs, and the
checksums file before publishing.

### Idempotence and recovery

- Re-running after a timeout resumes the existing workflow or release.
- An already published valid release advances only the missing Stable channel.
- An already current channel becomes a no-op.
- A remote immutable tag with a source defect stops with the instruction to
  prepare a higher patch version.
- An unchanged failed job may be rerun once only when the API and logs classify
  it as transient.
- Cleanup refuses dirty worktrees and branches not created for the requested
  tag.

### Files and tests

Expected changes:

- new `dev/release/publish.mjs`
- new `dev/release/publish-policy.mjs`
- new `dev/release/release-assets.mjs`
- focused tests using temporary repositories and a fake GitHub command adapter
- `package.json`
- `dev/ci/validate-workflows.mjs` when workflow contracts change
- this runbook and `RELEASES.md`

Tests should cover resume from every state, approval without authority, failed
asset contracts, published releases with stale channels, transient retry limits,
and cleanup target validation.

### Completion criterion

Against a fake GitHub adapter, one command can resume from every intermediate
state and reaches completion without repeating an irreversible action. Against
a real published test release, verification mode reports the release and all
channel manifests without modifying remote state.

## Phase 3: persistent release workspace and local cache

Create a small helper that provisions or reuses one managed detached worktree
for exact `origin/main`. A suggested location is a documented sibling directory
outside the repository root. The helper must resolve and verify the absolute
path before creating, moving, or removing anything.

Rules:

- The main repository remains on `develop`.
- The managed worktree checks out `origin/main` detached, so it does not compete
  with a user's `main` worktree.
- Reuse requires a clean tracked and untracked state. The helper refuses a dirty
  workspace instead of cleaning it.
- Downloaded release assets live outside the worktree.
- Ignored Cargo and frontend build caches may survive successful releases.
- Cleanup removes version-specific release worktrees and branches, not the
  managed cache worktree.

Measure a warm native package build before adding another cache system. If the
managed worktree does not provide enough reuse, evaluate `sccache` with a local
cache keyed by toolchain and target. Do not share one mutable Cargo `target`
directory across concurrent worktrees until concurrency tests prove it safe.

### Completion criterion

Two consecutive native package rehearsals for different commits reuse build
work without hiding source changes, and a dirty managed worktree stops before
checkout or deletion.

## Phase 4: measure remote builds before tuning them

The four native GitHub jobs are required and already run in parallel. Optimize
them only after emitting useful measurements:

- dependency-cache restore result;
- Rust compile duration;
- frontend build duration;
- packaging duration;
- signing or notarization duration;
- artifact upload duration;
- total approval wait.

Write these values to the GitHub step summary and compare at least three stable
or preview builds. If Rust compilation dominates despite successful cache
restores, test a pinned GitHub-compatible `sccache` action on one platform. Roll
it out only when it cuts the median build by at least 20 percent without adding
credentials, mutable action references, or cross-target contamination.

Do not prebuild signed stable assets on `develop`, copy artifacts between tags,
or remove native platform verification. Those shortcuts weaken provenance for a
small time gain.

### Completion criterion

Three comparable runs have stage timings. Any cache change shows a measured
median improvement, exact target isolation, and unchanged release checks.

## Phase 5: documentation and agent ergonomics

Once each phase lands:

- update `docs/release-agent-runbook.md` to name only commands that exist;
- update `RELEASES.md` for human-facing behavior and recovery;
- update `docs/ci.md` for validation and cache policy;
- keep the single release pointer in `AGENTS.md` short;
- add `--help` output to every release command;
- make failures print the failed condition, observed value, and next safe
  command;
- record timings and run IDs in the final agent report.

Remove obsolete instructions in the same change. Parallel runbooks that disagree
are worse than a slow release.

## Delivery sequence

Implement the work as separate pull requests so each optimization can be proven
and reverted independently:

1. Preflight evidence and exact-main CI reuse.
2. Remote publication orchestrator and asset policy.
3. Managed release worktree and local build reuse.
4. Remote timing telemetry, followed by cache changes only if measurements
   justify them.

Each pull request should stay within its phase. A later phase must not be used
to justify an untested shortcut in an earlier one.

## Success review

After the first release using the new system, compare it with the v0.1.3
baseline. Record:

- elapsed time from green `main` to remote tag;
- number and duration of exhaustive validation runs;
- time spent in local native packaging;
- approval wait;
- duration of each platform build;
- time from draft creation to Stable-channel verification;
- number of manual commands and recovery actions.

The optimization is accepted when the tag hook reuses exact evidence, the
release completes without a duplicated exhaustive gate, all security invariants
remain intact, and the final public and channel checks agree on the version.
