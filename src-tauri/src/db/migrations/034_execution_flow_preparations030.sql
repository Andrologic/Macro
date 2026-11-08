-- A native preparation receipt and its occurrence provenance commit with Prepared.
CREATE TABLE engine_flow030_preparations (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, prepare_id TEXT NOT NULL,
 native_receipt_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
 producer_json TEXT NOT NULL CHECK(json_valid(producer_json)),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 content_receipts_json TEXT NOT NULL CHECK(json_valid(content_receipts_json)),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 PRIMARY KEY(system_id,invocation_id,prepare_id),
 UNIQUE(system_id,invocation_id,native_receipt_id),
 FOREIGN KEY(system_id,invocation_id) REFERENCES engine_flow030_runs(system_id,invocation_id)
);
CREATE TABLE engine_flow030_occurrence_provenance (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, native_receipt_id TEXT NOT NULL,
 target_ordinal INTEGER NOT NULL CHECK(target_ordinal >= 0),
 item_index TEXT NOT NULL CHECK(item_index='0' OR (item_index NOT GLOB '*[^0-9]*' AND substr(item_index,1,1) BETWEEN '1' AND '9')),
 provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
 PRIMARY KEY(system_id,invocation_id,native_receipt_id,target_ordinal,item_index),
 FOREIGN KEY(system_id,invocation_id,native_receipt_id)
 REFERENCES engine_flow030_preparations(system_id,invocation_id,native_receipt_id)
);
CREATE TRIGGER engine_flow030_preparation_immutable BEFORE UPDATE ON engine_flow030_preparations
BEGIN SELECT RAISE(ABORT,'immutable native flow preparation'); END;
CREATE TRIGGER engine_flow030_occurrence_provenance_immutable BEFORE UPDATE ON engine_flow030_occurrence_provenance
BEGIN SELECT RAISE(ABORT,'immutable native occurrence provenance'); END;
