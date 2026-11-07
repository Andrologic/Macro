-- A 0.3 Start entry has its own durable delivery identity. This registry is
-- derived from the immutable request and is not authority to deliver work.
CREATE TABLE engine_start030_entries (
    delivery_id TEXT PRIMARY KEY NOT NULL CHECK(length(delivery_id) > 0),
    system_id TEXT NOT NULL UNIQUE REFERENCES engine_start030_requests(system_id)
);
CREATE TRIGGER engine_start030_entry_reject_020 BEFORE INSERT ON engine_start030_entries
WHEN EXISTS(SELECT 1 FROM engine_deliveries WHERE delivery_id=NEW.delivery_id)
BEGIN SELECT RAISE(ABORT, 'execution delivery identity conflict'); END;
CREATE TRIGGER engine_delivery020_reject_030 BEFORE INSERT ON engine_deliveries
WHEN EXISTS(SELECT 1 FROM engine_start030_entries WHERE delivery_id=NEW.delivery_id)
BEGIN SELECT RAISE(ABORT, 'execution delivery identity conflict'); END;
CREATE TRIGGER engine_start030_entry_immutable BEFORE UPDATE ON engine_start030_entries
BEGIN SELECT RAISE(ABORT, 'immutable start entry'); END;
CREATE TRIGGER engine_start030_entry_retained BEFORE DELETE ON engine_start030_entries
BEGIN SELECT RAISE(ABORT, 'retained start entry'); END;
-- Backfill deliberately fails on malformed or conflicting historical identities.
INSERT INTO engine_start030_entries(delivery_id, system_id)
SELECT CASE WHEN json_type(request_json, '$.entry') = 'object'
                 AND json_type(request_json, '$.entry.deliveryId') = 'text'
            THEN json_extract(request_json, '$.entry.deliveryId') END, system_id
FROM engine_start030_requests
WHERE json_type(request_json, '$.entry') IS NOT NULL
  AND json_type(request_json, '$.entry') <> 'null';
CREATE TRIGGER engine_start030_record_entry AFTER INSERT ON engine_start030_requests
WHEN json_type(NEW.request_json, '$.entry') IS NOT NULL
 AND json_type(NEW.request_json, '$.entry') <> 'null'
BEGIN
    INSERT INTO engine_start030_entries(delivery_id, system_id)
    VALUES(CASE WHEN json_type(NEW.request_json, '$.entry') = 'object'
                     AND json_type(NEW.request_json, '$.entry.deliveryId') = 'text'
                THEN json_extract(NEW.request_json, '$.entry.deliveryId') END, NEW.system_id);
END;
