-- Product request id is global; a conflicting system/body cannot reuse it.
CREATE TABLE engine_flow030_system_stop_requests (
 request_id TEXT NOT NULL PRIMARY KEY,
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
 owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 event_id TEXT,
 FOREIGN KEY(system_id,invocation_id) REFERENCES engine_flow030_runs(system_id,invocation_id),
 FOREIGN KEY(system_id,invocation_id,event_id) REFERENCES engine_flow030_events(system_id,invocation_id,event_id)
);
CREATE TRIGGER engine_flow030_system_stop_immutable BEFORE UPDATE ON engine_flow030_system_stop_requests
BEGIN SELECT RAISE(ABORT,'immutable system Stop request'); END;
CREATE TRIGGER engine_flow030_system_stop_retained BEFORE DELETE ON engine_flow030_system_stop_requests
BEGIN SELECT RAISE(ABORT,'retained system Stop request'); END;
