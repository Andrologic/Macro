-- Local disposal is distinct from canonical transfer resolution.
CREATE TABLE connect_local_deletions (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_transfers(transfer_id),
 conversation_id TEXT NOT NULL, ownership_incarnation TEXT NOT NULL, ownership_revision INTEGER NOT NULL CHECK(ownership_revision>=0),
 owner_mode TEXT NOT NULL CHECK(owner_mode IN ('open','ceded')),
 local_generation TEXT NOT NULL CHECK(length(CAST(local_generation AS BLOB)) BETWEEN 1 AND 128),
 source_epoch INTEGER NOT NULL CHECK(source_epoch>0), terminal_fingerprint BLOB NOT NULL CHECK(length(terminal_fingerprint)=32),
 import_id INTEGER UNIQUE REFERENCES e_inactive_imports(id), capture_id INTEGER UNIQUE REFERENCES e_source_captures(id),
 receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 98304), fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32),
 phase TEXT NOT NULL CHECK(phase IN ('deleting','deleted')),
 charge_bytes INTEGER NOT NULL CHECK(typeof(charge_bytes)='integer' AND charge_bytes>=0)
);
CREATE INDEX connect_deletion_conversation ON connect_local_deletions(conversation_id,phase);
CREATE INDEX connect_asset_reader ON connect_projection_assets(transfer_id,message_id,position,id);
CREATE INDEX connect_citation_reader ON connect_projection_citations(transfer_id,message_id,ordinal,id);
-- This context is local deletion intent, never relay authentication. Its
-- permitting state exists only inside the ordinary writer's transaction.
CREATE VIEW connect_deleting_transfers AS SELECT * FROM (
 SELECT d.*, CASE
  WHEN o.incarnation=d.ownership_incarnation AND o.revision=d.ownership_revision AND o.mode=d.owner_mode
   THEN CASE WHEN EXISTS(SELECT 1 FROM conversations c WHERE c.id=d.conversation_id) THEN 'before' ELSE 'cascade' END
  WHEN o.incarnation=d.ownership_incarnation AND o.revision=d.ownership_revision+1
   AND o.mode=CASE d.owner_mode WHEN 'ceded' THEN 'ceded' ELSE 'removed' END
   AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=d.conversation_id) THEN 'after'
 END AS stage
 FROM connect_local_deletions d JOIN connect_transfers t USING(transfer_id)
 JOIN chat_admission_owners o ON o.conversation_id=d.conversation_id
 WHERE d.phase='deleting' AND d.source_epoch=t.source_epoch AND d.terminal_fingerprint=t.terminal_fingerprint
 AND d.import_id IS t.inactive_import_id AND d.capture_id IS t.source_capture_id
 AND t.restore_hold=0 AND t.resolution IS NOT NULL AND t.resolution=t.terminal_outcome
 AND ((t.local_role='source' AND t.source_conversation_id=d.conversation_id
       AND (t.resolution='aborted' OR (d.owner_mode='ceded' AND o.incarnation=t.ownership_incarnation AND d.ownership_revision=t.ownership_revision+1)))
  OR (t.local_role='target' AND t.resolution='committed' AND EXISTS(
   SELECT 1 FROM connect_preparations p JOIN connect_activation_receipts r USING(transfer_id)
   WHERE p.transfer_id=t.transfer_id AND p.phase='published' AND p.target_conversation_id=d.conversation_id
   AND p.import_id=d.import_id AND r.conversation_id=d.conversation_id AND r.preparation_fingerprint=p.fingerprint
   AND r.terminal_digest=t.terminal_digest AND r.terminal_exact=t.terminal_exact)))
 AND NOT EXISTS(SELECT 1 FROM connect_transfers x LEFT JOIN connect_preparations p ON p.transfer_id=x.transfer_id
  WHERE ((x.local_role='source' AND x.source_conversation_id=d.conversation_id) OR (x.local_role='target' AND p.target_conversation_id=d.conversation_id))
  AND (x.restore_hold<>0 OR x.resolution IS NULL OR x.resolution IS NOT x.terminal_outcome OR x.terminal_fingerprint IS NULL
   OR EXISTS(SELECT 1 FROM connect_exchanges e WHERE e.transfer_id=x.transfer_id AND e.phase<>'result_recorded')))
 AND NOT EXISTS(SELECT 1 FROM chat_admission_operations w WHERE w.conversation_id=d.conversation_id
  AND (w.phase NOT IN ('completed','no_effect') OR (w.kind IN ('provider','tool') AND w.request_id IS NOT NULL AND w.phase<>'no_effect' AND w.local_closed_at IS NULL)))
) WHERE stage IS NOT NULL;
CREATE VIEW connect_deleting_owners AS SELECT DISTINCT conversation_id FROM connect_deleting_transfers WHERE stage IN ('before','cascade');
CREATE TRIGGER connect_deletion_insert AFTER INSERT ON connect_local_deletions
 WHEN NEW.phase<>'deleting' OR NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=NEW.transfer_id AND stage='before')
 BEGIN SELECT RAISE(ABORT,'connect_deletion_context_invalid'); END;
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
CREATE INDEX connect_message_reader ON connect_projection_messages(transfer_id,source_ordinal,ordinal);
CREATE TRIGGER connect_deletion_update BEFORE UPDATE ON connect_local_deletions WHEN OLD.phase<>'deleting' OR NEW.phase<>'deleted' OR NEW.transfer_id IS NOT OLD.transfer_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.ownership_incarnation IS NOT OLD.ownership_incarnation OR NEW.ownership_revision IS NOT OLD.ownership_revision OR NEW.owner_mode IS NOT OLD.owner_mode OR NEW.local_generation IS NOT OLD.local_generation OR NEW.source_epoch IS NOT OLD.source_epoch OR NEW.terminal_fingerprint IS NOT OLD.terminal_fingerprint OR NEW.import_id IS NOT OLD.import_id OR NEW.capture_id IS NOT OLD.capture_id OR NEW.receipt IS NOT OLD.receipt OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.charge_bytes IS NOT OLD.charge_bytes OR NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='after') BEGIN SELECT RAISE(ABORT,'connect_deletion_immutable'); END;
CREATE TRIGGER connect_deletion_delete BEFORE DELETE ON connect_local_deletions BEGIN SELECT RAISE(ABORT,'connect_deletion_retained'); END;
CREATE VIEW connect_deletion_payloads AS SELECT d.transfer_id FROM connect_local_deletions d WHERE
 EXISTS(SELECT 1 FROM conversations WHERE id=d.conversation_id)
 OR EXISTS(SELECT 1 FROM conversation_portable_archives WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_projection_messages WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_projection_citations WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_projection_assets WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_projection_fields WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_projection_fragments WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_projection_display WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_raw_prefix WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM connect_raw_chunks WHERE transfer_id=d.transfer_id)
 OR EXISTS(SELECT 1 FROM e_inactive_records WHERE import_id=d.import_id)
 OR EXISTS(SELECT 1 FROM e_inactive_fragments WHERE import_id=d.import_id)
 OR EXISTS(SELECT 1 FROM e_inactive_mapping WHERE import_id=d.import_id)
 OR EXISTS(SELECT 1 FROM e_source_fields WHERE capture_id=d.capture_id)
 OR EXISTS(SELECT 1 FROM e_source_fragments WHERE capture_id=d.capture_id)
 OR EXISTS(SELECT 1 FROM e_source_relations WHERE capture_id=d.capture_id)
 OR EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=d.transfer_id AND title<>'');
