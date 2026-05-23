import type {
  Plan,
  ProjectGroup,
  PlanNode,
  PredictedBranch,
  Conversation,
  ChatMessage,
  PredictedGitTree,
  GitCommit,
  AIProvider,
  AIModel,
  Project,
  MCPServer,
} from '../../types';
import type {
  CatalogedImplementTask,
  ImplementTaskCatalogSource,
  ImplementTaskPlanSummary,
} from '../implementTaskCatalog';

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

export interface TaskCatalogDto {
  tasks: CatalogedImplementTask[];
  plans: ImplementTaskPlanSummary[];
  hasStandaloneTasks: boolean;
  source: ImplementTaskCatalogSource;
}

export type TasksDto = TaskCatalogDto;

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

export interface DebugResetProjectReportDto {
  projectId: string;
  projectName: string;
  removedRegistryEntry: boolean;
  removedTaskWorktrees: number;
  removedMetadataWorktree: boolean;
  removedMacroBranch: boolean;
  warnings: string[];
}

export interface FileContentDto {
  content: string;
  language: string;
}

export interface ToolSettingsDto {
  tools: Record<string, boolean>;
}

export interface MCPServerSettingsDto {
  servers: Record<string, MCPServer | boolean | Record<string, unknown>>;
}

export interface ChatCompletionRequestDto {
  providerId: string;
  modelId: string;
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>;
}

export interface ChatCompletionResponseDto {
  message: Pick<ChatMessage, 'role' | 'content'>;
}
