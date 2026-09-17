# Release runbook for agents

Read this file before changing a stable version, creating its release branch or
tag, publishing it on GitHub, repairing its update channel, or cleaning up its
release work. `RELEASES.md` remains the reference for versioning, artifact
formats, signing, updater behavior, and platform test expectations.

If the task changes release scripts, hooks, workflows, caches, or approval
automation instead of shipping a version, also read
`docs/release-optimization-plan.md`.

## Operating rules

- Keep the repository root on `develop`. Prepare the version on a release
  branch in its own worktree and publish from a clean checkout of `main`.
- Treat the release tag as immutable. A defect found after a tag exists requires
  a higher patch version unless the failure is proven to be transient and the
  workflow can safely rerun unchanged.
- Keep signing material in the protected GitHub environment. Never place secret
  values in a prompt, document, command argument, log excerpt, release note, or
  local checkpoint.
- Use the smallest local checks while preparing the release. GitHub pull request
  checks are the merge authority. Run the release preflight once on the exact
  `main` commit that will receive the tag.
- Let independent GitHub platform builds run in parallel. Follow their state
  with one watcher and inspect logs only when a job fails or stops progressing.
- Make external changes only within the requested release. Publishing a draft,
  approving the protected environment, deleting a remote branch, or advancing a
  channel requires the user's release authorization.
- Preserve unrelated worktrees, local artifacts, branches, conversations, and
  user changes. Cleanup targets only resources created for the current release.

## Ready to prepare

Release preparation starts only when all of these conditions hold:

- The user has fixed the intended version and release scope.
- Every included task has reached its required review state and has been merged
  into `develop`.
- `develop` is clean, fetched, and aligned with `origin/develop`.
- No active task is editing the same version manifests, release notes, workflow,
  installer, or updater files.

If one condition is false, resolve it before changing the version.

## Prepare the release branch

1. Create `release/<version>` in a dedicated worktree from the current
   `develop`. Confirm the worktree is clean and its base is the expected
   `origin/develop` commit.
2. Run `bun run version:bump <version>`. Review every changed manifest rather
   than editing secondary version files independently.
3. Add `dev/release/notes/<version>.md` and update `CHANGELOG.md`. Write only
   behavior that shipped. Keep internal implementation details out of the
   user-facing note.
4. Run the focused version, notes, workflow, installer, or updater checks selected
   by the changed files. Run `bun run ci:pre-push` after committing the release
   preparation.
5. Push the release branch once its local gate passes. Open a pull request to
   `main`, wait for every required check, and inspect any failure before updating
   the branch.
6. Merge only when the worktree is clean, the pull request is current, and all
   required GitHub checks pass. Record the resulting `main` merge SHA.
7. Reintegrate the release changes into `develop` without rewriting either
   branch. Run the differential pre-push gate and push `develop`.

This phase is complete when `origin/main` contains the prepared version,
`origin/develop` contains the same release changes, and both remote branches
have successful required checks.

## Validate and create the tag

Use a clean checkout whose `HEAD` exactly matches `origin/main`. Keep a reusable
release checkout when possible so native build caches survive between releases.
Store downloaded release assets outside that checkout.

1. Fetch `origin/main` and tags. Confirm the intended remote tag does not exist.
2. Run `bun run release:preflight`. The current implementation runs exhaustive
   local CI and builds the native package. Until the evidence cache described in
   `docs/release-optimization-plan.md` is implemented, the tag push hook repeats
   this gate. Never bypass the hook to save time.
3. Confirm the checkout remains clean and `HEAD` still equals `origin/main`.
4. Create one annotated tag named exactly `v<version>` on that commit.
5. Push only that tag. Capture the Release workflow run ID immediately.

This phase is complete when the remote annotated tag points to the recorded
`main` SHA and the Release workflow has accepted its provenance.

## Build and approve

1. Watch the Release workflow as one run. The validation job should reuse the
   successful `main` validation for the exact SHA. If it falls back to full
   validation, record why.
2. As soon as validation passes, check for a pending deployment on the protected
   `release` environment. Review the tag, version, commit, and authorization.
3. If the user authorized publication and the connected maintainer can approve,
   approve the pending deployment once. Otherwise ask the authorized reviewer
   and wait.
