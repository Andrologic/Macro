CREATE TABLE tool_invocations (
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL CHECK (length(trim(turn_id)) > 0),
    message_id TEXT NOT NULL CHECK (length(trim(message_id)) > 0),
    call_id TEXT NOT NULL CHECK (length(trim(call_id)) > 0),
    tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) > 0),
    effect_class TEXT NOT NULL CHECK (effect_class IN ('read_only', 'workspace_mutation', 'external_effect')),
    arguments_sha256 TEXT NOT NULL CHECK (length(arguments_sha256) = 64),
    remote_execution_id TEXT CHECK (remote_execution_id IS NULL OR length(trim(remote_execution_id)) BETWEEN 1 AND 512),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'unknown')),
    receipt_id TEXT CHECK (receipt_id IS NULL OR length(trim(receipt_id)) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (status = 'completed' AND receipt_id IS NOT NULL OR status <> 'completed' AND receipt_id IS NULL),
    PRIMARY KEY (conversation_id, turn_id, message_id, call_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_tool_invocations_unresolved
ON tool_invocations(conversation_id, status, created_at, turn_id, message_id, call_id);
