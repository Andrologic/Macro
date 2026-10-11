CREATE TABLE IF NOT EXISTS conversation_management (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1,
 archived INTEGER NOT NULL DEFAULT 0,
 response_revision INTEGER NOT NULL DEFAULT 0,
 read_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_action_receipts (
 receipt_key TEXT PRIMARY KEY,
 digest TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO conversation_management(conversation_id) SELECT id FROM conversations;
CREATE TRIGGER IF NOT EXISTS conversation_management_insert AFTER INSERT ON conversations BEGIN
 INSERT INTO conversation_management(conversation_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS conversation_management_update AFTER UPDATE ON conversations BEGIN
 UPDATE conversation_management SET revision = revision + 1 WHERE conversation_id = NEW.id;
END;
CREATE TABLE IF NOT EXISTS conversation_response_versions (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 read_revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO conversation_response_versions(message_id, conversation_id, revision)
 SELECT id, conversation_id, ROW_NUMBER() OVER(PARTITION BY conversation_id ORDER BY created_at, id)
 FROM messages WHERE role = 'assistant';
UPDATE conversation_management SET response_revision = MAX(response_revision, COALESCE((SELECT MAX(revision) FROM conversation_response_versions WHERE conversation_id = conversation_management.conversation_id), 0));
CREATE TRIGGER IF NOT EXISTS conversation_response_insert AFTER INSERT ON messages WHEN NEW.role = 'assistant' BEGIN
 UPDATE conversation_management SET response_revision = response_revision + 1 WHERE conversation_id = NEW.conversation_id;
 INSERT INTO conversation_response_versions(message_id, conversation_id, revision) SELECT NEW.id, NEW.conversation_id, response_revision FROM conversation_management WHERE conversation_id = NEW.conversation_id;
END;
CREATE TRIGGER IF NOT EXISTS conversation_response_update AFTER UPDATE OF content, completion_reason ON messages
 WHEN NEW.role = 'assistant' AND (OLD.content IS NOT NEW.content OR OLD.completion_reason IS NOT NEW.completion_reason) BEGIN
 UPDATE conversation_management SET response_revision = response_revision + 1 WHERE conversation_id = NEW.conversation_id;
 INSERT INTO conversation_response_versions(message_id, conversation_id, revision) SELECT NEW.id, NEW.conversation_id, response_revision FROM conversation_management WHERE conversation_id = NEW.conversation_id
 ON CONFLICT(message_id) DO UPDATE SET revision = excluded.revision;
END;
