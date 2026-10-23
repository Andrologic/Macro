-- Local admission only; transfer decisions belong to the canonical F contract.
-- Ownership outlives its transcript and deliberately has no cascading FK.
CREATE TABLE chat_admission_owners (
 conversation_id TEXT PRIMARY KEY,
 incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
 mode TEXT NOT NULL DEFAULT 'open' CHECK(mode IN ('open','frozen','ceded','restore_hold','removed')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
 browser_reconciled INTEGER NOT NULL DEFAULT 0 CHECK(browser_reconciled IN (0,1)),
 runtime_generation TEXT
);
-- A browser registration is local to this database generation. Retired rows
-- are receipts, never reusable authority after reload or restore.
CREATE TABLE chat_admission_browsers (
 runtime TEXT PRIMARY KEY,
 caller TEXT NOT NULL,
 runtime_generation TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('active','retiring','retired'))
);
CREATE UNIQUE INDEX chat_admission_one_browser ON chat_admission_browsers((1)) WHERE phase IN ('active','retiring');
CREATE TABLE chat_admission_operations (
 operation_id TEXT PRIMARY KEY CHECK(length(trim(operation_id))>0),
 conversation_id TEXT NOT NULL REFERENCES chat_admission_owners(conversation_id),
 incarnation TEXT NOT NULL,
 parent_id TEXT REFERENCES chat_admission_operations(operation_id),
 runtime_generation TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('turn','provider','tool','compaction','queue','steer','question','approval','unsaved','recovery')),
 phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','result_pending','completed','no_effect','unknown')),
 turn_id TEXT,
 message_id TEXT,
 request_id TEXT,
 call_id TEXT,
 provider_id TEXT,
 provider_context TEXT,
 browser_caller TEXT,
 browser_runtime TEXT,
 browser_attempt TEXT,
 completion_receipt TEXT,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
 CHECK(parent_id IS NULL OR parent_id<>operation_id)
);
CREATE UNIQUE INDEX chat_admission_operations_browser_attempt ON chat_admission_operations(browser_caller,browser_runtime,conversation_id,kind,browser_attempt) WHERE browser_caller IS NOT NULL;
CREATE UNIQUE INDEX chat_admission_intent_identity ON chat_admission_operations(conversation_id,incarnation,kind,browser_attempt) WHERE kind IN ('queue','steer','question','approval','unsaved','recovery');
CREATE INDEX chat_admission_operations_owner ON chat_admission_operations(conversation_id,phase);
CREATE INDEX chat_admission_operations_provider_id ON chat_admission_operations(conversation_id,incarnation,provider_id,phase) WHERE provider_id IS NOT NULL;
CREATE INDEX chat_admission_operations_provider ON chat_admission_operations(conversation_id,incarnation,provider_context,phase) WHERE provider_context IS NOT NULL;
CREATE UNIQUE INDEX chat_admission_operations_tool ON chat_admission_operations(conversation_id,turn_id,message_id,call_id) WHERE kind='tool' AND call_id IS NOT NULL;
CREATE INDEX chat_admission_operations_parent ON chat_admission_operations(parent_id,phase);
CREATE UNIQUE INDEX chat_admission_operations_request ON chat_admission_operations(runtime_generation,request_id) WHERE request_id IS NOT NULL;
INSERT INTO chat_admission_owners(conversation_id)
 SELECT id FROM conversations WHERE scope_mode='Chat' AND project_id IS NULL AND group_id IS NULL AND task_id IS NULL;
CREATE TRIGGER chat_admission_register_insert AFTER INSERT ON conversations
 WHEN (NEW.scope_mode='Chat' AND NEW.project_id IS NULL AND NEW.group_id IS NULL AND NEW.task_id IS NULL)
 OR EXISTS(SELECT 1 FROM chat_admission_owners WHERE conversation_id=NEW.id) BEGIN
 -- BEFORE INSERT already rejected a preexisting tombstone. A removed owner
 -- here therefore belongs to the implicit DELETE of this accepted REPLACE.
 UPDATE chat_admission_operations SET phase='unknown',revision=revision+1
  WHERE conversation_id=NEW.id AND phase IN ('prepared','dispatched');
 INSERT INTO chat_admission_owners(conversation_id) VALUES(NEW.id)
 ON CONFLICT(conversation_id) DO UPDATE SET incarnation=lower(hex(randomblob(16))),mode='open',revision=revision+1,browser_reconciled=0,runtime_generation=NULL;
END;
CREATE TRIGGER chat_admission_register_update AFTER UPDATE ON conversations BEGIN
 UPDATE chat_admission_owners SET mode='removed',revision=revision+1
  WHERE conversation_id=OLD.id AND OLD.id IS NOT NEW.id;
 UPDATE chat_admission_operations SET phase='unknown',revision=revision+1
  WHERE conversation_id IN (OLD.id,NEW.id) AND OLD.id IS NOT NEW.id AND phase IN ('prepared','dispatched');
 INSERT INTO chat_admission_owners(conversation_id)
  SELECT NEW.id WHERE (NEW.scope_mode='Chat' AND NEW.project_id IS NULL AND NEW.group_id IS NULL AND NEW.task_id IS NULL)
   OR EXISTS(SELECT 1 FROM chat_admission_owners WHERE conversation_id=NEW.id)
 ON CONFLICT(conversation_id) DO UPDATE SET incarnation=lower(hex(randomblob(16))),mode='open',revision=revision+1,browser_reconciled=0,runtime_generation=NULL
  WHERE OLD.id IS NOT NEW.id;
