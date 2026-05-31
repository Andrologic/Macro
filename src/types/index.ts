// Core types for the Macro application

import type { SupportedLanguage } from '../i18n/languages';
import type { IconName } from '../components/ui/Icon';

export type ProjectStatus = 'active' | 'paused' | 'archived';
export type PlanStatus = 'Draft' | 'Validated' | 'InProgress' | 'Completed' | 'Cancelled';
export type TaskStatus =
  | 'Pending'
  | 'InProgress'
  | 'AwaitingResponse'
  | 'InReview'
  | 'Completed'
  | 'Failed'
  | 'Blocked';
export type MessageRole = 'user' | 'assistant';
export type ChatCompletionReason =
  | 'completed'
  | 'tool_turn_limit'
  | 'post_tool_empty_fallback';
export type FileOperation = 'Create' | 'Modify' | 'Delete' | 'Rename';
export type GitNodeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type AppMode = 'Architect' | 'Implement' | 'Chat';
export type ConversationScopeMode = AppMode;
export type AgentType = 'build' | 'plan';

// Plan Node types for dependency graph
export type PlanNodeStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';
export type PlanNodeType = 'spec' | 'feature' | 'task' | 'milestone';
export type PlanNodeTodoStatus = 'pending' | 'in-progress' | 'done';
export type PlanTaskArtifactContentType = 'markdown' | 'json' | 'text';
export type GitFlowBranchType = 'plan' | 'feature' | 'release' | 'hotfix' | 'bugfix';
export type CompletionMergePolicy = 'merge_commit' | 'fast_forward';
export type ProjectGitSetupState =
  | 'not_git'
  | 'unborn'
  | 'single_main_only'
  | 'ready'
  | 'needs_branch_confirmation';
export type ProjectGitRepoResolution =
  | 'none'
  | 'selected_folder'
  | 'parent_repo'
  | 'new_local_repo';
export type ProjectGitSetupAction = 'initialize_repo' | 'create_initial_commit' | 'create_develop';
export type ProjectGitSetupRiskFlag = 'env_file' | 'dependency_dir' | 'build_output';
export type ProjectAccessBlockingReason =
  | 'dirty_worktree'
  | 'live_terminal'
  | 'last_actionable_plan'
  | 'last_actionable_feature'
  | 'last_actionable_task';

export interface ProjectGitFlowSettings {
  baseBranch: string;
  mainBranch: string;
  completionMergePolicy?: CompletionMergePolicy;
  planBranchTemplate: string;
  featureBranchTemplate: string;
  standaloneFeatureBranchTemplate: string;
  releaseBranchTemplate: string;
  hotfixBranchTemplate: string;
  bugfixBranchTemplate: string;
}

export interface ProjectGitFlowDetection {
  repoDetected: boolean;
  branches: string[];
  currentBranch?: string | null;
  suggestedMainBranch?: string | null;
  suggestedBaseBranch?: string | null;
  suggestedCommitBranch?: string | null;
  requiresConfirmation: boolean;
  setupState: ProjectGitSetupState;
  hasInitialCommit: boolean;
  resolvedRepoRootPath?: string | null;
  repoResolution: ProjectGitRepoResolution;
  initialCommitPreviewPaths: string[];
  initialCommitPreviewCount: number;
  initialCommitRiskFlags: ProjectGitSetupRiskFlag[];
  recommendedActionSequence: ProjectGitSetupAction[];
}

export interface ProjectGitSetupCommitResult {
  project: Project;
  detection: ProjectGitFlowDetection;
}

export interface ProjectAccessMigrationItem {
  count: number;
  labels: string[];
}

export interface ProjectAccessMigrationSummary {
  plans: ProjectAccessMigrationItem;
  manualFeatures: ProjectAccessMigrationItem;
  tasks: ProjectAccessMigrationItem;
  worktrees: ProjectAccessMigrationItem;
  predictedBranches: ProjectAccessMigrationItem;
  planNodes: ProjectAccessMigrationItem;
  executionTargets: ProjectAccessMigrationItem;
}

export interface ProjectAccessChangePreview {
  projectId: string;
  targetReadOnly: boolean;
  canApply: boolean;
  requiresConfirmation: boolean;
  blockingReasons: ProjectAccessBlockingReason[];
  migrationSummary: ProjectAccessMigrationSummary;
}

