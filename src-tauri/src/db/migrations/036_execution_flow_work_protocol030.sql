-- Admissions and event authorizations are written only by the native host
-- after verifying captured policy / observed native provenance, under its
-- admission lock and the same BEGIN IMMEDIATE transaction as the causal event.
CREATE TABLE engine_flow030_work_admissions (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, activation_id TEXT NOT NULL,
 start_effect_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 capture_sha256 TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
 options_json TEXT NOT NULL CHECK(json_valid(options_json)),
 policy_evidence_json TEXT NOT NULL CHECK(json_valid(policy_evidence_json)),
 PRIMARY KEY(system_id,invocation_id,activation_id),
 FOREIGN KEY(system_id,invocation_id,start_effect_id) REFERENCES engine_flow030_outbox(system_id,invocation_id,effect_id)
);
CREATE TRIGGER engine_flow030_work_admissions_immutable BEFORE UPDATE ON engine_flow030_work_admissions BEGIN SELECT RAISE(ABORT,'immutable work admission'); END;
CREATE TRIGGER engine_flow030_work_admissions_retained BEFORE DELETE ON engine_flow030_work_admissions BEGIN SELECT RAISE(ABORT,'retained work admission'); END;
CREATE TABLE engine_flow030_work_authorizations (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, event_id TEXT NOT NULL,
 activation_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 provider_attempt_id TEXT, native_call_id TEXT,
 PRIMARY KEY(system_id,invocation_id,event_id),
 UNIQUE(system_id,invocation_id,provider_attempt_id,native_call_id),
 CHECK ((provider_attempt_id IS NULL) = (native_call_id IS NULL)),
 FOREIGN KEY(system_id,invocation_id,activation_id) REFERENCES engine_flow030_work_admissions(system_id,invocation_id,activation_id)
);
CREATE TRIGGER engine_flow030_work_authorizations_immutable BEFORE UPDATE ON engine_flow030_work_authorizations BEGIN SELECT RAISE(ABORT,'immutable work event'); END;
CREATE TRIGGER engine_flow030_work_authorizations_retained BEFORE DELETE ON engine_flow030_work_authorizations BEGIN SELECT RAISE(ABORT,'retained work event'); END;
CREATE TABLE engine_flow030_work_state (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, activation_id TEXT NOT NULL,
 revision TEXT NOT NULL CHECK(revision <> '' AND revision NOT GLOB '*[^0-9]*' AND (revision='0' OR substr(revision,1,1) <> '0')),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 PRIMARY KEY(system_id,invocation_id,activation_id),
 FOREIGN KEY(system_id,invocation_id,activation_id) REFERENCES engine_flow030_work_admissions(system_id,invocation_id,activation_id)
);
CREATE TABLE engine_flow030_work_events (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, event_id TEXT NOT NULL,
 activation_id TEXT NOT NULL, ticket_json TEXT NOT NULL CHECK(json_valid(ticket_json)),
 decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
 PRIMARY KEY(system_id,invocation_id,event_id),
 FOREIGN KEY(system_id,invocation_id,event_id) REFERENCES engine_flow030_work_authorizations(system_id,invocation_id,event_id)
);
CREATE TRIGGER engine_flow030_work_ticket_immutable
BEFORE UPDATE OF system_id,invocation_id,event_id,activation_id ON engine_flow030_work_events
BEGIN SELECT RAISE(ABORT,'immutable work ticket'); END;
CREATE TRIGGER engine_flow030_work_ticket_after_decision
BEFORE UPDATE OF ticket_json ON engine_flow030_work_events WHEN OLD.decision_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'committed work ticket'); END;
CREATE TRIGGER engine_flow030_work_decision_immutable
BEFORE UPDATE OF decision_json ON engine_flow030_work_events WHEN OLD.decision_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable work decision'); END;
CREATE TRIGGER engine_flow030_work_event_retained
BEFORE DELETE ON engine_flow030_work_events BEGIN SELECT RAISE(ABORT,'retained work event'); END;
CREATE TABLE engine_flow030_work_checks (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, check_id TEXT NOT NULL,
 activation_id TEXT NOT NULL, event_id TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 status TEXT NOT NULL CHECK(status IN ('reserved','uncertain','ended')),
 PRIMARY KEY(system_id,invocation_id,check_id),
 UNIQUE(system_id,invocation_id,event_id),
 FOREIGN KEY(system_id,invocation_id,event_id) REFERENCES engine_flow030_work_events(system_id,invocation_id,event_id)
);
