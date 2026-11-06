-- Exact controller decisions are opaque to the native repository.
CREATE TABLE engine_work_protocol030 (
    system_id TEXT NOT NULL REFERENCES engine_systems(system_id) ON DELETE CASCADE,
    activation_id TEXT NOT NULL,
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    contract_json TEXT NOT NULL CHECK (json_valid(contract_json)),
    initial_state_json TEXT NOT NULL CHECK (json_valid(initial_state_json)),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    revision TEXT NOT NULL CHECK (revision = '0' OR (revision GLOB '[1-9]*' AND revision NOT GLOB '*[^0-9]*')),
    PRIMARY KEY (system_id, activation_id)
);
CREATE TABLE engine_work_events030 (
    system_id TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    provider_attempt_id TEXT,
    native_call_id TEXT,
    ticket_json TEXT NOT NULL CHECK (json_valid(ticket_json)),
    decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
    committed_state_json TEXT CHECK (committed_state_json IS NULL OR json_valid(committed_state_json)),
    PRIMARY KEY (system_id, event_id),
    UNIQUE (system_id, provider_attempt_id, native_call_id),
    FOREIGN KEY (system_id, activation_id) REFERENCES engine_work_protocol030(system_id, activation_id) ON DELETE CASCADE,
    CHECK ((provider_attempt_id IS NULL) = (native_call_id IS NULL)),
    CHECK ((decision_json IS NULL) = (committed_state_json IS NULL))
);
CREATE TABLE engine_work_checks030 (
    system_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0, 1)),
    evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    PRIMARY KEY (system_id, check_id),
    UNIQUE (system_id, event_id),
    UNIQUE (system_id, effect_key),
    FOREIGN KEY (system_id, event_id) REFERENCES engine_work_events030(system_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (system_id, effect_key) REFERENCES engine_effects(system_id, effect_key) ON DELETE CASCADE,
    CHECK ((evidence_json IS NULL) = (result_json IS NULL))
);
CREATE TABLE engine_human_requests030 (
    system_id TEXT NOT NULL REFERENCES engine_systems(system_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    revision TEXT NOT NULL CHECK (revision IN ('0', '1')),
    answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    PRIMARY KEY (system_id, request_id),
    CHECK ((revision = '0') = (answer_json IS NULL))
);
CREATE TABLE engine_human_works030 (
    system_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    PRIMARY KEY (system_id, request_id, activation_id),
    FOREIGN KEY (system_id, request_id) REFERENCES engine_human_requests030(system_id, request_id) ON DELETE CASCADE,
    FOREIGN KEY (system_id, activation_id) REFERENCES engine_work_protocol030(system_id, activation_id) ON DELETE CASCADE
);
CREATE INDEX engine_human_works030_work ON engine_human_works030(system_id, activation_id);
