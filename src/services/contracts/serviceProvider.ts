import type {
  AppBootstrapDto,
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
  CommitsDto,
  ConversationsDto,
  FileContentDto,
  GitTreeDto,
  MCPServerSettingsDto,
  MessagesDto,
  ModelsDto,
  ProjectDto,
  ProvidersDto,
  TaskCatalogDto,
  ToolSettingsDto,
} from './dtos';
import type { ProjectGroup } from '../../types';

export interface ServiceProvider {
  getAppBootstrap: () => Promise<AppBootstrapDto>;
  listConversations: () => Promise<ConversationsDto>;
  listMessages: (conversationId?: string) => Promise<MessagesDto>;
  listTasks: () => Promise<TaskCatalogDto>;
  getGitTreeForProject: (projectId: string) => Promise<GitTreeDto>;
  gitWorktreeCreate: (
    projectId: string,
    taskId: string,
    branchName: string,
    fromRef?: string | null
  ) => Promise<string>;
  gitWorktreeRemove: (projectId: string, taskId: string) => Promise<void>;
  getFileContent: (path: string) => Promise<FileContentDto>;
  listCommits: (projectId?: string) => Promise<CommitsDto>;
  listProviders: () => Promise<ProvidersDto>;
  listModels: (providerId?: string) => Promise<ModelsDto>;
  sendChat: (request: ChatCompletionRequestDto) => Promise<ChatCompletionResponseDto>;
  createProject: (data: {
    name: string;
    description: string;
    groupId: string | null;
    groupName?: string | null;
    path?: string;
  }) => Promise<ProjectDto>;
  importGitRepo: (data: {
    gitUrl: string;
    projectName: string;
    branch: string;
    groupId: string | null;
    groupName?: string | null;
    path?: string;
  }) => Promise<ProjectDto>;
  renameProjectGroup: (data: {
    groupId: string;
    name: string;
  }) => Promise<{ projectGroup: ProjectGroup }>;
  renameProject: (data: {
    projectId: string;
    name: string;
  }) => Promise<ProjectDto>;
  archiveProjectGroup: (data: {
    groupId: string;
  }) => Promise<{ projectGroup: ProjectGroup }>;
  archiveProject: (data: {
    projectId: string;
  }) => Promise<ProjectDto>;
  removeProjectGroup: (data: {
    groupId: string;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  removeProject: (data: {
    projectId: string;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  closeProject: (data: {
    projectId: string;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  getToolSettings: () => Promise<ToolSettingsDto>;
  updateToolSettings: (settings: ToolSettingsDto) => Promise<void>;
  getMCPServerSettings: () => Promise<MCPServerSettingsDto>;
  updateMCPServerSettings: (settings: MCPServerSettingsDto) => Promise<void>;
}
