import type {
  AppBootstrapDto,
  ConversationsDto,
  MessagesDto,
  TaskCatalogDto,
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
import type {
  AIModel,
  AIProvider,
  ChatMessage,
  Conversation,
  Project,
  ProjectGitFlowDetection,
  ProjectGitSetupCommitResult,
  ProjectGroup,
  Task,
  ToolTrace,
} from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import * as tauriIpc from '../tauriIpc';
import { mockInternalTools, mockMCPServers } from '../../mock-data/tools';
import { normalizeArchitectToolId } from '../architectToolNames';
import { sendChat as sendChatFallback } from './mock';
import { loadImplementTaskCatalog } from '../loadImplementTaskCatalog';

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
  group_id: conversation.group_id,
  project_id: conversation.project_id,
  last_message: conversation.last_message ?? '',
  message_count: conversation.message_count,
  updated_at: conversation.updated_at,
  is_unread: false,
});

const parseToolTraces = (raw: string | null): ToolTrace[] | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const traces = parsed.filter(
      (trace): trace is ToolTrace =>
        !!trace &&
        typeof trace === 'object' &&
        typeof (trace as ToolTrace).tool_call_id === 'string' &&
        typeof (trace as ToolTrace).tool_name === 'string' &&
        ((trace as ToolTrace).status === 'running' || (trace as ToolTrace).status === 'done')
    );
    return traces.length > 0 ? traces : undefined;
  } catch {
    return undefined;
  }
};

const toMessageDto = (message: tauriIpc.DbMessage): ChatMessage => ({
  id: message.id,
  task_id: '',
  conversation_id: message.conversation_id,
  role: message.role === 'user' ? 'user' : 'assistant',
  content: message.content,
  timestamp: message.created_at,
  tool_traces: parseToolTraces(message.tool_traces_json),
  hidden_context: message.hidden_context ?? undefined,
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

export const listMessages = async (conversationId?: string): Promise<MessagesDto> => {
  const messages = conversationId
    ? await tauriIpc.listMessages(conversationId)
    : (
      await Promise.all(
        (await tauriIpc.listConversations()).map(async (conversation) => tauriIpc.listMessages(conversation.id))
      )
    ).flat();

  const sortedMessages = messages.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  return { messages: sortedMessages.map(toMessageDto) };
};

export const listTasks = async (): Promise<TaskCatalogDto> => {
  const taskCatalog = await tauriIpc.workspaceListTasks();

  return loadImplementTaskCatalog(taskCatalog.tasks as Task[]);
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
  branchName: string,
  fromRef?: string | null,
  preferredCommitBranch?: string | null
): Promise<{
  taskId: string;
  worktreePath: string;
  branchName: string;
  status: 'created' | 'reused' | 'repaired';
}> => {
  const project = useAppStore.getState().getProjectById(projectId);
  if (!project) throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project: ${projectId}` };

  return tauriIpc.gitWorktreeCreate({
    repoPath: project.path,
    taskId,
    branchName,
    fromRef: fromRef ?? null,
    preferredCommitBranch: preferredCommitBranch ?? null,
  });
};

export const gitWorktreeRemove = async (
  projectId: string,
  taskId: string
): Promise<{
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}> => {
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

export const previewProjectGitSetup = async (data: {
  path?: string;
}): Promise<ProjectGitFlowDetection> => {
  return tauriIpc.workspacePreviewProjectGitSetup({
    path: data.path,
  });
};

export const createProject = async (data: {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: Project['gitFlowSettings'];
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceCreateProject({
    name: data.name,
    description: data.description,
    groupId: data.groupId,
    groupName: data.groupName,
    path: data.path,
    gitFlowSettings: data.gitFlowSettings,
  });

  return { project };
};

export const createProjectWithGitSetup = async (data: {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path: string;
  gitFlowSettings?: Project['gitFlowSettings'];
  gitSetupActions: ProjectGitFlowDetection['recommendedActionSequence'];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection['setupState'];
  expectedRecommendedActionSequence: ProjectGitFlowDetection['recommendedActionSequence'];
}): Promise<ProjectGitSetupCommitResult> => {
  return tauriIpc.workspaceCreateProjectWithGitSetup({
    name: data.name,
    description: data.description,
    groupId: data.groupId,
    groupName: data.groupName,
    path: data.path,
    gitFlowSettings: data.gitFlowSettings,
    gitSetupActions: data.gitSetupActions,
    expectedRepoRootPath: data.expectedRepoRootPath ?? null,
    expectedSetupState: data.expectedSetupState,
    expectedRecommendedActionSequence: data.expectedRecommendedActionSequence,
  });
};

export const importGitRepo = async (data: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: Project['gitFlowSettings'];
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceImportGitRepo({
    gitUrl: data.gitUrl,
    projectName: data.projectName,
    branch: data.branch,
    groupId: data.groupId,
    groupName: data.groupName,
    path: data.path,
    gitFlowSettings: data.gitFlowSettings,
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

export const updateProjectGitFlow = async (data: {
  projectId: string;
  gitFlowSettings: NonNullable<Project['gitFlowSettings']>;
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceUpdateProjectGitFlow({
    projectId: data.projectId,
    gitFlowSettings: data.gitFlowSettings,
  });

  return { project };
};

export const updateProjectGitFlowWithSetup = async (data: {
  projectId: string;
  gitFlowSettings: NonNullable<Project['gitFlowSettings']>;
  gitSetupActions: ProjectGitFlowDetection['recommendedActionSequence'];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection['setupState'];
  expectedRecommendedActionSequence: ProjectGitFlowDetection['recommendedActionSequence'];
}): Promise<ProjectGitSetupCommitResult> => {
  return tauriIpc.workspaceUpdateProjectGitFlowWithSetup({
    projectId: data.projectId,
    gitFlowSettings: data.gitFlowSettings,
    gitSetupActions: data.gitSetupActions,
    expectedRepoRootPath: data.expectedRepoRootPath ?? null,
    expectedSetupState: data.expectedSetupState,
    expectedRecommendedActionSequence: data.expectedRecommendedActionSequence,
  });
};

export const updateProjectAccess = async (data: {
  projectId: string;
  userReadOnly: boolean;
  confirmedMigration?: boolean;
}): Promise<ProjectDto> => {
  const project = await tauriIpc.workspaceUpdateProjectAccess({
    projectId: data.projectId,
    userReadOnly: data.userReadOnly,
    confirmedMigration: data.confirmedMigration ?? false,
  });

  return { project };
};

export const previewProjectAccessChange = async (data: {
  projectId: string;
  targetReadOnly: boolean;
}) => {
  return tauriIpc.workspacePreviewProjectAccessChange({
    projectId: data.projectId,
    targetReadOnly: data.targetReadOnly,
  });
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

export const removeProjectGroup = async (data: {
  groupId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => {
  const projectGroups = await tauriIpc.workspaceRemoveProjectGroup({
    groupId: data.groupId,
  });

  return { projectGroups };
};

export const removeProject = async (data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => {
  const projectGroups = await tauriIpc.workspaceRemoveProject({
    projectId: data.projectId,
  });

  return { projectGroups };
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
  previewProjectGitSetup,
  createProject,
  createProjectWithGitSetup,
  importGitRepo,
  renameProjectGroup,
  renameProject,
  updateProjectGitFlow,
  updateProjectGitFlowWithSetup,
  updateProjectAccess,
  previewProjectAccessChange,
  archiveProjectGroup,
  archiveProject,
  removeProjectGroup,
  removeProject,
  closeProject,
  getToolSettings,
  updateToolSettings,
  getMCPServerSettings,
  updateMCPServerSettings,
};