CREATE TRIGGER connect_deletion_complete BEFORE UPDATE ON connect_local_deletions
 WHEN NEW.phase='deleted' AND EXISTS(SELECT 1 FROM connect_deletion_payloads WHERE transfer_id=OLD.transfer_id)
 BEGIN SELECT RAISE(ABORT,'connect_deletion_content_retained'); END;
CREATE TRIGGER connect_publication_time_update BEFORE UPDATE ON connect_publication_times BEGIN SELECT RAISE(ABORT,'connect_publication_immutable'); END;
CREATE TRIGGER connect_publication_time_delete BEFORE DELETE ON connect_publication_times BEGIN SELECT RAISE(ABORT,'connect_publication_immutable'); END;
CREATE TRIGGER connect_display_insert BEFORE INSERT ON connect_projection_display WHEN (SELECT phase FROM connect_preparations WHERE transfer_id=NEW.transfer_id)<>'preparing' BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_display_update BEFORE UPDATE ON connect_projection_display BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_display_delete BEFORE DELETE ON connect_projection_display WHEN NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
CREATE TRIGGER connect_preparation_charge_floor BEFORE UPDATE ON connect_preparations WHEN NEW.charge_bytes<OLD.charge_bytes AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='after') BEGIN SELECT RAISE(ABORT,'connect_preparation_charge_retained'); END;
-- Declared migration amendments; INSERT/UPDATE guards remain unchanged.
DROP TRIGGER chat_admission_agent_run_transitions_delete;
CREATE TRIGGER chat_admission_agent_run_transitions_delete BEFORE DELETE ON agent_run_transitions BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND mode<>'open' AND conversation_id IN (SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id))
 );
