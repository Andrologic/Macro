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
import type { Task } from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import * as tauriIpc from '../tauriIpc';

const notReady = () => {
  throw {
    code: 'IPC_NOT_READY',
    message: 'IPC provider not implemented yet',
  };
};

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => {
  const bootstrap = await tauriIpc.workspaceGetBootstrap();
  return {
    plan: bootstrap.plan,
    projectGroups: bootstrap.projectGroups,
    planNodes: bootstrap.planNodes,
    predictedBranches: bootstrap.predictedBranches,
  } as AppBootstrapDto;
};

export const listConversations = async (): Promise<ConversationsDto> => notReady();

export const listMessages = async (): Promise<MessagesDto> => notReady();

export const listTasks = async (): Promise<TasksDto> => {
  const tasks = await tauriIpc.workspaceListTasks();
  return { tasks: tasks as Task[] };
};

export const getGitTreeForProject = async (projectId: string): Promise<GitTreeDto> => {
  const project = useAppStore.getState().getProjectById(projectId);
  if (!project) {
    throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${projectId}` };
  }
  const tree = await tauriIpc.gitGetTree({ repoPath: project.path });
  return { tree };
};

export const getFileContent = async (path: string): Promise<FileContentDto> => {
  const file = await tauriIpc.fsReadFile(path);
  return {
    content: file.content,
    language: file.language,
  };
};

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

export const createProject = async (data: {
  name: string;
  description: string;
  groupId: string | null;
  path?: string;
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceCreateProject({
    name: data.name,
    description: data.description,
    groupId: data.groupId,
    path: data.path,
  });

  return { project };
};

export const importGitRepo = async (data: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  path?: string;
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceImportGitRepo({
    gitUrl: data.gitUrl,
    projectName: data.projectName,
    branch: data.branch,
    groupId: data.groupId,
    path: data.path,
  });

  return { project };
};

// Tools & MCP Settings
export const getToolSettings = async (): Promise<ToolSettingsDto> => notReady();

export const updateToolSettings = async (_settings: ToolSettingsDto): Promise<void> => notReady();

export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> => notReady();

export const updateMCPServerSettings = async (_settings: MCPServerSettingsDto): Promise<void> => notReady();
