// Core types for the Macro application

export type ProjectStatus = 'active' | 'paused' | 'archived';
export type PlanStatus = 'Draft' | 'Validated' | 'InProgress' | 'Completed' | 'Cancelled';
export type TaskStatus = 'Pending' | 'InProgress' | 'AwaitingResponse' | 'Completed' | 'Failed';
export type MessageRole = 'user' | 'assistant';
export type FileOperation = 'Create' | 'Modify' | 'Delete' | 'Rename';
export type GitNodeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type AppMode = 'Architect' | 'Implement';

export interface ApiContract {
  id: string;
  name: string;
  endpoint: string;
  method: string;
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
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  estimated_changes: FileChange[];
  code_diff?: CodeDiff;
}

export interface GitNode {
  name: string;
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
  role: MessageRole;
  content: string;
  timestamp: string;
  code_diff?: CodeDiff;
  choices?: AIChoice[];
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

export interface GitCommit {
  id: string;
  hash: string;
  message: string;
  author: string;
  date: string;
  status: CommitStatus;
  task_id?: string;
}
