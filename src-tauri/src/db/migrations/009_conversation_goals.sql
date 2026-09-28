CREATE TABLE conversation_goals (
    goal_id TEXT PRIMARY KEY CHECK (length(trim(goal_id)) > 0),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
    objective TEXT NOT NULL CHECK (length(trim(objective)) > 0),
    success_criteria_json TEXT NOT NULL CHECK (json_valid(success_criteria_json) AND json_type(success_criteria_json) = 'array'),
    status TEXT NOT NULL CHECK (status IN ('active_ready', 'executor_running', 'audit_pending', 'auditing', 'continuation_pending', 'awaiting_user', 'paused', 'achieved', 'error')),
    provider_id TEXT,
    model_id TEXT,
    reasoning_effort TEXT,
    latest_verdict_json TEXT CHECK (latest_verdict_json IS NULL OR json_valid(latest_verdict_json)),
    audit_count INTEGER NOT NULL DEFAULT 0 CHECK (audit_count >= 0),
    continuation_count INTEGER NOT NULL DEFAULT 0 CHECK (continuation_count >= 0),
    executor_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (executor_turn_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_audited_at TEXT,
    last_executor_turn_at TEXT,
    awaiting_user_since_at TEXT,
    last_error TEXT
);
CREATE UNIQUE INDEX idx_conversation_goals_current
ON conversation_goals(conversation_id) WHERE is_current = 1;
CREATE UNIQUE INDEX idx_conversation_goals_identity
ON conversation_goals(conversation_id, goal_id);

CREATE TABLE conversation_goal_audits (
    audit_id TEXT PRIMARY KEY CHECK (length(trim(audit_id)) > 0),
    conversation_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
    executor_turn_id TEXT NOT NULL CHECK (length(trim(executor_turn_id)) > 0),
    current_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready_for_verdict', 'interrupted', 'applied', 'failed')),
    verdict_json TEXT CHECK (verdict_json IS NULL OR json_valid(verdict_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id, goal_id) REFERENCES conversation_goals(conversation_id, goal_id) ON DELETE CASCADE,
    UNIQUE (conversation_id, executor_turn_id),
    UNIQUE (current_run_id)
);
CREATE INDEX idx_conversation_goal_audits_recovery
ON conversation_goal_audits(status, updated_at);

CREATE TABLE conversation_goal_audit_runs (
    audit_id TEXT NOT NULL REFERENCES conversation_goal_audits(audit_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (audit_id, attempt)
);

CREATE TRIGGER conversation_goal_audit_run_status
AFTER UPDATE OF status ON agent_runs
BEGIN
    UPDATE conversation_goal_audits
    SET status = CASE NEW.status
        WHEN 'running' THEN 'running'
        WHEN 'completed' THEN 'ready_for_verdict'
        WHEN 'interrupted' THEN 'interrupted'
        ELSE 'failed'
    END,
    updated_at = NEW.updated_at
    WHERE current_run_id = NEW.id AND status IN ('queued', 'running');
    UPDATE conversation_goals
    SET status = CASE WHEN NEW.status IN ('interrupted', 'cancelled') THEN 'paused' ELSE 'error' END,
        last_error = CASE WHEN NEW.status IN ('failed', 'timed_out')
            THEN COALESCE(NEW.error_message, NEW.timeout_reason) ELSE NULL END,
        updated_at = NEW.updated_at
    WHERE status = 'auditing' AND is_current = 1
      AND NEW.status IN ('failed', 'timed_out', 'interrupted', 'cancelled')
      AND EXISTS (
          SELECT 1 FROM conversation_goal_audits AS audit
          WHERE audit.current_run_id = NEW.id
            AND audit.conversation_id = conversation_goals.conversation_id
            AND audit.goal_id = conversation_goals.goal_id
            AND audit.goal_revision = conversation_goals.revision
      );
END;
