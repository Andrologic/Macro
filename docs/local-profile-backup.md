# Local profile backup

Open Settings → General → Backup and restore. Stop running tasks, enter an
absolute path to a new archive file, select Prepare backup and confirm. Quit
Macro completely without editing the session, then reopen it. The operation
runs before the database and configuration writers start. Its result appears
in the same settings section.

To restore, enter the archive path, select Restore backup and confirm the
replacement. Quit and reopen Macro. The archive is checked both when preparing
the request and before restoring. A damaged or incompatible archive does not
replace the profile. Use the same Macro version that created the archive.

The profile includes SQLite conversations, messages, stored citation contents,
code checkpoint histories, private direct checkpoints, global approved
configuration, native UI state, message images and composer/questionnaire
drafts. Project source folders and their Git metadata, including `@macro`, are
outside this archive. Copy those projects separately. Unapproved configuration
proposals are not exported.

The portable archive excludes `provider-secrets.json`, legacy provider API keys,
MCP environment variables and MCP headers. Secrets already present on the
receiving installation remain there. On another installation, reconnect your
providers. User-authored conversations, snapshots, URLs and command arguments
are preserved and may themselves contain private information. Protect the
archive as private data.

Archives use the versioned `macro-local-profile` JSON format. Each file and the
browser state have SHA-256 checksums. SQLite uses `VACUUM INTO` so committed WAL
contents are included; credentials are removed from the copy and that copy is
vacuumed again. Validation checks database integrity, foreign keys, supported
migration versions, tables and column shapes, configuration validity, paths,
checksums and size. Archives are limited to 256 MiB and 10,000 file entries;
private checkpoint traversal also has a depth and entry budget.

Before replacing the current profile, Macro preserves its managed files as raw
bytes, including SQLite WAL/SHM and invalid configuration or state files, in a
new private `<app-data>/local-backup/preserved-<id>.json` file. Each preservation
has its own name and is retained. Its exact path appears after restoration.
Checksums are verified again after writing this file. If any required file
cannot be read or the preservation cannot be saved, no profile file is replaced.
A damaged but readable database or runtime configuration does not prevent a
prepared restoration.

An interrupted native replacement leaves a journal pointing to that private
preservation. On the next startup, Macro restores the prior raw files before
opening SQLite or parsing configuration. If the previous profile was damaged,
its damaged bytes remain recoverable. A healthy private preservation can also
be selected in the restoration UI; Macro first normalizes its SQLite WAL in a
temporary directory and performs the ordinary compatibility checks. A damaged
preservation is retained for recovery of its original file bytes, not accepted
as a valid replacement profile.

If browser storage cannot accept restored images or drafts, Macro restores the
prior browser values and blocks Chat hydration. Free browser storage and restart
to retry. After a successful application and acknowledgement, the webview reloads
once so all stores start from the restored values. Private preservation files
may contain sensitive configuration values and must remain local.

Checkpoint corruption never becomes an empty history on the desktop. It is
reported and prevents replacing the affected record. Message image recovery
loads valid records within its limits while retaining the raw original storage;
a partially invalid history cannot be silently overwritten. Persistence failures
appear in the notification center and in the backup settings section.