END;
CREATE TRIGGER chat_admission_retire_delete AFTER DELETE ON conversations BEGIN
 UPDATE chat_admission_owners SET mode='removed', revision=revision+1 WHERE conversation_id=OLD.id;
END;
-- NEW.rowid is undefined for an INSERT that omits rowid. REPLACE victims
-- are protected by their actual DELETE, with recursive triggers enabled.
-- A nonconforming connection fails closed whenever protected owners exist.
CREATE TRIGGER chat_admission_conversations_insert BEFORE INSERT ON conversations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT NEW.id)
 );
END;
CREATE TRIGGER chat_admission_conversations_update BEFORE UPDATE ON conversations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.id UNION SELECT NEW.id)
 );
END;
CREATE TRIGGER chat_admission_conversations_delete BEFORE DELETE ON conversations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.id)
 );
END;
-- AFTER INSERT trigger order is unspecified. During an accepted open REPLACE,
-- the new transcript exists before all of its children are registered. Its
-- temporary removed owner cannot block those children; the strict conversation
-- INSERT guard above still rejects a separate resurrection of a tombstone.
CREATE TRIGGER chat_admission_messages_insert BEFORE INSERT ON messages BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_messages_update BEFORE UPDATE ON messages BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_messages_delete BEFORE DELETE ON messages BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_management_insert BEFORE INSERT ON conversation_management BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_management_update BEFORE UPDATE ON conversation_management BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_management_delete BEFORE DELETE ON conversation_management BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_response_versions_insert BEFORE INSERT ON conversation_response_versions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id UNION SELECT conversation_id FROM messages WHERE id IN (NEW.message_id))
 );
END;
CREATE TRIGGER chat_admission_conversation_response_versions_update BEFORE UPDATE ON conversation_response_versions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id UNION SELECT conversation_id FROM messages WHERE id IN (OLD.message_id,NEW.message_id))
 );
END;
CREATE TRIGGER chat_admission_conversation_response_versions_delete BEFORE DELETE ON conversation_response_versions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT conversation_id FROM messages WHERE id IN (OLD.message_id))
 );
END;
CREATE TRIGGER chat_admission_conversation_citations_insert BEFORE INSERT ON conversation_citations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_citations_update BEFORE UPDATE ON conversation_citations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_citations_delete BEFORE DELETE ON conversation_citations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_toolbox_state_insert BEFORE INSERT ON conversation_toolbox_state BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_toolbox_state_update BEFORE UPDATE ON conversation_toolbox_state BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_toolbox_state_delete BEFORE DELETE ON conversation_toolbox_state BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_compactions_insert BEFORE INSERT ON conversation_compactions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_compactions_update BEFORE UPDATE ON conversation_compactions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_compactions_delete BEFORE DELETE ON conversation_compactions BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_compaction_events_insert BEFORE INSERT ON conversation_compaction_events BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_compaction_events_update BEFORE UPDATE ON conversation_compaction_events BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_compaction_events_delete BEFORE DELETE ON conversation_compaction_events BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_action_receipts_insert BEFORE INSERT ON conversation_action_receipts BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_action_receipts_update BEFORE UPDATE ON conversation_action_receipts BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_action_receipts_delete BEFORE DELETE ON conversation_action_receipts BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_tool_invocations_insert BEFORE INSERT ON tool_invocations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_tool_invocations_update BEFORE UPDATE ON tool_invocations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_tool_invocations_delete BEFORE DELETE ON tool_invocations BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_pilot_message_attachments_insert BEFORE INSERT ON pilot_message_attachments BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=NEW.message_id COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_pilot_message_attachments_update BEFORE UPDATE ON pilot_message_attachments BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=OLD.message_id COLLATE BINARY UNION SELECT conversation_id FROM messages WHERE id=NEW.message_id COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_pilot_message_attachments_delete BEFORE DELETE ON pilot_message_attachments BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=OLD.message_id COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_pilot_file_sends_insert BEFORE INSERT ON pilot_file_sends BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=NEW.message_id COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_pilot_file_sends_update BEFORE UPDATE ON pilot_file_sends BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=OLD.message_id COLLATE BINARY UNION SELECT conversation_id FROM messages WHERE id=NEW.message_id COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_pilot_file_sends_delete BEFORE DELETE ON pilot_file_sends BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE id=OLD.message_id COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_app_settings_insert BEFORE INSERT ON app_settings BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE substr(NEW.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(NEW.key,38) COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_app_settings_update BEFORE UPDATE ON app_settings BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE substr(OLD.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(OLD.key,38) COLLATE BINARY UNION SELECT conversation_id FROM messages WHERE substr(NEW.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(NEW.key,38) COLLATE BINARY)
 );
END;
CREATE TRIGGER chat_admission_app_settings_delete BEFORE DELETE ON app_settings BEGIN
 SELECT RAISE(ABORT,'chat_admission_connection_config')
  WHERE (SELECT recursive_triggers FROM pragma_recursive_triggers)<>1
  AND EXISTS(SELECT 1 FROM chat_admission_owners WHERE mode IN ('frozen','ceded','restore_hold'));
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE (mode IN ('frozen','ceded','restore_hold') OR (mode='removed' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=chat_admission_owners.conversation_id))) AND conversation_id IN (SELECT conversation_id FROM messages WHERE substr(OLD.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(OLD.key,38) COLLATE BINARY)
 );
