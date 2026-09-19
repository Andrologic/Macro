-- Version 5 compatibility contract. Keep immutable after publication.

-- Validate columns and indexes without reading user rows or rebuilding tables.

SELECT
    id,
    title,
    description,
    scope_mode,
    task_id,
    group_id,
    project_id,
    provider_id,
    model_id,
    reasoning_effort,
    created_at,
    updated_at,
    last_message,
    message_count,
    is_pinned
FROM conversations LIMIT 0;

SELECT
    id,
    conversation_id,
    turn_id,
    role,
    content,
    created_at,
    token_count,
    tool_traces_json,
    hidden_context,
    provider_input_items_json,
    provider_turn_state_json,
    context_refs_json,
    completion_reason
FROM messages LIMIT 0;

SELECT conversation_id, plan_id, target_branch, transcript_revision, message_count, updated_at FROM architect_plan_conversation_sync LIMIT 0;

SELECT
    id,
    conversation_id,
    message_id,
    type,
    scope,
    source,
    title,
    snippet,
    content,
    url,
    favicon,
    path,
    language,
    size_bytes,
    kind,
    reason,
    created_at,
    updated_at
FROM conversation_citations LIMIT 0;

SELECT conversation_id, composer_context_refs_json, created_at, updated_at FROM conversation_toolbox_state LIMIT 0;

SELECT
    conversation_id,
    up_to_message_id,
    summary_text,
    tool_digest_json,
    used_source_passage_ids_json,
    interesting_source_passage_ids_json,
    estimated_tokens_before,
    estimated_tokens_after,
    fingerprint,
    version,
    pruned_tool_context_message_ids_json,
    reserved_tokens,
    footprint_before_json,
    footprint_after_json,
    degraded_reason,
    compaction_kind,
    compaction_pass,
    summary_format_version,
    summary_source,
    policy_version,
    fingerprint_inputs_json,
    source_hashes_json,
    model_context_window_tokens,
    provider_id,
    model_id,
    checkpoint_health,
    last_trigger,
    created_at,
    updated_at
FROM conversation_compactions LIMIT 0;

SELECT
    id,
    conversation_id,
    trigger,
    provider_id,
    model_id,
    model_context_window_tokens,
    tokens_before,
    tokens_after,
    status,
    error_code,
    reason,
    metadata_json,
    created_at
FROM conversation_compaction_events LIMIT 0;

SELECT key, value FROM settings LIMIT 0;

SELECT id, project_id, path, default_branch, last_commit, created_at, updated_at FROM git_repositories LIMIT 0;

SELECT
    id,
    repo_id,
    project_id,
    task_id,
    worktree_name,
    path,
    branch,
    head_commit,
    created_at,
    updated_at,
    last_used_at,
    is_active,
    is_prunable
FROM git_worktrees LIMIT 0;

SELECT
    id,
    name,
    provider_type,
    base_url,
    api_key,
    has_stored_api_key,
    is_enabled,
    is_local,
    auth_status,
    auth_source,
    plan_type,
    account_label,
    token_expires_at,
    created_at,
    updated_at
FROM provider_configs LIMIT 0;

SELECT
    id,
    provider_id,
    model_id,
    name,
    description,
    owned_by,
    pricing_prompt,
    pricing_completion,
    pricing_request,
    reasoning_efforts_json,
    default_reasoning_effort,
    context_window_tokens,
    input_limit_tokens,
    output_limit_tokens,
    context_window_source,
    context_limits_updated_at,
    is_enabled,
    is_manual,
    first_seen_at,
    last_seen_at
FROM ai_models LIMIT 0;

SELECT provider_id, filter_free_models, copilot_send_timeout_ms FROM provider_settings LIMIT 0;

SELECT id, name, provider_type, base_url, model, has_stored_api_key, is_enabled, is_local, created_at, updated_at FROM speech_provider_configs LIMIT 0;

SELECT key, value_json, updated_at FROM app_settings LIMIT 0;

