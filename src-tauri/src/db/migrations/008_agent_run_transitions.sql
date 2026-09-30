CREATE TABLE agent_run_transitions (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN ('queued', 'running')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
    transition_json TEXT NOT NULL CHECK (json_valid(transition_json)),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    CHECK (sequence <> 0 OR (previous_state IS NULL AND state = 'queued')),
    CHECK (sequence = 0 OR previous_state IS NOT NULL)
);