export interface PlanNode {
  id: string;
  title: string;
  description?: string;
  type: PlanNodeType;
  status: PlanNodeStatus;
  dependencies: string[];
  todos?: PlanNodeTodo[];
  artifactContracts?: PlanNodeArtifactContract[];
  assignedBranch?: string;
  branchType?: Exclude<GitFlowBranchType, 'plan'>;
  branchSlug?: string;
  projectId?: string;
  projectIds?: string[];
  estimatedTime?: string;
  archivedAt?: string | null;
  archiveReason?: string | null;
  mergedAt?: string | null;
}

export interface PlanNodeTodo {
  id: string;
  title: string;
  description?: string;
  status: PlanNodeTodoStatus;
}

export interface PlanNodeArtifactContract {
  id: string;
  title: string;
  kind: string;
  description?: string;
  required: boolean;
}

export interface PlanTaskArtifact {
  id: string;
  planId: string;
  taskId: string;
  kind: string;
  title: string;
  summary: string;
  contentType: PlanTaskArtifactContentType;
  path: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  contractId?: string;
  supersedes?: string;
}

export interface PlanTaskArtifactReview {
  artifactId: string;
  taskId: string;
  validatedAt: string;
  validatedBy: string;
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
}

// Predicted Git Flow types
export interface PredictedBranch {
  id: string;
  name: string;
  color: string;
  parentBranch: string | null;
  projectId: string;
  taskIds: string[];
  branchType?: GitFlowBranchType;
  branchSlug?: string;
  status: 'pending' | 'active' | 'merged';
}

export interface TaskExecutionTarget {
  projectId: string;
  branchName: string;
  targetBranchName?: string;
  // `worktree` tasks run in dedicated task worktrees, while
  // `repository_root` targets operate directly in the parent repository.
  executionKind?: 'worktree' | 'repository_root';
  worktreeKey: string;
  repoPath?: string;
  planBranchName?: string;
  predictedBranchId?: string | null;
}

export type ImplementTaskSource = 'architect' | 'plan_finalization' | 'standalone';

export interface PredictedCommit {
  id: string;
  branchId: string;
  message: string;
  taskId?: string;
  status: 'pending' | 'done';
}

// Plan Block for interactive messages
export interface PlanBlock {
  id: string;
  type: 'spec' | 'task-group' | 'dependency';
  title: string;
  items: PlanBlockItem[];
  status: 'draft' | 'accepted' | 'rejected';
}

export interface PlanBlockItem {
  id: string;
  text: string;
  checked: boolean;
}

// User Needs (Architect Mode)
export type NeedStatus = 'identified' | 'refined' | 'validated';
export type NeedCategory = 'functional' | 'technical' | 'ux' | 'performance' | 'security' | 'data' | 'business' | 'other';

