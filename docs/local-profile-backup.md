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

Before replacing a valid current profile, Macro saves a private rollback archive
in `<app-data>/local-backup/rollback.json`. Its exact path is shown after a
successful restore. That file can be selected in the same restoration UI to
return to the prior profile. It is overwritten only by a later restoration.
It may retain private configuration values and must remain local.

An interrupted native replacement leaves a journal. On the next startup, Macro
restores the prior profile before opening SQLite or configuration. If browser
storage cannot accept restored images or drafts, Macro restores the prior
browser values and blocks Chat hydration. Free browser storage and restart to
retry; the native rollback archive is retained. An unreadable current database
or invalid current configuration prevents creation of the rollback archive and
therefore blocks restoration instead of discarding the original files.

Checkpoint corruption never becomes an empty history on the desktop. It is
reported and prevents replacing the affected record. Message image recovery
loads valid records within its limits while retaining the raw original storage;
a partially invalid history cannot be silently overwritten. Persistence failures
appear in the notification center and in the backup settings section.
