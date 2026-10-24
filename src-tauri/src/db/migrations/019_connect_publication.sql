-- Private storage transitions only. No row or stored receipt authenticates a caller.
ALTER TABLE connect_transfers ADD COLUMN resolution TEXT CHECK(resolution IN ('committed','aborted'));
ALTER TABLE connect_transfers ADD COLUMN terminal_outcome TEXT CHECK(terminal_outcome IN ('committed','aborted'));
ALTER TABLE connect_transfers ADD COLUMN terminal_exact BLOB CHECK(length(terminal_exact) BETWEEN 1 AND 98304);
ALTER TABLE connect_transfers ADD COLUMN terminal_digest BLOB CHECK(length(terminal_digest)=32);
ALTER TABLE connect_transfers ADD COLUMN terminal_fingerprint BLOB CHECK(length(terminal_fingerprint)=32);
ALTER TABLE connect_transfers ADD COLUMN terminal_revision TEXT;
ALTER TABLE connect_transfers ADD COLUMN terminal_prepared_digest BLOB CHECK(length(terminal_prepared_digest)=32);
DROP INDEX connect_source_exclusive;
DROP INDEX connect_local_source_exclusive;
CREATE UNIQUE INDEX connect_source_exclusive ON connect_transfers(relay_origin,account_id,source_instance_id,source_conversation_id) WHERE local_role='source' AND resolution IS NOT 'aborted';
CREATE UNIQUE INDEX connect_local_source_exclusive ON connect_transfers(source_conversation_id) WHERE local_role='source' AND resolution IS NOT 'aborted';
DROP TRIGGER connect_owner_thaw;
DROP TRIGGER connect_owner_delete;
CREATE TRIGGER connect_owner_thaw BEFORE UPDATE ON chat_admission_owners WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE local_role='source' AND source_conversation_id=OLD.conversation_id AND resolution IS NOT 'aborted') AND (NEW.mode NOT IN ('frozen','ceded','restore_hold') OR NEW.incarnation<>OLD.incarnation OR NEW.conversation_id<>OLD.conversation_id) BEGIN SELECT RAISE(ABORT,'connect_transfer_reserved'); END;
CREATE TRIGGER connect_owner_delete BEFORE DELETE ON chat_admission_owners WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE local_role='source' AND source_conversation_id=OLD.conversation_id AND resolution IS NOT 'aborted') BEGIN SELECT RAISE(ABORT,'connect_transfer_reserved'); END;
CREATE TRIGGER connect_terminal_immutable BEFORE UPDATE ON connect_transfers WHEN OLD.terminal_fingerprint IS NOT NULL AND (NEW.terminal_fingerprint IS NOT OLD.terminal_fingerprint OR NEW.terminal_exact IS NOT OLD.terminal_exact OR NEW.terminal_digest IS NOT OLD.terminal_digest OR NEW.terminal_revision IS NOT OLD.terminal_revision OR NEW.terminal_outcome IS NOT OLD.terminal_outcome OR NEW.terminal_prepared_digest IS NOT OLD.terminal_prepared_digest) BEGIN SELECT RAISE(ABORT,'connect_terminal_immutable'); END;
CREATE TRIGGER connect_resolution_immutable BEFORE UPDATE ON connect_transfers WHEN OLD.resolution IS NOT NULL AND NEW.resolution IS NOT OLD.resolution BEGIN SELECT RAISE(ABORT,'connect_resolution_immutable'); END;
CREATE TABLE connect_preparations (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_transfers(transfer_id) ON DELETE RESTRICT,
 canonical_import_id TEXT NOT NULL UNIQUE CHECK(length(canonical_import_id)=36),
 target_conversation_id TEXT NOT NULL UNIQUE CHECK(length(target_conversation_id)=36),
 import_id INTEGER NOT NULL UNIQUE REFERENCES e_inactive_imports(id) ON DELETE RESTRICT,
 import_revision INTEGER NOT NULL CHECK(import_revision>=0),
 lineage_id TEXT NOT NULL CHECK(length(lineage_id)=36),
 raw_manifest BLOB NOT NULL CHECK(length(raw_manifest)=32),
 portable_manifest BLOB NOT NULL CHECK(length(portable_manifest)=32),
 storage_manifest BLOB NOT NULL CHECK(length(storage_manifest)=32),
 mapping_hash BLOB NOT NULL CHECK(length(mapping_hash)=32),
 local_generation TEXT NOT NULL, source_generation TEXT NOT NULL, target_generation TEXT NOT NULL,
 configuration_digest BLOB NOT NULL CHECK(length(configuration_digest)=32),
 preparators_digest BLOB NOT NULL CHECK(length(preparators_digest)=32),
 prepared_digest BLOB CHECK(length(prepared_digest)=32),
 projection_hash BLOB CHECK(length(projection_hash)=32),
 preparation_revision INTEGER NOT NULL CHECK(preparation_revision>0),
 provider_id TEXT NOT NULL, model_id TEXT NOT NULL, reasoning_effort TEXT,
 title TEXT NOT NULL, created_at TEXT NOT NULL,
 message_count INTEGER NOT NULL CHECK(message_count>=0), citation_count INTEGER NOT NULL CHECK(citation_count>=0), asset_count INTEGER NOT NULL CHECK(asset_count>=0),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 phase TEXT NOT NULL CHECK(phase IN ('preparing','prepared','pinned','published')),
 pin_receipt BLOB CHECK(length(pin_receipt) BETWEEN 1 AND 98304),
 pin_fingerprint BLOB CHECK(length(pin_fingerprint)=32),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0),
 CHECK(phase='preparing' OR (prepared_digest IS NOT NULL AND projection_hash IS NOT NULL)),
 CHECK((phase IN ('preparing','prepared') AND pin_receipt IS NULL AND pin_fingerprint IS NULL) OR (phase IN ('pinned','published') AND pin_receipt IS NOT NULL AND pin_fingerprint IS NOT NULL))
);
CREATE TABLE connect_projection_messages (
 transfer_id TEXT NOT NULL REFERENCES connect_preparations(transfer_id) ON DELETE RESTRICT,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), created_at TEXT NOT NULL, source_ordinal INTEGER CHECK(source_ordinal>=0),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 PRIMARY KEY(transfer_id,ordinal), UNIQUE(transfer_id,id)
);
CREATE TABLE connect_projection_citations (
 transfer_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
 message_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('web','file','document','source_passage')),
 scope TEXT NOT NULL CHECK(scope IN ('context','source')), kind TEXT CHECK(kind IN ('interesting','used')),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 PRIMARY KEY(transfer_id,ordinal),
 FOREIGN KEY(transfer_id) REFERENCES connect_preparations(transfer_id) ON DELETE RESTRICT,
 FOREIGN KEY(transfer_id,message_id) REFERENCES connect_projection_messages(transfer_id,id) ON DELETE RESTRICT
);
CREATE TABLE connect_projection_assets (
 transfer_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
 message_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), mime_type TEXT NOT NULL CHECK(mime_type IN ('text/plain','image/png','image/jpeg','image/webp')),
 fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 PRIMARY KEY(transfer_id,ordinal), UNIQUE(transfer_id,message_id,position),
 FOREIGN KEY(transfer_id) REFERENCES connect_preparations(transfer_id) ON DELETE RESTRICT,
 FOREIGN KEY(transfer_id,message_id) REFERENCES connect_projection_messages(transfer_id,id) ON DELETE RESTRICT
);
CREATE TABLE connect_projection_fields (
 transfer_id TEXT NOT NULL REFERENCES connect_preparations(transfer_id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('message','citation','asset')), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 field TEXT NOT NULL CHECK(field IN ('content','source','title','snippet','data')),
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=0), sha256 BLOB NOT NULL CHECK(length(sha256)=32),
 received INTEGER NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=bytes),
 PRIMARY KEY(transfer_id,kind,ordinal,field)
);
CREATE TABLE connect_projection_fragments (
 transfer_id TEXT NOT NULL, kind TEXT NOT NULL, ordinal INTEGER NOT NULL, field TEXT NOT NULL,
 offset_bytes INTEGER NOT NULL CHECK(offset_bytes>=0), data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 4093),
 sha256 BLOB NOT NULL CHECK(length(sha256)=32),
 PRIMARY KEY(transfer_id,kind,ordinal,field,offset_bytes),
 FOREIGN KEY(transfer_id,kind,ordinal,field) REFERENCES connect_projection_fields(transfer_id,kind,ordinal,field) ON DELETE RESTRICT
);
CREATE TABLE conversation_portable_archives (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 transfer_id TEXT NOT NULL UNIQUE REFERENCES connect_preparations(transfer_id) ON DELETE RESTRICT,
 import_id INTEGER NOT NULL UNIQUE REFERENCES e_inactive_imports(id) ON DELETE RESTRICT,
 import_revision INTEGER NOT NULL, manifest BLOB NOT NULL CHECK(length(manifest)=32), mapping_hash BLOB NOT NULL CHECK(length(mapping_hash)=32),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0)
);
CREATE TABLE connect_activation_receipts (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_preparations(transfer_id) ON DELETE RESTRICT,
 conversation_id TEXT NOT NULL UNIQUE,
 terminal_digest BLOB NOT NULL CHECK(length(terminal_digest)=32), terminal_exact BLOB NOT NULL,
 preparation_fingerprint BLOB NOT NULL CHECK(length(preparation_fingerprint)=32),
 local_receipt BLOB NOT NULL, fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0)
);
-- Published assets stay as immutable fragments. This view binds them to a real
-- conversation without restoring a Pilot send or fabricating remote identities.
CREATE VIEW connect_published_assets AS SELECT a.*,p.target_conversation_id AS conversation_id FROM connect_projection_assets a JOIN connect_preparations p USING(transfer_id) JOIN connect_activation_receipts r USING(transfer_id) JOIN conversation_portable_archives ar ON ar.transfer_id=p.transfer_id AND ar.conversation_id=p.target_conversation_id WHERE p.phase='published';
CREATE TRIGGER connect_preparation_pin_immutable BEFORE UPDATE ON connect_preparations WHEN OLD.pin_fingerprint IS NOT NULL AND (NEW.pin_fingerprint IS NOT OLD.pin_fingerprint OR NEW.pin_receipt IS NOT OLD.pin_receipt OR NEW.fingerprint<>OLD.fingerprint OR NEW.prepared_digest<>OLD.prepared_digest OR NEW.import_id<>OLD.import_id OR NEW.import_revision<>OLD.import_revision OR NEW.mapping_hash<>OLD.mapping_hash OR NEW.configuration_digest<>OLD.configuration_digest OR NEW.local_generation<>OLD.local_generation OR NEW.phase NOT IN ('pinned','published')) BEGIN SELECT RAISE(ABORT,'connect_pin_immutable'); END;
CREATE TRIGGER connect_activation_update BEFORE UPDATE ON connect_activation_receipts BEGIN SELECT RAISE(ABORT,'connect_activation_immutable'); END;
CREATE TRIGGER connect_activation_delete BEFORE DELETE ON connect_activation_receipts BEGIN SELECT RAISE(ABORT,'connect_activation_immutable'); END;
CREATE TRIGGER connect_projection_messages_insert BEFORE INSERT ON connect_projection_messages WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=NEW.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_messages_update BEFORE UPDATE ON connect_projection_messages WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id IN (OLD.transfer_id,NEW.transfer_id) AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_messages_delete BEFORE DELETE ON connect_projection_messages WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_citations_insert BEFORE INSERT ON connect_projection_citations WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=NEW.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_citations_update BEFORE UPDATE ON connect_projection_citations WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id IN (OLD.transfer_id,NEW.transfer_id) AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_citations_delete BEFORE DELETE ON connect_projection_citations WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_assets_insert BEFORE INSERT ON connect_projection_assets WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=NEW.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_assets_update BEFORE UPDATE ON connect_projection_assets WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id IN (OLD.transfer_id,NEW.transfer_id) AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_assets_delete BEFORE DELETE ON connect_projection_assets WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_fields_insert BEFORE INSERT ON connect_projection_fields WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=NEW.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_fields_update BEFORE UPDATE ON connect_projection_fields WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id IN (OLD.transfer_id,NEW.transfer_id) AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_fields_delete BEFORE DELETE ON connect_projection_fields WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_fragments_insert BEFORE INSERT ON connect_projection_fragments WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=NEW.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_fragments_update BEFORE UPDATE ON connect_projection_fragments WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id IN (OLD.transfer_id,NEW.transfer_id) AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_projection_fragments_delete BEFORE DELETE ON connect_projection_fragments WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_preparation_delete BEFORE DELETE ON connect_preparations BEGIN SELECT RAISE(ABORT,'connect_preparation_retained'); END;
CREATE TRIGGER connect_preparation_metadata BEFORE UPDATE ON connect_preparations WHEN OLD.phase<>'preparing' AND (NEW.transfer_id IS NOT OLD.transfer_id OR NEW.canonical_import_id IS NOT OLD.canonical_import_id OR NEW.target_conversation_id IS NOT OLD.target_conversation_id OR NEW.import_id IS NOT OLD.import_id OR NEW.import_revision IS NOT OLD.import_revision OR NEW.lineage_id IS NOT OLD.lineage_id OR NEW.raw_manifest IS NOT OLD.raw_manifest OR NEW.portable_manifest IS NOT OLD.portable_manifest OR NEW.storage_manifest IS NOT OLD.storage_manifest OR NEW.mapping_hash IS NOT OLD.mapping_hash OR NEW.local_generation IS NOT OLD.local_generation OR NEW.source_generation IS NOT OLD.source_generation OR NEW.target_generation IS NOT OLD.target_generation OR NEW.configuration_digest IS NOT OLD.configuration_digest OR NEW.preparators_digest IS NOT OLD.preparators_digest OR NEW.prepared_digest IS NOT OLD.prepared_digest OR NEW.projection_hash IS NOT OLD.projection_hash OR NEW.preparation_revision IS NOT OLD.preparation_revision OR NEW.provider_id IS NOT OLD.provider_id OR NEW.model_id IS NOT OLD.model_id OR NEW.reasoning_effort IS NOT OLD.reasoning_effort OR NEW.title IS NOT OLD.title OR NEW.created_at IS NOT OLD.created_at OR NEW.message_count IS NOT OLD.message_count OR NEW.citation_count IS NOT OLD.citation_count OR NEW.asset_count IS NOT OLD.asset_count OR NEW.fingerprint IS NOT OLD.fingerprint) BEGIN SELECT RAISE(ABORT,'connect_preparation_immutable'); END;
CREATE TRIGGER connect_archive_e_inactive_imports_update BEFORE UPDATE ON e_inactive_imports WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE import_id=OLD.id) BEGIN SELECT RAISE(ABORT,'connect_archive_immutable'); END;
CREATE TRIGGER connect_archive_e_inactive_records_update BEFORE UPDATE ON e_inactive_records WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE import_id=OLD.import_id) BEGIN SELECT RAISE(ABORT,'connect_archive_immutable'); END;
CREATE TRIGGER connect_archive_e_inactive_fragments_update BEFORE UPDATE ON e_inactive_fragments WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE import_id=OLD.import_id) BEGIN SELECT RAISE(ABORT,'connect_archive_immutable'); END;
CREATE TRIGGER connect_archive_e_inactive_mapping_update BEFORE UPDATE ON e_inactive_mapping WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE import_id=OLD.import_id) BEGIN SELECT RAISE(ABORT,'connect_archive_immutable'); END;
CREATE TRIGGER connect_transfer_delete BEFORE DELETE ON connect_transfers BEGIN SELECT RAISE(ABORT,'connect_transfer_retained'); END;
CREATE TRIGGER connect_transfer_identity BEFORE UPDATE ON connect_transfers WHEN NEW.transfer_id IS NOT OLD.transfer_id OR NEW.local_role IS NOT OLD.local_role OR NEW.relay_origin IS NOT OLD.relay_origin OR NEW.account_id IS NOT OLD.account_id OR NEW.source_instance_id IS NOT OLD.source_instance_id OR NEW.source_conversation_id IS NOT OLD.source_conversation_id OR NEW.source_epoch IS NOT OLD.source_epoch OR NEW.target_instance_id IS NOT OLD.target_instance_id OR NEW.source_generation IS NOT OLD.source_generation OR NEW.target_generation IS NOT OLD.target_generation OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.binding_json IS NOT OLD.binding_json OR NEW.expectation_json IS NOT OLD.expectation_json OR NEW.reserve_request IS NOT OLD.reserve_request OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.local_generation IS NOT OLD.local_generation OR NEW.ownership_incarnation IS NOT OLD.ownership_incarnation OR NEW.ownership_revision IS NOT OLD.ownership_revision OR NEW.content_incarnation IS NOT OLD.content_incarnation OR NEW.content_revision IS NOT OLD.content_revision BEGIN SELECT RAISE(ABORT,'connect_transfer_identity'); END;
CREATE TRIGGER connect_preparation_phase BEFORE UPDATE ON connect_preparations WHEN NEW.phase<>OLD.phase AND NOT ((OLD.phase='preparing' AND NEW.phase='prepared') OR (OLD.phase='prepared' AND NEW.phase='pinned') OR (OLD.phase='pinned' AND NEW.phase='published')) BEGIN SELECT RAISE(ABORT,'connect_preparation_phase'); END;
CREATE TRIGGER connect_resolution_terminal BEFORE UPDATE ON connect_transfers WHEN NEW.resolution IS NOT NULL AND NEW.resolution IS NOT NEW.terminal_outcome BEGIN SELECT RAISE(ABORT,'connect_terminal_missing'); END;
