# Local profile backup

Open Settings → General → Backup and restore. Stop running tasks, select Prepare
backup and choose a new archive file in the native save dialog. Review the
destination and confirm. Quit Macro completely without editing the session, then
reopen it. The operation runs before the database and configuration writers
start. Its result appears in the same settings section.

To restore, select Restore backup, choose the archive in the native file dialog
and confirm the replacement. Quit and reopen Macro. The archive is checked both
when preparing the request and before restoring. A damaged or incompatible
archive does not replace the profile. Use the same Macro version that created
the archive.

The profile includes SQLite conversations, messages, stored citation contents,
code checkpoint histories, private direct checkpoints, global approved
configuration, native UI state, message images and composer/questionnaire
drafts, queued instructions and unsaved assistant recovery responses. Queued
instructions retain their identity and text but load paused; resuming requires
an explicit action. Restoring an older archive without these recovery keys
clears the newer values instead of mixing two profile states. Project source
folders and their Git metadata, including `@macro`, are outside this archive.
Copy those projects separately. Unapproved configuration proposals are not
exported.

Every portable restoration detaches managed credentials, including on the same
computer with the same provider IDs. The archive excludes the provider secret
store, its version-zero/version-one migration backups and pending migration
journal, legacy SQLite API keys, MCP environment variables and headers, and
credential fields in configuration. This covers provider and speech keys, web
search keys, MCP OAuth client secrets and tokens, Macro AI installation identity,
and ChatGPT sessions. Restoration removes the receiving profile's active secret
store and migration recovery files and resets stored authentication flags.
Reconnect the services you need after restoration.

Pilot retains its relay address and optional pending instance label, but receives
a new configuration context. Its saved account, session, instance and unfinished
authentication flows are discarded. This prevents the restored profile from
reattaching to the original native vault entries. Macro does not read, erase or
revoke those OS vault entries during backup or restoration. Restart initializes
the stores and their memory caches from the detached profile.

These operations do not revoke remote credentials or disconnect external CLI,
Git, SSH or environment-based authentication. User-authored conversations,
snapshots, URLs, command arguments and extension data are preserved and may
contain private information. Archives are not encrypted; protect them as private
data.

Archives use the versioned `macro-local-profile` JSON format. Each file and the
browser state have SHA-256 checksums. SQLite uses `VACUUM INTO` so committed WAL
contents are included; credentials are removed from the copy and that copy is
vacuumed again. Validation checks database integrity, foreign keys, supported
migration versions, tables and column shapes, configuration validity, paths,
checksums and size. Archives are limited to 256 MiB and 10,000 file entries;
private checkpoint traversal also has a depth and entry budget.

Before replacing the current profile, Macro preserves its managed files as raw
bytes, including SQLite WAL/SHM, the managed secret store and migration files,
Pilot's original state, and invalid configuration or state files, in a new
private `<app-data>/local-backup/preserved-<id>.json` file. Each preservation
has its own name and is retained. On Unix, newly written preservation and
restored profile files have private permissions (0600). The preservation also
contains the browser recovery values captured at confirmation, including queued
instructions and unsaved responses. Its exact path appears after restoration.
Checksums are verified again after writing this file. If any required file
cannot be read or the preservation cannot be saved, no profile file is replaced.
A damaged but readable database or runtime configuration does not prevent a
prepared restoration.

An interrupted native replacement leaves a journal pointing to that private
preservation. On the next startup, Macro restores the prior raw files before
opening SQLite or parsing configuration. This internal rollback restores the
original configuration, state and managed secrets together in their original
context; subsequent initialization may perform the normal store migration. If
the previous profile was damaged, its damaged bytes remain recoverable. A
healthy private preservation can also be selected in the restoration UI; Macro
first normalizes its SQLite WAL in a temporary directory and performs the
ordinary compatibility checks. This chosen restoration follows the portable
policy above: managed secrets and Pilot authentication identities are detached.
Selecting a preservation never restores keys automatically. A damaged
preservation is retained for recovery of its original file bytes, not accepted
as a valid replacement profile.

If browser storage cannot accept restored images, drafts or recovery values,
Macro restores the prior browser values and blocks Chat hydration. Free browser
storage and restart to retry. After a successful application and
acknowledgement, the webview reloads once so all stores start from the restored
values. Private preservation files may contain sensitive configuration values
and must remain local.

Checkpoint corruption never becomes an empty history on the desktop. It is
reported and prevents replacing the affected record. Message image recovery
loads valid records within its limits while retaining the raw original storage;
a partially invalid history cannot be silently overwritten. Persistence failures
appear in the notification center and in the backup settings section.

Restoration replaces the profile without merging. It keeps recorded project
paths and does not reassociate projects moved to another machine or directory.
