/**
 * Tauri IPC Bridge
 * Type-safe wrapper around Tauri's invoke function
 */

import { invoke } from "@tauri-apps/api/core";
import type { TaskCatalogDto } from "./contracts/dtos";
import type {
  PredictedGitTree,
  GitCommit,
  Plan,
  ProjectAccessChangePreview,
  ProjectGroup,
  PlanNode,
  PredictedBranch,
  Project,
  ProjectGitFlowDetection,
  ProjectGitFlowSettings,
  ProjectGitSetupAction,
  ProjectGitSetupCommitResult,
  AppMode,
  ProjectMount,
  ProviderTurnState,
  ToolTrace,
} from "../types";
import { parseToolTracesJson as parseSerializedToolTracesJson } from "./toolTraceState";

// ============ Types ============

export interface DbConversation {
  id: string;
  title: string;
  description: string | null;
  scope_mode: AppMode;
  task_id: string | null;
  group_id: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  message_count: number;
  is_pinned: boolean;
}

export interface DbMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  token_count: number | null;
  tool_traces_json: string | null;
  hidden_context: string | null;
  provider_input_items_json: string | null;
  provider_turn_state_json: string | null;
}

export interface DbConversationCompactionState {
  conversation_id: string;
  up_to_message_id: string;
  summary_text: string;
  tool_digest_json: string;
  used_source_passage_ids_json: string;
  interesting_source_passage_ids_json: string;
  estimated_tokens_before: number;
  estimated_tokens_after: number;
  fingerprint: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DbImportMessageInput {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface DbChatSnapshot {
  conversations: DbConversation[];
  messages: DbMessage[];
}

export interface DbProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string | null;
  has_stored_api_key: boolean;
  is_enabled: boolean;
  is_local: boolean;
  auth_status: string | null;
  auth_source: string | null;
  plan_type: string | null;
  account_label: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
  old_path?: string | null;
}

export interface GitStatusDto {
  branch: string;
  head_commit: GitCommit | null;
  staged_files: GitFileStatus[];
  unstaged_files: GitFileStatus[];
  untracked_files: GitFileStatus[];
  conflicted_files?: string[];
  merge_in_progress?: boolean;
  conflictedFiles: string[];
  mergeInProgress: boolean;
  is_clean: boolean;
  has_origin: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
}

export interface GitBranchDto {
  name: string;
  is_head: boolean;
  commit: string;
}

export interface GitBranchesDto {
  local: GitBranchDto[];
  remote: GitBranchDto[];
  current: string | null;
}

export type GitWorktreeInspectionStatus =
  | "absent"
  | "ready"
  | "stale_registration"
  | "orphan_path"
  | "invalid_repo";

export type GitWorktreeEnsureStatus = "created" | "reused" | "repaired";

export interface GitWorktreeInspectionDto {
  taskId: string;
  worktreePath: string;
  branchName: string | null;
  status: GitWorktreeInspectionStatus;
  isDirty: boolean | null;
}

export interface GitWorktreeEnsureDto {
  taskId: string;
  worktreePath: string;
  branchName: string;
  status: GitWorktreeEnsureStatus;
}

export interface GitWorktreeRemoveDto {
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}

export interface GitSyncDto {
  branch: string;
  remote: string;
  output: string;
}

export interface GitMergeCheckDto {
  mergeable: boolean;
  conflictFiles: string[];
  hasChanges: boolean;
  ahead?: number;
  behind?: number;
}

export interface GitFilePairDto {
  headExists: boolean;
  headContent: string;
  indexExists: boolean;
  indexContent: string;
  worktreeExists: boolean;
  worktreeContent: string;
  originalContent: string;
  modifiedContent: string;
}

export type MacroSyncState = "clean" | "pending" | "failed" | "conflict";
export type MacroSyncReason =
  | "clean"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged"
  | "merge_conflict"
  | "missing_origin"
  | "missing_upstream"
  | "auth_required"
  | "network_error"
  | "unknown_error";
export type MacroSyncNextAction =
  | "commit"
  | "push"
  | "pull"
  | "resolve_conflict"
  | "configure_remote"
  | "configure_auth"
  | "retry";

export interface MacroBranchSyncDto {
  branch: string;
  state: MacroSyncState;
  worktree_path: string;
  is_dirty: boolean;
  has_origin: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
  conflicted_files: string[];
  committed: boolean;
  commit_hash: string | null;
  reason: MacroSyncReason | null;
  next_action: MacroSyncNextAction | null;
  output: string | null;
  error: string | null;
}

export interface DbAiModel {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  description: string | null;
  owned_by: string | null;
  pricing_prompt: string | null;
  pricing_completion: string | null;
  pricing_request: string | null;
  reasoning_efforts: string[] | null;
  default_reasoning_effort: string | null;
  context_window_tokens: number | null;
  is_enabled: boolean;
  is_manual: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DbProviderSettings {
  provider_id: string;
  filter_free_models: boolean;
}

export interface DevProviderOverrideConfig {
  name?: string;
  providerType?: string;
  apiKey?: string;
  baseUrl?: string;
  isLocal?: boolean;
}

export interface DevProviderOverridesFile {
  providers?: Record<string, DevProviderOverrideConfig>;
}

export interface DbAppSetting {
  key: string;
  value_json: string;
  updated_at: string;
}

export type ExternalOpenAction = "editor" | "terminal" | "files";
export type ExternalAppKind = "none" | "builtin" | "detected";

export interface ExternalAppOptionDto {
  id: string;
  label: string;
  action: ExternalOpenAction;
  kind: ExternalAppKind;
}

export interface ExternalAppCatalogDto {
  editor: ExternalAppOptionDto[];
  terminal: ExternalAppOptionDto[];
  files: ExternalAppOptionDto[];
}

export interface DbProjectContextState {
  project_id: string;
  group_id: string | null;
  focus_project_id: string | null;
  last_plan_id: string | null;
  last_task_id: string | null;
  architect_conversation_id: string | null;
  implement_conversation_id: string | null;
  updated_at: string;
}

export interface DbSessionContextState {
  selected_group_id: string | null;
  selected_project_id: string | null;
  mode: string | null;
  updated_at: string;
}

export interface DbProjectRegistryRepairReport {
  conversations_updated: number;
  project_contexts_deleted: number;
  project_contexts_updated: number;
  session_context_updated: boolean;
}

export interface ProjectRegistryRepairReportDto {
  duplicate_paths_removed: number;
  empty_groups_removed: number;
  removed_synthetic_groups: number;
  removed_synthetic_projects: number;
  mount_names_assigned: number;
  removed_group_ids: string[];
  removed_project_ids: string[];
  current_plan_project_ids_removed: number;
  current_plan_tasks_removed: number;
  current_plan_task_targets_removed: number;
  plan_nodes_removed: number;
  predicted_branches_removed: number;
  git_flow_settings_auto_updated: number;
}

export interface ProjectRegistryDiagnosticsDto {
  rawProjectGroups: ProjectGroup[];
  sanitizedProjectGroups: ProjectGroup[];
  rawGroupCount: number;
  rawProjectCount: number;
  sanitizedGroupCount: number;
  sanitizedProjectCount: number;
  repairReport: ProjectRegistryRepairReportDto;
}

export interface WorkspaceMetadataRecoveryHintDto {
  projectId: string;
  groupId: string | null;
  name: string;
  path: string;
}

export interface WorkspaceMetadataRecoveryReportDto {
  status:
    | "none"
    | "restored_from_history"
    | "reconstructed_from_hints"
    | "blocked_dirty"
    | "blocked_conflict";
  restoredCommit?: string | null;
  pullAttempted: boolean;
  pullSucceeded: boolean;
  message?: string | null;
}

export interface DbProviderModelInput {
  model_id: string;
  name: string;
  description?: string | null;
  owned_by?: string | null;
  pricing_prompt?: string | null;
  pricing_completion?: string | null;
  pricing_request?: string | null;
  reasoning_efforts?: string[] | null;
  default_reasoning_effort?: string | null;
  context_window_tokens?: number | null;
}

export interface DbUpsertConversationCompactionStateInput {
  conversation_id: string;
  up_to_message_id: string;
  summary_text: string;
  tool_digest_json: string;
  used_source_passage_ids_json: string;
  interesting_source_passage_ids_json: string;
  estimated_tokens_before: number;
  estimated_tokens_after: number;
  fingerprint: string;
  version: number;
}

export interface AiChatMessageImageUrl {
  url: string;
}

export interface AiChatMessagePart {
  type: string;
  text?: string;
  image_url?: AiChatMessageImageUrl;
}

export type AiChatMessageContent = string | AiChatMessagePart[];

export interface AiChatMessage {
  role: string;
  content: AiChatMessageContent;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
}

export interface AiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AiStreamChunkEvent {
  request_id: string;
  delta: string;
}

export interface AiStreamToolTraceEvent {
  request_id: string;
  tool_trace: ToolTrace;
}

export interface AiToolRequestEvent {
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
}

export interface AiStreamDoneEvent {
  request_id: string;
  output_text: string;
  tool_calls: AiToolCall[];
  response_id?: string | null;
  output_items?: unknown[] | null;
  provider_input_items?: unknown[] | null;
  provider_turn_state?: ProviderTurnState | null;
  reasoning_summary?: string | null;
  tool_traces?: ToolTrace[] | null;
  hidden_context?: string | null;
}

export const parseProviderInputItemsJson = (
  raw: string | null,
): unknown[] | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const parseProviderTurnStateJson = (
  raw: string | null,
): ProviderTurnState | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as ProviderTurnState | null;
    if (!parsed || parsed.provider !== "chatgpt" || !Array.isArray(parsed.output_items)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

export const parseToolTracesJson = (raw: string | null): ToolTrace[] | undefined => {
  return parseSerializedToolTracesJson(raw);
};

export interface AiStreamErrorEvent {
  request_id: string;
  message: string;
}

export interface AiAuthStartedEvent {
  request_id: string;
  provider_id: string;
}

export interface AiAuthSuccessEvent {
  request_id: string;
  provider_id: string;
}

export interface AiAuthCancelledEvent {
  request_id: string;
  provider_id: string;
}

export interface AiAuthErrorEvent {
  request_id: string;
  provider_id: string;
  code: string;
  message: string;
}

export interface CopilotStatusDto {
  ok: boolean;
  runtime_source: "managed" | "system" | "none";
  runtime_status:
    | "ready"
    | "missing"
    | "downloading"
    | "update_required"
    | "error";
  runtime_version: string | null;
  min_cli_version: string;
  auth_status: string;
  auth_source: string | null;
  account_label: string | null;
  status_message: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface CopilotDownloadProgressEvent {
  request_id: string;
  provider_id: string;
  phase: string;
  message: string;
  downloaded_bytes: number;
  total_bytes: number | null;
}

export interface CopilotDownloadCompleteEvent {
  request_id: string;
  provider_id: string;
  runtime_version: string;
  runtime_source: "managed" | "system" | "none";
}

export interface CopilotDownloadErrorEvent {
  request_id: string;
  provider_id: string;
  code: string;
  message: string;
}

export interface CopilotAuthProgressEvent {
  request_id: string;
  provider_id: string;
  phase: string;
  message: string;
  verification_url: string | null;
  user_code: string | null;
}

export interface CopilotAuthCompleteEvent {
  request_id: string;
  provider_id: string;
}

export interface CopilotAuthCancelledEvent {
  request_id: string;
  provider_id: string;
}

export interface CopilotAuthErrorEvent {
  request_id: string;
  provider_id: string;
  code: string;
  message: string;
}

export interface FsFileContentDto {
  content: string;
  language: string;
  is_binary: boolean;
  size: number;
  encoding: string;
}

export interface FsDirEntryDto {
  path: string;
  relative_path: string;
  name: string;
  kind: string;
  size?: number | null;
  modified?: string | null;
  created?: string | null;
  language?: string | null;
  is_hidden: boolean;
  is_readonly: boolean;
}

export interface FsFileStatsDto {
  path: string;
  name: string;
  kind: string;
  size: number;
  created?: string | null;
  modified: string;
  accessed?: string | null;
  permissions: string;
  language?: string | null;
  is_readonly: boolean;
  is_hidden: boolean;
  is_symlink: boolean;
  symlink_target?: string | null;
}

export interface FsWriteResultDto {
  path: string;
  bytes_written: number;
  created: boolean;
  skipped: boolean;
}

export interface WorkspaceBootstrapDto {
  plan: Plan | null;
  projectGroups: ProjectGroup[];
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
}

export interface WorkspaceMetadataDto {
  workspace_path: string;
  metadata_path: string;
  project_count: number;
}

export interface WorkspaceManualFeatureExecutionTargetDto {
  projectId: string;
  branchName: string;
  targetBranchName?: string | null;
  worktreeKey: string;
  repoPath?: string | null;
}

export interface WorkspaceManualFeatureMergeWorkflowRepositoryDto {
  id: string;
  projectId: string;
  repoPath: string;
  sourceBranchName: string;
  targetBranchName: string;
  state: string;
  hadChangesAtStart?: boolean;
  mergeAppliedAt?: string | null;
  blockingKind?: string | null;
  blockingReason?: string | null;
  conflictFiles?: string[];
}

export interface WorkspaceManualFeatureMergeWorkflowDto {
  kind: string;
  phase: string;
  taskStatus: string;
  startedAt: string;
  updatedAt: string;
  lastLoadedAt?: string | null;
  message?: string | null;
  repositories: WorkspaceManualFeatureMergeWorkflowRepositoryDto[];
}

export interface WorkspaceManualFeatureDto {
  id: string;
  conversationId: string;
  draft: boolean;
  title: string;
  description: string;
  status: string;
  featureSlug: string | null;
  branchName: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  mergedAt: string | null;
  baseBranch: string;
  projectIds: string[];
  contextProjectIds: string[];
  executionTargets: WorkspaceManualFeatureExecutionTargetDto[];
  mergeWorkflow?: WorkspaceManualFeatureMergeWorkflowDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolValidationResultDto {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

export interface ToolModePolicyDto {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
}

export interface TerminalSessionDto {
  id: string;
  project_id: string;
  project_name: string;
  mount_name: string;
  workspace_path: string;
  cwd: string;
  status: string;
  last_command: string | null;
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  updated_at: string;
}

export interface TerminalTabDto {
  id: string;
  kind: string;
  task_id: string | null;
  project_id: string;
  project_name: string;
  mount_name: string;
  workspace_path: string;
  cwd: string;
  title: string;
  status: string;
  snapshot: string;
  last_command: string | null;
  last_exit_code: number | null;
  has_live_session: boolean;
  is_restored: boolean;
  created_at: string;
  updated_at: string;
}

export interface TerminalPromptContextInput {
  projectLabel?: string | null;
  taskLabel?: string | null;
  branchLabel?: string | null;
}

export interface TerminalOutputEvent {
  tab_id: string;
  data: string;
  snapshot: string;
  updated_at: string;
}

export type WorkspaceScope = "default" | "metadata";

const normalizeGitStatus = (
  status: Omit<GitStatusDto, "conflictedFiles" | "mergeInProgress">,
): GitStatusDto => {
  const conflictedFiles = status.conflicted_files ?? [];
  const mergeInProgress = status.merge_in_progress ?? false;

  return {
    ...status,
    conflicted_files: conflictedFiles,
    merge_in_progress: mergeInProgress,
    conflictedFiles,
    mergeInProgress,
  };
};

// ============ Conversations ============

export async function listConversations(): Promise<DbConversation[]> {
  return invoke<DbConversation[]>("db_list_conversations");
}

export async function getChatSnapshot(): Promise<DbChatSnapshot> {
  return invoke<DbChatSnapshot>("db_get_chat_snapshot");
}

export async function getConversation(
  id: string,
): Promise<DbConversation | null> {
  return invoke<DbConversation | null>("db_get_conversation", { id });
}

export async function createConversation(params?: {
  title?: string;
  scopeMode?: AppMode;
  taskId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
}): Promise<DbConversation> {
  return invoke<DbConversation>("db_create_conversation", {
    title: params?.title,
    scopeMode: params?.scopeMode ?? "Chat",
    taskId: params?.taskId ?? null,
    groupId: params?.groupId ?? null,
    projectId: params?.projectId ?? null,
  });
}

export async function renameConversation(
  id: string,
  title: string,
): Promise<void> {
  return invoke("db_rename_conversation", { id, title });
}

export async function updateConversationDetails(params: {
  id: string;
  title?: string;
  description?: string;
}): Promise<void> {
  return invoke("db_update_conversation_details", {
    id: params.id,
    title: params.title ?? null,
    description: params.description ?? null,
  });
}

export async function updateConversationScope(params: {
  id: string;
  scopeMode: AppMode;
  taskId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
}): Promise<void> {
  return invoke("db_update_conversation_scope", {
    id: params.id,
    scopeMode: params.scopeMode,
    taskId: params.taskId ?? null,
    groupId: params.groupId ?? null,
    projectId: params.projectId ?? null,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  return invoke("db_delete_conversation_by_id", { id });
}

export async function deleteConversations(ids: string[]): Promise<void> {
  return invoke("db_delete_conversations_by_ids", { ids });
}

export async function togglePinConversation(id: string): Promise<boolean> {
  return invoke<boolean>("db_toggle_pin_conversation", { id });
}

// ============ Messages ============

export async function listMessages(
  conversationId: string,
): Promise<DbMessage[]> {
  return invoke<DbMessage[]>("db_list_messages", { conversationId });
}

export async function dbGetConversationCompactionState(
  conversationId: string,
): Promise<DbConversationCompactionState | null> {
  return invoke<DbConversationCompactionState | null>("db_get_conversation_compaction_state", {
    conversationId,
  });
}

export async function dbUpsertConversationCompactionState(
  input: DbUpsertConversationCompactionStateInput,
): Promise<DbConversationCompactionState> {
  return invoke<DbConversationCompactionState>("db_upsert_conversation_compaction_state", {
    input,
  });
}

export async function dbDeleteConversationCompactionState(
  conversationId: string,
): Promise<void> {
  return invoke("db_delete_conversation_compaction_state", {
    conversationId,
  });
}

export async function createMessage(
  conversationId: string,
  role: string,
  content: string,
  options?: {
    tokenCount?: number;
    toolTraces?: ToolTrace[];
    hiddenContext?: string;
    providerInputItems?: unknown[];
    providerTurnState?: ProviderTurnState;
  },
): Promise<DbMessage> {
  return invoke<DbMessage>("db_create_message", {
    conversationId,
    role,
    content,
    tokenCount: options?.tokenCount ?? null,
    toolTracesJson: options?.toolTraces
      ? JSON.stringify(options.toolTraces)
      : null,
    hiddenContext: options?.hiddenContext ?? null,
    providerInputItemsJson: options?.providerInputItems
      ? JSON.stringify(options.providerInputItems)
      : null,
    providerTurnStateJson: options?.providerTurnState
      ? JSON.stringify(options.providerTurnState)
      : null,
  });
}

export async function importMessages(
  conversationId: string,
  messages: DbImportMessageInput[],
): Promise<DbMessage[]> {
  return invoke<DbMessage[]>("db_import_messages", {
    conversationId,
    messages,
  });
}

export async function updateMessage(
  id: string,
  content: string,
  options?: {
    tokenCount?: number;
    toolTraces?: ToolTrace[];
    hiddenContext?: string;
    providerInputItems?: unknown[];
    providerTurnState?: ProviderTurnState;
  },
): Promise<void> {
  return invoke("db_update_message", {
    id,
    content,
    tokenCount: options?.tokenCount ?? null,
    toolTracesJson: options?.toolTraces
      ? JSON.stringify(options.toolTraces)
      : null,
    hiddenContext: options?.hiddenContext ?? null,
    providerInputItemsJson: options?.providerInputItems
      ? JSON.stringify(options.providerInputItems)
      : null,
    providerTurnStateJson: options?.providerTurnState
      ? JSON.stringify(options.providerTurnState)
      : null,
  });
}

export async function deleteMessagesAfter(
  conversationId: string,
  afterMessageId: string,
): Promise<void> {
  return invoke("db_delete_messages_after", { conversationId, afterMessageId });
}

// ============ File System ============

export async function fsReadFile(path: string): Promise<FsFileContentDto> {
  return invoke<FsFileContentDto>("fs_read_file", { path });
}

export async function fsReadFileWithOptions(params: {
  path: string;
  allowOutsideWorkspace?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<FsFileContentDto> {
  return invoke<FsFileContentDto>("fs_read_file", {
    path: params.path,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsWriteFile(params: {
  path: string;
  content: string;
  createDirs?: boolean;
  allowOutsideWorkspace?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<FsWriteResultDto> {
  return invoke<FsWriteResultDto>("fs_write_file", {
    path: params.path,
    content: params.content,
    createDirs: params.createDirs ?? null,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsListDir(params: {
  path: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  allowOutsideWorkspace?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<FsDirEntryDto[]> {
  return invoke<FsDirEntryDto[]>("fs_list_dir", {
    path: params.path,
    recursive: params.recursive ?? null,
    includeHidden: params.includeHidden ?? null,
    maxDepth: params.maxDepth ?? null,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsStat(
  path: string,
  options?: {
    workspaceScope?: WorkspaceScope;
    workspacePath?: string | null;
  },
): Promise<FsFileStatsDto> {
  return invoke<FsFileStatsDto>("fs_stat", {
    path,
    workspaceScope: options?.workspaceScope ?? null,
    workspacePath: options?.workspacePath ?? null,
  });
}

export async function fsExists(
  path: string,
  options?: {
    workspaceScope?: WorkspaceScope;
    workspacePath?: string | null;
  },
): Promise<boolean> {
  return invoke<boolean>("fs_exists", {
    path,
    workspaceScope: options?.workspaceScope ?? null,
    workspacePath: options?.workspacePath ?? null,
  });
}

export async function fsDelete(params: {
  path: string;
  recursive?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<void> {
  return invoke("fs_delete", {
    path: params.path,
    recursive: params.recursive ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsCreateDir(params: {
  path: string;
  recursive?: boolean;
  workspaceScope?: WorkspaceScope;
  workspacePath?: string | null;
}): Promise<void> {
  return invoke("fs_create_dir", {
    path: params.path,
    recursive: params.recursive ?? null,
    workspaceScope: params.workspaceScope ?? null,
    workspacePath: params.workspacePath ?? null,
  });
}

export async function fsCopy(params: {
  src: string;
  dest: string;
}): Promise<number> {
  return invoke<number>("fs_copy", {
    src: params.src,
    dest: params.dest,
  });
}

export async function fsMove(params: {
  src: string;
  dest: string;
}): Promise<void> {
  return invoke("fs_move", {
    src: params.src,
    dest: params.dest,
  });
}

// ============ Provider Configs ============

export async function listProviderConfigs(): Promise<DbProviderConfig[]> {
  return invoke<DbProviderConfig[]>("db_list_provider_configs");
}

export async function getProviderConfig(
  id: string,
): Promise<DbProviderConfig | null> {
  return invoke<DbProviderConfig | null>("db_get_provider_config", { id });
}

export async function revealProviderApiKey(id: string): Promise<string | null> {
  return invoke<string | null>("db_reveal_provider_api_key", { id });
}

export async function updateProviderConfig(params: {
  id: string;
  name?: string;
  providerType?: string;
  baseUrl?: string;
  apiKey?: string;
  isLocal?: boolean;
  isEnabled?: boolean;
}): Promise<void> {
  return invoke("db_update_provider_config", {
    id: params.id,
    name: params.name ?? null,
    providerType: params.providerType ?? null,
    baseUrl: params.baseUrl ?? null,
    apiKey: params.apiKey ?? null,
    isLocal: params.isLocal ?? null,
    isEnabled: params.isEnabled ?? null,
  });
}

export async function createProviderConfig(params: {
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
}): Promise<DbProviderConfig> {
  return invoke<DbProviderConfig>("db_create_provider_config", {
    name: params.name,
    providerType: params.providerType,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey ?? null,
    isLocal: params.isLocal,
  });
}

export async function deleteProviderConfig(id: string): Promise<void> {
  return invoke("db_delete_provider_config", { id });
}

export async function aiStartChatGptAuth(params: {
  requestId: string;
  providerId?: string;
}): Promise<void> {
  return invoke("ai_start_chatgpt_auth", {
    requestId: params.requestId,
    providerId: params.providerId ?? null,
  });
}

export async function aiCancelChatGptAuth(requestId: string): Promise<void> {
  return invoke("ai_cancel_chatgpt_auth", { requestId });
}

export async function aiGetCopilotStatus(
  providerId?: string,
): Promise<CopilotStatusDto> {
  return invoke<CopilotStatusDto>("ai_get_copilot_status", {
    providerId: providerId ?? null,
  });
}

export async function aiDownloadCopilotRuntime(params: {
  requestId: string;
  providerId?: string;
}): Promise<void> {
  return invoke("ai_download_copilot_runtime", {
    requestId: params.requestId,
    providerId: params.providerId ?? null,
  });
}

export async function aiCancelCopilotRuntimeDownload(
  requestId: string,
): Promise<void> {
  return invoke("ai_cancel_copilot_runtime_download", { requestId });
}

export async function aiStartCopilotAuth(params: {
  requestId: string;
  providerId?: string;
}): Promise<void> {
  return invoke("ai_start_copilot_auth", {
    requestId: params.requestId,
    providerId: params.providerId ?? null,
  });
}

export async function aiCancelCopilotAuth(requestId: string): Promise<void> {
  return invoke("ai_cancel_copilot_auth", { requestId });
}

export async function aiDisconnectProviderAuth(
  providerId: string,
): Promise<DbProviderConfig> {
  return invoke<DbProviderConfig>("ai_disconnect_provider_auth", {
    providerId,
  });
}

export async function aiSyncProviderModels(
  providerId: string,
): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("ai_sync_provider_models", { providerId });
}

export async function aiGetDevProviderOverrides(): Promise<DevProviderOverridesFile | null> {
  return invoke<DevProviderOverridesFile | null>(
    "ai_get_dev_provider_overrides",
  );
}

export async function aiStreamChat(params: {
  requestId: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: string | null;
  conversationId?: string | null;
  messages: AiChatMessage[];
  tools?: unknown[];
  toolChoice?: string;
  parallelToolCalls?: boolean;
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  allowedToolIds?: string[];
}): Promise<void> {
  return invoke("ai_stream_chat", {
    request: {
      request_id: params.requestId,
      provider_id: params.providerId,
      model_id: params.modelId,
      reasoning_effort: params.reasoningEffort ?? null,
      conversation_id: params.conversationId ?? null,
      messages: params.messages,
      tools: params.tools ?? [],
      tool_choice: params.toolChoice ?? "auto",
      parallel_tool_calls: params.parallelToolCalls ?? false,
      workspace_path: params.workspacePath ?? null,
      default_workspace_path: params.defaultWorkspacePath ?? null,
      project_mounts: (params.projectMounts ?? []).map((mount) => ({
        project_id: mount.projectId,
        mount_name: mount.mountName,
        workspace_path: mount.workspacePath ?? null,
        display_name: mount.displayName,
      })),
      virtual_root_enabled: params.virtualRootEnabled ?? null,
      focused_project_id: params.focusedProjectId ?? null,
      allowed_tool_ids: params.allowedToolIds ?? [],
    },
  });
}

export async function aiCancelStream(requestId: string): Promise<void> {
  return invoke("ai_cancel_stream", { requestId });
}

export async function aiSubmitToolResult(params: {
  requestId: string;
  toolCallId: string;
  result: string;
  hiddenContext?: string | null;
  visibleContent?: string | null;
  interrupt?: boolean;
}): Promise<void> {
  return invoke("ai_submit_tool_result", {
    request: {
      request_id: params.requestId,
      tool_call_id: params.toolCallId,
      result: params.result,
      hidden_context: params.hiddenContext ?? null,
      visible_content: params.visibleContent ?? null,
      interrupt: params.interrupt ?? false,
    },
  });
}

// ============ Git ============

export async function gitStatus(repoPath: string): Promise<GitStatusDto> {
  const status = await invoke<
    Omit<GitStatusDto, "conflictedFiles" | "mergeInProgress">
  >("git_status", { repoPath });
  return normalizeGitStatus(status);
}

export async function gitLog(params: {
  repoPath: string;
  limit?: number;
  branch?: string;
}): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", {
    repoPath: params.repoPath,
    limit: params.limit ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitBranchList(repoPath: string): Promise<GitBranchesDto> {
  return invoke<GitBranchesDto>("git_branch_list", { repoPath });
}

export async function gitBranchCreate(params: {
  repoPath: string;
  branchName: string;
  fromRef: string;
}): Promise<void> {
  return invoke("git_branch_create", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    fromRef: params.fromRef,
  });
}

export async function gitBranchDelete(params: {
  repoPath: string;
  branchName: string;
  force?: boolean;
}): Promise<void> {
  return invoke("git_branch_delete", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    force: params.force ?? null,
  });
}

export async function gitBranchDeleteRemote(params: {
  repoPath: string;
  branchName: string;
  remote?: string;
}): Promise<void> {
  return invoke("git_branch_delete_remote", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    remote: params.remote ?? null,
  });
}

export async function gitCheckout(params: {
  repoPath: string;
  branchOrCommit: string;
  create: boolean;
}): Promise<void> {
  return invoke("git_checkout", {
    repoPath: params.repoPath,
    branchOrCommit: params.branchOrCommit,
    create: params.create,
  });
}

export async function gitMerge(params: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
}): Promise<string> {
  return invoke<string>("git_merge", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    intoBranch: params.intoBranch,
  });
}

export async function gitMergeCheck(params: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
}): Promise<GitMergeCheckDto> {
  return invoke<GitMergeCheckDto>("git_merge_check", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    intoBranch: params.intoBranch,
  });
}

export async function gitCommit(params: {
  repoPath: string;
  message: string;
  stageAll: boolean;
}): Promise<string> {
  return invoke<string>("git_commit", {
    repoPath: params.repoPath,
    message: params.message,
    stageAll: params.stageAll,
  });
}

export async function gitAdd(params: {
  repoPath: string;
  paths: string[];
}): Promise<void> {
  return invoke("git_add", { repoPath: params.repoPath, paths: params.paths });
}

export async function gitRestorePaths(params: {
  repoPath: string;
  paths: string[];
  target?: "worktree" | "staged" | "staged_and_worktree";
}): Promise<void> {
  return invoke("git_restore_paths", {
    repoPath: params.repoPath,
    paths: params.paths,
    target: params.target ?? null,
  });
}

export async function gitReset(params: {
  repoPath: string;
  mode: "soft" | "mixed" | "hard";
  commit?: string;
  confirm?: boolean;
}): Promise<void> {
  return invoke("git_reset", {
    repoPath: params.repoPath,
    mode: params.mode,
    commit: params.commit ?? null,
    confirm: params.confirm ?? null,
  });
}

export async function gitAbortMerge(params: {
  repoPath: string;
  confirm: boolean;
}): Promise<void> {
  return invoke("git_abort_merge", {
    repoPath: params.repoPath,
    confirm: params.confirm,
  });
}

export async function gitStash(params: {
  repoPath: string;
  message?: string;
}): Promise<string> {
  return invoke<string>("git_stash", {
    repoPath: params.repoPath,
    message: params.message ?? null,
  });
}

export async function gitDiff(params: {
  repoPath: string;
  base?: string;
  head?: string;
  contextLines?: number;
  ignoreWhitespace?: boolean;
  paths?: string[];
}): Promise<string> {
  return invoke<string>("git_diff", {
    repoPath: params.repoPath,
    base: params.base ?? null,
    head: params.head ?? null,
    contextLines: params.contextLines ?? null,
    ignoreWhitespace: params.ignoreWhitespace ?? null,
    paths: params.paths ?? null,
  });
}

export async function gitReadFilePair(params: {
  repoPath: string;
  path: string;
}): Promise<GitFilePairDto> {
  return invoke<GitFilePairDto>("git_read_file_pair", {
    repoPath: params.repoPath,
    path: params.path,
  });
}

export async function gitGetTree(params: {
  repoPath: string;
  branch?: string;
}): Promise<PredictedGitTree> {
  return invoke<PredictedGitTree>("git_get_tree", {
    repoPath: params.repoPath,
    branch: params.branch ?? null,
  });
}

export async function gitWorktreeInspect(params: {
  repoPath: string;
  taskId: string;
  branchName?: string | null;
}): Promise<GitWorktreeInspectionDto> {
  return invoke<GitWorktreeInspectionDto>("git_worktree_inspect", {
    repoPath: params.repoPath,
    taskId: params.taskId,
    branchName: params.branchName ?? null,
  });
}

export async function gitWorktreeCreate(params: {
  repoPath: string;
  taskId: string;
  branchName: string;
  fromRef?: string | null;
  preferredCommitBranch?: string | null;
}): Promise<GitWorktreeEnsureDto> {
  return invoke<GitWorktreeEnsureDto>("git_worktree_create", {
    repoPath: params.repoPath,
    taskId: params.taskId,
    branchName: params.branchName,
    fromRef: params.fromRef ?? null,
    preferredCommitBranch: params.preferredCommitBranch ?? null,
  });
}

export async function gitWorktreeRemove(params: {
  repoPath: string;
  taskId: string;
  force?: boolean;
  branchName?: string | null;
}): Promise<GitWorktreeRemoveDto> {
  return invoke<GitWorktreeRemoveDto>("git_worktree_remove", {
    repoPath: params.repoPath,
    taskId: params.taskId,
    force: params.force ?? null,
    branchName: params.branchName ?? null,
  });
}

export async function gitPush(params: {
  repoPath: string;
  remote?: string;
  branch?: string;
}): Promise<GitSyncDto> {
  return invoke<GitSyncDto>("git_push", {
    repoPath: params.repoPath,
    remote: params.remote ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitFetch(params: {
  repoPath: string;
  remote?: string;
  branch?: string;
}): Promise<GitSyncDto> {
  return invoke<GitSyncDto>("git_fetch", {
    repoPath: params.repoPath,
    remote: params.remote ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitPull(params: {
  repoPath: string;
  remote?: string;
  branch?: string;
}): Promise<GitSyncDto> {
  return invoke<GitSyncDto>("git_pull", {
    repoPath: params.repoPath,
    remote: params.remote ?? null,
    branch: params.branch ?? null,
  });
}

export async function macroBranchEnsure(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_ensure", {
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchStatus(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_status", {
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchCommitIfDirty(params?: {
  message?: string;
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_commit_if_dirty", {
    message: params?.message ?? null,
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchPush(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_push", {
    workspacePath: params?.workspacePath ?? null,
  });
}

export async function macroBranchPull(params?: {
  workspacePath?: string | null;
}): Promise<MacroBranchSyncDto> {
  return invoke<MacroBranchSyncDto>("macro_branch_pull", {
    workspacePath: params?.workspacePath ?? null,
  });
}

// ============ Workspace ============

export async function workspaceGetBootstrap(): Promise<WorkspaceBootstrapDto> {
  return invoke<WorkspaceBootstrapDto>("workspace_get_bootstrap");
}

export async function workspaceListProjects(): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_list_projects");
}

export async function workspaceListTasks(): Promise<TaskCatalogDto> {
  return invoke<TaskCatalogDto>("workspace_list_tasks");
}

export async function workspaceGetMetadata(): Promise<WorkspaceMetadataDto> {
  return invoke<WorkspaceMetadataDto>("workspace_get_metadata");
}

export async function workspaceGetActiveRoot(): Promise<string> {
  return invoke<string>("workspace_get_active_root");
}

export async function workspacePreviewProjectGitSetup(params: {
  path?: string;
}): Promise<ProjectGitFlowDetection> {
  return invoke<ProjectGitFlowDetection>(
    "workspace_preview_project_git_setup",
    {
      path: params.path ?? null,
    },
  );
}

export async function workspaceCreateProjectWithGitSetup(params: {
  name: string;
  description: string;
  groupId?: string | null;
  groupName?: string | null;
  path: string;
  gitFlowSettings?: ProjectGitFlowSettings | null;
  gitSetupActions: ProjectGitSetupAction[];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection["setupState"];
  expectedRecommendedActionSequence: ProjectGitSetupAction[];
}): Promise<ProjectGitSetupCommitResult> {
  return invoke<ProjectGitSetupCommitResult>(
    "workspace_create_project_with_git_setup",
    {
      name: params.name,
      description: params.description,
      groupId: params.groupId ?? null,
      groupName: params.groupName ?? null,
      path: params.path,
      gitFlowSettings: params.gitFlowSettings ?? null,
      gitSetupActions: params.gitSetupActions,
      expectedRepoRootPath: params.expectedRepoRootPath ?? null,
      expectedSetupState: params.expectedSetupState,
      expectedRecommendedActionSequence:
        params.expectedRecommendedActionSequence,
    },
  );
}

export async function workspaceUpdateProjectGitFlowWithSetup(params: {
  projectId: string;
  gitFlowSettings: ProjectGitFlowSettings;
  gitSetupActions: ProjectGitSetupAction[];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection["setupState"];
  expectedRecommendedActionSequence: ProjectGitSetupAction[];
}): Promise<ProjectGitSetupCommitResult> {
  return invoke<ProjectGitSetupCommitResult>(
    "workspace_update_project_git_flow_with_setup",
    {
      projectId: params.projectId,
      gitFlowSettings: params.gitFlowSettings,
      gitSetupActions: params.gitSetupActions,
      expectedRepoRootPath: params.expectedRepoRootPath ?? null,
      expectedSetupState: params.expectedSetupState,
      expectedRecommendedActionSequence:
        params.expectedRecommendedActionSequence,
    },
  );
}

export async function workspaceSetActiveRoot(path: string): Promise<string> {
  return invoke<string>("workspace_set_active_root", { path });
}

export async function workspaceCreateProject(params: {
  name: string;
  description: string;
  groupId?: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ProjectGitFlowSettings | null;
}): Promise<Project> {
  return invoke<Project>("workspace_create_project", {
    name: params.name,
    description: params.description,
    groupId: params.groupId ?? null,
    groupName: params.groupName ?? null,
    path: params.path ?? null,
    gitFlowSettings: params.gitFlowSettings ?? null,
  });
}

export async function workspaceImportGitRepo(params: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId?: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ProjectGitFlowSettings | null;
}): Promise<Project> {
  return invoke<Project>("workspace_import_git_repo", {
    gitUrl: params.gitUrl,
    projectName: params.projectName,
    branch: params.branch,
    groupId: params.groupId ?? null,
    groupName: params.groupName ?? null,
    path: params.path ?? null,
    gitFlowSettings: params.gitFlowSettings ?? null,
  });
}

export async function workspaceRenameProjectGroup(params: {
  groupId: string;
  name: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>("workspace_rename_project_group", {
    groupId: params.groupId,
    name: params.name,
  });
}

export async function workspaceRenameProject(params: {
  projectId: string;
  name: string;
}): Promise<Project> {
  return invoke<Project>("workspace_rename_project", {
    projectId: params.projectId,
    name: params.name,
  });
}

export async function workspaceUpdateProjectGitFlow(params: {
  projectId: string;
  gitFlowSettings: ProjectGitFlowSettings;
}): Promise<Project> {
  return invoke<Project>("workspace_update_project_git_flow", {
    projectId: params.projectId,
    gitFlowSettings: params.gitFlowSettings,
  });
}

export async function workspaceUpdateProjectAccess(params: {
  projectId: string;
  userReadOnly: boolean;
  confirmedMigration?: boolean;
}): Promise<Project> {
  return invoke<Project>("workspace_update_project_access", {
    projectId: params.projectId,
    userReadOnly: params.userReadOnly,
    confirmedMigration: params.confirmedMigration ?? false,
  });
}

export async function workspacePreviewProjectAccessChange(params: {
  projectId: string;
  targetReadOnly: boolean;
}): Promise<ProjectAccessChangePreview> {
  return invoke<ProjectAccessChangePreview>(
    "workspace_preview_project_access_change",
    {
      projectId: params.projectId,
      targetReadOnly: params.targetReadOnly,
    },
  );
}

export async function workspaceArchiveProjectGroup(params: {
  groupId: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>("workspace_archive_project_group", {
    groupId: params.groupId,
  });
}

export async function workspaceArchiveProject(params: {
  projectId: string;
}): Promise<Project> {
  return invoke<Project>("workspace_archive_project", {
    projectId: params.projectId,
  });
}

export async function workspaceRemoveProjectGroup(params: {
  groupId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_remove_project_group", {
    groupId: params.groupId,
  });
}

export async function workspaceRemoveProject(params: {
  projectId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_remove_project", {
    projectId: params.projectId,
  });
}

export interface DebugResetProjectReportDto {
  projectId: string;
  projectName: string;
  removedRegistryEntry: boolean;
  removedTaskWorktrees: number;
  removedMetadataWorktree: boolean;
  removedMacroBranch: boolean;
  warnings: string[];
}

export async function workspaceDebugResetProject(params: {
  projectId: string;
  force: boolean;
}): Promise<DebugResetProjectReportDto> {
  return invoke<DebugResetProjectReportDto>("workspace_debug_reset_project", {
    projectId: params.projectId,
    force: params.force,
  });
}

export async function workspaceCloseProject(params: {
  projectId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_close_project", {
    projectId: params.projectId,
  });
}

export async function workspaceGetProjectRegistryDiagnostics(): Promise<ProjectRegistryDiagnosticsDto> {
  return invoke<ProjectRegistryDiagnosticsDto>(
    "workspace_get_project_registry_diagnostics",
  );
}

export async function workspaceRecoverMissingMetadata(params: {
  attemptPull: boolean;
  projects: WorkspaceMetadataRecoveryHintDto[];
}): Promise<WorkspaceMetadataRecoveryReportDto> {
  return invoke<WorkspaceMetadataRecoveryReportDto>(
    "workspace_recover_missing_metadata",
    {
      request: {
        attemptPull: params.attemptPull,
        projects: params.projects,
      },
    },
  );
}

export async function workspaceCreateManualFeatureDraft(params: {
  taskId: string;
  conversationId: string;
  groupId?: string | null;
  projectIds: string[];
  contextProjectIds?: string[];
  baseBranch?: string | null;
  title?: string | null;
  description?: string | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    "workspace_create_manual_feature_draft",
    {
      taskId: params.taskId,
      conversationId: params.conversationId,
      groupId: params.groupId ?? null,
      projectIds: params.projectIds,
      contextProjectIds: params.contextProjectIds ?? [],
      baseBranch: params.baseBranch ?? null,
      title: params.title ?? null,
      description: params.description ?? null,
    },
  );
}

export async function workspaceFinalizeManualFeature(params: {
  taskId: string;
  conversationId?: string | null;
  title: string;
  description: string;
  featureSlug: string;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    "workspace_finalize_manual_feature",
    {
      taskId: params.taskId,
      conversationId: params.conversationId ?? null,
      title: params.title,
      description: params.description,
      featureSlug: params.featureSlug,
    },
  );
}

export async function workspaceRevertManualFeatureToDraft(params: {
  taskId: string;
  conversationId?: string | null;
  title?: string | null;
  description?: string | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    "workspace_revert_manual_feature_to_draft",
    {
      taskId: params.taskId,
      conversationId: params.conversationId ?? null,
      title: params.title ?? null,
      description: params.description ?? null,
    },
  );
}

export async function workspaceDeleteManualFeatureDraft(
  taskId: string,
): Promise<void> {
  return invoke("workspace_delete_manual_feature_draft", { taskId });
}

export async function workspaceRenameManualFeature(params: {
  taskId: string;
  title: string;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>("workspace_rename_manual_feature", {
    taskId: params.taskId,
    title: params.title,
  });
}

export async function workspaceArchiveManualFeature(params: {
  taskId: string;
  reason?: string | null;
  mergedAt?: string | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>("workspace_archive_manual_feature", {
    taskId: params.taskId,
    reason: params.reason ?? null,
    mergedAt: params.mergedAt ?? null,
  });
}

export async function workspaceRestoreManualFeature(
  taskId: string,
): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>("workspace_restore_manual_feature", {
    taskId,
  });
}

export async function workspaceDeleteManualFeature(
  taskId: string,
): Promise<void> {
  return invoke("workspace_delete_manual_feature", { taskId });
}

export async function workspaceUpdateStandaloneTaskStatus(params: {
  taskId: string;
  status: string;
}): Promise<void> {
  return invoke("workspace_update_standalone_task_status", {
    taskId: params.taskId,
    status: params.status,
  });
}

export async function workspaceUpdateManualFeatureMergeWorkflow(params: {
  taskId: string;
  mergeWorkflow?: WorkspaceManualFeatureMergeWorkflowDto | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    'workspace_update_manual_feature_merge_workflow',
    {
      taskId: params.taskId,
      mergeWorkflow: params.mergeWorkflow ?? null,
    }
  );
}

// ============ Provider Models ============

export async function listProviderModels(
  providerId: string,
): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_list_provider_models", { providerId });
}

export async function upsertProviderModels(params: {
  providerId: string;
  models: DbProviderModelInput[];
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_upsert_provider_models", {
    providerId: params.providerId,
    models: params.models,
  });
}

export async function registerManualModel(params: {
  providerId: string;
  modelId: string;
  name: string;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_register_manual_model", {
    providerId: params.providerId,
    modelId: params.modelId,
    name: params.name,
  });
}

export async function updateManualModel(params: {
  providerId: string;
  currentModelId: string;
  nextModelId: string;
  name: string;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_update_manual_model", {
    providerId: params.providerId,
    currentModelId: params.currentModelId,
    nextModelId: params.nextModelId,
    name: params.name,
  });
}

export async function deleteManualModel(params: {
  providerId: string;
  modelId: string;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_delete_manual_model", {
    providerId: params.providerId,
    modelId: params.modelId,
  });
}

export async function setProviderModelEnabled(params: {
  providerId: string;
  modelId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke("db_set_provider_model_enabled", {
    providerId: params.providerId,
    modelId: params.modelId,
    enabled: params.enabled,
  });
}

export async function setAllProviderModelsEnabled(params: {
  providerId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke("db_set_all_provider_models_enabled", {
    providerId: params.providerId,
    enabled: params.enabled,
  });
}

// ============ Provider Settings ============

export async function getProviderSettings(
  providerId: string,
): Promise<DbProviderSettings> {
  return invoke<DbProviderSettings>("db_get_provider_settings", { providerId });
}

export async function updateProviderSettings(params: {
  providerId: string;
  filterFreeModels: boolean;
}): Promise<void> {
  return invoke("db_update_provider_settings", {
    providerId: params.providerId,
    filterFreeModels: params.filterFreeModels,
  });
}

// ============ Local App State ============

export async function dbGetSetting(key: string): Promise<string | null> {
  return invoke<string | null>("db_get_setting", { key });
}

export async function dbSetSetting(params: {
  key: string;
  value: string;
}): Promise<void> {
  return invoke("db_set_setting", {
    key: params.key,
    value: params.value,
  });
}

export async function dbGetAppSetting(
  key: string,
): Promise<DbAppSetting | null> {
  return invoke<DbAppSetting | null>("db_get_app_setting", { key });
}

export async function dbSetAppSetting(params: {
  key: string;
  valueJson: string;
}): Promise<DbAppSetting> {
  return invoke<DbAppSetting>("db_set_app_setting", {
    key: params.key,
    value_json: params.valueJson,
  });
}

export async function dbGetProjectContextState(
  projectId: string,
): Promise<DbProjectContextState | null> {
  return invoke<DbProjectContextState | null>("db_get_project_context_state", {
    project_id: projectId,
  });
}

export async function dbUpsertProjectContextState(params: {
  projectId: string;
  groupId?: string | null;
  focusProjectId?: string | null;
  lastPlanId?: string | null;
  lastTaskId?: string | null;
  architectConversationId?: string | null;
  implementConversationId?: string | null;
}): Promise<DbProjectContextState> {
  return invoke<DbProjectContextState>("db_upsert_project_context_state", {
    input: {
      project_id: params.projectId,
      group_id: params.groupId ?? null,
      focus_project_id: params.focusProjectId ?? null,
      last_plan_id: params.lastPlanId ?? null,
      last_task_id: params.lastTaskId ?? null,
      architect_conversation_id: params.architectConversationId ?? null,
      implement_conversation_id: params.implementConversationId ?? null,
    },
  });
}

export async function dbDeleteProjectContextState(
  projectId: string,
): Promise<void> {
  return invoke("db_delete_project_context_state", {
    project_id: projectId,
  });
}

export async function dbGetSessionContextState(): Promise<DbSessionContextState | null> {
  return invoke<DbSessionContextState | null>("db_get_session_context_state");
}

export async function dbUpsertSessionContextState(params: {
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  mode?: AppMode | null;
}): Promise<DbSessionContextState> {
  return invoke<DbSessionContextState>("db_upsert_session_context_state", {
    input: {
      selected_group_id: params.selectedGroupId ?? null,
      selected_project_id: params.selectedProjectId ?? null,
      mode: params.mode ?? null,
    },
  });
}

export async function dbReconcileProjectRegistry(params: {
  validGroupIds: string[];
  validProjectIds: string[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
}): Promise<DbProjectRegistryRepairReport> {
  return invoke<DbProjectRegistryRepairReport>(
    "db_reconcile_project_registry",
    {
      input: {
        valid_group_ids: params.validGroupIds,
        valid_project_ids: params.validProjectIds,
        selected_group_id: params.selectedGroupId ?? null,
        selected_project_id: params.selectedProjectId ?? null,
      },
    },
  );
}

export async function openExternalTarget(params: {
  targetPath: string;
  action: ExternalOpenAction;
  appId: string;
}): Promise<void> {
  return invoke("open_external_target", {
    targetPath: params.targetPath,
    action: params.action,
    appId: params.appId,
  });
}

export async function listExternalApps(): Promise<ExternalAppCatalogDto> {
  return invoke<ExternalAppCatalogDto>("list_external_apps");
}

export async function validateToolExecution(params: {
  mode: AppMode;
  toolId: string;
  path?: string;
}): Promise<ToolValidationResultDto> {
  return invoke<ToolValidationResultDto>("tool_validate_execution", {
    mode: params.mode,
    toolId: params.toolId,
    path: params.path,
  });
}

export async function getToolModePolicy(
  mode: AppMode,
): Promise<ToolModePolicyDto> {
  return invoke<ToolModePolicyDto>("tool_get_mode_policy", { mode });
}

export async function executeWorkspaceTool(params: {
  mode: AppMode;
  toolId: string;
  args: Record<string, unknown>;
  workspacePath?: string | null;
  workspaceScope?: WorkspaceScope;
}): Promise<string> {
  return invoke<string>("tool_execute_workspace", {
    mode: params.mode,
    toolId: params.toolId,
    args: params.args,
    workspacePath: params.workspacePath ?? null,
    workspaceScope: params.workspaceScope ?? null,
  });
}

export async function terminalCreateSession(params: {
  projectId: string;
  cwd?: string | null;
}): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_create_session", {
    projectId: params.projectId,
    cwd: params.cwd ?? null,
  });
}

export async function terminalRun(params: {
  sessionId: string;
  command: string;
  timeoutMs?: number | null;
}): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_run", {
    sessionId: params.sessionId,
    command: params.command,
    timeoutMs: params.timeoutMs ?? null,
  });
}

export async function terminalRead(
  sessionId: string,
): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_read", { sessionId });
}

export async function terminalKill(
  sessionId: string,
): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_kill", { sessionId });
}

export async function terminalListTabs(): Promise<TerminalTabDto[]> {
  return invoke<TerminalTabDto[]>("terminal_list_tabs");
}

export async function terminalCreateTab(params: {
  kind: "manual" | "task";
  projectId: string;
  cwd?: string | null;
  title: string;
  taskId?: string | null;
  promptContext?: TerminalPromptContextInput | null;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_create_tab", {
    kind: params.kind,
    projectId: params.projectId,
    cwd: params.cwd ?? null,
    title: params.title,
    taskId: params.taskId ?? null,
    promptContext: params.promptContext ?? null,
  });
}

export async function terminalReconnectTab(
  tabId: string,
): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_reconnect_tab", { tabId });
}

export async function terminalReadTab(tabId: string): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_read_tab", { tabId });
}

export async function terminalUpdateTabMetadata(params: {
  tabId: string;
  title: string;
  promptContext?: TerminalPromptContextInput | null;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_update_tab_metadata", {
    tabId: params.tabId,
    title: params.title,
    promptContext: params.promptContext ?? null,
  });
}

export async function terminalWriteInput(params: {
  tabId: string;
  input: string;
}): Promise<void> {
  return invoke("terminal_write_input", {
    tabId: params.tabId,
    input: params.input,
  });
}

export async function terminalResize(params: {
  tabId: string;
  cols: number;
  rows: number;
}): Promise<void> {
  return invoke("terminal_resize", {
    tabId: params.tabId,
    cols: params.cols,
    rows: params.rows,
  });
}

export async function terminalExecuteCommand(params: {
  tabId: string;
  command: string;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_execute_command", {
    tabId: params.tabId,
    command: params.command,
  });
}

export async function terminalInterrupt(
  tabId: string,
): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_interrupt", { tabId });
}

export async function terminalClearTab(tabId: string): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_clear_tab", { tabId });
}

export async function terminalCloseTab(tabId: string): Promise<void> {
  return invoke("terminal_close_tab", { tabId });
}

// ============ Utility ============

/**
 * Check if we're running in Tauri
 */
export function isTauriAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const tauriWindow = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    } | null;
  };

  return typeof tauriWindow.__TAURI_INTERNALS__?.invoke === 'function';
}

/**
 * Wrapper that falls back gracefully when Tauri is not available
 */
export async function safeInvoke<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (!isTauriAvailable()) {
    console.warn("Tauri not available, using fallback");
    return fallback;
  }

  try {
    return await fn();
  } catch (error) {
    console.error("Tauri invoke error:", error);
    throw error;
  }
}
