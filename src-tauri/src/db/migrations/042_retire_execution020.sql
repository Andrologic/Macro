-- Retire only the unpublished AgSDL 0.2 execution schema. Run in the existing
-- migration transaction. Native 0.3 captures, events and identities are retained.
-- Pending/admitted 0.2 intents have no supported consumer and are discarded.
DROP TRIGGER engine_start030_reject_020;
DROP TRIGGER engine_start030_entry_reject_020;
CREATE TABLE engine_ui_intents_042 (
    intent_id TEXT PRIMARY KEY NOT NULL,
    format_version TEXT NOT NULL CHECK(format_version = '1'),
    project_id TEXT NOT NULL, plan_id TEXT NOT NULL,
    branch TEXT NOT NULL, conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('start','deliver')),
    request_id TEXT, delivery_id TEXT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 4000000),
    status TEXT NOT NULL CHECK(status IN ('prepared','submissionPending','admitted','refused','closed')),
    revision TEXT NOT NULL CHECK(length(revision) BETWEEN 1 AND 4096 AND revision NOT GLOB '*[^0-9]*' AND substr(revision,1,1) <> '0'),
    retryable_code TEXT CHECK(retryable_code IN ('RUNTIME_UNAVAILABLE','CAPTURE_CHANGED','POLICY_UNAVAILABLE','SCOPE_UNAVAILABLE','EXECUTION_UNAVAILABLE')),
    refusal_code TEXT CHECK(refusal_code IN ('SCOPE_INVALID','SOURCE_CHANGED','TARGET_INVALID','TARGET_CLOSED','INPUT_CONSTRAINT')),
    disposition TEXT CHECK(disposition IN ('acknowledged','discarded')),
    admission_system_id TEXT CHECK(admission_system_id IS NULL),
    admission_system030_id TEXT REFERENCES engine_start030_requests(system_id),
    CHECK((kind = 'start' AND request_id IS NOT NULL) OR (kind = 'deliver' AND request_id IS NULL AND delivery_id IS NOT NULL)),
    CHECK((status = 'submissionPending' OR retryable_code IS NULL) AND (status = 'refused') = (refusal_code IS NOT NULL)),
    CHECK((status = 'closed') = (disposition IS NOT NULL)),
    CHECK((status = 'admitted' OR (status = 'closed' AND disposition = 'acknowledged')) = ((admission_system_id IS NOT NULL) OR (admission_system030_id IS NOT NULL))),
    CHECK(admission_system_id IS NULL OR admission_system030_id IS NULL),
    CHECK(admission_system030_id IS NULL OR kind = 'start'),
    CHECK(length(CAST(coalesce(admission_system030_id, '') AS BLOB)) <= 16384),
    CHECK(length(CAST(intent_id || project_id || plan_id || branch || conversation_id || coalesce(request_id,'') || coalesce(delivery_id,'') || revision || coalesce(admission_system_id,'') AS BLOB)) <= 16384)
);
INSERT INTO engine_ui_intents_042 SELECT * FROM engine_ui_intents
WHERE kind='start' AND json_extract(payload_json, '$.request.profile')='macro-agsdl-030-v1'
  AND admission_system_id IS NULL;
DROP TABLE engine_ui_intents;
ALTER TABLE engine_ui_intents_042 RENAME TO engine_ui_intents;
CREATE TRIGGER engine_ui_intent_closed_immutable BEFORE UPDATE ON engine_ui_intents WHEN OLD.status = 'closed'
BEGIN SELECT RAISE(ABORT,'immutable execution intent tombstone'); END;
CREATE TRIGGER engine_ui_intent_identity_immutable BEFORE UPDATE OF intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,delivery_id,payload_json ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,'immutable execution intent'); END;
CREATE TRIGGER engine_ui_intent_retained BEFORE DELETE ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,'retained execution intent'); END;
CREATE UNIQUE INDEX engine_ui_intents_delivery ON engine_ui_intents(delivery_id) WHERE delivery_id IS NOT NULL;
CREATE UNIQUE INDEX engine_ui_intents_open_scope ON engine_ui_intents(project_id,plan_id,branch,conversation_id) WHERE status <> 'closed';
CREATE UNIQUE INDEX engine_ui_intents_request ON engine_ui_intents(request_id) WHERE request_id IS NOT NULL;
-- The FK establishes existence; the trigger additionally binds the Start
-- request identity. Payload/source authentication remains a native obligation.
CREATE TRIGGER engine_ui_intent_start030_identity_insert BEFORE INSERT ON engine_ui_intents
WHEN NEW.admission_system030_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM engine_start030_requests s
    WHERE s.system_id = NEW.admission_system030_id AND s.request_id = NEW.request_id
)
BEGIN SELECT RAISE(ABORT, 'start030 intent identity mismatch'); END;
CREATE TRIGGER engine_ui_intent_start030_identity_update BEFORE UPDATE OF admission_system030_id, request_id ON engine_ui_intents
WHEN NEW.admission_system030_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM engine_start030_requests s
    WHERE s.system_id = NEW.admission_system030_id AND s.request_id = NEW.request_id
)
BEGIN SELECT RAISE(ABORT, 'start030 intent identity mismatch'); END;

DROP TABLE engine_human_submissions030;
DROP TABLE engine_human_public_works030;
DROP TABLE engine_human_public030;
DROP TABLE engine_human_projection030;
DROP TABLE engine_work_admission030;
DROP TABLE engine_human_link_events030;
DROP TABLE engine_human_works030;
DROP TABLE engine_human_requests030;
DROP TABLE engine_work_checks030;
DROP TABLE engine_work_events030;
DROP TABLE engine_work_protocol030;
DROP TABLE engine_native_operations;
DROP TABLE engine_effect_processes;
DROP TABLE engine_prepared_terminals;
DROP TABLE engine_approvals;
DROP TABLE engine_response_closures;
DROP TABLE engine_responses;
DROP TABLE engine_host_captures;
DROP TABLE engine_events;
DROP TABLE engine_effects;
DROP TABLE engine_deliveries;
DROP TABLE engine_systems;
