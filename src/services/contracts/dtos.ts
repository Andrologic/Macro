import type {
  Plan,
  ProjectGroup,
  Conversation,
  ChatMessage,
  PredictedGitTree,
  GitCommit,
  Task,
  AIProvider,
  AIModel,
  Project,
} from '../../types';

export interface AppBootstrapDto {
  plan: Plan | null;
  projectGroups: ProjectGroup[];
}

export interface ConversationsDto {
  conversations: Conversation[];
}

export interface MessagesDto {
  messages: ChatMessage[];
}

export interface TasksDto {
  tasks: Task[];
}

export interface GitTreeDto {
  tree: PredictedGitTree | null;
}

export interface CommitsDto {
  commits: GitCommit[];
}

export interface ProvidersDto {
  providers: AIProvider[];
}

export interface ModelsDto {
  models: AIModel[];
}

export interface ProjectDto {
  project: Project;
}

export interface FileContentDto {
  content: string;
  language: string;
}

export interface ToolSettingsDto {
  tools: Record<string, boolean>;
}

export interface MCPServerSettingsDto {
  servers: Record<string, MCPServer>;
}
