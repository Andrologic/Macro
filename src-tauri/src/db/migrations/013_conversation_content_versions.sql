-- A token identifies one committed conversation observation, not an effect count.
-- BEFORE conflict triggers cover every possible text-key and explicit-rowid victim,
-- including REPLACE when SQLite does not run implicit DELETE triggers.
CREATE TABLE conversation_content_versions (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
  CHECK (length(incarnation) = 32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0)
);
INSERT INTO conversation_content_versions(conversation_id) SELECT id FROM conversations;
CREATE TRIGGER content_versions_conversations_insert AFTER INSERT ON conversations BEGIN
 INSERT INTO conversation_content_versions(conversation_id) VALUES(NEW.id) ON CONFLICT(conversation_id) DO UPDATE SET incarnation = lower(hex(randomblob(16))), revision = 0;
END;
CREATE TRIGGER content_versions_conversations_update AFTER UPDATE ON conversations BEGIN
 DELETE FROM conversation_content_versions WHERE conversation_id = OLD.id AND OLD.id IS NOT NEW.id;
 INSERT INTO conversation_content_versions(conversation_id) SELECT NEW.id WHERE OLD.id IS NOT NEW.id ON CONFLICT(conversation_id) DO UPDATE SET incarnation = lower(hex(randomblob(16))), revision = 0;
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT NEW.id);
END;
CREATE TRIGGER content_versions_messages_before_insert BEFORE INSERT ON messages BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM messages WHERE (id = NEW.id COLLATE BINARY OR rowid = NEW.rowid));
END;
CREATE TRIGGER content_versions_messages_before_update BEFORE UPDATE ON messages BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM messages WHERE (id = NEW.id COLLATE BINARY OR rowid = NEW.rowid) AND rowid != OLD.rowid);
END;
CREATE TRIGGER content_versions_messages_insert AFTER INSERT ON messages BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT NEW.conversation_id);
END;
CREATE TRIGGER content_versions_messages_update AFTER UPDATE ON messages BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id);
END;
CREATE TRIGGER content_versions_messages_delete AFTER DELETE ON messages BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT OLD.conversation_id);
END;
CREATE TRIGGER content_versions_app_settings_before_insert BEFORE INSERT ON app_settings BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT m.conversation_id FROM app_settings victim JOIN messages m ON m.id = substr(victim.key,38) COLLATE BINARY WHERE (victim.key = NEW.key COLLATE BINARY OR victim.rowid = NEW.rowid) AND substr(victim.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY);
END;
CREATE TRIGGER content_versions_app_settings_before_update BEFORE UPDATE ON app_settings BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT m.conversation_id FROM app_settings victim JOIN messages m ON m.id = substr(victim.key,38) COLLATE BINARY WHERE (victim.key = NEW.key COLLATE BINARY OR victim.rowid = NEW.rowid) AND substr(victim.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND victim.rowid != OLD.rowid);
END;
CREATE TRIGGER content_versions_app_settings_insert AFTER INSERT ON app_settings BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM messages WHERE substr(NEW.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(NEW.key,38) COLLATE BINARY);
END;
CREATE TRIGGER content_versions_app_settings_update AFTER UPDATE ON app_settings BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM messages WHERE substr(OLD.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(OLD.key,38) COLLATE BINARY UNION SELECT conversation_id FROM messages WHERE substr(NEW.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(NEW.key,38) COLLATE BINARY);
END;
CREATE TRIGGER content_versions_app_settings_delete AFTER DELETE ON app_settings BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM messages WHERE substr(OLD.key,1,37) = 'chat:assistant-visible-provenance:v1:' COLLATE BINARY AND id = substr(OLD.key,38) COLLATE BINARY);
END;
CREATE TRIGGER content_versions_conversation_management_before_insert BEFORE INSERT ON conversation_management BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM conversation_management WHERE (conversation_id = NEW.conversation_id COLLATE BINARY OR rowid = NEW.rowid));
END;
CREATE TRIGGER content_versions_conversation_management_before_update BEFORE UPDATE ON conversation_management BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM conversation_management WHERE (conversation_id = NEW.conversation_id COLLATE BINARY OR rowid = NEW.rowid) AND rowid != OLD.rowid);
END;
CREATE TRIGGER content_versions_conversation_management_insert AFTER INSERT ON conversation_management BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT NEW.conversation_id);
END;
CREATE TRIGGER content_versions_conversation_management_update AFTER UPDATE ON conversation_management BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id);
END;
CREATE TRIGGER content_versions_conversation_management_delete AFTER DELETE ON conversation_management BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT OLD.conversation_id);
END;
CREATE TRIGGER content_versions_conversation_response_versions_before_insert BEFORE INSERT ON conversation_response_versions BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM conversation_response_versions WHERE (message_id = NEW.message_id COLLATE BINARY OR rowid = NEW.rowid));
END;
CREATE TRIGGER content_versions_conversation_response_versions_before_update BEFORE UPDATE ON conversation_response_versions BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT conversation_id FROM conversation_response_versions WHERE (message_id = NEW.message_id COLLATE BINARY OR rowid = NEW.rowid) AND rowid != OLD.rowid);
END;
CREATE TRIGGER content_versions_conversation_response_versions_insert AFTER INSERT ON conversation_response_versions BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT NEW.conversation_id);
END;
CREATE TRIGGER content_versions_conversation_response_versions_update AFTER UPDATE ON conversation_response_versions BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT OLD.conversation_id UNION SELECT NEW.conversation_id);
END;
CREATE TRIGGER content_versions_conversation_response_versions_delete AFTER DELETE ON conversation_response_versions BEGIN
 UPDATE conversation_content_versions SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE conversation_id IN (SELECT OLD.conversation_id);
END;
