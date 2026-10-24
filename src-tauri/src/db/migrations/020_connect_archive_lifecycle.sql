-- Local disposal is distinct from canonical transfer resolution.
CREATE TABLE connect_local_deletions (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_transfers(transfer_id),
 conversation_id TEXT NOT NULL, ownership_incarnation TEXT NOT NULL, ownership_revision INTEGER NOT NULL CHECK(ownership_revision>=0),
 source_epoch INTEGER NOT NULL CHECK(source_epoch>0), terminal_fingerprint BLOB NOT NULL CHECK(length(terminal_fingerprint)=32),
 import_id INTEGER, capture_id INTEGER,
 receipt BLOB NOT NULL, fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 phase TEXT NOT NULL CHECK(phase IN ('deleting','deleted')),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0)
);
CREATE INDEX connect_deletion_conversation ON connect_local_deletions(conversation_id,phase);
CREATE TABLE connect_publication_times (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_preparations(transfer_id), published_at TEXT NOT NULL
);
CREATE TABLE connect_projection_display (
 transfer_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 original_date TEXT CHECK(original_date IS NULL OR length(CAST(original_date AS BLOB))<=98304), inherited_from INTEGER CHECK(inherited_from>=0 AND inherited_from<ordinal),
 PRIMARY KEY(transfer_id,ordinal),
 FOREIGN KEY(transfer_id,ordinal) REFERENCES connect_projection_messages(transfer_id,ordinal) ON DELETE RESTRICT,
 FOREIGN KEY(transfer_id,inherited_from) REFERENCES connect_projection_messages(transfer_id,ordinal) ON DELETE RESTRICT
);
CREATE VIEW connect_message_origins AS SELECT m.id AS message_id,
 p.canonical_import_id AS portable_import_key, lower(hex(p.storage_manifest)) AS portable_manifest,
 CAST(m.ordinal AS TEXT) AS portable_ordinal, CAST(m.source_ordinal AS TEXT) AS portable_source_ordinal,
 d.original_date AS portable_display_date, CAST(d.inherited_from AS TEXT) AS portable_inherited_from
 FROM connect_projection_messages m JOIN connect_preparations p USING(transfer_id)
 JOIN conversation_portable_archives a ON a.transfer_id=p.transfer_id AND a.conversation_id=p.target_conversation_id
 JOIN connect_activation_receipts r ON r.transfer_id=p.transfer_id AND r.conversation_id=a.conversation_id
 LEFT JOIN connect_projection_display d ON d.transfer_id=m.transfer_id AND d.ordinal=m.ordinal
 WHERE p.phase='published' AND NOT EXISTS(SELECT 1 FROM connect_local_deletions x WHERE x.transfer_id=p.transfer_id);
CREATE TRIGGER connect_deletion_update BEFORE UPDATE ON connect_local_deletions WHEN OLD.phase<>'deleting' OR NEW.phase<>'deleted' OR NEW.transfer_id IS NOT OLD.transfer_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.ownership_incarnation IS NOT OLD.ownership_incarnation OR NEW.ownership_revision IS NOT OLD.ownership_revision OR NEW.source_epoch IS NOT OLD.source_epoch OR NEW.terminal_fingerprint IS NOT OLD.terminal_fingerprint OR NEW.import_id IS NOT OLD.import_id OR NEW.capture_id IS NOT OLD.capture_id OR NEW.receipt IS NOT OLD.receipt OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.charge_bytes IS NOT OLD.charge_bytes BEGIN SELECT RAISE(ABORT,'connect_deletion_immutable'); END;
CREATE TRIGGER connect_deletion_delete BEFORE DELETE ON connect_local_deletions BEGIN SELECT RAISE(ABORT,'connect_deletion_retained'); END;
CREATE TRIGGER connect_publication_time_update BEFORE UPDATE ON connect_publication_times BEGIN SELECT RAISE(ABORT,'connect_publication_immutable'); END;
CREATE TRIGGER connect_publication_time_delete BEFORE DELETE ON connect_publication_times BEGIN SELECT RAISE(ABORT,'connect_publication_immutable'); END;
CREATE TRIGGER connect_display_insert BEFORE INSERT ON connect_projection_display WHEN (SELECT phase FROM connect_preparations WHERE transfer_id=NEW.transfer_id)<>'preparing' BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_display_update BEFORE UPDATE ON connect_projection_display BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_display_delete BEFORE DELETE ON connect_projection_display WHEN NOT EXISTS(SELECT 1 FROM connect_local_deletions WHERE transfer_id=OLD.transfer_id AND phase='deleting') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
