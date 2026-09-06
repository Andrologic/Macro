CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
    content,
    content = 'messages',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_search_insert
AFTER INSERT ON messages BEGIN
    INSERT INTO message_search(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_search_delete
AFTER DELETE ON messages BEGIN
    INSERT INTO message_search(message_search, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_search_update
AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO message_search(message_search, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO message_search(rowid, content) VALUES (new.rowid, new.content);
END;

INSERT INTO message_search(message_search) VALUES ('rebuild');