SELECT
    id,
    kind,
    task_id,
    project_id,
    project_name,
    mount_name,
    workspace_path,
    cwd,
    title,
    prompt_context_json,
    status,
    snapshot,
    last_command,
    last_exit_code,
    generation,
    created_at,
    updated_at
FROM terminal_tabs LIMIT 0;

SELECT
    project_id,
    group_id,
    focus_project_id,
    last_plan_id,
    last_task_id,
    architect_conversation_id,
    implement_conversation_id,
    updated_at
FROM project_context_states LIMIT 0;

SELECT id, selected_group_id, selected_project_id, mode, updated_at FROM session_context_state LIMIT 0;

SELECT
    id,
    parent_conversation_id,
    child_conversation_id,
    agent_profile,
    depth,
    status,
    prompt,
    result_text,
    result_json,
    error_code,
    error_message,
    error_details_json,
    cancellation_reason,
    interruption_reason,
    timeout_reason,
    model_metadata_json,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    reasoning_tokens,
    total_tokens,
    usage_json,
    attempt_count,
    created_at,
    updated_at,
    started_at,
    finished_at,
    last_interrupted_at
FROM agent_runs LIMIT 0;

SELECT rowid, content FROM message_search LIMIT 0;

SELECT 1 FROM conversations INDEXED BY idx_conversations_scope_mode LIMIT 0;

SELECT 1 FROM conversations INDEXED BY idx_conversations_project_scope LIMIT 0;

SELECT 1 FROM conversations INDEXED BY idx_conversations_group_scope LIMIT 0;

SELECT 1 FROM conversations INDEXED BY idx_conversations_task_scope LIMIT 0;

SELECT 1 FROM messages INDEXED BY idx_messages_conversation LIMIT 0;

SELECT 1 FROM messages INDEXED BY idx_messages_conversation_turn LIMIT 0;

SELECT 1 FROM messages INDEXED BY idx_messages_conversation_created_at_id LIMIT 0;

SELECT 1 FROM messages INDEXED BY idx_messages_created_at_id LIMIT 0;

SELECT 1 FROM architect_plan_conversation_sync INDEXED BY idx_architect_plan_conversation_sync_plan LIMIT 0;

SELECT 1 FROM conversation_citations INDEXED BY idx_conversation_citations_conversation LIMIT 0;

SELECT 1 FROM conversation_citations INDEXED BY idx_conversation_citations_message LIMIT 0;

SELECT 1 FROM conversation_toolbox_state INDEXED BY idx_conversation_toolbox_state_updated_at LIMIT 0;

SELECT 1 FROM conversation_compactions INDEXED BY idx_conversation_compactions_updated_at LIMIT 0;

SELECT 1 FROM conversation_compaction_events INDEXED BY idx_conversation_compaction_events_conversation LIMIT 0;

SELECT 1 FROM git_repositories INDEXED BY idx_git_repositories_path LIMIT 0;

SELECT 1 FROM git_worktrees INDEXED BY idx_git_worktrees_path LIMIT 0;

SELECT 1 FROM git_worktrees INDEXED BY idx_git_worktrees_task LIMIT 0;

SELECT 1 FROM ai_models INDEXED BY idx_ai_models_provider LIMIT 0;

SELECT 1 FROM terminal_tabs INDEXED BY idx_terminal_tabs_updated_at LIMIT 0;

SELECT 1 FROM terminal_tabs INDEXED BY idx_terminal_tabs_task_project LIMIT 0;

SELECT 1 FROM project_context_states INDEXED BY idx_project_context_state_updated_at LIMIT 0;

SELECT 1 FROM agent_runs INDEXED BY idx_agent_runs_parent LIMIT 0;

SELECT 1 FROM agent_runs INDEXED BY idx_agent_runs_status LIMIT 0;

SELECT 1 FROM agent_runs INDEXED BY idx_agent_runs_child WHERE child_conversation_id IS NOT NULL LIMIT 0;
