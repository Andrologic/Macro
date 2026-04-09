// Core types for the Macro application

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
export type FileOperation = 'Create' | 'Modify' | 'Delete' | 'Rename';
export type GitNodeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type AppMode = 'Architect' | 'Implement' | 'Chat';
export type ConversationScopeMode = AppMode;
export type AgentType = 'build' | 'plan';
export type ImplementExecutionMode = 'semi_auto' | 'full_auto';

// Plan Node types for dependency graph
export type PlanNodeStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';
export type PlanNodeType = 'spec' | 'feature' | 'task' | 'milestone';
export type GitFlowBranchType = 'plan' | 'feature' | 'release' | 'hotfix' | 'bugfix';
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
  assignedBranch?: string;
  branchType?: Exclude<GitFlowBranchType, 'plan'>;
  branchSlug?: string;
  projectId?: string;
  projectIds?: string[];
  estimatedTime?: string;
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
  worktreeKey: string;
  repoPath?: string;
  planBranchName?: string;
  predictedBranchId?: string | null;
}

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

// Context references for chat composer (tag needs, nodes, branches)
export type ContextRefKind = 'need' | 'plan-node' | 'predicted-branch';

export interface ContextReference {
  id: string;
  kind: ContextRefKind;
  title: string;
  subtitle?: string;
  data: Need | PlanNode | PredictedBranch;
}

// Activity indicator for projects
export type ProjectActivity = 'idle' | 'ai-active' | 'completed' | 'error';
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'loading';
export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = 'en' | 'fr';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodeOverflowMode = 'wrap' | 'horizontal_scroll';

// Tools & MCP types
export type ToolStatus = 'enabled' | 'disabled' | 'error' | 'loading';
export type ToolCategory = 'git' | 'filesystem' | 'web' | 'database' | 'terminal' | 'ai' | 'productivity' | 'external';
export type MCPServerStatus = 'online' | 'offline' | 'degraded' | 'unconfigured';
export type MCPServerCategory = 'database' | 'productivity' | 'communication' | 'development' | 'ai' | 'other';

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
  icon: string;
  config?: Record<string, unknown>;
}

export interface ToolSettings {
  tools: Record<string, Tool>;
}

// MCP Server interfaces
export interface MCPServer {
  id: string;
  name: string;
  category: MCPServerCategory;
  status: MCPServerStatus;
  description: string;
  icon: string;
  website?: string;
  config?: Record<string, unknown>;
}

export interface MCPServerSettings {
  servers: Record<string, MCPServer>;
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

export type ToolTraceStatus = 'running' | 'done';

export interface ToolTrace {
  tool_call_id: string;
  tool_name: string;
  detail?: string;
  status: ToolTraceStatus;
  visible_offset?: number;
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
  | 'post_compaction_overflow';

export interface ContextFootprint {
  totalEstimatedTokens: number;
  messageTokens: number;
  hiddenContextTokens: number;
  systemTokens: number;
  toolSchemaTokens: number;
  imagePlaceholderTokens: number;
  citationTokens: number;
  modelContextWindowTokens: number;
  threshold: ContextFootprintThreshold;
  reason: ContextFootprintReason;
  totalContextRatio: number;
  hiddenContextRatio: number;
  toolTurnCount: number;
}

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
}

export interface ChatGptProviderTurnState {
  provider: 'chatgpt';
  response_id?: string;
  output_items: unknown[];
}

export type ProviderTurnState = ChatGptProviderTurnState;

export interface ChatMessage {
  id: string;
  task_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  code_diff?: CodeDiff;
  choices?: AIChoice[];
  allow_free_response?: boolean;
  tool_traces?: ToolTrace[];
  hidden_context?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
}

export interface Conversation {
  id: string;
  title: string;
  description?: string;
  scope_mode: ConversationScopeMode;
  task_id: string | null;
  group_id?: string | null;
  project_id: string | null;
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