END;

-- Official native connections require recursive_triggers=ON, also attested
-- before reservation. Goal/run guards below are strictly relation-scoped.
-- No guarantee is made for external connections disabling that prerequisite.
CREATE TRIGGER chat_admission_agent_runs_insert BEFORE INSERT ON agent_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT NEW.parent_conversation_id UNION SELECT NEW.child_conversation_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id))
 );
END;
CREATE TRIGGER chat_admission_agent_runs_update BEFORE UPDATE ON agent_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.parent_conversation_id UNION SELECT OLD.child_conversation_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT NEW.parent_conversation_id UNION SELECT NEW.child_conversation_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.id))
 );
END;
CREATE TRIGGER chat_admission_agent_runs_delete BEFORE DELETE ON agent_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.parent_conversation_id UNION SELECT OLD.child_conversation_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.id))
 );
END;
CREATE TRIGGER chat_admission_agent_run_transitions_insert BEFORE INSERT ON agent_run_transitions BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id))
 );
END;
CREATE TRIGGER chat_admission_agent_run_transitions_update BEFORE UPDATE ON agent_run_transitions BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id))
 );
END;
CREATE TRIGGER chat_admission_agent_run_transitions_delete BEFORE DELETE ON agent_run_transitions BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id))
 );
END;
CREATE TRIGGER chat_admission_conversation_goals_insert BEFORE INSERT ON conversation_goals BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_goals_update BEFORE UPDATE ON conversation_goals BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_goals_delete BEFORE DELETE ON conversation_goals BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.conversation_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_goal_audits_insert BEFORE INSERT ON conversation_goal_audits BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT NEW.conversation_id UNION SELECT conversation_id FROM conversation_goals WHERE goal_id=NEW.goal_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.current_run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.current_run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=NEW.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_goal_audits_update BEFORE UPDATE ON conversation_goal_audits BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT conversation_id FROM conversation_goals WHERE goal_id=OLD.goal_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.current_run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.current_run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=OLD.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT NEW.conversation_id UNION SELECT conversation_id FROM conversation_goals WHERE goal_id=NEW.goal_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.current_run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.current_run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.current_run_id) UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=NEW.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_goal_audits_delete BEFORE DELETE ON conversation_goal_audits BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT OLD.conversation_id UNION SELECT conversation_id FROM conversation_goals WHERE goal_id=OLD.goal_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.current_run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.current_run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.current_run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.current_run_id) UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=OLD.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id)
 );
END;
CREATE TRIGGER chat_admission_conversation_goal_audit_runs_insert BEFORE INSERT ON conversation_goal_audit_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=NEW.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id))
 );
END;
CREATE TRIGGER chat_admission_conversation_goal_audit_runs_update BEFORE UPDATE ON conversation_goal_audit_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=OLD.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=NEW.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=NEW.audit_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=NEW.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=NEW.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=NEW.run_id))
 );
END;
CREATE TRIGGER chat_admission_conversation_goal_audit_runs_delete BEFORE DELETE ON conversation_goal_audit_runs BEGIN
 SELECT RAISE(ABORT,'chat_admission_read_only') WHERE EXISTS(
  SELECT 1 FROM chat_admission_owners WHERE mode<>'open' AND conversation_id IN (SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id=OLD.audit_id UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id=OLD.audit_id UNION SELECT parent_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT child_conversation_id FROM agent_runs WHERE id=OLD.run_id UNION SELECT a.conversation_id FROM conversation_goal_audits a WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT g.conversation_id FROM conversation_goal_audits a JOIN conversation_goals g ON g.goal_id=a.goal_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN agent_runs r ON r.id=a.current_run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.parent_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id) UNION SELECT r.child_conversation_id FROM conversation_goal_audits a JOIN conversation_goal_audit_runs l ON l.audit_id=a.audit_id JOIN agent_runs r ON r.id=l.run_id WHERE a.audit_id IN (SELECT audit_id FROM conversation_goal_audits WHERE current_run_id=OLD.run_id UNION SELECT audit_id FROM conversation_goal_audit_runs WHERE run_id=OLD.run_id))
 );
END;
