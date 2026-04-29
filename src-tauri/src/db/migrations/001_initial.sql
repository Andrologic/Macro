-- Canonical baseline for a fresh Macro database.
-- Legacy compatibility upgrades live in Rust and are only used to adopt older databases.

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    scope_mode TEXT NOT NULL DEFAULT 'Chat',
    task_id TEXT,
    group_id TEXT,
    project_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message TEXT,
    message_count INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    token_count INTEGER,
    tool_traces_json TEXT,
    hidden_context TEXT,
    provider_input_items_json TEXT,
    provider_turn_state_json TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Legacy simple key/value settings still supported by db_get_setting/db_set_setting.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_repositories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    default_branch TEXT,
    last_commit TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_worktrees (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    worktree_name TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    head_commit TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    is_active INTEGER DEFAULT 1,
    is_prunable INTEGER DEFAULT 0,
    FOREIGN KEY (repo_id) REFERENCES git_repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    has_stored_api_key INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER DEFAULT 1,
    is_local INTEGER DEFAULT 0,
    auth_status TEXT,
    auth_source TEXT,
    plan_type TEXT,
    account_label TEXT,
    token_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    owned_by TEXT,
    pricing_prompt TEXT,
    pricing_completion TEXT,
    pricing_request TEXT,
    is_enabled INTEGER DEFAULT 1,
    is_manual INTEGER DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES provider_configs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_settings (
    provider_id TEXT PRIMARY KEY,
    filter_free_models INTEGER DEFAULT 0,
    copilot_send_timeout_ms INTEGER,
    FOREIGN KEY (provider_id) REFERENCES provider_configs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_tabs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    task_id TEXT,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    mount_name TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt_context_json TEXT,
    status TEXT NOT NULL,
    snapshot TEXT NOT NULL DEFAULT '',
    last_command TEXT,
    last_exit_code INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_context_states (
    project_id TEXT PRIMARY KEY,
    group_id TEXT,
    focus_project_id TEXT,
    last_plan_id TEXT,
    last_task_id TEXT,
    architect_conversation_id TEXT,
    implement_conversation_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_context_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    selected_group_id TEXT,
    selected_project_id TEXT,
    mode TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS architect_plan_conversation_sync (
    conversation_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    transcript_revision TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_scope_mode
ON conversations(scope_mode, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_project_scope
ON conversations(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_group_scope
ON conversations(group_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_task_scope
ON conversations(task_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at_id
ON messages(conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at_id
ON messages(created_at, id);

CREATE INDEX IF NOT EXISTS idx_architect_plan_conversation_sync_plan
ON architect_plan_conversation_sync(plan_id, target_branch, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_repositories_path
ON git_repositories(path);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_path
ON git_worktrees(path);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_task
ON git_worktrees(repo_id, task_id);

CREATE INDEX IF NOT EXISTS idx_ai_models_provider
ON ai_models(provider_id);

CREATE INDEX IF NOT EXISTS idx_terminal_tabs_updated_at
ON terminal_tabs(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_terminal_tabs_task_project
ON terminal_tabs(task_id, project_id);

CREATE INDEX IF NOT EXISTS idx_project_context_state_updated_at
ON project_context_states(updated_at DESC);
