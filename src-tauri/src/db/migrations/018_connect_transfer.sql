-- Private native F journal. These rows grant no network or preparation authority.
-- Ownership and local receipts survive transcript deletion and restore.
CREATE TABLE connect_transfers (
 transfer_id TEXT PRIMARY KEY CHECK(length(transfer_id)=36),
 local_role TEXT NOT NULL CHECK(local_role IN ('source','target')),
 relay_origin TEXT NOT NULL, account_id TEXT NOT NULL,
 source_instance_id TEXT NOT NULL, source_conversation_id TEXT NOT NULL,
 source_epoch INTEGER NOT NULL CHECK(typeof(source_epoch)='integer' AND source_epoch>0),
 target_instance_id TEXT NOT NULL,
 source_generation TEXT NOT NULL, target_generation TEXT NOT NULL,
 binding_digest BLOB NOT NULL CHECK(length(binding_digest)=32),
 binding_json BLOB NOT NULL CHECK(length(binding_json) BETWEEN 1 AND 98304),
 expectation_json BLOB NOT NULL CHECK(length(expectation_json) BETWEEN 1 AND 98304),
 reserve_request BLOB NOT NULL CHECK(length(reserve_request) BETWEEN 1 AND 98304),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 local_generation TEXT,
 ownership_incarnation TEXT, ownership_revision INTEGER CHECK(ownership_revision>0),
 content_incarnation TEXT, content_revision TEXT,
 source_capture_id INTEGER UNIQUE REFERENCES e_source_captures(id) ON DELETE RESTRICT,
 inactive_import_id INTEGER UNIQUE REFERENCES e_inactive_imports(id) ON DELETE RESTRICT,
 restore_hold INTEGER NOT NULL DEFAULT 0 CHECK(restore_hold IN (0,1)),
 phase TEXT NOT NULL CHECK(phase IN ('reserved','receiving','reconciliation_required')),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0),
 UNIQUE(relay_origin,account_id,source_instance_id,source_conversation_id,source_epoch),
 CHECK(source_instance_id<>target_instance_id),
 CHECK((local_role='target' AND ownership_incarnation IS NULL AND ownership_revision IS NULL AND content_incarnation IS NULL AND content_revision IS NULL)
  OR (local_role='source' AND local_generation IS NOT NULL AND ownership_incarnation IS NOT NULL AND length(ownership_incarnation)=32 AND ownership_revision IS NOT NULL AND content_incarnation IS NOT NULL AND length(content_incarnation)=32 AND content_revision IS NOT NULL)),
 CHECK((local_role='source' AND inactive_import_id IS NULL) OR (local_role='target' AND source_capture_id IS NULL))
);
-- Resolution is deliberately unavailable until authenticated terminals are wired.
CREATE UNIQUE INDEX connect_source_exclusive ON connect_transfers(relay_origin,account_id,source_instance_id,source_conversation_id) WHERE local_role='source';
CREATE UNIQUE INDEX connect_local_source_exclusive ON connect_transfers(source_conversation_id) WHERE local_role='source';
CREATE TABLE connect_exchanges (
 delivery_id TEXT PRIMARY KEY CHECK(length(delivery_id)=36),
 transfer_id TEXT NOT NULL REFERENCES connect_transfers(transfer_id) ON DELETE RESTRICT,
 challenge_id TEXT NOT NULL UNIQUE CHECK(length(challenge_id)=36),
 request_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('source_frozen','source_sealed','target_pinned','source_maintained','target_maintained','target_activated')),
 subject_digest BLOB NOT NULL CHECK(length(subject_digest)=32),
 prior_receipt_digest BLOB CHECK(prior_receipt_digest IS NULL OR length(prior_receipt_digest)=32),
 producer_generation TEXT NOT NULL, connection_id TEXT NOT NULL CHECK(length(connection_id)=36),
 canonical_request BLOB NOT NULL CHECK(length(canonical_request) BETWEEN 1 AND 98304),
 expectation_json BLOB NOT NULL CHECK(length(expectation_json) BETWEEN 1 AND 98304),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 phase TEXT NOT NULL CHECK(phase IN ('accepted','result_pending','result_recorded')),
 local_result BLOB CHECK(local_result IS NULL OR length(local_result) BETWEEN 1 AND 98304),
 relay_receipt BLOB CHECK(relay_receipt IS NULL OR length(relay_receipt) BETWEEN 1 AND 98304),
 previous_delivery_id TEXT UNIQUE,
 previous_challenge_id TEXT UNIQUE,
 previous_fingerprint BLOB CHECK(previous_fingerprint IS NULL OR length(previous_fingerprint)=32),
 previous_local_result BLOB CHECK(previous_local_result IS NULL OR length(previous_local_result) BETWEEN 1 AND 98304),
 previous_relay_receipt BLOB CHECK(previous_relay_receipt IS NULL OR length(previous_relay_receipt) BETWEEN 1 AND 98304),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0),
 CHECK((phase='accepted' AND local_result IS NULL) OR (phase<>'accepted' AND local_result IS NOT NULL)),
 CHECK((phase='result_recorded' AND relay_receipt IS NOT NULL) OR (phase<>'result_recorded' AND relay_receipt IS NULL)),
 CHECK((previous_delivery_id IS NULL AND previous_challenge_id IS NULL AND previous_fingerprint IS NULL AND previous_local_result IS NULL AND previous_relay_receipt IS NULL)
  OR (length(previous_delivery_id)=36 AND length(previous_challenge_id)=36 AND previous_fingerprint IS NOT NULL AND previous_local_result IS NOT NULL AND previous_relay_receipt IS NOT NULL)),
 UNIQUE(transfer_id,kind)
);
CREATE TABLE connect_raw_prefix (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_transfers(transfer_id) ON DELETE RESTRICT,
 transit_id TEXT NOT NULL CHECK(length(transit_id)=36),
 producer_generation TEXT NOT NULL,
 session_json BLOB NOT NULL CHECK(length(session_json) BETWEEN 1 AND 4096),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 stream_bytes INTEGER NOT NULL CHECK(typeof(stream_bytes)='integer' AND stream_bytes>0),
 next_sequence INTEGER NOT NULL CHECK(typeof(next_sequence)='integer' AND next_sequence>=0),
 next_offset INTEGER NOT NULL CHECK(typeof(next_offset)='integer' AND next_offset>=0 AND next_offset<=stream_bytes),
 eof INTEGER NOT NULL CHECK(eof IN (0,1)),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0),
 CHECK(eof=(next_offset=stream_bytes))
);
CREATE TABLE connect_raw_chunks (
 transfer_id TEXT NOT NULL REFERENCES connect_raw_prefix(transfer_id) ON DELETE RESTRICT,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=0),
 offset_bytes INTEGER NOT NULL CHECK(typeof(offset_bytes)='integer' AND offset_bytes>=0),
 sha256 BLOB NOT NULL CHECK(length(sha256)=32),
 data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 65536),
 eof INTEGER NOT NULL CHECK(eof IN (0,1)),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0),
 PRIMARY KEY(transfer_id,sequence), UNIQUE(transfer_id,offset_bytes)
);
-- A F attachment is a durable lease, not a prepared pin. No local TTL removes it.
CREATE TRIGGER connect_capture_delete BEFORE DELETE ON e_source_captures WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_capture_shrink BEFORE UPDATE ON e_source_captures WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.id) AND (NEW.id<>OLD.id OR NEW.capture_id<>OLD.capture_id OR NEW.binding_json<>OLD.binding_json OR NEW.phase>2 OR NEW.charge_bytes<OLD.charge_bytes OR NEW.bytes_received<OLD.bytes_received OR NEW.fields_count<OLD.fields_count OR NEW.rows_count<OLD.rows_count) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_import_delete BEFORE DELETE ON e_inactive_imports WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_import_shrink BEFORE UPDATE ON e_inactive_imports WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.id) AND (NEW.id<>OLD.id OR NEW.identity_key<>OLD.identity_key OR NEW.begin_json<>OLD.begin_json OR NEW.phase>2 OR NEW.charge_bytes<OLD.charge_bytes OR NEW.received_bytes<OLD.received_bytes OR NEW.next_record<OLD.next_record) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_source_fields_delete BEFORE DELETE ON e_source_fields WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.capture_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_source_fragments_delete BEFORE DELETE ON e_source_fragments WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.capture_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_source_relations_delete BEFORE DELETE ON e_source_relations WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.capture_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_records_delete BEFORE DELETE ON e_inactive_records WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.import_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_fragments_delete BEFORE DELETE ON e_inactive_fragments WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.import_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_mapping_delete BEFORE DELETE ON e_inactive_mapping WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.import_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
CREATE TRIGGER connect_owner_thaw BEFORE UPDATE ON chat_admission_owners WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE local_role='source' AND source_conversation_id=OLD.conversation_id) AND (NEW.mode NOT IN ('frozen','ceded','restore_hold') OR NEW.incarnation<>OLD.incarnation OR NEW.conversation_id<>OLD.conversation_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_reserved'); END;
CREATE TRIGGER connect_owner_delete BEFORE DELETE ON chat_admission_owners WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE local_role='source' AND source_conversation_id=OLD.conversation_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_reserved'); END;