END;
-- Exact local disposal exceptions and retained-parent guards.
DROP TRIGGER connect_projection_messages_delete;
CREATE TRIGGER connect_projection_messages_delete BEFORE DELETE ON connect_projection_messages WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
DROP TRIGGER connect_projection_citations_delete;
CREATE TRIGGER connect_projection_citations_delete BEFORE DELETE ON connect_projection_citations WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
DROP TRIGGER connect_projection_assets_delete;
CREATE TRIGGER connect_projection_assets_delete BEFORE DELETE ON connect_projection_assets WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
DROP TRIGGER connect_projection_fields_delete;
CREATE TRIGGER connect_projection_fields_delete BEFORE DELETE ON connect_projection_fields WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
DROP TRIGGER connect_projection_fragments_delete;
CREATE TRIGGER connect_projection_fragments_delete BEFORE DELETE ON connect_projection_fragments WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE transfer_id=OLD.transfer_id AND phase<>'preparing') AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_projection_immutable'); END;
DROP TRIGGER connect_source_fields_delete;
CREATE TRIGGER connect_source_fields_delete BEFORE DELETE ON e_source_fields WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.capture_id) AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE capture_id=OLD.capture_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_source_fragments_delete;
CREATE TRIGGER connect_source_fragments_delete BEFORE DELETE ON e_source_fragments WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.capture_id) AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE capture_id=OLD.capture_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_source_relations_delete;
CREATE TRIGGER connect_source_relations_delete BEFORE DELETE ON e_source_relations WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.capture_id) AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE capture_id=OLD.capture_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_records_delete;
CREATE TRIGGER connect_records_delete BEFORE DELETE ON e_inactive_records WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.import_id) AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE import_id=OLD.import_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_fragments_delete;
CREATE TRIGGER connect_fragments_delete BEFORE DELETE ON e_inactive_fragments WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.import_id) AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE import_id=OLD.import_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_mapping_delete;
CREATE TRIGGER connect_mapping_delete BEFORE DELETE ON e_inactive_mapping WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.import_id) AND NOT EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE import_id=OLD.import_id AND stage='before') BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_capture_shrink;
CREATE TRIGGER connect_capture_shrink BEFORE UPDATE ON e_source_captures WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE source_capture_id=OLD.id) AND (NEW.id<>OLD.id OR NEW.capture_id<>OLD.capture_id OR NEW.binding_json<>OLD.binding_json OR NEW.phase>2 OR NEW.charge_bytes<OLD.charge_bytes OR NEW.bytes_received<OLD.bytes_received OR NEW.fields_count<OLD.fields_count OR NEW.rows_count<OLD.rows_count) AND NOT (NEW.charge_bytes<=OLD.charge_bytes AND NEW.id IS OLD.id AND NEW.capture_id IS OLD.capture_id AND NEW.binding_json IS OLD.binding_json AND NEW.phase IS OLD.phase AND NEW.revision IS OLD.revision AND NEW.family IS OLD.family AND NEW.cursor_rowid IS OLD.cursor_rowid AND NEW.cursor_field IS OLD.cursor_field AND NEW.cursor_offset IS OLD.cursor_offset AND NEW.row_ordinal IS OLD.row_ordinal AND NEW.fields_count IS OLD.fields_count AND NEW.rows_count IS OLD.rows_count AND NEW.bytes_received IS OLD.bytes_received AND NEW.created_at IS OLD.created_at AND NEW.progressed_at IS OLD.progressed_at AND NEW.expires_at IS OLD.expires_at AND NEW.idle_ms IS OLD.idle_ms AND NEW.last_clock IS OLD.last_clock AND NEW.manifest_hash IS OLD.manifest_hash AND EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE capture_id=OLD.id AND stage='before')) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_import_shrink;
CREATE TRIGGER connect_import_shrink BEFORE UPDATE ON e_inactive_imports WHEN EXISTS(SELECT 1 FROM connect_transfers WHERE inactive_import_id=OLD.id) AND (NEW.id<>OLD.id OR NEW.identity_key<>OLD.identity_key OR NEW.begin_json<>OLD.begin_json OR NEW.phase>2 OR NEW.charge_bytes<OLD.charge_bytes OR NEW.received_bytes<OLD.received_bytes OR NEW.next_record<OLD.next_record) AND NOT (NEW.charge_bytes<=OLD.charge_bytes AND NEW.id IS OLD.id AND NEW.identity_key IS OLD.identity_key AND NEW.begin_json IS OLD.begin_json AND NEW.phase IS OLD.phase AND NEW.revision IS OLD.revision AND NEW.next_record IS OLD.next_record AND NEW.received_bytes IS OLD.received_bytes AND NEW.created_at IS OLD.created_at AND NEW.progressed_at IS OLD.progressed_at AND NEW.expires_at IS OLD.expires_at AND NEW.idle_ms IS OLD.idle_ms AND NEW.last_clock IS OLD.last_clock AND NEW.mapping_hash IS OLD.mapping_hash AND EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE import_id=OLD.id AND stage='before')) BEGIN SELECT RAISE(ABORT,'connect_transfer_leased'); END;
DROP TRIGGER connect_archive_e_inactive_imports_update;
CREATE TRIGGER connect_archive_e_inactive_imports_update BEFORE UPDATE ON e_inactive_imports WHEN EXISTS(SELECT 1 FROM connect_preparations WHERE import_id=OLD.id) AND NOT (NEW.charge_bytes<=OLD.charge_bytes AND NEW.id IS OLD.id AND NEW.identity_key IS OLD.identity_key AND NEW.begin_json IS OLD.begin_json AND NEW.phase IS OLD.phase AND NEW.revision IS OLD.revision AND NEW.next_record IS OLD.next_record AND NEW.received_bytes IS OLD.received_bytes AND NEW.created_at IS OLD.created_at AND NEW.progressed_at IS OLD.progressed_at AND NEW.expires_at IS OLD.expires_at AND NEW.idle_ms IS OLD.idle_ms AND NEW.last_clock IS OLD.last_clock AND NEW.mapping_hash IS OLD.mapping_hash AND EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE import_id=OLD.id AND stage='before')) BEGIN SELECT RAISE(ABORT,'connect_archive_immutable'); END;
DROP TRIGGER connect_preparation_metadata;
CREATE TRIGGER connect_preparation_metadata BEFORE UPDATE ON connect_preparations WHEN OLD.phase<>'preparing' AND (NEW.transfer_id IS NOT OLD.transfer_id OR NEW.canonical_import_id IS NOT OLD.canonical_import_id OR NEW.target_conversation_id IS NOT OLD.target_conversation_id OR NEW.import_id IS NOT OLD.import_id OR NEW.import_revision IS NOT OLD.import_revision OR NEW.lineage_id IS NOT OLD.lineage_id OR NEW.raw_manifest IS NOT OLD.raw_manifest OR NEW.portable_manifest IS NOT OLD.portable_manifest OR NEW.storage_manifest IS NOT OLD.storage_manifest OR NEW.mapping_hash IS NOT OLD.mapping_hash OR NEW.local_generation IS NOT OLD.local_generation OR NEW.source_generation IS NOT OLD.source_generation OR NEW.target_generation IS NOT OLD.target_generation OR NEW.configuration_digest IS NOT OLD.configuration_digest OR NEW.preparators_digest IS NOT OLD.preparators_digest OR NEW.prepared_digest IS NOT OLD.prepared_digest OR NEW.projection_hash IS NOT OLD.projection_hash OR NEW.preparation_revision IS NOT OLD.preparation_revision OR NEW.provider_id IS NOT OLD.provider_id OR NEW.model_id IS NOT OLD.model_id OR NEW.reasoning_effort IS NOT OLD.reasoning_effort OR (NEW.title IS NOT OLD.title AND NOT(NEW.title='' AND EXISTS(SELECT 1 FROM connect_deleting_transfers WHERE transfer_id=OLD.transfer_id AND stage='before'))) OR NEW.created_at IS NOT OLD.created_at OR NEW.message_count IS NOT OLD.message_count OR NEW.citation_count IS NOT OLD.citation_count OR NEW.asset_count IS NOT OLD.asset_count OR NEW.fingerprint IS NOT OLD.fingerprint) BEGIN SELECT RAISE(ABORT,'connect_preparation_immutable'); END;
CREATE TRIGGER connect_disposed_e_source_fields_insert BEFORE INSERT ON e_source_fields WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_source_fields_update BEFORE UPDATE ON e_source_fields WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_source_fragments_insert BEFORE INSERT ON e_source_fragments WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_source_fragments_update BEFORE UPDATE ON e_source_fragments WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_source_relations_insert BEFORE INSERT ON e_source_relations WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_source_relations_update BEFORE UPDATE ON e_source_relations WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_inactive_records_insert BEFORE INSERT ON e_inactive_records WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_inactive_records_update BEFORE UPDATE ON e_inactive_records WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_inactive_fragments_insert BEFORE INSERT ON e_inactive_fragments WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_inactive_fragments_update BEFORE UPDATE ON e_inactive_fragments WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_inactive_mapping_insert BEFORE INSERT ON e_inactive_mapping WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_e_inactive_mapping_update BEFORE UPDATE ON e_inactive_mapping WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE import_id=NEW.import_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_connect_raw_prefix_insert BEFORE INSERT ON connect_raw_prefix WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE transfer_id=NEW.transfer_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_connect_raw_prefix_update BEFORE UPDATE ON connect_raw_prefix WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE transfer_id=NEW.transfer_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_connect_raw_chunks_insert BEFORE INSERT ON connect_raw_chunks WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE transfer_id=NEW.transfer_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
CREATE TRIGGER connect_disposed_connect_raw_chunks_update BEFORE UPDATE ON connect_raw_chunks WHEN EXISTS(SELECT 1 FROM connect_local_deletions WHERE transfer_id=NEW.transfer_id) BEGIN SELECT RAISE(ABORT,'connect_content_removed'); END;
DROP TRIGGER chat_admission_agent_runs_delete;
CREATE TRIGGER chat_admission_agent_runs_delete BEFORE DELETE ON agent_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND mode<>'open' AND conversation_id IN (SELECT OLD.parent_conversation_id UNION SELECT OLD.child_conversation_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id))
 );
