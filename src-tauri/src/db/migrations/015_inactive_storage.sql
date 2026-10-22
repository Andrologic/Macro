-- Inactive storage only. No ordinary conversation or provider authority.
CREATE TABLE e_inactive_domain (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 budget_bytes INTEGER NOT NULL CHECK(budget_bytes>0),
 max_receipts INTEGER NOT NULL CHECK(max_receipts>0)
);
CREATE TABLE e_inactive_imports (
 id INTEGER PRIMARY KEY,
 identity_key TEXT NOT NULL UNIQUE CHECK(length(identity_key)=64),
 begin_json TEXT NOT NULL CHECK(length(CAST(begin_json AS BLOB))<=4096),
 phase INTEGER NOT NULL CHECK(phase BETWEEN 0 AND 4),
 revision INTEGER NOT NULL CHECK(revision>=0),
 next_record INTEGER NOT NULL CHECK(next_record>=0),
 received_bytes INTEGER NOT NULL CHECK(received_bytes>=0),
 charge_bytes INTEGER NOT NULL CHECK(charge_bytes>=0),
 created_at INTEGER NOT NULL,
 progressed_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 idle_ms INTEGER NOT NULL CHECK(idle_ms>0),
 last_clock INTEGER NOT NULL,
 mapping_hash BLOB CHECK(mapping_hash IS NULL OR length(mapping_hash)=32)
);
CREATE TABLE e_inactive_records (
 import_id INTEGER NOT NULL REFERENCES e_inactive_imports(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 header_json TEXT NOT NULL CHECK(length(CAST(header_json AS BLOB))<=4096),
 kind INTEGER NOT NULL CHECK(kind BETWEEN 0 AND 4),
 from_record INTEGER,
 to_record INTEGER,
 position INTEGER,
 relation INTEGER CHECK(relation IS NULL OR relation BETWEEN 0 AND 2),
 received_bytes INTEGER NOT NULL CHECK(received_bytes>=0),
 complete INTEGER NOT NULL CHECK(complete IN (0,1)),
 utf8_tail BLOB NOT NULL CHECK(length(utf8_tail)<=3),
 scan_tail BLOB NOT NULL CHECK(length(scan_tail)<=127),
 PRIMARY KEY(import_id,ordinal),
 UNIQUE(import_id,from_record,relation,position)
);
CREATE TABLE e_inactive_fragments (
 import_id INTEGER NOT NULL,
 ordinal INTEGER NOT NULL,
 offset_bytes INTEGER NOT NULL CHECK(offset_bytes>=0),
 sha256 BLOB NOT NULL CHECK(length(sha256)=32),
 data BLOB NOT NULL CHECK(length(data)<=4093),
 ack_next_offset INTEGER NOT NULL,
 ack_total_received INTEGER NOT NULL,
 ack_revision INTEGER NOT NULL,
 PRIMARY KEY(import_id,ordinal,offset_bytes),
 FOREIGN KEY(import_id,ordinal) REFERENCES e_inactive_records(import_id,ordinal) ON DELETE CASCADE
);
CREATE TABLE e_inactive_mapping (
 import_id INTEGER NOT NULL,
 ordinal INTEGER NOT NULL,
 target_uuid TEXT NOT NULL CHECK(length(target_uuid)=36),
 PRIMARY KEY(import_id,ordinal),
 UNIQUE(import_id,target_uuid),
 FOREIGN KEY(import_id,ordinal) REFERENCES e_inactive_records(import_id,ordinal) ON DELETE CASCADE
);
