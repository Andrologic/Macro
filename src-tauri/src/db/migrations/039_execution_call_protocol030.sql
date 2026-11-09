-- A call has its own native identity, never an agent instance/provider attempt.
CREATE TABLE engine_flow030_calls (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
 activation_id TEXT NOT NULL, start_effect_id TEXT NOT NULL,
 call_id TEXT NOT NULL UNIQUE,
 attempt_json TEXT NOT NULL CHECK(json_valid(attempt_json)),
 status TEXT NOT NULL CHECK(status IN ('reserved','prepared','launched','received','terminal')),
 prepared_json TEXT CHECK(prepared_json IS NULL OR json_valid(prepared_json)),
 received_json TEXT CHECK(received_json IS NULL OR json_valid(received_json)),
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
 PRIMARY KEY(system_id,invocation_id,activation_id),
 UNIQUE(system_id,invocation_id,start_effect_id),
 FOREIGN KEY(system_id,invocation_id,start_effect_id)
 REFERENCES engine_flow030_outbox(system_id,invocation_id,effect_id),
 CHECK((status='reserved' AND prepared_json IS NULL AND received_json IS NULL AND receipt_json IS NULL)
    OR (status='prepared' AND prepared_json IS NOT NULL AND received_json IS NULL AND receipt_json IS NULL)
    OR (status='launched' AND prepared_json IS NOT NULL AND received_json IS NULL AND receipt_json IS NULL)
    OR (status='received' AND prepared_json IS NOT NULL AND received_json IS NOT NULL AND receipt_json IS NULL)
    OR (status='terminal' AND received_json IS NOT NULL AND receipt_json IS NOT NULL))
);
CREATE TRIGGER engine_flow030_call_identity_immutable
BEFORE UPDATE OF system_id,invocation_id,activation_id,start_effect_id,call_id,attempt_json ON engine_flow030_calls
BEGIN SELECT RAISE(ABORT,'immutable native call identity'); END;
CREATE TRIGGER engine_flow030_call_progress
BEFORE UPDATE ON engine_flow030_calls
WHEN NOT ((OLD.status='reserved' AND NEW.status IN ('prepared','terminal'))
 OR (OLD.status='prepared' AND NEW.status IN ('launched','terminal'))
 OR (OLD.status='launched' AND NEW.status='received')
 OR (OLD.status='received' AND NEW.status='terminal'))
 OR (OLD.prepared_json IS NOT NULL AND NEW.prepared_json IS NOT OLD.prepared_json)
 OR (OLD.received_json IS NOT NULL AND NEW.received_json IS NOT OLD.received_json)
BEGIN SELECT RAISE(ABORT,'native call cannot replay or change its receipt'); END;
CREATE TRIGGER engine_flow030_call_retained BEFORE DELETE ON engine_flow030_calls
BEGIN SELECT RAISE(ABORT,'retained native call receipt'); END;
-- Native clock decisions precede cancellation/join. They cannot be supplied by
-- a raw command/MCP receipt or overwritten by a later normal return.
CREATE TABLE engine_flow030_call_causes (
 call_id TEXT NOT NULL PRIMARY KEY REFERENCES engine_flow030_calls(call_id),
 cause_json TEXT NOT NULL CHECK(json_valid(cause_json))
);
CREATE TRIGGER engine_flow030_call_cause_immutable BEFORE UPDATE ON engine_flow030_call_causes
BEGIN SELECT RAISE(ABORT,'immutable native call cause'); END;
CREATE TRIGGER engine_flow030_call_cause_retained BEFORE DELETE ON engine_flow030_call_causes
BEGIN SELECT RAISE(ABORT,'retained native call cause'); END;
-- A reducer diagnostic is durable without a successful work transition. Keep
-- the exact proposed result so retry/readback never reruns pure normalization.
CREATE TABLE engine_flow030_call_diagnostics (
 call_id TEXT NOT NULL PRIMARY KEY REFERENCES engine_flow030_calls(call_id),
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, event_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 FOREIGN KEY(system_id,invocation_id,event_id)
 REFERENCES engine_flow030_events(system_id,invocation_id,event_id)
);
CREATE TRIGGER engine_flow030_call_diagnostic_immutable BEFORE UPDATE ON engine_flow030_call_diagnostics
BEGIN SELECT RAISE(ABORT,'immutable native call diagnostic'); END;
CREATE TRIGGER engine_flow030_call_diagnostic_retained BEFORE DELETE ON engine_flow030_call_diagnostics
BEGIN SELECT RAISE(ABORT,'retained native call diagnostic'); END;
