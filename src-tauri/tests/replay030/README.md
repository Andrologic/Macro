# AgSDL 0.3 journal replay

This standalone target builds the production reader and reducer without desktop
packaging, provider SDKs or a Tauri runtime. It uses the same source as the Cargo
example `agsdl_flow030_replay` in the desktop manifest.
Its dependency versions and checksums match the desktop lock. The native CI
profiles check this target with `cargo check --locked --all-targets`; the CI
profile tests also reject dependency versions absent from the desktop lock.

With `CARGO_TARGET_DIR` set to the desired build cache:

```sh
cargo build --locked --manifest-path src-tauri/tests/replay030/Cargo.toml --profile replay -j 2
bun -e 'const r = Bun.spawnSync(Bun.argv.slice(1), {stdout:"inherit", stderr:"inherit"}); process.exit(r.exitCode)' -- "$CARGO_TARGET_DIR/replay/agsdl_flow030_replay" "$DB" "$SYSTEM_ID" "$INVOCATION_ID"
```

The single stdout line is JSON. Exit status is 0 for consistency, 1 for a
divergence or unreadable database, and 2 for invalid command-line arguments.
The `outsideReplay` field lists the host evidence that still needs validation.
No schema migrations or host execution code run. The reader opens SQLite with
`mode=ro`, enables `query_only`, and uses a read transaction. It enables immutable
mode only when there is no nonempty WAL. With a nonempty WAL, it first copies
the database and its available `-wal` and `-shm` companions into a private
temporary directory, then opens only that copy. No SQLite operation opens the
original in that case, so even a missing SHM is never created beside it. Quiesce
a live writer first so the copied database and WAL form a consistent snapshot.
On Unix, the directory is created with mode `0700` and each copied file with
mode `0600`. These modes apply at creation, before journal bytes are written.

Each accepted event is reduced from the initial state in journal `rowid` order.
Its receipt, retained event record, and ordered outbox effects are checked at
that point. The schema stores only the latest state, so the full typed state is
compared after the last event. Settlement checks correlate status and receipt
with consumed preparations, handoffs, retained joined-stop events or no-admission
proofs. They cannot prove physical execution or reconstruct a claim history that
was never journaled. An agent Start handoff requires its native work attempt.
Recorded work evidence or a WorkResult requires a settled Start with a retained
handoff. For admitted work, PhysicalEnded requires a settled Start with its
handoff, plus a settled, correlated StopWork when the event names one. Native
non-admission is a separate path: its exact proof and physical-end receipt must
correlate, but `settle_unadmitted` settles only Start and leaves StopWork's
dispatch status unchanged. Pending or uncertain StopWork is then allowed
without a handoff or settlement. The initial Enter event keeps its native
`start:enter` identity.
Unexpected SQLite storage types and residual verifier panics yield a negative
JSON verdict and exit status 1.

Durable `UNSPECIFIED_SHARED_CANCELLATION` diagnostics are recomputed with the
reducer. They must have the exact diagnostic payload, no receipt, no state
advance and no produced effects. As in `apply_tx`, later events are blocked
except Stop and physical proofs after Stop. A conforming diagnostic is accepted.

Run the synthetic tests with:

```sh
cargo test --locked --manifest-path src-tauri/tests/replay030/Cargo.toml --profile replay -j 2
```

The external corpus test requires `AGSDL_REPLAY_AUDIT_DIR` containing the audit's
`all-mutation-results.json` and `mutations/`, `AGSDL_REPLAY_R6_DIR` containing the
15 `*-scenario-delete.sqlite` files, and `AGSDL_REPLAY_REPORT` for its JSON output.
It copies every database and companion into a temporary directory before reads.
No corpus files are tracked in this repository.

```sh
cargo test --locked --manifest-path src-tauri/tests/replay030/Cargo.toml --profile replay -j 2 -- real_r6_and_audit_mutations_on_copies --ignored
```

The ignored `real_r6_physical_only_pending_and_uncertain_are_rejected` test uses
`AGSDL_REPLAY_R6_DIR` to reproduce the four physical-only audit mutations.
`real_r6_final_runs_on_copies` uses `AGSDL_REPLAY_R6_FINAL_DIR` to verify the
fifteen final QA databases on copies as well.

The corpus test requires every baseline to pass and every semantic mutation to
the run, journal or outbox to fail. Host-only mutations may pass replay; the
report marks whether those three tables actually changed.
