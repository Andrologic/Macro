-- One token for the committed conversations table, not a mutation count.
CREATE TABLE conversation_catalog_version (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
  CHECK (typeof(incarnation) = 'text' AND length(incarnation) = 32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0)
);
INSERT INTO conversation_catalog_version(singleton) VALUES(1);
-- The final INSERT also covers all implicit REPLACE victims, including rowid.
CREATE TRIGGER catalog_version_conversations_insert AFTER INSERT ON conversations BEGIN
 UPDATE conversation_catalog_version SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE singleton = 1;
END;
-- The final UPDATE also covers all implicit REPLACE victims, including rowid.
CREATE TRIGGER catalog_version_conversations_update AFTER UPDATE ON conversations BEGIN
 UPDATE conversation_catalog_version SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE singleton = 1;
END;
-- The final DELETE also covers all implicit REPLACE victims, including rowid.
CREATE TRIGGER catalog_version_conversations_delete AFTER DELETE ON conversations BEGIN
 UPDATE conversation_catalog_version SET incarnation = CASE WHEN revision = 9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision = CASE WHEN revision = 9223372036854775807 THEN 0 ELSE revision + 1 END WHERE singleton = 1;
END;
