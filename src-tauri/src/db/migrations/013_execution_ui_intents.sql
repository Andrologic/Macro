CREATE TABLE engine_ui_intents (
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
    admission_system_id TEXT REFERENCES engine_systems(system_id),
    CHECK((kind = 'start' AND request_id IS NOT NULL) OR (kind = 'deliver' AND request_id IS NULL AND delivery_id IS NOT NULL)),
    CHECK((status = 'submissionPending' OR retryable_code IS NULL) AND (status = 'refused') = (refusal_code IS NOT NULL)),
    CHECK((status = 'closed') = (disposition IS NOT NULL)),
    CHECK((status = 'admitted' OR (status = 'closed' AND disposition = 'acknowledged')) = (admission_system_id IS NOT NULL)),
    CHECK(length(CAST(intent_id || project_id || plan_id || branch || conversation_id || coalesce(request_id,'') || coalesce(delivery_id,'') || revision || coalesce(admission_system_id,'') AS BLOB)) <= 16384)
);
CREATE UNIQUE INDEX engine_ui_intents_open_scope ON engine_ui_intents(project_id,plan_id,branch,conversation_id) WHERE status <> 'closed';
CREATE UNIQUE INDEX engine_ui_intents_request ON engine_ui_intents(request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX engine_ui_intents_delivery ON engine_ui_intents(delivery_id) WHERE delivery_id IS NOT NULL;
CREATE TRIGGER engine_ui_intent_identity_immutable BEFORE UPDATE OF intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,delivery_id,payload_json ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,'immutable execution intent'); END;
CREATE TRIGGER engine_ui_intent_closed_immutable BEFORE UPDATE ON engine_ui_intents WHEN OLD.status = 'closed'
BEGIN SELECT RAISE(ABORT,'immutable execution intent tombstone'); END;
CREATE TRIGGER engine_ui_intent_retained BEFORE DELETE ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,'retained execution intent'); END;
