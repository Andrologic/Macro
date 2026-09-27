-- Synthetic pre-versioning schema. No application or personal data.
CREATE TABLE conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL,
    last_message TEXT, message_count INTEGER DEFAULT 0
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, timestamp TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX fixture_message_content ON messages(conversation_id, content);
CREATE TABLE fixture_notes (value TEXT NOT NULL CHECK(length(value) > 0));
CREATE TRIGGER fixture_message_insert AFTER INSERT ON messages BEGIN
    INSERT INTO fixture_notes(value) VALUES (new.id);
END;
INSERT INTO conversations VALUES ('conversation', 'Historical conversation', '2025-01-01', 'Original message', 1);
INSERT INTO messages VALUES ('message', 'conversation', 'user', 'Original message', '2025-01-01');
