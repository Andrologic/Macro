DROP TRIGGER messages_search_insert;
DROP TRIGGER messages_search_delete;
DROP TRIGGER messages_search_update;
DROP TABLE message_search;

-- A correlated projection keeps the original transcript untouched and applies
-- the same text to indexing, trigger maintenance and FTS rebuilds.
CREATE VIEW message_search_content AS
SELECT messages.rowid AS rowid,
    CASE WHEN messages.role != 'assistant'
        OR instr(messages.content, '<') = 0
        OR instr(lower(messages.content), 'think') = 0
    THEN messages.content ELSE (
        WITH RECURSIVE
        whitespace(chars) AS (
            VALUES(char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194,
                        8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288))
        ),
        scan(rest, visible, hidden, piece, tag) AS NOT MATERIALIZED (
            SELECT messages.content, '', 0, NULL, NULL
            UNION ALL
            SELECT
                CASE WHEN piece IS NOT NULL AND tag IS NOT NULL
                    THEN substr(rest, length(piece) + 1) ELSE rest END,
                visible || CASE
                    WHEN tag IN ('think', 'thinking')
                        OR (substr(tag, 1, 1) = '/' AND trim(substr(tag, 2), chars) IN ('think', 'thinking')) THEN ' '
                    WHEN tag IS NOT NULL AND hidden = 0 THEN piece
                    ELSE '' END,
                CASE
                    WHEN tag IN ('think', 'thinking') THEN 1
                    WHEN substr(tag, 1, 1) = '/' AND trim(substr(tag, 2), chars) IN ('think', 'thinking') THEN 0
                    ELSE hidden END,
                CASE
                    WHEN piece IS NULL THEN CASE
                        WHEN instr(rest, '<') = 0 OR instr(lower(rest), 'think') = 0 THEN rest
                        -- Skip ordinary HTML/text in one piece. Only a word
                        -- think preceded by '<' and tag whitespace can be a tag.
                        WHEN substr(rtrim(substr(rest, 1, instr(lower(rest), 'think') - 1), chars || '/'), -1) != '<'
                            THEN substr(rest, 1, instr(lower(rest), 'think') + 4)
                        WHEN length(rtrim(substr(rest, 1, instr(lower(rest), 'think') - 1), chars || '/')) > 1
                            THEN substr(rest, 1, length(rtrim(substr(rest, 1, instr(lower(rest), 'think') - 1), chars || '/')) - 1)
                        WHEN instr(substr(rest, 2), '<') > 0
                            AND (instr(rest, '>') = 0 OR instr(substr(rest, 2), '<') < instr(rest, '>'))
                            THEN substr(rest, 1, instr(substr(rest, 2), '<'))
                        WHEN instr(rest, '>') > 0 THEN substr(rest, 1, instr(rest, '>'))
                        ELSE rest END
                    WHEN tag IS NULL THEN piece
                    ELSE NULL END,
                CASE WHEN piece IS NOT NULL AND tag IS NULL THEN CASE
                    WHEN substr(piece, 1, 1) = '<' AND substr(piece, -1) = '>'
                        THEN lower(trim(substr(piece, 2, length(piece) - 2), chars))
                    ELSE '' END ELSE NULL END
            FROM scan CROSS JOIN whitespace
            WHERE rest != ''
        )
        SELECT visible FROM scan WHERE rest = ''
    ) END AS content
FROM messages;

CREATE VIRTUAL TABLE message_search USING fts5(
    content,
    content = 'message_search_content',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_search_insert
AFTER INSERT ON messages BEGIN
    INSERT INTO message_search(rowid, content)
    SELECT rowid, content FROM message_search_content WHERE rowid = new.rowid;
END;

CREATE TRIGGER messages_search_delete
BEFORE DELETE ON messages BEGIN
    INSERT INTO message_search(message_search, rowid, content)
    SELECT 'delete', rowid, content FROM message_search_content WHERE rowid = old.rowid;
END;

CREATE TRIGGER messages_search_update
BEFORE UPDATE OF content, role ON messages BEGIN
    INSERT INTO message_search(message_search, rowid, content)
    SELECT 'delete', rowid, content FROM message_search_content WHERE rowid = old.rowid;
END;

CREATE TRIGGER messages_search_update_insert
AFTER UPDATE OF content, role ON messages BEGIN
    INSERT INTO message_search(rowid, content)
    SELECT rowid, content FROM message_search_content WHERE rowid = new.rowid;
END;

INSERT INTO message_search(message_search) VALUES ('rebuild');
