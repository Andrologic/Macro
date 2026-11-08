-- Registered only by native Start, in the same transaction as its flow capture.
CREATE TABLE engine_flow030_owners (
 system_id TEXT NOT NULL PRIMARY KEY, invocation_id TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, capture_epoch TEXT NOT NULL,
 owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('live','revoked')),
 capture_sha256 TEXT NOT NULL CHECK(length(capture_sha256)=64),
 FOREIGN KEY(system_id,invocation_id,snapshot_id,capture_epoch)
 REFERENCES engine_flow030_runs(system_id,invocation_id,snapshot_id,epoch)
 DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER engine_flow030_owner_capture_immutable
BEFORE UPDATE OF system_id,invocation_id,snapshot_id,capture_epoch,capture_sha256 ON engine_flow030_owners
BEGIN SELECT RAISE(ABORT,'immutable native flow owner capture'); END;
-- Native handoff proof is inserted only after the non-clonable dispatch lease
-- transferred its exact effect to the owned native executor.
CREATE TABLE engine_flow030_handoffs (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, effect_id TEXT NOT NULL,
 owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 PRIMARY KEY(system_id,invocation_id,effect_id),
 FOREIGN KEY(system_id,invocation_id,effect_id)
 REFERENCES engine_flow030_outbox(system_id,invocation_id,effect_id)
);
CREATE TRIGGER engine_flow030_handoff_immutable BEFORE UPDATE ON engine_flow030_handoffs
BEGIN SELECT RAISE(ABORT,'immutable native flow handoff'); END;
