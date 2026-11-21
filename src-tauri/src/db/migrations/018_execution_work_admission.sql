-- Controller options and native admission evidence are immutable per work.
CREATE TABLE engine_work_admission030 (
    system_id TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    PRIMARY KEY (system_id, activation_id),
    FOREIGN KEY (system_id, activation_id)
        REFERENCES engine_work_protocol030(system_id, activation_id) ON DELETE CASCADE
);
