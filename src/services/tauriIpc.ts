/**
 * Tauri IPC Bridge
 * Type-safe wrapper around Tauri's invoke function
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  PredictedGitTree,
  GitCommit,
  Plan,
  ProjectGroup,
  PlanNode,
  PredictedBranch,
  Task,
  Project,
} from '../types';

// ============ Types ============

export interface DbConversation {
  id: string;
  title: string;
  description: string | null;
  task_id: string | null;
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
}

export interface DbProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string | null;
  is_enabled: boolean;
  is_local: boolean;
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
  is_clean: boolean;
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
  is_enabled: boolean;
  is_manual: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DbProviderSettings {
  provider_id: string;
  filter_free_models: boolean;
}

export interface DbProviderModelInput {
  model_id: string;
  name: string;
  description?: string | null;
  owned_by?: string | null;
  pricing_prompt?: string | null;
  pricing_completion?: string | null;
  pricing_request?: string | null;
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

// ============ Conversations ============

export async function listConversations(): Promise<DbConversation[]> {
  return invoke<DbConversation[]>('db_list_conversations');
}

export async function getConversation(id: string): Promise<DbConversation | null> {
  return invoke<DbConversation | null>('db_get_conversation', { id });
}

export async function createConversation(params?: {
  title?: string;
  taskId?: string | null;
  projectId?: string | null;
}): Promise<DbConversation> {
  return invoke<DbConversation>('db_create_conversation', {
    title: params?.title,
    taskId: params?.taskId ?? null,
    projectId: params?.projectId ?? null,
  });
}

export async function renameConversation(id: string, title: string): Promise<void> {
  return invoke('db_rename_conversation', { id, title });
}

export async function updateConversationDetails(params: {
  id: string;
  title?: string;
  description?: string;
}): Promise<void> {
  return invoke('db_update_conversation_details', {
    id: params.id,
    title: params.title ?? null,
    description: params.description ?? null,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  return invoke('db_delete_conversation_by_id', { id });
}

export async function togglePinConversation(id: string): Promise<boolean> {
  return invoke<boolean>('db_toggle_pin_conversation', { id });
}

// ============ Messages ============

export async function listMessages(conversationId: string): Promise<DbMessage[]> {
  return invoke<DbMessage[]>('db_list_messages', { conversationId });
}

export async function createMessage(
  conversationId: string,
  role: string,
  content: string,
  tokenCount?: number
): Promise<DbMessage> {
  return invoke<DbMessage>('db_create_message', {
    conversationId,
    role,
    content,
    tokenCount: tokenCount ?? null,
  });
}

export async function updateMessage(
  id: string,
  content: string,
  tokenCount?: number
): Promise<void> {
  return invoke('db_update_message', {
    id,
    content,
    tokenCount: tokenCount ?? null,
  });
}

export async function deleteMessagesAfter(
  conversationId: string,
  afterMessageId: string
): Promise<void> {
  return invoke('db_delete_messages_after', { conversationId, afterMessageId });
}

// ============ File System ============

export async function fsReadFile(path: string): Promise<FsFileContentDto> {
  return invoke<FsFileContentDto>('fs_read_file', { path });
}

export async function fsReadFileWithOptions(params: {
  path: string;
  allowOutsideWorkspace?: boolean;
}): Promise<FsFileContentDto> {
  return invoke<FsFileContentDto>('fs_read_file', {
    path: params.path,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
  });
}

export async function fsWriteFile(params: {
  path: string;
  content: string;
  createDirs?: boolean;
  allowOutsideWorkspace?: boolean;
}): Promise<FsWriteResultDto> {
  return invoke<FsWriteResultDto>('fs_write_file', {
    path: params.path,
    content: params.content,
    createDirs: params.createDirs ?? null,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
  });
}

export async function fsListDir(params: {
  path: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  allowOutsideWorkspace?: boolean;
}): Promise<FsDirEntryDto[]> {
  return invoke<FsDirEntryDto[]>('fs_list_dir', {
    path: params.path,
    recursive: params.recursive ?? null,
    includeHidden: params.includeHidden ?? null,
    maxDepth: params.maxDepth ?? null,
    allowOutsideWorkspace: params.allowOutsideWorkspace ?? null,
  });
}

export async function fsStat(path: string): Promise<FsFileStatsDto> {
  return invoke<FsFileStatsDto>('fs_stat', { path });
}

export async function fsExists(path: string): Promise<boolean> {
  return invoke<boolean>('fs_exists', { path });
}

export async function fsDelete(params: {
  path: string;
  recursive?: boolean;
}): Promise<void> {
  return invoke('fs_delete', {
    path: params.path,
    recursive: params.recursive ?? null,
  });
}

export async function fsCreateDir(params: {
  path: string;
  recursive?: boolean;
}): Promise<void> {
  return invoke('fs_create_dir', {
    path: params.path,
    recursive: params.recursive ?? null,
  });
}

export async function fsCopy(params: {
  src: string;
  dest: string;
}): Promise<number> {
  return invoke<number>('fs_copy', {
    src: params.src,
    dest: params.dest,
  });
}

export async function fsMove(params: {
  src: string;
  dest: string;
}): Promise<void> {
  return invoke('fs_move', {
    src: params.src,
    dest: params.dest,
  });
}

// ============ Provider Configs ============

export async function listProviderConfigs(): Promise<DbProviderConfig[]> {
  return invoke<DbProviderConfig[]>('db_list_provider_configs');
}

export async function getProviderConfig(id: string): Promise<DbProviderConfig | null> {
  return invoke<DbProviderConfig | null>('db_get_provider_config', { id });
}

export async function updateProviderConfig(params: {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  isEnabled?: boolean;
}): Promise<void> {
  return invoke('db_update_provider_config', {
    id: params.id,
    name: params.name ?? null,
    baseUrl: params.baseUrl ?? null,
    apiKey: params.apiKey ?? null,
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
  return invoke<DbProviderConfig>('db_create_provider_config', {
    name: params.name,
    providerType: params.providerType,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey ?? null,
    isLocal: params.isLocal,
  });
}

export async function deleteProviderConfig(id: string): Promise<void> {
  return invoke('db_delete_provider_config', { id });
}

// ============ Git ============

export async function gitStatus(repoPath: string): Promise<GitStatusDto> {
  return invoke<GitStatusDto>('git_status', { repoPath });
}

export async function gitLog(params: {
  repoPath: string;
  limit?: number;
  branch?: string;
}): Promise<GitCommit[]> {
  return invoke<GitCommit[]>('git_log', {
    repoPath: params.repoPath,
    limit: params.limit ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitBranchList(repoPath: string): Promise<GitBranchesDto> {
  return invoke<GitBranchesDto>('git_branch_list', { repoPath });
}

export async function gitCheckout(params: {
  repoPath: string;
  branchOrCommit: string;
  create: boolean;
}): Promise<void> {
  return invoke('git_checkout', {
    repoPath: params.repoPath,
    branchOrCommit: params.branchOrCommit,
    create: params.create,
  });
}

export async function gitCommit(params: {
  repoPath: string;
  message: string;
  stageAll: boolean;
}): Promise<string> {
  return invoke<string>('git_commit', {
    repoPath: params.repoPath,
    message: params.message,
    stageAll: params.stageAll,
  });
}

export async function gitAdd(params: {
  repoPath: string;
  paths: string[];
}): Promise<void> {
  return invoke('git_add', { repoPath: params.repoPath, paths: params.paths });
}

export async function gitReset(params: {
  repoPath: string;
  mode: 'soft' | 'mixed' | 'hard';
  commit?: string;
  confirm?: boolean;
}): Promise<void> {
  return invoke('git_reset', {
    repoPath: params.repoPath,
    mode: params.mode,
    commit: params.commit ?? null,
    confirm: params.confirm ?? null,
  });
}

export async function gitStash(params: {
  repoPath: string;
  message?: string;
}): Promise<string> {
  return invoke<string>('git_stash', {
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
  return invoke<string>('git_diff', {
    repoPath: params.repoPath,
    base: params.base ?? null,
    head: params.head ?? null,
    contextLines: params.contextLines ?? null,
    ignoreWhitespace: params.ignoreWhitespace ?? null,
    paths: params.paths ?? null,
  });
}

export async function gitGetTree(params: {
  repoPath: string;
  branch?: string;
}): Promise<PredictedGitTree> {
  return invoke<PredictedGitTree>('git_get_tree', {
    repoPath: params.repoPath,
    branch: params.branch ?? null,
  });
}

// ============ Workspace ============

export async function workspaceGetBootstrap(): Promise<WorkspaceBootstrapDto> {
  return invoke<WorkspaceBootstrapDto>('workspace_get_bootstrap');
}

export async function workspaceListProjects(): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>('workspace_list_projects');
}

export async function workspaceListTasks(): Promise<Task[]> {
  return invoke<Task[]>('workspace_list_tasks');
}

export async function workspaceGetMetadata(): Promise<WorkspaceMetadataDto> {
  return invoke<WorkspaceMetadataDto>('workspace_get_metadata');
}

export async function workspaceCreateProject(params: {
  name: string;
  description: string;
  groupId?: string | null;
  path?: string;
}): Promise<Project> {
  return invoke<Project>('workspace_create_project', {
    name: params.name,
    description: params.description,
    group_id: params.groupId ?? null,
    path: params.path ?? null,
  });
}

export async function workspaceImportGitRepo(params: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId?: string | null;
  path?: string;
}): Promise<Project> {
  return invoke<Project>('workspace_import_git_repo', {
    git_url: params.gitUrl,
    project_name: params.projectName,
    branch: params.branch,
    group_id: params.groupId ?? null,
    path: params.path ?? null,
  });
}

export async function workspaceRenameProjectGroup(params: {
  groupId: string;
  name: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>('workspace_rename_project_group', {
    group_id: params.groupId,
    name: params.name,
  });
}

export async function workspaceRenameProject(params: {
  projectId: string;
  name: string;
}): Promise<Project> {
  return invoke<Project>('workspace_rename_project', {
    project_id: params.projectId,
    name: params.name,
  });
}

export async function workspaceArchiveProjectGroup(params: {
  groupId: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>('workspace_archive_project_group', {
    group_id: params.groupId,
  });
}

export async function workspaceArchiveProject(params: {
  projectId: string;
}): Promise<Project> {
  return invoke<Project>('workspace_archive_project', {
    project_id: params.projectId,
  });
}

export async function workspaceCloseProject(params: {
  projectId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>('workspace_close_project', {
    project_id: params.projectId,
  });
}

// ============ Provider Models ============

export async function listProviderModels(providerId: string): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>('db_list_provider_models', { providerId });
}

export async function upsertProviderModels(params: {
  providerId: string;
  models: DbProviderModelInput[];
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>('db_upsert_provider_models', {
    providerId: params.providerId,
    models: params.models,
  });
}

export async function registerManualModel(params: {
  providerId: string;
  modelId: string;
  name: string;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>('db_register_manual_model', {
    providerId: params.providerId,
    modelId: params.modelId,
    name: params.name,
  });
}

export async function setProviderModelEnabled(params: {
  providerId: string;
  modelId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke('db_set_provider_model_enabled', {
    providerId: params.providerId,
    modelId: params.modelId,
    enabled: params.enabled,
  });
}

export async function setAllProviderModelsEnabled(params: {
  providerId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke('db_set_all_provider_models_enabled', {
    providerId: params.providerId,
    enabled: params.enabled,
  });
}

// ============ Provider Settings ============

export async function getProviderSettings(providerId: string): Promise<DbProviderSettings> {
  return invoke<DbProviderSettings>('db_get_provider_settings', { providerId });
}

export async function updateProviderSettings(params: {
  providerId: string;
  filterFreeModels: boolean;
}): Promise<void> {
  return invoke('db_update_provider_settings', {
    providerId: params.providerId,
    filterFreeModels: params.filterFreeModels,
  });
}

// ============ Utility ============

/**
 * Check if we're running in Tauri
 */
export function isTauriAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
  );
}

/**
 * Wrapper that falls back gracefully when Tauri is not available
 */
export async function safeInvoke<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (!isTauriAvailable()) {
    console.warn('Tauri not available, using fallback');
    return fallback;
  }
  
  try {
    return await fn();
  } catch (error) {
    console.error('Tauri invoke error:', error);
    throw error;
  }
}
