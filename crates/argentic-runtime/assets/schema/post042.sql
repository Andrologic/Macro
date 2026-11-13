-- From 030_execution_flow.sql; retained engine objects after migration 042.
-- Durable 0.3 flow state; the native owner and dispatch are admitted separately.
CREATE TABLE engine_flow030_runs (
    system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL, epoch TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    state_json TEXT NOT NULL CHECK(json_valid(state_json)),
    PRIMARY KEY(system_id, invocation_id),
    UNIQUE(system_id, invocation_id, snapshot_id, epoch)
);
CREATE TRIGGER engine_flow030_capture_immutable
BEFORE UPDATE OF system_id, invocation_id, snapshot_id, epoch, source_json, plan_json ON engine_flow030_runs
BEGIN SELECT RAISE(ABORT, 'immutable flow capture'); END;
CREATE TABLE engine_flow030_events (
    system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    event_id TEXT NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json)),
    receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
    diagnostic_json TEXT CHECK(diagnostic_json IS NULL OR json_valid(diagnostic_json)),
    PRIMARY KEY(system_id, invocation_id, event_id),
    FOREIGN KEY(system_id, invocation_id) REFERENCES engine_flow030_runs(system_id, invocation_id),
    CHECK((receipt_json IS NULL) <> (diagnostic_json IS NULL))
);
CREATE TABLE engine_flow030_outbox (
    system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    effect_id TEXT NOT NULL, event_id TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK(json_valid(effect_json)), owner_epoch TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','uncertain','settled','revoked')),
    settlement_json TEXT CHECK(settlement_json IS NULL OR json_valid(settlement_json)),
    PRIMARY KEY(system_id, invocation_id, effect_id),
    FOREIGN KEY(system_id, invocation_id, event_id) REFERENCES engine_flow030_events(system_id, invocation_id, event_id),
    CHECK((status = 'settled') = (settlement_json IS NOT NULL))
);
CREATE INDEX engine_flow030_outbox_pending ON engine_flow030_outbox(system_id, invocation_id, status);
CREATE TABLE engine_start030_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    system_id TEXT NOT NULL UNIQUE, invocation_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL, capture_epoch TEXT NOT NULL,
    capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    UNIQUE(system_id, invocation_id),
    FOREIGN KEY(system_id, invocation_id, snapshot_id, capture_epoch)
        REFERENCES engine_flow030_runs(system_id, invocation_id, snapshot_id, epoch)
);
CREATE TRIGGER engine_start030_immutable BEFORE UPDATE ON engine_start030_requests
BEGIN SELECT RAISE(ABORT, 'immutable start capture'); END;



-- From 031_execution_start_entry.sql; retained engine objects after migration 042.
-- A 0.3 Start entry has its own durable delivery identity. This registry is
-- derived from the immutable request and is not authority to deliver work.
CREATE TABLE engine_start030_entries (
    delivery_id TEXT PRIMARY KEY NOT NULL CHECK(length(delivery_id) > 0),
    system_id TEXT NOT NULL UNIQUE REFERENCES engine_start030_requests(system_id)
);


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

-- From 033_execution_flow_owner030.sql; retained engine objects after migration 042.
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

-- From 034_execution_flow_preparations030.sql; retained engine objects after migration 042.
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

-- From 035_execution_flow_no_admission030.sql; retained engine objects after migration 042.
-- Native proof that an exact start effect was never handed to an executor.
CREATE TABLE engine_flow030_no_admissions (
    system_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    start_effect_id TEXT NOT NULL,
    owner_epoch TEXT NOT NULL,
    generation TEXT NOT NULL,
    proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
    PRIMARY KEY(system_id, invocation_id, start_effect_id),
    FOREIGN KEY(system_id, invocation_id, start_effect_id)
        REFERENCES engine_flow030_outbox(system_id, invocation_id, effect_id)
);
CREATE TRIGGER engine_flow030_no_admission_immutable
BEFORE UPDATE ON engine_flow030_no_admissions
BEGIN SELECT RAISE(ABORT, 'immutable native no-admission proof'); END;
CREATE TRIGGER engine_flow030_no_admission_retained
BEFORE DELETE ON engine_flow030_no_admissions
BEGIN SELECT RAISE(ABORT, 'retained native no-admission proof'); END;
CREATE TRIGGER engine_flow030_handoff_retained
BEFORE DELETE ON engine_flow030_handoffs
BEGIN SELECT RAISE(ABORT, 'retained native handoff'); END;
CREATE TRIGGER engine_flow030_preparation_retained
BEFORE DELETE ON engine_flow030_preparations
BEGIN SELECT RAISE(ABORT, 'retained native preparation'); END;
CREATE TRIGGER engine_flow030_occurrence_provenance_retained
BEFORE DELETE ON engine_flow030_occurrence_provenance
BEGIN SELECT RAISE(ABORT, 'retained native occurrence provenance'); END;
CREATE TRIGGER engine_flow030_no_admission_reject_handoff
BEFORE INSERT ON engine_flow030_no_admissions
WHEN EXISTS(SELECT 1 FROM engine_flow030_handoffs
            WHERE system_id=NEW.system_id AND invocation_id=NEW.invocation_id
              AND effect_id=NEW.start_effect_id)
BEGIN SELECT RAISE(ABORT, 'native effect was already handed off'); END;
CREATE TRIGGER engine_flow030_handoff_reject_no_admission
BEFORE INSERT ON engine_flow030_handoffs
WHEN EXISTS(SELECT 1 FROM engine_flow030_no_admissions
            WHERE system_id=NEW.system_id AND invocation_id=NEW.invocation_id
              AND start_effect_id=NEW.effect_id)
