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
export type AppMode = 'Architect' | 'Implement' | 'Chat' | 'Debug';
export type AgentType = 'build' | 'plan';
export type ImplementExecutionMode = 'semi_auto' | 'full_auto';

// Plan Node types for dependency graph
export type PlanNodeStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';
export type PlanNodeType = 'spec' | 'feature' | 'task' | 'milestone';

export interface PlanNode {
  id: string;
  title: string;
  description?: string;
  type: PlanNodeType;
  status: PlanNodeStatus;
  dependencies: string[];
  assignedBranch?: string;
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
  status: 'pending' | 'active' | 'merged';
}

export interface TaskExecutionTarget {
  projectId: string;
  branchName: string;
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
  path: string;
  created_at: string;
  status: ProjectStatus;
  metadata: ProjectMetadata;
}

export interface ProjectGroup {
  id: string;
  name: string;
  isOpen: boolean;
  projects: Project[];
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
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  estimated_changes: FileChange[];
  code_diff?: CodeDiff;
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
  tasks: Task[];
  predicted_git_trees: Record<string, PredictedGitTree>;
}

export interface CodeDiff {
  file_path: string;
  old_content: string;
  new_content: string;
  language: string;
}

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
}

export interface Conversation {
  id: string;
  title: string;
  description?: string;
  task_id: string | null;
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
}

export interface AIModel {
  id: string;
  name: string;
  provider_id: string;
  description?: string;
  capabilities?: string[];
  owned_by?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
  isFree?: boolean;
  isEnabled?: boolean;
  isManual?: boolean;
  first_seen_at?: string;
  last_seen_at?: string;
  db_id?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  isEnabled: boolean;
  isLocal: boolean;
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

