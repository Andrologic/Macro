# SQLite migration history

Versions 1, 3 and 4 retain their published SQL. Version 2 was a provider data
migration removed from the source tree; its existing record remains valid and
is not recreated. The file `002_agent_runs.sql` implements version 3.

Version 5, `005_runtime_schema`, freezes the former startup compatibility
helpers in `reconcile_runtime_schema_v5`. SQLite cannot conditionally add a
column in plain SQL, so this transition uses the existing Rust introspection
and additive statements. `005_runtime_schema_check.sql` checks the resulting
columns and indexes before version 5 is recorded. Keep both this transition
and its helpers immutable after publication. Add future schema changes under
a new version, including when the change is implemented in Rust.

Version 6 adds generation attempt metadata to messages. Version 7 adds the
conversation-owned tool invocation journal. It stores only the SHA-256 digest
of canonical JSON arguments, never argument or result bodies. The owning
runtime must record an invocation before dispatch and call completion only
after its transport confirms acceptance of the result. A startup pass changes
remaining `pending` rows to `unknown`; neither state authorizes replay.
Only a newly inserted row (`is_new=true`) authorizes a first dispatch. Repeated
records never authorize dispatch, even when the stored state is still `pending`.
Receipt IDs are checked per invocation and may be reused by separate calls.

The supported inputs are:

- An empty database, initialized with version 1 and upgraded through version 7.
- An unversioned database with historical runtime tables, adopted through the
  legacy path. Missing tables and known additive columns are supplied by the
  frozen compatibility helpers. Existing extra columns, tables, indexes and
  triggers remain in place.
- A database stamped with version 1, optionally 2, then 3 and 4, whose runtime
  tables still lack historical additive columns or tables. Version 5 performs
  the same bounded reconciliation once. It runs before any pending versions
  3 and 4 because those migrations require the runtime tables; version 5 is
  recorded only after their completion and its checks.
- A version 7 database, reopened without compatibility helpers, DDL, timestamp
  backfills or FTS rebuilds. Default provider seeding retains its existing
  startup behavior and is separate from schema migration.

All pending work, including legacy adoption, checks and version stamps, runs
under the existing `BEGIN IMMEDIATE` transaction. SQL failure or foreign-key
violations roll back the entire attempt. Closing the connection before commit
also rolls back; the next opening retries from the previous committed version.
No table rebuild, row deletion or personal database conversion is performed by
the development tests.

Unknown versions and histories missing a required predecessor fail before
schema reconciliation. Missing core columns, required indexes or FTS triggers
that the compatibility transition cannot supply also fail rather than recording
version 5. Foreign-key violations must be repaired separately from migration;
this path does not discard or rewrite orphaned records. Error details are
returned through the existing database error path.

This is not a repair engine for arbitrary corruption. It preserves historical
constraints instead of rebuilding tables to impose today's canonical SQL.
The checks do not certify arbitrary hand-edited types, constraint definitions,
trigger bodies or FTS contents. A committed version 5 is trusted on subsequent
openings; normal migration startup does not run a full integrity audit. Backup
validation and recovery retain their separate schema validation contracts.
