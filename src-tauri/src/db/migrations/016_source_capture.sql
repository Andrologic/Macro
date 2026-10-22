-- Local raw source copies only. No ordinary conversation or transfer authority.
CREATE TABLE e_source_version (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 incarnation TEXT NOT NULL CHECK(typeof(incarnation)='text' AND length(CAST(incarnation AS BLOB))=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0)
);
INSERT INTO e_source_version VALUES(1,lower(hex(randomblob(16))),0);
CREATE TABLE e_source_captures (
 id INTEGER PRIMARY KEY,
 capture_id TEXT NOT NULL UNIQUE CHECK(length(capture_id)=36),
 binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB))<=4096),
 phase INTEGER NOT NULL CHECK(phase BETWEEN 0 AND 4),
 revision INTEGER NOT NULL CHECK(revision>=0),
 family INTEGER NOT NULL CHECK(family BETWEEN 0 AND 10),
 cursor_rowid INTEGER,
 cursor_field INTEGER NOT NULL CHECK(cursor_field>=0),
 cursor_offset INTEGER NOT NULL CHECK(cursor_offset>=0),
 row_ordinal INTEGER NOT NULL CHECK(row_ordinal>=0),
 fields_count INTEGER NOT NULL CHECK(fields_count>=0),
 rows_count INTEGER NOT NULL CHECK(rows_count>=0),
 bytes_received INTEGER NOT NULL CHECK(bytes_received>=0),
 charge_bytes INTEGER NOT NULL CHECK(charge_bytes>=0),
 created_at INTEGER NOT NULL, progressed_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, idle_ms INTEGER NOT NULL CHECK(idle_ms>0),
 last_clock INTEGER NOT NULL,
 manifest_hash BLOB CHECK(manifest_hash IS NULL OR length(manifest_hash)=32)
);
CREATE TABLE e_source_fields (
 capture_id INTEGER NOT NULL REFERENCES e_source_captures(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 row_ordinal INTEGER NOT NULL CHECK(row_ordinal>=0),
 family INTEGER NOT NULL CHECK(family BETWEEN 0 AND 9),
 source_rowid INTEGER NOT NULL,
 field_tag INTEGER NOT NULL CHECK(field_tag>=0),
 sql_type INTEGER NOT NULL CHECK(sql_type BETWEEN 0 AND 3),
 total_bytes INTEGER NOT NULL CHECK(total_bytes>=0),
 received_bytes INTEGER NOT NULL CHECK(received_bytes>=0 AND received_bytes<=total_bytes),
 complete INTEGER NOT NULL CHECK(complete IN (0,1)),
 sha256 BLOB CHECK(sha256 IS NULL OR length(sha256)=32),
 utf8_tail BLOB NOT NULL CHECK(length(utf8_tail)<=3),
 PRIMARY KEY(capture_id,ordinal),
 UNIQUE(capture_id,family,source_rowid,field_tag)
);
CREATE TABLE e_source_fragments (
 capture_id INTEGER NOT NULL, field_ordinal INTEGER NOT NULL,
 offset_bytes INTEGER NOT NULL CHECK(offset_bytes>=0),
 data BLOB NOT NULL CHECK(length(data)<=4093),
 sha256 BLOB NOT NULL CHECK(length(sha256)=32),
 ack_next_field INTEGER NOT NULL, ack_next_offset INTEGER NOT NULL,
 ack_total_bytes INTEGER NOT NULL, ack_revision INTEGER NOT NULL,
 PRIMARY KEY(capture_id,field_ordinal,offset_bytes),
 FOREIGN KEY(capture_id,field_ordinal) REFERENCES e_source_fields(capture_id,ordinal) ON DELETE CASCADE
);
CREATE TABLE e_source_relations (
 capture_id INTEGER NOT NULL REFERENCES e_source_captures(id) ON DELETE CASCADE,
 from_row INTEGER NOT NULL, kind INTEGER NOT NULL,
 position INTEGER NOT NULL CHECK(position>=0), to_row INTEGER,
 status INTEGER NOT NULL CHECK(status BETWEEN 0 AND 2),
 PRIMARY KEY(capture_id,from_row,kind,position)
);
CREATE INDEX e_source_relations_target ON e_source_relations(capture_id,to_row);
CREATE TRIGGER e_source_version_conversation_compactions_insert AFTER INSERT ON conversation_compactions BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_compactions_update AFTER UPDATE ON conversation_compactions BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_compactions_delete AFTER DELETE ON conversation_compactions BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_citations_insert AFTER INSERT ON conversation_citations BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_citations_update AFTER UPDATE ON conversation_citations BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_citations_delete AFTER DELETE ON conversation_citations BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_toolbox_state_insert AFTER INSERT ON conversation_toolbox_state BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_toolbox_state_update AFTER UPDATE ON conversation_toolbox_state BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_conversation_toolbox_state_delete AFTER DELETE ON conversation_toolbox_state BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_pilot_message_attachments_insert AFTER INSERT ON pilot_message_attachments BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_pilot_message_attachments_update AFTER UPDATE ON pilot_message_attachments BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_pilot_message_attachments_delete AFTER DELETE ON pilot_message_attachments BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_pilot_file_sends_insert AFTER INSERT ON pilot_file_sends BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_pilot_file_sends_update AFTER UPDATE ON pilot_file_sends BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
CREATE TRIGGER e_source_version_pilot_file_sends_delete AFTER DELETE ON pilot_file_sends BEGIN
 UPDATE e_source_version SET incarnation=CASE WHEN revision=9223372036854775807 THEN lower(hex(randomblob(16))) ELSE incarnation END, revision=CASE WHEN revision=9223372036854775807 THEN 0 ELSE revision+1 END WHERE singleton=1;
END;
