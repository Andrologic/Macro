-- Desktop-only bytes and receipts. Authority is installed by the local host.
CREATE TABLE IF NOT EXISTS pilot_file_authorities (
 owner_key TEXT PRIMARY KEY, instance_id TEXT NOT NULL, binding TEXT NOT NULL,
 active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS pilot_file_binding_history (
 owner_key TEXT NOT NULL, binding TEXT NOT NULL, PRIMARY KEY(owner_key,binding)
);
CREATE TABLE IF NOT EXISTS pilot_file_transfers (
 id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, owner_key TEXT NOT NULL,
 ref_key TEXT NOT NULL, instance_id TEXT NOT NULL, session_id TEXT NOT NULL,
 intent_id TEXT NOT NULL, batch_id TEXT NOT NULL, intent_digest TEXT NOT NULL,
 file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
 total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 1 AND 2097152),
 sha256 TEXT NOT NULL, data BLOB NOT NULL DEFAULT X'',
 received_bytes INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('receiving','finalized','attached','aborted','expired')),
 attachment_id TEXT UNIQUE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, last_progress_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(scope_key,intent_id)
);
CREATE INDEX IF NOT EXISTS pilot_file_quota ON pilot_file_transfers(instance_id,session_id,state);
CREATE TABLE IF NOT EXISTS pilot_file_chunks (
 transfer_id TEXT NOT NULL REFERENCES pilot_file_transfers(id) ON DELETE CASCADE,
 offset_bytes INTEGER NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
 PRIMARY KEY(transfer_id,offset_bytes)
);
CREATE TABLE IF NOT EXISTS pilot_file_sends (
 owner_key TEXT NOT NULL, ref_key TEXT NOT NULL, send_intent_id TEXT NOT NULL,
 scope_key TEXT NOT NULL, digest TEXT NOT NULL,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('message_persisted','launch_uncertain','confirmed')),
 revision INTEGER NOT NULL DEFAULT 1,
 attachment_ids_json TEXT NOT NULL, assistant_message_id TEXT,
 context_state TEXT NOT NULL CHECK(context_state IN ('ready','unavailable')),
 intent_expires_at INTEGER NOT NULL,
 PRIMARY KEY(owner_key,ref_key,send_intent_id)
);
CREATE TABLE IF NOT EXISTS pilot_message_attachments (
 id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, instance_id TEXT NOT NULL, ref_key TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 file_name TEXT NOT NULL, mime_type TEXT NOT NULL, total_bytes INTEGER NOT NULL,
 sha256 TEXT NOT NULL, data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_message_attachments_owner ON pilot_message_attachments(instance_id,ref_key,message_id);
CREATE TABLE IF NOT EXISTS pilot_file_sources (
 id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, instance_id TEXT NOT NULL,
 kind TEXT NOT NULL, native_id TEXT NOT NULL, sha256 TEXT NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(scope_key,kind,native_id,sha256)
);
