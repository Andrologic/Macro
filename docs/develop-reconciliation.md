# Develop reconciliation

This integration joins local develop `484c78e2` to the released develop base
`21875a71`. Both histories remain reachable through the merge commit. The
application version remains 0.1.5; this change does not publish a release.

## Resolution decisions

- Keep the released archive/search flows, diagnostics, profile backups,
  notifications, attachments/export, and recoverable review sessions.
- Keep local durable task/plan lifecycle operations, generation checks,
  serialized preference/provider/tool updates, and recoverable chat writes.
- Combine review visit/task invalidation with unique modal sessions and file
  revisions. A dirty draft never acquires a newer revision from a reread.
  Preserve text typed while a save is pending and reconcile a lost write reply
  against durable file contents.
- Keep synchronous image-paste consumption with the released image validation,
  attachment import exclusion, context checks, and user-facing error notice.
- Keep the released update writer based on unique temporary files and its
  treatment of directory-sync failures after replacement. Serialize writes on
  Windows and retain local publication generations, process locks, and recovery.
- Keep read-only worktree diagnostics and refuse repairs that would remove or
  relocate existing data. Preserve stale Git administration and its reachable
  objects before recreating a missing worktree. Retain local path ownership,
  linked-parent, and replacement-identity checks for managed cleanup.
- Remove the superseded automatic repair/quarantine helpers. Adjust the old
  quarantine and reset tests to require refusal while verifying that user files
  and worktree registrations survive.
- Use the released cached skill manifest builder after the local staged,
  validated, atomic skill installation.
- Keep French conflict translations and add the local binary/large-file labels.
- Prune completed RPC connection handles on registration under the same mutex
  used by shutdown. Active handles still drain, and late registrations abort.

## Automatic merge review

`StateManager` retains backup validation and reloads the durable snapshot under
its interprocess lock before mutation. Profile restoration still runs before
state/configuration initialization. Archive allowlists exclude state and
configuration lock files, so restoration does not replace live lock identities.

Task and chat stores retain the released workflow additions alongside local
persistence queues and generation fences. Preference mutations reread config
ETags inside their serialized operation. RPC connection registration and shutdown
share one atomic accepting/draining state.

## Validation scope

Run the focused frontend suites, TypeScript check, native worktree/update/state/
backup/skill/configuration tests, and RPC tests in the vendor package itself.
Run the differential pre-push gate against the committed branch. Windows native
tests need permission to create temporary Git repositories. A root-crate test
filter returning zero RPC tests is not vendor validation.

Release packaging, macOS/Linux execution, and visual desktop validation remain
separate checks before release. This reconciliation does not claim those checks.

## Completed integration checks

- Focused frontend tests covering ChatZone, ComposerEditor, StrategyGraph,
  TaskQueue, modelContextCatalog, useFileChangesStore, useChatStore and useTaskStore
  passed, including matching helper suites, 12 files in total.
- `bun run typecheck` and ESLint on manually resolved TypeScript files passed.
- `cargo check --manifest-path src-tauri/Cargo.toml --tests --offline` passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib FILTER
  -- --test-threads=1` passed for `worktree` 66 tests, `app_updates::tests` 20,
  `state_manager::tests` 4, `local_backup::tests` 11,
  `commands::skills::tests` 34, and `config::` 67.
- `cargo test --manifest-path src-tauri/vendor/tauri-remote-ui/Cargo.toml
  --target-dir src-tauri/target --locked --offline --lib rpc_server
  -- --test-threads=1` passed all 8 selected vendor tests. For this standalone
  run, seed the ignored vendor Cargo.lock from the root Cargo.lock and let Cargo
  resolve the standalone package once offline before using `--locked`.
- Rust formatting and whitespace checks passed.

The update concurrency regression was exposed by
`concurrent_atomic_writes_do_not_share_a_partial_file`: the released tempfile
replacement writer returned Windows error 5 when the local concurrency test ran
without the local writer mutex. Restoring that mutex keeps the released atomic
replacement and post-publication durability semantics, while serializing competing
writers. All 20 update tests then passed, including generation fencing and
interprocess publication locking.
