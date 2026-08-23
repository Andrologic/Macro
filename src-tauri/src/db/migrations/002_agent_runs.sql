CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY CHECK (LENGTH(TRIM(id)) > 0),
    parent_conversation_id TEXT NOT NULL CHECK (LENGTH(TRIM(parent_conversation_id)) > 0),
    child_conversation_id TEXT,
    agent_profile TEXT NOT NULL CHECK (LENGTH(TRIM(agent_profile)) > 0),
    depth INTEGER NOT NULL CHECK (depth >= 1),
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'timed_out')
    ),
    prompt TEXT NOT NULL CHECK (LENGTH(TRIM(prompt)) > 0),
    result_text TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_code TEXT,
    error_message TEXT,
    error_details_json TEXT CHECK (error_details_json IS NULL OR json_valid(error_details_json)),
    cancellation_reason TEXT,
    interruption_reason TEXT,
    timeout_reason TEXT,
    model_metadata_json TEXT CHECK (model_metadata_json IS NULL OR json_valid(model_metadata_json)),
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    last_interrupted_at TEXT,
    FOREIGN KEY (parent_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (child_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
    CHECK (child_conversation_id IS NULL OR child_conversation_id <> parent_conversation_id),
    CHECK (result_text IS NULL OR result_json IS NULL),
    CHECK (status = 'completed' OR (result_text IS NULL AND result_json IS NULL)),
    CHECK (
        status = 'failed'
        OR (error_code IS NULL AND error_message IS NULL AND error_details_json IS NULL)
    ),
    CHECK (status = 'cancelled' OR cancellation_reason IS NULL),
    CHECK (status = 'interrupted' OR interruption_reason IS NULL),
    CHECK (status = 'timed_out' OR timeout_reason IS NULL),
    CHECK (
        (status = 'queued' AND attempt_count = 0 AND started_at IS NULL AND finished_at IS NULL
            AND result_text IS NULL AND result_json IS NULL AND error_message IS NULL
            AND cancellation_reason IS NULL AND interruption_reason IS NULL AND timeout_reason IS NULL)
        OR (status = 'running' AND attempt_count >= 1 AND started_at IS NOT NULL AND finished_at IS NULL
            AND result_text IS NULL AND result_json IS NULL AND error_message IS NULL
            AND cancellation_reason IS NULL AND interruption_reason IS NULL AND timeout_reason IS NULL)
        OR (status = 'interrupted' AND attempt_count >= 1 AND started_at IS NOT NULL
            AND finished_at IS NULL AND last_interrupted_at IS NOT NULL
            AND result_text IS NULL AND result_json IS NULL AND error_message IS NULL
            AND cancellation_reason IS NULL AND interruption_reason IS NOT NULL AND timeout_reason IS NULL)
        OR (status = 'completed' AND attempt_count >= 1 AND started_at IS NOT NULL
            AND finished_at IS NOT NULL AND error_message IS NULL AND cancellation_reason IS NULL
            AND interruption_reason IS NULL AND timeout_reason IS NULL)
        OR (status = 'failed' AND attempt_count >= 1 AND started_at IS NOT NULL
            AND finished_at IS NOT NULL AND result_text IS NULL AND result_json IS NULL
            AND error_message IS NOT NULL AND cancellation_reason IS NULL
            AND interruption_reason IS NULL AND timeout_reason IS NULL)
        OR (status = 'cancelled' AND finished_at IS NOT NULL
            AND result_text IS NULL AND result_json IS NULL AND error_message IS NULL
            AND interruption_reason IS NULL AND timeout_reason IS NULL)
        OR (status = 'timed_out' AND attempt_count >= 1 AND started_at IS NOT NULL
            AND finished_at IS NOT NULL AND result_text IS NULL AND result_json IS NULL
            AND error_message IS NULL AND cancellation_reason IS NULL
            AND interruption_reason IS NULL AND timeout_reason IS NOT NULL)
    )
);

CREATE INDEX idx_agent_runs_parent
ON agent_runs(parent_conversation_id, created_at ASC, id ASC);

CREATE INDEX idx_agent_runs_status
ON agent_runs(status, updated_at ASC, id ASC);

CREATE UNIQUE INDEX idx_agent_runs_child
ON agent_runs(child_conversation_id)
WHERE child_conversation_id IS NOT NULL;
