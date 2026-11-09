# AgSDL 0.3 journal replay

This standalone target builds the production reader and reducer without desktop
packaging, provider SDKs or a Tauri runtime. It uses the same source as the Cargo
example `agsdl_flow030_replay` in the desktop manifest.

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
mode only when there is no nonempty WAL. For a live database, first make a
consistent copy together with its `-wal` and `-shm` companions.

Each accepted event is reduced from the initial state in journal `rowid` order.
Its receipt, retained event record, and ordered outbox effects are checked at
that point. The schema stores only the latest state, so the full typed state is
compared after the last event. Settlement checks correlate status and receipt
with consumed preparations, handoffs, retained joined-stop events or no-admission
proofs. They cannot prove physical execution or reconstruct a claim history that
was never journaled.

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

The corpus test requires every baseline to pass and every semantic mutation to
the run, journal or outbox to fail. Host-only mutations may pass replay; the
report marks whether those three tables actually changed.
