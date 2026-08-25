import type {
  Plan,
  ProjectGroup,
  ProjectRegistry,
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
  SkillManifest,
} from '../../types';
import type {
  CatalogedImplementTask,
  ImplementTaskCatalogSource,
  ImplementTaskPlanSummary,
} from '../implementTaskCatalog';

export interface AppBootstrapDto {
  plan: Plan | null;
  standaloneProjects?: ProjectRegistry['standaloneProjects'];
  projectGroups: ProjectGroup[];
  planNodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  runtimeCapabilities?: Record<string, boolean>;
  capabilities?: Record<string, boolean>;
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
  revision?: string;
}

export interface ToolSettingsDto {
  tools: Record<string, boolean>;
}

export interface MCPServerSettingsDto {
  servers: Record<string, MCPServer | boolean | Record<string, unknown>>;
}

export interface SkillListDto {
  skills: SkillManifest[];
}

export interface SkillDetailDto {
  skill: SkillManifest;
  body: string;
}

export interface SkillResourceReadDto {
  skillId: string;
  path: string;
  content: string;
}

export interface ChatCompletionRequestDto {
  providerId: string;
  modelId: string;
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>;
}

export interface ChatCompletionResponseDto {
  message: Pick<ChatMessage, 'role' | 'content'>;
}
