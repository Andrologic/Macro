-- Run inside the migration runner's BEGIN IMMEDIATE transaction, with foreign
-- keys enabled. The runner must roll back the entire transaction on any error.
-- Refuse a modified schema instead of silently losing unknown constraints,
-- dependent foreign keys, indexes or triggers during the table rebuild.
CREATE TEMP TABLE _migration032_checks (invalid INTEGER UNIQUE);
INSERT INTO _migration032_checks VALUES (0);
INSERT INTO _migration032_checks SELECT CASE WHEN ignore_check_constraints = 0 THEN NULL ELSE 0 END FROM pragma_ignore_check_constraints;
CREATE TEMP TABLE _migration032_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration032_guard SELECT foreign_keys FROM pragma_foreign_keys;
INSERT INTO _migration032_guard SELECT 1 - ignore_check_constraints FROM pragma_ignore_check_constraints;
INSERT INTO _migration032_guard SELECT CASE WHEN COUNT(*) = 1 AND min(integrity_check) = 'ok' THEN 1 ELSE 0 END FROM pragma_integrity_check;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS(
    SELECT 1 FROM sqlite_schema s, pragma_foreign_key_list(s.name) f
    WHERE s.type = 'table' AND s.name NOT LIKE 'sqlite_%' AND f."table" = 'engine_ui_intents' COLLATE NOCASE
) THEN 0 ELSE 1 END;
INSERT INTO _migration032_guard SELECT CASE WHEN count(*) = 7 THEN 1 ELSE 0 END FROM sqlite_schema WHERE tbl_name='engine_ui_intents' AND sql IS NOT NULL;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='engine_ui_intent_closed_immutable' AND tbl_name='engine_ui_intents' AND sql='CREATE TRIGGER engine_ui_intent_closed_immutable BEFORE UPDATE ON engine_ui_intents WHEN OLD.status = ''closed''
BEGIN SELECT RAISE(ABORT,''immutable execution intent tombstone''); END') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='engine_ui_intent_identity_immutable' AND tbl_name='engine_ui_intents' AND sql='CREATE TRIGGER engine_ui_intent_identity_immutable BEFORE UPDATE OF intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,delivery_id,payload_json ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,''immutable execution intent''); END') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='engine_ui_intent_retained' AND tbl_name='engine_ui_intents' AND sql='CREATE TRIGGER engine_ui_intent_retained BEFORE DELETE ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,''retained execution intent''); END') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_ui_intents' AND tbl_name='engine_ui_intents' AND sql='CREATE TABLE engine_ui_intents (
    intent_id TEXT PRIMARY KEY NOT NULL,
    format_version TEXT NOT NULL CHECK(format_version = ''1''),
    project_id TEXT NOT NULL, plan_id TEXT NOT NULL,
    branch TEXT NOT NULL, conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (''start'',''deliver'')),
    request_id TEXT, delivery_id TEXT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 4000000),
    status TEXT NOT NULL CHECK(status IN (''prepared'',''submissionPending'',''admitted'',''refused'',''closed'')),
    revision TEXT NOT NULL CHECK(length(revision) BETWEEN 1 AND 4096 AND revision NOT GLOB ''*[^0-9]*'' AND substr(revision,1,1) <> ''0''),
    retryable_code TEXT CHECK(retryable_code IN (''RUNTIME_UNAVAILABLE'',''CAPTURE_CHANGED'',''POLICY_UNAVAILABLE'',''SCOPE_UNAVAILABLE'',''EXECUTION_UNAVAILABLE'')),
    refusal_code TEXT CHECK(refusal_code IN (''SCOPE_INVALID'',''SOURCE_CHANGED'',''TARGET_INVALID'',''TARGET_CLOSED'',''INPUT_CONSTRAINT'')),
    disposition TEXT CHECK(disposition IN (''acknowledged'',''discarded'')),
    admission_system_id TEXT REFERENCES engine_systems(system_id),
    CHECK((kind = ''start'' AND request_id IS NOT NULL) OR (kind = ''deliver'' AND request_id IS NULL AND delivery_id IS NOT NULL)),
    CHECK((status = ''submissionPending'' OR retryable_code IS NULL) AND (status = ''refused'') = (refusal_code IS NOT NULL)),
    CHECK((status = ''closed'') = (disposition IS NOT NULL)),
    CHECK((status = ''admitted'' OR (status = ''closed'' AND disposition = ''acknowledged'')) = (admission_system_id IS NOT NULL)),
    CHECK(length(CAST(intent_id || project_id || plan_id || branch || conversation_id || coalesce(request_id,'''') || coalesce(delivery_id,'''') || revision || coalesce(admission_system_id,'''') AS BLOB)) <= 16384)
)') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='index' AND name='engine_ui_intents_delivery' AND tbl_name='engine_ui_intents' AND sql='CREATE UNIQUE INDEX engine_ui_intents_delivery ON engine_ui_intents(delivery_id) WHERE delivery_id IS NOT NULL') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='index' AND name='engine_ui_intents_open_scope' AND tbl_name='engine_ui_intents' AND sql='CREATE UNIQUE INDEX engine_ui_intents_open_scope ON engine_ui_intents(project_id,plan_id,branch,conversation_id) WHERE status <> ''closed''') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='index' AND name='engine_ui_intents_request' AND tbl_name='engine_ui_intents' AND sql='CREATE UNIQUE INDEX engine_ui_intents_request ON engine_ui_intents(request_id) WHERE request_id IS NOT NULL') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_start030_requests' AND sql='CREATE TABLE engine_start030_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    system_id TEXT NOT NULL UNIQUE, invocation_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL, capture_epoch TEXT NOT NULL,
    capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    UNIQUE(system_id, invocation_id),
    FOREIGN KEY(system_id, invocation_id, snapshot_id, capture_epoch)
        REFERENCES engine_flow030_runs(system_id, invocation_id, snapshot_id, epoch)
)') THEN 1 ELSE 0 END;
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='engine_start030_immutable' AND tbl_name='engine_start030_requests' AND sql='CREATE TRIGGER engine_start030_immutable BEFORE UPDATE ON engine_start030_requests
BEGIN SELECT RAISE(ABORT, ''immutable start capture''); END') THEN 1 ELSE 0 END;
CREATE TABLE engine_ui_intents_032 (
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
INSERT INTO engine_ui_intents_032 (intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,delivery_id,payload_json,status,revision,retryable_code,refusal_code,disposition,admission_system_id) SELECT intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,delivery_id,payload_json,status,revision,retryable_code,refusal_code,disposition,admission_system_id FROM engine_ui_intents;
DROP TABLE engine_ui_intents;
ALTER TABLE engine_ui_intents_032 RENAME TO engine_ui_intents;
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
INSERT INTO _migration032_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DROP TABLE _migration032_guard;
DROP TABLE _migration032_checks;