END;
DROP TRIGGER chat_admission_app_settings_delete;
CREATE TRIGGER chat_admission_app_settings_delete BEFORE DELETE ON app_settings BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE substr(OLD.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(OLD.key,38) COLLATE BINARY)
 );
END;
DROP TRIGGER chat_admission_conversation_action_receipts_delete;
CREATE TRIGGER chat_admission_conversation_action_receipts_delete BEFORE DELETE ON conversation_action_receipts BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversation_citations_delete;
CREATE TRIGGER chat_admission_conversation_citations_delete BEFORE DELETE ON conversation_citations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversation_compaction_events_delete;
CREATE TRIGGER chat_admission_conversation_compaction_events_delete BEFORE DELETE ON conversation_compaction_events BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversation_compactions_delete;
CREATE TRIGGER chat_admission_conversation_compactions_delete BEFORE DELETE ON conversation_compactions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversation_goal_audit_runs_delete;
CREATE TRIGGER chat_admission_conversation_goal_audit_runs_delete BEFORE DELETE ON conversation_goal_audit_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND mode<>'open' AND conversation_id IN (SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=OLD.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id))
 );
END;
DROP TRIGGER chat_admission_conversation_goal_audits_delete;
CREATE TRIGGER chat_admission_conversation_goal_audits_delete BEFORE DELETE ON conversation_goal_audits BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND mode<>'open' AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT conversation_id FROM conversation_goals WHERE goal_id=OLD.goal_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.current_run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.current_run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=OLD.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id)
 );