4. Follow the macOS universal, Windows x64, Windows ARM64, and Linux x64 jobs in
   parallel. Report state changes, failures, or approval needs. Avoid narrating
   unchanged polls.
5. Rerun an unchanged job at most once and only when its log proves a transient
   runner, service, or network failure. A source or packaging defect requires a
   new patch version.

This phase is complete when all four platform jobs pass their package-specific
checks and the workflow creates a draft release.

## Verify and publish the draft

Check the draft through the GitHub API before publishing it. The expected asset
set for version `<version>` is:

```text
latest.json
Macro_<version>_Linux_x64.AppImage
Macro_<version>_Linux_x64.AppImage.sig
Macro_<version>_Linux_x64.deb
Macro_<version>_Linux_x64.rpm
Macro_<version>_macOS_universal.app.tar.gz
Macro_<version>_macOS_universal.app.tar.gz.sig
Macro_<version>_macOS_universal.dmg
Macro_<version>_Windows_ARM64_setup.exe
Macro_<version>_Windows_ARM64_setup.exe.sig
Macro_<version>_Windows_x64_setup.exe
Macro_<version>_Windows_x64_setup.exe.sig
SHA256SUMS.txt
```

Verify all of the following:

- The release has the exact tag, commit, title, stable status, and reviewed
  notes.
- Every expected asset exists once, has state `uploaded`, and has a nonzero
  size. No unexpected generated asset is present.
- `latest.json` contains the expected version, five updater targets, embedded
  signatures, and URLs pinned to the immutable tag.
- The checksums file covers the release assets. The workflow's checksum and
  updater verification steps passed.
- The macOS job verified signing and notarization. The Windows jobs verified the
  native PE architectures and the documented installer signing state. The Linux
  job inspected every package format.

Publish the draft only after the complete check passes. Publishing should
trigger `Publish update channel` automatically.

## Verify Stable and finish

1. Wait for `Publish update channel`. If the release event did not start it,
   dispatch that workflow once with the exact published tag.
2. Verify the public release is neither a draft nor a prerelease and that all
   assets remain available.
3. Read all five `channels/stable-*.json` files on the `updates` branch. Each
   must contain the released version, one matching target, an embedded
   signature, and a URL pinned to the published tag.
4. Record the validation results according to the release validation policy in
   `RELEASES.md`, including any additional checks explicitly requested by the user.
5. Remove the clean release worktree and release branch created for this
   version. Delete the remote release branch after the tag and public release
   are verified. Keep the reusable clean `main` release checkout and its ignored
   build cache if the repository has adopted that convention.
6. Archive completed Codex release tasks when requested. Leave unrelated tasks
   and prior release artifacts untouched.
7. Confirm the repository root is clean on `develop` and aligned with
   `origin/develop`.

The release is complete only when the public release and all five Stable
manifests agree on the version, Git cleanup is scoped and complete, and the
final report links the release and names the validations that passed.

## Failure branches

### Failure before the remote tag exists

Fix the release branch, rerun focused checks, merge the correction, and repeat
the exact-main preflight. A local tag that was never pushed may be removed only
after confirming the remote tag is absent and the corrected release will use a
different commit.

### Failure after the remote tag exists

Keep the tag fixed. Leave an incomplete draft unpublished. Diagnose the job and
rerun it once only for a proven transient failure. For a code, packaging, notes,
or manifest defect, prepare the next patch version.

### Failure after publication

Follow `RELEASES.md` under "Recovering a faulty release". Restore the Stable
channel to the previous supported manifests when necessary, mark the faulty
release clearly, and publish a higher patch version. Never replace tag-pinned
assets or reuse their signatures.

## Handoff record

An agent that stops before completion must leave these exact facts:

- intended version and tag;
- release branch, worktree, and current commit;
- `main` and `develop` integration state;
- commands already passed on the current SHA;
- Release and Stable-channel workflow run IDs;
- pending approval or failed step;
- draft or public release URL;
- asset and channel verification state;
- resources still requiring cleanup.

Facts that can be queried again should stay out of `AGENTS.md`. This runbook is
the operational source of truth for release agents.
