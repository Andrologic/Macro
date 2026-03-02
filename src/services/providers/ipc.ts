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
import type { AIModel, AIProvider, ChatMessage, Conversation, ProjectGroup, Task } from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import * as tauriIpc from '../tauriIpc';
import { mockInternalTools, mockMCPServers } from '../../mock-data/tools';
import { normalizeArchitectToolId } from '../architectToolNames';
import { sendChat as sendChatFallback } from './mock';

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

const toConversationDto = (conversation: tauriIpc.DbConversation): Conversation => ({
  id: conversation.id,
  title: conversation.title,
  description: conversation.description ?? undefined,
  task_id: conversation.task_id,
  project_id: conversation.project_id,
  last_message: conversation.last_message ?? '',
  message_count: conversation.message_count,
  updated_at: conversation.updated_at,
  is_unread: false,
});

const toMessageDto = (message: tauriIpc.DbMessage): ChatMessage => ({
  id: message.id,
  task_id: '',
  conversation_id: message.conversation_id,
  role: message.role === 'user' ? 'user' : 'assistant',
  content: message.content,
  timestamp: message.created_at,
});

const toProviderDto = (provider: tauriIpc.DbProviderConfig): AIProvider => ({
  id: provider.id,
  name: provider.name,
  status: provider.is_enabled ? 'online' : 'offline',
  baseUrl: provider.base_url,
  isLocal: provider.is_local,
  isEnabled: provider.is_enabled,
});

const toModelDto = (model: tauriIpc.DbAiModel): AIModel => ({
  id: model.model_id,
  name: model.name,
  provider_id: model.provider_id,
  description: model.description ?? undefined,
  owned_by: model.owned_by ?? undefined,
  pricing: {
    prompt: model.pricing_prompt ?? undefined,
    completion: model.pricing_completion ?? undefined,
    request: model.pricing_request ?? undefined,
  },
  isEnabled: model.is_enabled,
  isManual: model.is_manual,
  first_seen_at: model.first_seen_at,
  last_seen_at: model.last_seen_at,
  db_id: model.id,
});

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => {
  const bootstrap = await tauriIpc.workspaceGetBootstrap();
  return {
    plan: bootstrap.plan,
    projectGroups: bootstrap.projectGroups,
    planNodes: bootstrap.planNodes,
    predictedBranches: bootstrap.predictedBranches,
  } as AppBootstrapDto;
};

export const listConversations = async (): Promise<ConversationsDto> => {
  const conversations = await tauriIpc.listConversations();
  return { conversations: conversations.map(toConversationDto) };
};

export const listMessages = async (): Promise<MessagesDto> => {
  const conversations = await tauriIpc.listConversations();
  const byConversation = await Promise.all(
    conversations.map(async (conversation) => tauriIpc.listMessages(conversation.id))
  );
  const messages = byConversation.flat().sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  return { messages: messages.map(toMessageDto) };
};

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

export const listProviders = async (): Promise<ProvidersDto> => {
  const providers = await tauriIpc.listProviderConfigs();
  return { providers: providers.map(toProviderDto) };
};

export const listModels = async (providerId?: string): Promise<ModelsDto> => {
  const providers = await tauriIpc.listProviderConfigs();
  const resolvedProviderId = providerId || providers.find((provider) => provider.is_enabled)?.id || providers[0]?.id;
  if (!resolvedProviderId) {
    return { models: [] };
  }
  const models = await tauriIpc.listProviderModels(resolvedProviderId);
  return { models: models.map(toModelDto) };
};

export const sendChat = async (
  request: ChatCompletionRequestDto
): Promise<ChatCompletionResponseDto> => sendChatFallback(request);

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