END;
DROP TRIGGER chat_admission_conversation_goals_delete;
CREATE TRIGGER chat_admission_conversation_goals_delete BEFORE DELETE ON conversation_goals BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND mode<>'open' AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversation_management_delete;
CREATE TRIGGER chat_admission_conversation_management_delete BEFORE DELETE ON conversation_management BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversation_response_versions_delete;
CREATE TRIGGER chat_admission_conversation_response_versions_delete BEFORE DELETE ON conversation_response_versions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT conversation_id FROM messages WHERE id IN (OLD.message_id))
 );
END;
DROP TRIGGER chat_admission_conversation_toolbox_state_delete;
CREATE TRIGGER chat_admission_conversation_toolbox_state_delete BEFORE DELETE ON conversation_toolbox_state BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_conversations_delete;
CREATE TRIGGER chat_admission_conversations_delete BEFORE DELETE ON conversations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND mode<>'open' AND conversation_id IN (SELECT OLD.id)
 );
END;
DROP TRIGGER chat_admission_messages_delete;
CREATE TRIGGER chat_admission_messages_delete BEFORE DELETE ON messages BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
DROP TRIGGER chat_admission_pilot_file_sends_delete;
CREATE TRIGGER chat_admission_pilot_file_sends_delete BEFORE DELETE ON pilot_file_sends BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=OLD.message_id COLLATE BINARY)
 );
END;
DROP TRIGGER chat_admission_pilot_message_attachments_delete;
CREATE TRIGGER chat_admission_pilot_message_attachments_delete BEFORE DELETE ON pilot_message_attachments BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=OLD.message_id COLLATE BINARY)
 );
END;
DROP TRIGGER chat_admission_retire_delete;
CREATE TRIGGER chat_admission_retire_delete AFTER DELETE ON conversations BEGIN
 UPDATE chat_admission_owners SET mode=CASE WHEN mode='ceded' AND EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=OLD.id) THEN 'ceded' ELSE 'removed' END,revision=revision+1 WHERE conversation_id=OLD.id;
END;
DROP TRIGGER chat_admission_tool_invocations_delete;
CREATE TRIGGER chat_admission_tool_invocations_delete BEFORE DELETE ON tool_invocations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE NOT EXISTS(SELECT 1 FROM connect_deleting_owners d WHERE d.conversation_id=chat_admission_owners.conversation_id) AND (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
