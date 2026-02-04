-- Initial migration for Macro database
-- Migration version: 001

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    task_id TEXT,
    project_id TEXT,
    last_message TEXT,
    message_count INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL, -- ISO 8601 datetime
    is_unread INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL, -- ISO 8601 datetime
    code_diff TEXT, -- JSON string
    choices TEXT, -- JSON string
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_cache (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    created_at TEXT NOT NULL, -- ISO 8601 datetime
    updated_at TEXT NOT NULL, -- ISO 8601 datetime
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS git_repositories (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    default_branch TEXT,
    last_commit TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS git_worktrees (
    id TEXT PRIMARY KEY NOT NULL,
    repo_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    worktree_name TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    head_commit TEXT,
    created_at TEXT,
    updated_at TEXT,
    last_used_at TEXT,
    is_active INTEGER DEFAULT 1,
    is_prunable INTEGER DEFAULT 0,
    FOREIGN KEY (repo_id) REFERENCES git_repositories(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_task_id ON messages(task_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_repositories_path ON git_repositories(path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_path ON git_worktrees(path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_task ON git_worktrees(repo_id, task_id);
