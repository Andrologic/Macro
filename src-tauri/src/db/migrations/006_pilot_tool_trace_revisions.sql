CREATE TABLE IF NOT EXISTS conversation_tool_trace_revisions (
    conversation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS messages_tool_trace_revision_insert
AFTER INSERT ON messages
BEGIN
    INSERT INTO conversation_tool_trace_revisions (conversation_id, revision)
    SELECT NEW.conversation_id, 1
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id)
    ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS messages_tool_trace_revision_delete
AFTER DELETE ON messages
BEGIN
    INSERT INTO conversation_tool_trace_revisions (conversation_id, revision)
    SELECT OLD.conversation_id, 1
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id)
    ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS messages_tool_trace_revision_update_same_conversation
AFTER UPDATE OF id, created_at, role, conversation_id, tool_traces_json ON messages
WHEN OLD.conversation_id = NEW.conversation_id
 AND (
     OLD.id IS NOT NEW.id
     OR OLD.created_at IS NOT NEW.created_at
     OR OLD.role IS NOT NEW.role
     OR OLD.tool_traces_json IS NOT NEW.tool_traces_json
 )
BEGIN
    INSERT INTO conversation_tool_trace_revisions (conversation_id, revision)
    SELECT NEW.conversation_id, 1
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id)
    ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS messages_tool_trace_revision_update_conversation
AFTER UPDATE OF id, created_at, role, conversation_id, tool_traces_json ON messages
WHEN OLD.conversation_id IS NOT NEW.conversation_id
BEGIN
    INSERT INTO conversation_tool_trace_revisions (conversation_id, revision)
    SELECT OLD.conversation_id, 1
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id)
    ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
    INSERT INTO conversation_tool_trace_revisions (conversation_id, revision)
    SELECT NEW.conversation_id, 1
    WHERE EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id)
    ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;
