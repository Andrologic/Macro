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
import type { ServiceProvider } from '../contracts/serviceProvider';
import type { ProjectGroup, Task } from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import * as tauriIpc from '../tauriIpc';
import { mockInternalTools, mockMCPServers } from '../../mock-data/tools';
import { normalizeArchitectToolId } from '../architectToolNames';

const TOOL_SETTINGS_STORAGE_KEY = 'macro_tool_settings';
const MCP_SERVER_SETTINGS_STORAGE_KEY = 'macro_mcp_server_settings';
const LEGACY_TOOL_ID_MAP: Record<string, string> = {
  'web-search': 'web_search',
  'file-read': 'read_file',
};

const normalizeToolSettings = (settings: Record<string, boolean>): Record<string, boolean> => {
  return Object.fromEntries(
    Object.entries(settings)
      .filter(([, value]) => typeof value === 'boolean')
      .map(([id, enabled]) => [normalizeArchitectToolId(LEGACY_TOOL_ID_MAP[id] || id), enabled])
  );
};

const loadLocalToolSettings = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(TOOL_SETTINGS_STORAGE_KEY);
    if (!raw || raw === 'undefined') return {};
    return normalizeToolSettings(JSON.parse(raw));
  } catch {
    return {};
  }
};

const loadLocalMcpSettings = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(MCP_SERVER_SETTINGS_STORAGE_KEY);
    if (!raw || raw === 'undefined') return {};
    return normalizeToolSettings(JSON.parse(raw));
  } catch {
    return {};
  }
};

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

export const gitWorktreeCreate = async (
  projectId: string,
  taskId: string,
  branchName: string
): Promise<string> => {
  const project = useAppStore.getState().getProjectById(projectId);
  if (!project) throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${projectId}` };

  return tauriIpc.gitWorktreeCreate({
    repoPath: project.path,
    taskId,
    branchName,
  });
};

export const gitWorktreeRemove = async (
  projectId: string,
  taskId: string
): Promise<void> => {
  const project = useAppStore.getState().getProjectById(projectId);
  if (!project) throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${projectId}` };

  return tauriIpc.gitWorktreeRemove({
    repoPath: project.path,
    taskId,
  });
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

export const renameProjectGroup = async (data: {
  groupId: string;
  name: string;
}): Promise<{ projectGroup: ProjectGroup }> => {
  const projectGroup = await tauriIpc.workspaceRenameProjectGroup({
    groupId: data.groupId,
    name: data.name,
  });

  return { projectGroup };
};

export const renameProject = async (data: {
  projectId: string;
  name: string;
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceRenameProject({
    projectId: data.projectId,
    name: data.name,
  });

  return { project };
};

export const archiveProjectGroup = async (data: {
  groupId: string;
}): Promise<{ projectGroup: ProjectGroup }> => {
  const projectGroup = await tauriIpc.workspaceArchiveProjectGroup({
    groupId: data.groupId,
  });

  return { projectGroup };
};

export const archiveProject = async (data: {
  projectId: string;
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceArchiveProject({
    projectId: data.projectId,
  });

  return { project };
};

export const closeProject = async (data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => {
  const projectGroups = await tauriIpc.workspaceCloseProject({
    projectId: data.projectId,
  });

  return { projectGroups };
};

// Tools & MCP Settings
export const getToolSettings = async (): Promise<ToolSettingsDto> => {
  const enabledMap = loadLocalToolSettings();
  const tools = Object.fromEntries(
    mockInternalTools.map((tool) => {
      const enabled = enabledMap[tool.id] ?? tool.config?.enabled !== false;
      return [
        tool.id,
        {
          ...tool,
          status: enabled ? 'enabled' : 'disabled',
          config: {
            ...tool.config,
            enabled,
          },
        },
      ];
    })
  );

  return { tools: tools as unknown as Record<string, boolean> };
};

export const updateToolSettings = async (settings: ToolSettingsDto): Promise<void> => {
  localStorage.setItem(TOOL_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeToolSettings(settings.tools || {})));
};

export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> => {
  const enabledMap = loadLocalMcpSettings();
  const servers = Object.fromEntries(
    mockMCPServers.map((server) => {
      const enabled = enabledMap[server.id] ?? false;
      return [
        server.id,
        {
          ...server,
          status: (enabled ? 'online' : 'offline') as 'online' | 'offline',
          config: {
            ...server.config,
            enabled,
          },
        },
      ];
    })
  );

  return { servers };
};

export const updateMCPServerSettings = async (settings: MCPServerSettingsDto): Promise<void> => {
  const enabledMap: Record<string, boolean> = {};
  Object.entries(settings.servers || {}).forEach(([id, server]) => {
    const enabled =
      typeof server === 'boolean'
        ? server
        : (server as unknown as { config?: { enabled?: boolean } }).config?.enabled ?? false;
    enabledMap[id] = enabled;
  });

  localStorage.setItem(MCP_SERVER_SETTINGS_STORAGE_KEY, JSON.stringify(enabledMap));
};

export const provider: ServiceProvider = {
  getAppBootstrap,
  listConversations,
  listMessages,
  listTasks,
  getGitTreeForProject,
  gitWorktreeCreate,
  gitWorktreeRemove,
  getFileContent,
  listCommits,
  listProviders,
  listModels,
  sendChat,
  createProject,
  importGitRepo,
  renameProjectGroup,
  renameProject,
  archiveProjectGroup,
  archiveProject,
  closeProject,
  getToolSettings,
  updateToolSettings,
  getMCPServerSettings,
  updateMCPServerSettings,
};
