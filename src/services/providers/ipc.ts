import type {
  AppBootstrapDto,
  ConversationsDto,
  MessagesDto,
  TasksDto,
  GitTreeDto,
  CommitsDto,
  ProvidersDto,
  ModelsDto,
  ProjectDto,
  FileContentDto,
  ToolSettingsDto,
  MCPServerSettingsDto,
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
} from '../contracts/dtos';
import { useAppStore } from '../../stores/useAppStore';
import * as tauriIpc from '../tauriIpc';

const notReady = () => {
  throw {
    code: 'IPC_NOT_READY',
    message: 'IPC provider not implemented yet',
  };
};

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => notReady();

export const listConversations = async (): Promise<ConversationsDto> => notReady();

export const listMessages = async (): Promise<MessagesDto> => notReady();

export const listTasks = async (): Promise<TasksDto> => notReady();

export const getGitTreeForProject = async (projectId: string): Promise<GitTreeDto> => {
  const project = useAppStore.getState().getProjectById(projectId);
  if (!project) {
    throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${projectId}` };
  }
  const tree = await tauriIpc.gitGetTree({ repoPath: project.path });
  return { tree };
};

export const getFileContent = async (_path: string): Promise<FileContentDto> => notReady();

export const listCommits = async (projectId?: string): Promise<CommitsDto> => {
  if (!projectId) {
    throw { code: 'PROJECT_NOT_FOUND', message: 'Project id is required' };
  }
  const project = useAppStore.getState().getProjectById(projectId);
  if (!project) {
    throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${projectId}` };
  }
  const commits = await tauriIpc.gitLog({ repoPath: project.path });
  return { commits };
};

export const listProviders = async (): Promise<ProvidersDto> => notReady();

export const listModels = async (): Promise<ModelsDto> => notReady();

export const sendChat = async (
  _request: ChatCompletionRequestDto
): Promise<ChatCompletionResponseDto> => notReady();

export const createProject = async (_data: {
  name: string;
  description: string;
  groupId: string | null;
  path?: string;
}): Promise<ProjectDto> => notReady();

export const importGitRepo = async (_data: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  path?: string;
}): Promise<ProjectDto> => notReady();

// Tools & MCP Settings
export const getToolSettings = async (): Promise<ToolSettingsDto> => notReady();

export const updateToolSettings = async (_settings: ToolSettingsDto): Promise<void> => notReady();

export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> => notReady();

export const updateMCPServerSettings = async (_settings: MCPServerSettingsDto): Promise<void> => notReady();
