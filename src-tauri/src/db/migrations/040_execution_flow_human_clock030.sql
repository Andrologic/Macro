-- 039 is reserved for the parallel Call protocol lot. Register this migration
-- after that lot in db/mod.rs. All identities belong to the actual 0.3 flow.
CREATE TABLE engine_flow030_clock (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
 owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 revision TEXT NOT NULL DEFAULT '0', state_json TEXT NOT NULL DEFAULT '',
 receipt_json TEXT NOT NULL DEFAULT '{}', observed_ms TEXT NOT NULL,
 PRIMARY KEY(system_id,invocation_id),
 FOREIGN KEY(system_id,invocation_id) REFERENCES engine_flow030_runs(system_id,invocation_id)
);
CREATE TABLE engine_flow030_clock_events (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, event_id TEXT NOT NULL,
 ticket_json TEXT NOT NULL CHECK(json_valid(ticket_json)),
 output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
 PRIMARY KEY(system_id,invocation_id,event_id),
 FOREIGN KEY(system_id,invocation_id) REFERENCES engine_flow030_clock(system_id,invocation_id)
);
CREATE UNIQUE INDEX engine_flow030_clock_pending ON engine_flow030_clock_events(system_id,invocation_id) WHERE output_json IS NULL;
CREATE TRIGGER engine_flow030_clock_event_immutable BEFORE UPDATE ON engine_flow030_clock_events WHEN OLD.output_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable clock decision'); END;
CREATE TRIGGER engine_flow030_clock_event_retained BEFORE DELETE ON engine_flow030_clock_events
BEGIN SELECT RAISE(ABORT,'retained clock journal'); END;
CREATE TABLE engine_flow030_clock_works (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, activation_id TEXT NOT NULL,
 start_effect_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('agent','call','approval')),
 work_json TEXT NOT NULL CHECK(json_valid(work_json)),
 admitted_ms TEXT NOT NULL, timeout_json TEXT, answer_timeout_json TEXT,
 snapshot_json TEXT NOT NULL DEFAULT '{}', retired INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(system_id,invocation_id,activation_id),
 FOREIGN KEY(system_id,invocation_id,start_effect_id) REFERENCES engine_flow030_handoffs(system_id,invocation_id,effect_id)
);
CREATE TABLE engine_flow030_human_requests (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, request_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('ask','plan','question','approval')),
 revision TEXT NOT NULL DEFAULT '0',
 work_ids_json TEXT NOT NULL CHECK(json_valid(work_ids_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 opened_ms TEXT NOT NULL,
 -- Exact deadline = opened_ms + the minimum authored duration. Never a double.
 deadline_json TEXT NOT NULL CHECK(json_valid(deadline_json)),
 resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json)),
 delivery TEXT NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','reserved','acknowledged')),
 PRIMARY KEY(system_id,invocation_id,request_id),
 FOREIGN KEY(system_id,invocation_id) REFERENCES engine_flow030_clock(system_id,invocation_id)
);
CREATE TABLE engine_flow030_human_submissions (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
 request_id TEXT NOT NULL, received_ms TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('person','synthetic-person')),
 answer_json TEXT NOT NULL CHECK(json_valid(answer_json)),
 accepted INTEGER,
 PRIMARY KEY(system_id,invocation_id,receipt_id),
 FOREIGN KEY(system_id,invocation_id,request_id) REFERENCES engine_flow030_human_requests(system_id,invocation_id,request_id)
);
CREATE TABLE engine_flow030_clock_controls (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, activation_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL CHECK(reason='TIMEOUT'),
 observed_ms TEXT NOT NULL, joined INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(system_id,invocation_id,activation_id),
 FOREIGN KEY(system_id,invocation_id,activation_id) REFERENCES engine_flow030_clock_works(system_id,invocation_id,activation_id)
);
CREATE TRIGGER engine_flow030_clock_ticket_immutable BEFORE UPDATE OF ticket_json ON engine_flow030_clock_events
BEGIN SELECT RAISE(ABORT,'immutable clock ticket'); END;
CREATE TRIGGER engine_flow030_human_payload_immutable BEFORE UPDATE OF system_id,invocation_id,request_id,kind,payload_json,opened_ms ON engine_flow030_human_requests
BEGIN SELECT RAISE(ABORT,'immutable presented human request'); END;
CREATE TRIGGER engine_flow030_human_resolution_immutable BEFORE UPDATE OF resolution_json,revision ON engine_flow030_human_requests WHEN OLD.resolution_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable human resolution'); END;
CREATE TRIGGER engine_flow030_human_request_retained BEFORE DELETE ON engine_flow030_human_requests
BEGIN SELECT RAISE(ABORT,'retained human request'); END;
CREATE TRIGGER engine_flow030_human_submission_immutable BEFORE UPDATE OF system_id,invocation_id,receipt_id,request_id,received_ms,origin,answer_json ON engine_flow030_human_submissions
BEGIN SELECT RAISE(ABORT,'immutable received human answer'); END;
CREATE TRIGGER engine_flow030_human_arbitration_immutable BEFORE UPDATE OF accepted ON engine_flow030_human_submissions WHEN OLD.accepted IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable answer arbitration'); END;
CREATE TRIGGER engine_flow030_human_submission_retained BEFORE DELETE ON engine_flow030_human_submissions
BEGIN SELECT RAISE(ABORT,'retained human answer'); END;
CREATE TRIGGER engine_flow030_clock_work_immutable BEFORE UPDATE OF system_id,invocation_id,activation_id,start_effect_id,owner_epoch,generation,kind,work_json,admitted_ms,timeout_json,answer_timeout_json ON engine_flow030_clock_works
BEGIN SELECT RAISE(ABORT,'immutable machine admission'); END;
CREATE TRIGGER engine_flow030_clock_cause_immutable BEFORE UPDATE OF system_id,invocation_id,activation_id,receipt_id,reason,observed_ms ON engine_flow030_clock_controls
BEGIN SELECT RAISE(ABORT,'immutable timeout cause'); END;
CREATE TRIGGER engine_flow030_clock_cause_retained BEFORE DELETE ON engine_flow030_clock_controls
BEGIN SELECT RAISE(ABORT,'retained timeout cause'); END;
-- Captured inside the native handoff transaction, before settlement/release.
-- Broker admission must never manufacture a new origin for a delivered Start.
CREATE TABLE engine_flow030_handoff_clock (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, start_effect_id TEXT NOT NULL,
 owner_epoch TEXT NOT NULL, generation TEXT NOT NULL, started_ms TEXT NOT NULL,
 PRIMARY KEY(system_id,invocation_id,start_effect_id),
 FOREIGN KEY(system_id,invocation_id,start_effect_id)
 REFERENCES engine_flow030_handoffs(system_id,invocation_id,effect_id)
);
CREATE TRIGGER engine_flow030_handoff_clock_immutable BEFORE UPDATE ON engine_flow030_handoff_clock
BEGIN SELECT RAISE(ABORT,'immutable handoff clock origin'); END;
CREATE TRIGGER engine_flow030_handoff_clock_retained BEFORE DELETE ON engine_flow030_handoff_clock
BEGIN SELECT RAISE(ABORT,'retained handoff clock origin'); END;
-- Written only after native semantic validation, atomically with the decision.
-- A historical resident-produced row alone cannot mint a native capability.
CREATE TABLE engine_flow030_human_resolution_proofs (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, request_id TEXT NOT NULL,
 event_id TEXT NOT NULL, resolution_json TEXT NOT NULL CHECK(json_valid(resolution_json)),
 PRIMARY KEY(system_id,invocation_id,request_id),
 FOREIGN KEY(system_id,invocation_id,request_id)
 REFERENCES engine_flow030_human_requests(system_id,invocation_id,request_id),
 FOREIGN KEY(system_id,invocation_id,event_id)
 REFERENCES engine_flow030_clock_events(system_id,invocation_id,event_id)
);
CREATE TRIGGER engine_flow030_human_proof_immutable BEFORE UPDATE ON engine_flow030_human_resolution_proofs
BEGIN SELECT RAISE(ABORT,'immutable native human resolution proof'); END;
CREATE TRIGGER engine_flow030_human_proof_retained BEFORE DELETE ON engine_flow030_human_resolution_proofs
BEGIN SELECT RAISE(ABORT,'retained native human resolution proof'); END;