BEGIN SELECT RAISE(ABORT, 'native effect was proven not admitted'); END;

-- From 036_execution_flow_work_protocol030.sql; retained engine objects after migration 042.
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

-- From 037_execution_route_attestations030.sql; retained engine objects after migration 042.
-- Native-only attestations. Writers must derive them from authenticated 04/11
-- receipts and the captured reducer state, never from a model or helper result.
CREATE TABLE engine_flow030_route_source_attestations (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, prepare_id TEXT NOT NULL,
 preparation_effect_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 capture_sha256 TEXT NOT NULL, native_receipt_id TEXT NOT NULL,
 receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('agentWork','call','human','join','error')),
 work_event_id TEXT, producer_json TEXT NOT NULL CHECK(json_valid(producer_json)),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 PRIMARY KEY(system_id,invocation_id,prepare_id),
 UNIQUE(system_id,invocation_id,native_receipt_id),
 FOREIGN KEY(system_id,invocation_id,preparation_effect_id)
 REFERENCES engine_flow030_outbox(system_id,invocation_id,effect_id),
 FOREIGN KEY(system_id,invocation_id,work_event_id)
 REFERENCES engine_flow030_work_events(system_id,invocation_id,event_id),
 CHECK(receipt_kind <> 'agentWork' OR work_event_id IS NOT NULL)
);
CREATE TABLE engine_flow030_route_content_contexts (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, prepare_id TEXT NOT NULL,
 target_ordinal INTEGER NOT NULL CHECK(target_ordinal>=0),
 item_index TEXT NOT NULL CHECK(item_index='0' OR (item_index NOT GLOB '*[^0-9]*' AND substr(item_index,1,1) BETWEEN '1' AND '9')),
 context_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 capture_sha256 TEXT NOT NULL, target_address_json TEXT NOT NULL CHECK(json_valid(target_address_json)),
 recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('agent','approval','compose')),
 recipient_agent TEXT, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 policy_evidence_json TEXT NOT NULL CHECK(json_valid(policy_evidence_json)),
 status TEXT NOT NULL CHECK(status IN ('live','revoked')),
 PRIMARY KEY(system_id,invocation_id,prepare_id,target_ordinal,item_index),
 UNIQUE(system_id,invocation_id,context_id),
 FOREIGN KEY(system_id,invocation_id,prepare_id)
 REFERENCES engine_flow030_route_source_attestations(system_id,invocation_id,prepare_id)
);
CREATE TABLE engine_flow030_route_content_receipts (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, context_id TEXT NOT NULL,
 receipt_sha256 TEXT NOT NULL, source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 native_receipt_json TEXT NOT NULL CHECK(json_valid(native_receipt_json)),
 transport_receipt_json TEXT NOT NULL CHECK(json_valid(transport_receipt_json)),
 PRIMARY KEY(system_id,invocation_id,context_id,receipt_sha256),
 FOREIGN KEY(system_id,invocation_id,context_id)
 REFERENCES engine_flow030_route_content_contexts(system_id,invocation_id,context_id)
);
CREATE TRIGGER engine_flow030_route_source_immutable BEFORE UPDATE ON engine_flow030_route_source_attestations BEGIN SELECT RAISE(ABORT,'immutable native route source'); END;
CREATE TRIGGER engine_flow030_route_source_retained BEFORE DELETE ON engine_flow030_route_source_attestations BEGIN SELECT RAISE(ABORT,'retained native route source'); END;
CREATE TRIGGER engine_flow030_route_context_immutable BEFORE UPDATE OF system_id,invocation_id,prepare_id,target_ordinal,item_index,context_id,owner_epoch,generation,capture_sha256,target_address_json,recipient_kind,recipient_agent,identity_json,policy_evidence_json ON engine_flow030_route_content_contexts BEGIN SELECT RAISE(ABORT,'immutable native content context'); END;
CREATE TRIGGER engine_flow030_route_context_revoked BEFORE UPDATE OF status ON engine_flow030_route_content_contexts WHEN OLD.status='revoked' AND NEW.status<>'revoked' BEGIN SELECT RAISE(ABORT,'revoked native content context'); END;
CREATE TRIGGER engine_flow030_route_context_retained BEFORE DELETE ON engine_flow030_route_content_contexts BEGIN SELECT RAISE(ABORT,'retained native content context'); END;
CREATE TRIGGER engine_flow030_route_content_immutable BEFORE UPDATE ON engine_flow030_route_content_receipts BEGIN SELECT RAISE(ABORT,'immutable native content receipt'); END;
CREATE TRIGGER engine_flow030_route_content_retained BEFORE DELETE ON engine_flow030_route_content_receipts BEGIN SELECT RAISE(ABORT,'retained native content receipt'); END;

-- From 038_execution_system_stop030.sql; retained engine objects after migration 042.
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

-- From 039_execution_call_protocol030.sql; retained engine objects after migration 042.
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

-- From 040_execution_flow_human_clock030.sql; retained engine objects after migration 042.
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

-- From 041_execution_flow_interrupted030.sql; retained engine objects after migration 042.
CREATE TABLE engine_flow030_interruptions (
    system_id TEXT PRIMARY KEY NOT NULL,
    interrupted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(system_id) REFERENCES engine_flow030_owners(system_id)
);
