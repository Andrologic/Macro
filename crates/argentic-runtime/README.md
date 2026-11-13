# Argentic runtime

The runtime embeds SQLx 0.9 SQLite. File and shared-memory pools execute the same
queries and transactions. `sqlite::memory()` retains an idle connection for the
pool lifetime and gives each pool its own memory database.

## Schema ownership

`assets/schema/post042.sql` contains the effective engine objects whose table
names start with `engine_flow030_` or `engine_start030_`. It preserves the DDL of
Macro migrations 030, 031 and 033–041, excluding only the four cross-edition
triggers removed by migration 042 or by dropping their 0.2 owner tables. The
Start-entry recording trigger remains. Initializing a standalone database also
records `post-042` in `argentic_schema_revision`.

Macro retains every historical migration, its identities, ordering and backup
validation. UI intentions, their 032/042 migrations and all other application
tables remain Macro-owned. Macro applies its existing migration chain and does
not invoke the standalone initializer. The integration test compares engine
DDL, including indexes, foreign keys, checks and triggers, against that chain
and exercises rollback, entry recording, immutability and foreign-key refusal.

Future engine changes require additive SQL and a new runtime schema revision.
Macro must apply the corresponding engine SQL in its own next migration, in its
existing transaction and ledger. Existing databases must never silently receive
the initial schema or have their history renumbered. No general migration system
is introduced here.

The filesystem permission implementation is runtime-owned because normalization
resolves real paths and links. Its TypeScript wire mirrors remain in Macro.