export interface Need {
  id: string;
  planId?: string;
  groupId?: string;
  title: string;
  description: string;
  category: NeedCategory;
  status: NeedStatus;
  priority: 'low' | 'medium' | 'high';
  tags: string[];
  projectId?: string;
  sourceMessageId?: string; // Link to the chat message where this was identified
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFileReference {
  id: string;
  path: string;
  relativePath: string;
  projectId?: string | null;
  projectName?: string | null;
  language?: string | null;
  sizeBytes?: number | null;
  modified?: string | null;
  isFocused?: boolean;
}

// Context references for chat composer (tag needs, nodes, branches, skills, files)
export type ContextRefKind = 'need' | 'plan-node' | 'predicted-branch' | 'skill' | 'file';

export interface ContextReference {
  id: string;
  kind: ContextRefKind;
  title: string;
  subtitle?: string;
  data: Need | PlanNode | PredictedBranch | SkillManifest | WorkspaceFileReference;
}

export interface PersistedContextReference {
  id: string;
  kind: ContextRefKind;
  title: string;
  subtitle?: string;
  skillFilePath?: string | null;
  contentHash?: string;
  location?: SkillLocation;
  source?: SkillSource;
  path?: string;
  relativePath?: string;
  projectId?: string | null;
  projectName?: string | null;
}

// Activity indicator for projects
export type ProjectActivity = 'idle' | 'ai-active' | 'completed' | 'error';
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'loading';
export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = SupportedLanguage;
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodeOverflowMode = 'wrap' | 'horizontal_scroll';

// Tools & MCP types
export type ToolStatus = 'enabled' | 'disabled' | 'error' | 'loading';
export type ToolCategory = 'git' | 'filesystem' | 'web' | 'database' | 'terminal' | 'ai' | 'productivity' | 'external';
export type MCPServerStatus = 'online' | 'offline' | 'degraded' | 'unconfigured';
export type MCPServerCategory = 'database' | 'productivity' | 'communication' | 'development' | 'ai' | 'other';
export type MCPTransportType = 'stdio' | 'sse' | 'streamable_http';
export type ToolRiskLevel = 'strict' | 'balanced' | 'yolo';
export type ToolSecurityActionGroup = 'observe' | 'change' | 'escape';
export type ToolSecurityDecision = 'allow' | 'ask' | 'deny';
export type ToolApprovalCategory = 'modify' | 'delete' | 'web' | 'system';

export interface ApiContract {
  id: string;
  name: string;
  endpoint: string;
  method: string;
}

// Tools interfaces
export interface Tool {
  id: string;
  name: string;
  category: ToolCategory;
  status: ToolStatus;
  description: string;
  icon: IconName;
  config?: Record<string, unknown>;
}

export interface ToolSettings {
  tools: Record<string, Tool>;
}

// MCP Server interfaces
export interface MCPStdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPHttpTransportConfig {
  type: 'sse' | 'streamable_http';
  url: string;
  headers?: Record<string, string>;
}

export type MCPTransportConfig = MCPStdioTransportConfig | MCPHttpTransportConfig;

export interface MCPTool {
  id: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled?: boolean;
  discoveredAt?: string;
}

export interface MCPServer {
  id: string;
  name: string;
  category: MCPServerCategory;
  status: MCPServerStatus;
  description: string;
  icon: IconName;
  website?: string;
  transport?: MCPTransportConfig;
  tools?: MCPTool[];
  lastError?: string | null;
  discoveredAt?: string | null;
  config?: Record<string, unknown> & { enabled?: boolean };
}

export interface MCPServerSettings {
  servers: Record<string, MCPServer>;
}

export type SkillSourceKind = 'global' | 'project';
export type SkillSourceNamespace = 'agents' | 'codex' | 'opencode' | 'claude';
export type SkillLocationKind = 'local' | 'remote' | 'bundled';
export type SkillDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface SkillProjectRoot {
  projectId: string;
  projectName: string;
  path: string;
}

export interface SkillSource {
  kind: SkillSourceKind;
  namespace?: SkillSourceNamespace;
  projectId?: string | null;
  projectName?: string | null;
  rootPath: string;
  skillRootPath?: string;
}

export type SkillResourceKind = 'reference' | 'asset' | 'script';

export interface SkillResource {
  path: string;
  kind: SkillResourceKind;
  sizeBytes: number;
}

export interface SkillLocation {
  kind: SkillLocationKind;
  uri: string;
}

export interface SkillDiagnostic {
  severity: SkillDiagnosticSeverity;
  code: string;
  message: string;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  license?: string | null;
  compatibility?: string | null;
  allowedTools?: string | null;
  metadata?: Record<string, string>;
  rootPath?: string | null;
  skillFilePath?: string | null;
  location?: SkillLocation;
  source: SkillSource;
  resources: SkillResource[];
  scripts: SkillResource[];
  diagnostics?: SkillDiagnostic[];
  specCompliant?: boolean;
  shadowedBySkillId?: string | null;
  contentHash?: string;
  validationErrors: string[];
  isValid: boolean;
}

export interface SkillSettings {
  enabled: boolean;
  scriptsEnabled: boolean;
}

export interface SkillPermissionSnapshotEntry {
  skillId: string;
  enabled: boolean;
  scriptsEnabled: boolean;
  hasScripts: boolean;
}

export interface SkillPermissionSnapshot {
  conversationId: string;
  turnId: string;
  capturedAt: string;
  skills: Record<string, SkillPermissionSnapshotEntry>;
}

export interface SkillActivation {
  skillId: string;
  activatedAt: string;
  body: string;
  contentHash?: string;
  locationUri?: string;
  skillFilePath?: string | null;
}

export type SkillTurnFeedbackStatus = 'loaded' | 'blocked' | 'ignored';

export type SkillTurnFeedbackAction = 'open_settings' | 'refresh';

export interface SkillTurnFeedbackItem {
  skillId?: string;
  title: string;
  status: SkillTurnFeedbackStatus;
  reason?: string;
  action?: SkillTurnFeedbackAction;
}

export interface SkillTurnFeedback {
  messageId: string;
  loaded: SkillTurnFeedbackItem[];
  warnings: SkillTurnFeedbackItem[];
}

export interface SkillScriptRunRequest {
  skillId: string;
  scriptPath: string;
  args?: string[];
  timeoutMs?: number | null;
  allowWorkspace?: boolean;
}

export interface SkillScriptRunResult {
  skillId: string;
  scriptPath: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface SkillTemplateCreateResult {
  skill: SkillManifest;
  folderPath: string;
  skillFilePath: string;
}

export interface SkillTemplateCreateRequest {
  name: string;
  description: string;
  destinationKind: 'global' | 'project';
  projectId?: string | null;
  projectRoots?: SkillProjectRoot[];
}

export interface SkillLocationOpenRequest {
  skillId: string;
  target: 'skillFile' | 'folder';
  projectRoots?: SkillProjectRoot[];
}

export interface ProjectDependency {
  id: string;
  type: 'runtime' | 'development' | 'peer';
  version: string;
}

export interface ProjectMetadata {
  description: string;
  tags: string[];
  team_members: string[];
  api_contracts: ApiContract[];
  dependencies: ProjectDependency[];
}

export interface Project {
  id: string;
  name: string;
  mountName: string;
  path: string;
  created_at: string;
  status: ProjectStatus;
  gitFlowSettings?: ProjectGitFlowSettings;
  userReadOnly?: boolean;
  gitSetupState?: Extract<ProjectGitSetupState, 'ready' | 'not_git' | 'unborn'>;
  isReadOnly?: boolean;
  readOnlyReason?: 'manual' | 'missing_git' | 'missing_initial_commit' | 'manual_and_missing_git' | null;
  metadata: ProjectMetadata;
}

export interface ProjectGroup {
  id: string;
  name: string;
  isOpen: boolean;
  projects: Project[];
}

export interface ProjectRegistry {
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
}

export interface GlobalProject {
  groupId: string;
  name: string;
  subProjects: Project[];
  subProjectIds: string[];
  primarySubProjectId: string | null;
}

export interface ProjectMount {
  projectId: string;
  groupId: string | null;
  mountName: string;
  displayName: string;
  workspacePath: string | null;
  isReadOnly?: boolean;
}

export interface FileChange {
  path: string;
  operation: FileOperation;
  diff_preview: string;
}

export interface Task {
  id: string;
  plan_id: string;
  project_id: string;
  project_ids?: string[];
  context_project_ids?: string[];
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  estimated_changes: FileChange[];
  code_diff?: CodeDiff;
  draft?: boolean;
  standalone_kind?: 'legacy' | 'manual_feature';
  base_branch?: string | null;
  feature_slug?: string | null;
  conversation_id?: string | null;
  archived_at?: string | null;
  archive_reason?: string | null;
  merged_at?: string | null;
  needs_revalidation?: boolean;
  task_source?: ImplementTaskSource;
  assigned_branch?: string;
  branch_name?: string;
  branch_id?: string | null;
  branch_task_index?: number;
  blocked_by_task_ids?: string[];
  blocked_by?: string[];
  is_blocked?: boolean;
  is_ready?: boolean;
  sequence_index?: number;
  execution_targets?: TaskExecutionTarget[];
  todos?: PlanNodeTodo[];
}

export interface GitNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  status?: GitNodeStatus;
  children?: GitNode[];
}

export interface PredictedGitTree {
  branch: string;
  structure: GitNode[];
  modified_files_count: number;
}

export interface Plan {
  id: string;
  description: string;
  created_at: string;
  updated_at: string;
  status: PlanStatus;
  project_ids: string[];
  context_project_ids?: string[];
  tasks: Task[];
  predicted_git_trees: Record<string, PredictedGitTree>;
}

export interface CodeDiff {
  file_path: string;
  old_content: string;
  new_content: string;
  language: string;
}

export type ToolTraceStatus =
  | 'running'
  | 'pending_approval'
  | 'denied'
  | 'done';

export type ToolTraceExecutionMode = 'sequential' | 'parallel';

export interface ToolTrace {
  tool_call_id: string;
  tool_name: string;
  detail?: string;
  status: ToolTraceStatus;
  visible_offset?: number;
  execution_mode?: ToolTraceExecutionMode;
  batch_id?: string;
  order?: number;
  started_at_ms?: number;
  completed_at_ms?: number;
}

export interface PendingToolApproval {
  conversationId: string;
  assistantMessageId: string;
  toolCallId: string;
  toolId: string;
  actionGroup: ToolSecurityActionGroup;
  riskLevel: ToolRiskLevel;
  isDestructive?: boolean;
  summary: string;
  detail?: string;
  args?: Record<string, unknown>;
  rememberKey: string;
}

export interface AgentCodeCheckpointFileSnapshot {
  exists: boolean;
  content: string | null;
  isBinary?: boolean;
  size?: number;
  encoding?: string | null;
  language?: string | null;
}

export type AgentCodeCheckpointFileStatus = 'created' | 'modified' | 'deleted';

export interface AgentCodeCheckpointFile {
  path: string;
  realPath: string;
  projectId?: string | null;
  mountName?: string | null;
  workspacePath?: string | null;
  workspaceScope?: string | null;
  allowOutsideWorkspace?: boolean;
  status: AgentCodeCheckpointFileStatus;
  before: AgentCodeCheckpointFileSnapshot;
  after: AgentCodeCheckpointFileSnapshot;
}

export interface AgentCodeCheckpoint {
  id: string;
  conversationId: string;
  turnId?: string | null;
  assistantMessageId: string;
  toolCallId: string;
  toolName: string;
  sequence: number;
  createdAt: string;
  files: AgentCodeCheckpointFile[];
}

export type AgentCodeReplayFileAction = 'modify' | 'delete' | 'restore';

export interface AgentCodeReplayPreviewFile {
  path: string;
  realPath: string;
  action: AgentCodeReplayFileAction;
  status: AgentCodeCheckpointFileStatus;
  projectId?: string | null;
  mountName?: string | null;
  workspacePath?: string | null;
  workspaceScope?: string | null;
  allowOutsideWorkspace?: boolean;
  target: AgentCodeCheckpointFileSnapshot;
  expectedCurrent?: AgentCodeCheckpointFileSnapshot;
  current?: AgentCodeCheckpointFileSnapshot;
  hasExternalChanges?: boolean;
}

export interface AgentCodeReplayPreview {
  conversationId: string;
  messageId: string;
  targetCheckpointId: string | null;
  affectedFiles: AgentCodeReplayPreviewFile[];
  hasExternalChanges?: boolean;
}

export interface ConversationApprovalGrant {
  toolId: string;
  rememberKey: string;
  createdAt: string;
}

export type ContextFootprintThreshold =
  | 'none'
  | 'background'
  | 'blocking'
  | 'degraded';

export type ContextFootprintReason =
  | 'below_threshold'
  | 'total_context_ratio'
  | 'hidden_context_ratio'
  | 'tool_turn_count'
  | 'post_compaction_overflow'
  | 'hard_stop_ratio'
  | 'model_window_shrank'
  | 'manual_compaction_required';

export type ModelContextLimitSource =
  | 'model_metadata'
  | 'provider_metadata'
  | 'user_override'
  | 'models_dev'
  | 'provider_overflow_error'
  | 'macro_fallback';

export type ModelContextLimitConfidence =
  | 'verified'
  | 'configured'
  | 'catalog'
  | 'learned'
  | 'fallback';

export interface ContextFootprint {
  totalEstimatedTokens: number;
  serializedPayloadTokens?: number;
  messageTokens: number;
  visibleMessageTokens?: number;
  providerInputTokens?: number;
  hiddenContextTokens: number;
  systemTokens: number;
  toolSchemaTokens: number;
  imagePlaceholderTokens: number;
  citationTokens: number;
  summaryTokens?: number;
  latestUserContextTokens?: number;
  modelContextWindowTokens: number;
  inputLimitTokens?: number;
  outputLimitTokens?: number;
  contextLimitSource?: ModelContextLimitSource;
  isContextLimitAuthoritative?: boolean;
  contextLimitConfidence?: ModelContextLimitConfidence;
  contextLimitWarning?: string;
  previousModelContextWindowTokens?: number;
  modelContextWindowShrank?: boolean;
  marginTokens?: number;
  reservedTokens: number;
  outputReserveTokens?: number;
  usableContextTokens: number;
  threshold: ContextFootprintThreshold;
  reason: ContextFootprintReason;
  totalContextRatio: number;
  usableContextRatio: number;
  hiddenContextRatio: number;
  hardStopRatio: number;
  isHardStop: boolean;
  toolTurnCount: number;
}

export interface ContextCompactionDecisionAudit {
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  trigger?: ContextCompactionKind | ContextCompactionTrigger | null;
  result?: string | null;
  reason?: ContextFootprintReason | string | null;
  modelContextWindowTokens?: number | null;
  inputLimitTokens?: number | null;
  outputLimitTokens?: number | null;
  outputReserveTokens?: number | null;
  reservedTokens?: number | null;
  usableContextTokens?: number | null;
  totalEstimatedTokens?: number | null;
  usableContextRatio?: number | null;
  totalContextRatio?: number | null;
  threshold?: ContextFootprintThreshold | null;
  contextLimitSource?: ModelContextLimitSource | null;
  isContextLimitAuthoritative?: boolean | null;
  contextLimitConfidence?: ModelContextLimitConfidence | null;
  contextLimitWarning?: string | null;
  autoCompactionEnabled?: boolean | null;
  formula?: string | null;
}

export type ContextCompactionKind =
  | 'background'
  | 'blocking'
  | 'model_switch'
  | 'overflow_recovery'
  | 'safety_prestream'
  | 'stream_overflow'
  | 'manual';

export type ContextCompactionTrigger =
  | 'manual'
  | 'model_switch'
  | 'safety_prestream'
  | 'stream_overflow';

export type CompactionPass = 'normal' | 'forced' | 'ultra';
export type CompactionSummarySource = 'model' | 'fallback';
export type CompactionCheckpointHealth = 'ok' | 'degraded' | 'fallback';

export type ToolContextDigestKind =
  | 'file_read'
  | 'web_result'
  | 'git_result'
  | 'terminal_result'
  | 'tool_result';

export interface ToolContextDigestEntry {
  tool_name: string;
  target: string;
  kind: ToolContextDigestKind;
  evidence_excerpt: string;
  source_message_id: string;
  hash: string;
  timestamp?: string;
}

export interface ConversationCompactionState {
  conversationId: string;
  upToMessageId: string;
  summaryText: string;
  toolDigest: ToolContextDigestEntry[];
  usedSourcePassageIds: string[];
  interestingSourcePassageIds: string[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  fingerprint: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  prunedToolContextMessageIds?: string[];
  reservedTokens?: number;
  outputReserveTokens?: number;
  footprintBefore?: ContextFootprint;
  footprintAfter?: ContextFootprint;
  degradedReason?: ContextFootprintReason | null;
  compactionKind?: ContextCompactionKind;
  compactionPass?: CompactionPass;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
  policyVersion?: number;
  fingerprintInputsJson?: string;
  sourceHashesJson?: string;
  modelContextWindowTokens?: number;
  providerId?: string | null;
  modelId?: string | null;
  checkpointHealth?: CompactionCheckpointHealth;
  lastTrigger?: ContextCompactionTrigger;
}

export interface ChatGptProviderTurnState {
  provider: 'chatgpt';
  response_id?: string;
  output_items: unknown[];
}

export type ProviderTurnState = ChatGptProviderTurnState;

export interface QuestionStep {
  id: string;
  prompt: string;
  choices: [string, string, string];
  free_text_placeholder?: string;
}

export interface QuestionnairePayload {
  intro?: string;
  questions: QuestionStep[];
  source?: 'tool' | 'legacy_quick_replies';
}

export interface QuestionnaireResponseSummaryItem {
  id: string;
  prompt: string;
  answer: string;
}

export interface QuestionnaireResponseSummary {
  assistantMessageId: string;
  source?: QuestionnairePayload['source'];
  originToolCallId?: string;
  items: QuestionnaireResponseSummaryItem[];
}

export interface ConversationQuestionnaireDraft {
  mode?: 'pending_reply' | 'editing_response';
  assistantMessageId: string;
  responseMessageId?: string;
  currentStepIndex: number;
  answersByStepId: Record<string, string>;
  draftTextByStepId: Record<string, string>;
}

export interface ConversationQuestionnaireState {
  conversationId: string;
  taskId: string | null;
  mode: 'pending_reply' | 'editing_response';
  assistantMessageId: string;
  responseMessageId?: string;
  originToolCallId?: string;
  questionnaire: QuestionnairePayload;
  currentStepIndex: number;
  currentStep: QuestionStep;
  answersByStepId: Record<string, string>;
  draftTextByStepId: Record<string, string>;
  totalSteps: number;
  isLastStep: boolean;
}

export type ConversationExecutionPhase =
  | 'idle'
  | 'preparing'
  | 'overflow_recovery'
  | 'streaming'
  | 'error';

export interface ConversationRuntimeState {
  phase: ConversationExecutionPhase;
  sessionId: string | null;
  turnId?: string | null;
  assistantMessageId?: string | null;
  abortController?: AbortController | null;
  lastError?: string | null;
  lastErrorOrigin?: 'macro' | 'provider' | null;
  lastErrorDisplayTarget?: 'composer' | 'transcript' | null;
}

export interface ChatMessage {
  id: string;
  turn_id?: string | null;
  task_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  code_diff?: CodeDiff;
  choices?: AIChoice[];
  allow_free_response?: boolean;
  questionnaire?: QuestionnairePayload;
  questionnaire_response_summary?: QuestionnaireResponseSummary;
  tool_traces?: ToolTrace[];
  hidden_context?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
  context_refs?: PersistedContextReference[];
  completion_reason?: ChatCompletionReason;
}

export interface ProviderReplayEnvelope {
  provider: string;
  protocol: string;
  conversationId: string;
  messageId: string;
  turnId?: string | null;
  modelId?: string | null;
  items: unknown[];
  validity?: 'valid' | 'invalid' | 'compacted';
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  description?: string;
  scope_mode: ConversationScopeMode;
  task_id: string | null;
  group_id?: string | null;
  project_id: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  last_message: string;
  message_count: number;
  updated_at: string;
  is_unread: boolean;
}

export interface AIChoice {
  id: string;
  text: string;
}

export interface AppState {
  mode: AppMode;
  currentPlan: Plan | null;
  currentTask: Task | null;
  selectedProject: string | null;
}

export interface EditorState {
  code: string;
  language: string;
  readOnly: boolean;
}

export type CommitStatus = 'done' | 'planned' | 'in-progress';

export type AIProviderStatus = 'online' | 'offline' | 'degraded';

export interface AIProvider {
  id: string;
  name: string;
  status: AIProviderStatus;
  baseUrl?: string;
  isLocal?: boolean;
  isEnabled?: boolean;
  nativeToolCalling?: boolean;
}

export interface AIModel {
  id: string;
  name: string;
  provider_id: string;
  description?: string;
  capabilities?: string[];
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort | null;
  owned_by?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
  isFree?: boolean;
  isEnabled?: boolean;
  isManual?: boolean;
  nativeToolCalling?: boolean;
  contextWindowTokens?: number;
  inputLimitTokens?: number;
  outputLimitTokens?: number;
  contextWindowSource?: ModelContextLimitSource;
  contextLimitsUpdatedAt?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  db_id?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  hasStoredApiKey: boolean;
  apiKey?: string;
  apiKeyLoaded?: boolean;
  isEnabled: boolean;
  isLocal: boolean;
  nativeToolCalling?: boolean;
  authStatus?:
    | 'authenticated'
    | 'unauthenticated'
    | 'authorizing'
    | 'refreshing'
    | 'expired'
    | 'error'
    | 'connected'
    | 'login_required'
    | 'policy_blocked'
    | 'quota_or_auth_error';
  authSource?: string;
  planType?: string;
  accountLabel?: string;
  tokenExpiresAt?: string;
}

export interface ProviderSettings {
  providerId: string;
  filterFreeModels: boolean;
  copilotSendTimeoutMs?: number | null;
}

export interface GitCommit {
  id: string;
  hash: string;
  message: string;
  author: string;
  date: string;
  status: CommitStatus;
  parent_ids?: string[];
  graph_depth?: number;
  is_branch_point?: boolean;
  task_id?: string;
}

export interface UserPreferences {
  theme: ThemeMode;
  language: Language;
  notifications: boolean;
  emailUpdates: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  preferences: UserPreferences;
  created_at: string;
  updated_at: string;
}

export interface Session {
  user: User;
  token: string;
  expires_at: string;
}

export interface AuthCredentials {
  email: string;
  password: string;
}
