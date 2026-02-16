import type {
  Plan,
  ProjectGroup,
  PlanNode,
  PredictedBranch,
  Conversation,
  ChatMessage,
  PredictedGitTree,
  GitCommit,
  Task,
  AIProvider,
  AIModel,
  Project,
  MCPServer,
} from '../../types';

export interface AppBootstrapDto {
  plan: Plan | null;
  projectGroups: ProjectGroup[];
  planNodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
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

export interface ChatCompletionRequestDto {
  providerId: string;
  modelId: string;
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>;
}

export interface ChatCompletionResponseDto {
  message: Pick<ChatMessage, 'role' | 'content'>;
}
