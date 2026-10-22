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

Version 8 records ordered goal-audit transitions under `agent_runs`. The
`(run_id, sequence)` key makes an identical transition replay safe and rejects
conflicting or out-of-order writes. The run row and transition row are changed
in one SQLite transaction. Version 7 remains unchanged.

Version 9 adds current and historical conversation goals, success criteria and
revision counters, plus unique audit identities per conversation/executor turn
and per goal/revision.
Each audit keeps its current run and append-only links to earlier attempts.
The queued run, transition, audit identity and run link commit in one transaction.
An identical queued payload may be replayed after a lost response. The audit
status follows durable run transitions; startup marks remaining
queued/running audits interrupted so a caller must explicitly resume them with
a fresh queued run. Verdict application checks the exact audit, turn, run,
completed run output and goal revision in one transaction. A new claim requires
`audit_pending`; resume requires an interrupted audit and paused goal. Achieved
goals are terminal, though they can be replaced by a new goal. The migration
does not decide when the UI should start an audit.

Version 10 was published independently on two branches. Its recorded name is
part of the migration identity and remains unchanged, including its timestamp:

- `010_visible_message_search` rebuilds message search against the
  `message_search_content` view. Its projection strips assistant thinking blocks
  while preserving original transcripts and user examples. Index maintenance and
  rebuilds use that same projection.
- `010_tool_results` adds validated JSON results to the tool journal. Versions
  11 through 14 then add the durable AgSDL execution, host, UI intent and process
  receipt tables.

Version 15, `015_parallel_v10_reconciliation`, joins these published histories.
The runner checks the name recorded for version 10 before schema work. Unknown
names fail without mutation. A database carrying the visible-search variant
receives the tool-result schema before any pending AgSDL migrations; a database
carrying the tool-result variant receives the visible-search migration after
the AgSDL migrations. A new database follows the tool-result variant. Both paths
record version 15 only after their missing work succeeds. The published SQL and
historical stamps are preserved. All work commits in the existing transaction,
so a failure restores the original schema, data and migration history.

Later openings perform no DDL or FTS rebuild. Backup validation also reads the
version-10 name and compares each historical archive against its own canonical
schema before migration. It accepts both published histories and the joined
schema, while continuing to reject altered tables, indexes and triggers.

The supported inputs are:

- An empty database, initialized with version 1 and upgraded through version 15.
- An unversioned database with historical runtime tables, adopted through the
  legacy path. Missing tables and known additive columns are supplied by the
  frozen compatibility helpers. Existing extra columns, tables, indexes and
  triggers remain in place.
- A database stamped with version 1, optionally 2, then 3 and 4, whose runtime
  tables still lack historical additive columns or tables. Version 5 performs
  the same bounded reconciliation once. It runs before any pending versions
  3 and 4 because those migrations require the runtime tables; version 5 is
  recorded only after their completion and its checks.
- A version 7 database, upgraded to version 8 without rebuilding its tool journal.
- A version 8 database, upgraded to version 9 without rebuilding its run journal.
- Either published version 10 database, or an AgSDL database through version
  14, upgraded to the joined version 15 without replacing historical stamps or
  existing tool results and engine records.
- A version 15 database, reopened without compatibility helpers, DDL, timestamp
  backfills or FTS rebuilds. Default provider seeding retains its existing
  startup behavior and is separate from schema migration.

All pending work, including legacy adoption, checks and version stamps, runs
under the existing `BEGIN IMMEDIATE` transaction. SQL failure or foreign-key
violations roll back the entire attempt. Closing the connection before commit
also rolls back; the next opening retries from the previous committed version.
The development tests use synthetic databases and preserve their transcript
tables and message rows.

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

Version 16 adds the private native-operation journal. Requests enter `possiblySent`
before writing to a native process; received thread and turn references survive
reopening the database before a terminal checkpoint. The journal never authorizes
retrying an operation. Backup validation retains compatibility with older schemas.
