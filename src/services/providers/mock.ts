import {
  mockAuthPlan,
  mockProjects,
  mockConversations,
  mockChatMessages,
  mockCommits,
  getGitTree,
} from '../../mock-data/auth-scenario';
import { mockPlanNodes, mockPredictedBranches } from '../../mock-data/plans';
import { MOCK_CODE_FILES } from '../../mock-data/code-files';
import { mockProviders, mockModels } from '../../mock-data/ai';
import { mockInternalTools, mockMCPServers } from '../../mock-data/tools';
import { getProviderConfig } from '../aiConfig';
import type {
  AppBootstrapDto,
  ConversationsDto,
  MessagesDto,
  TasksDto,
  GitTreeDto,
  CommitsDto,
  ProvidersDto,
  ModelsDto,
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
  ProjectDto,
  ToolSettingsDto,
  MCPServerSettingsDto,
  FileContentDto,
} from '../contracts/dtos';
import type { Project, ProjectGroup } from '../../types';
import { delay, maybeFail } from '../utils';

const TOOL_SETTINGS_STORAGE_KEY = 'macro_tool_settings';
const LEGACY_TOOL_ID_MAP: Record<string, string> = {
  'web-search': 'web_search',
  'file-read': 'read_file',
};

const normalizeToolId = (id: string): string => LEGACY_TOOL_ID_MAP[id] || id;

const normalizeToolSettings = (settings: Record<string, boolean>): Record<string, boolean> =>
  Object.fromEntries(Object.entries(settings).map(([id, enabled]) => [normalizeToolId(id), enabled]));

// =============================================================================
// MOCK PROVIDER CONFIGURATION
// =============================================================================
// Latency reduced for faster development experience
// Set to 0 for instant responses, or increase to simulate network delay

const DEFAULT_LATENCY_MS = 0; // Reduced from 180ms for faster startup
const ERROR_RATE = 0;

const simulate = async <T>(value: T): Promise<T> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  return value;
};

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => {
  return simulate({
    plan: mockAuthPlan,
    projectGroups: mockProjects,
    planNodes: mockPlanNodes,
    predictedBranches: mockPredictedBranches,
  });
};

export const listConversations = async (): Promise<ConversationsDto> => {
  return simulate({ conversations: mockConversations });
};

export const listMessages = async (
  conversationId?: string
): Promise<MessagesDto> => {
  const messages = conversationId
    ? mockChatMessages.filter((msg) => msg.conversation_id === conversationId)
    : mockChatMessages;
  return simulate({ messages });
};

export const listTasks = async (): Promise<TasksDto> => {
  return simulate({ tasks: mockAuthPlan.tasks });
};

export const getGitTreeForProject = async (
  projectId: string
): Promise<GitTreeDto> => {
  return simulate({ tree: getGitTree(projectId) ?? null });
};

export const gitWorktreeCreate = async (
  _projectId: string,
  _taskId: string,
  _branchName: string
): Promise<string> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  return simulate(`/path/to/mock/worktree/${_projectId}/${_taskId}/${_branchName}`);
};

export const gitWorktreeRemove = async (
  _projectId: string,
  _taskId: string
): Promise<void> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  return simulate(undefined);
};

export const getFileContent = async (
  path: string
): Promise<FileContentDto> => {
  const file = MOCK_CODE_FILES[path] || MOCK_CODE_FILES['demo-feature.tsx'];
  return simulate(file);
};

export const listCommits = async (_projectId?: string): Promise<CommitsDto> => {
  return simulate({ commits: mockCommits });
};

export const listProviders = async (): Promise<ProvidersDto> => {
  return simulate({ providers: mockProviders });
};

export const listModels = async (providerId?: string): Promise<ModelsDto> => {
  const models = providerId
    ? mockModels.filter((model) => model.providerId === providerId)
    : mockModels;
  return simulate({
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      provider_id: model.providerId,
      description: model.description,
      capabilities: model.capabilities,
    }))
  });
};

export const sendChat = async (
  request: ChatCompletionRequestDto
): Promise<ChatCompletionResponseDto> => {
  const { providerId, modelId, messages } = request;
  const { apiKey, baseUrl } = await getProviderConfig(providerId);

  if (!apiKey) {
    throw {
      code: 'MISSING_API_KEY',
      message: `Missing API key for provider: ${providerId}`,
    };
  }

  if (!baseUrl) {
    throw {
      code: 'MISSING_BASE_URL',
      message: `Missing base URL for provider: ${providerId}`,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  if (providerId === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
    }),
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      payload?.message ||
      `Chat request failed (${response.status})`;
    throw {
      code: 'CHAT_REQUEST_FAILED',
      message: errorMessage,
      details: payload,
    };
  }

  const content = payload?.choices?.[0]?.message?.content ?? '';
  return {
    message: {
      role: 'assistant',
      content,
    },
  };
};

export const createProject = async (data: {
  name: string;
  description: string;
  groupId: string | null;
  path?: string;
}): Promise<ProjectDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const newProject: Project = {
    id: `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: data.name,
    path: data.path || data.name.toLowerCase().replace(/\s+/g, '-'),
    created_at: new Date().toISOString(),
    status: 'active',
    metadata: {
      description: data.description,
      tags: [],
      team_members: [],
      api_contracts: [],
      dependencies: [],
    },
  };

  return simulate({ project: newProject });
};

export const importGitRepo = async (data: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  path?: string;
}): Promise<ProjectDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const newProject: Project = {
    id: `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: data.projectName,
    path: data.path || data.projectName.toLowerCase().replace(/\s+/g, '-'),
    created_at: new Date().toISOString(),
    status: 'active',
    metadata: {
      description: `Imported from ${data.gitUrl}`,
      tags: [],
      team_members: [],
      api_contracts: [],
      dependencies: [],
    },
  };

  return simulate({ project: newProject });
};

export const renameProjectGroup = async (data: {
  groupId: string;
  name: string;
}): Promise<{ projectGroup: ProjectGroup }> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const found = mockProjects.find((group) => group.id === data.groupId);
  const projectGroup: ProjectGroup = found
    ? { ...found, name: data.name }
    : {
      id: data.groupId,
      name: data.name,
      isOpen: true,
      projects: [],
    };

  return simulate({ projectGroup });
};

export const renameProject = async (data: {
  projectId: string;
  name: string;
}): Promise<ProjectDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const existingProject = mockProjects
    .flatMap((group) => group.projects)
    .find((project) => project.id === data.projectId);

  const project: Project = existingProject
    ? { ...existingProject, name: data.name }
    : {
      id: data.projectId,
      name: data.name,
      path: '.',
      created_at: new Date().toISOString(),
      status: 'active',
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    };

  return simulate({ project });
};

export const archiveProjectGroup = async (data: {
  groupId: string;
}): Promise<{ projectGroup: ProjectGroup }> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const found = mockProjects.find((group) => group.id === data.groupId);
  const projectGroup: ProjectGroup = found
    ? {
      ...found,
      projects: found.projects.map((project) => ({
        ...project,
        status: 'archived',
      })),
    }
    : {
      id: data.groupId,
      name: 'Archived Group',
      isOpen: true,
      projects: [],
    };

  return simulate({ projectGroup });
};

export const archiveProject = async (data: {
  projectId: string;
}): Promise<ProjectDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const existingProject = mockProjects
    .flatMap((group) => group.projects)
    .find((project) => project.id === data.projectId);

  const project: Project = existingProject
    ? { ...existingProject, status: 'archived' }
    : {
      id: data.projectId,
      name: 'Archived Project',
      path: '.',
      created_at: new Date().toISOString(),
      status: 'archived',
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    };

  return simulate({ project });
};

export const closeProject = async (data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const projectGroups = mockProjects
    .map((group) => ({
      ...group,
      projects: group.projects.filter((project) => project.id !== data.projectId),
    }))
    .filter((group) => group.projects.length > 0);

  return simulate({ projectGroups });
};

// Tools & MCP Settings
export const getToolSettings = async (): Promise<any> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  // Return mock tool settings from localStorage or defaults
  const savedTools = localStorage.getItem(TOOL_SETTINGS_STORAGE_KEY);
  let enabledTools: Record<string, boolean> = {};

  try {
    if (savedTools && savedTools !== "undefined") {
      enabledTools = normalizeToolSettings(JSON.parse(savedTools));
    }
  } catch (e) {
    console.error("Failed to parse tool settings", e);
  }

  // Persist normalized IDs back to storage to migrate legacy keys once.
  localStorage.setItem(TOOL_SETTINGS_STORAGE_KEY, JSON.stringify(enabledTools));

  const tools: Record<string, any> = {};
  mockInternalTools.forEach((tool) => {
    const id = tool.id;
    const enabled = enabledTools[id] !== false;
    tools[id] = {
      ...tool,
      status: enabled ? 'enabled' : 'disabled',
      config: {
        ...tool.config,
        enabled,
      }
    };
  });

  return simulate({ tools });
};

export const updateToolSettings = async (settings: ToolSettingsDto): Promise<void> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  localStorage.setItem(
    TOOL_SETTINGS_STORAGE_KEY,
    JSON.stringify(normalizeToolSettings(settings.tools || {}))
  );
  return simulate(undefined);
};

export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const savedServers = localStorage.getItem('macro_mcp_server_settings');
  let enabledServers: Record<string, boolean> = {};

  try {
    if (savedServers && savedServers !== "undefined") {
      enabledServers = JSON.parse(savedServers);
    }
  } catch (e) {
    console.error("Failed to parse MCP server settings", e);
  }

  const servers = Object.fromEntries(
    mockMCPServers.map((server) => [
      server.id,
      {
        ...server,
        status: (enabledServers[server.id] ? 'online' : 'offline') as typeof server.status,
        config: {
          ...server.config,
          enabled: enabledServers[server.id] ?? false,
        },
      },
    ])
  );

  return simulate({ servers });
};

export const updateMCPServerSettings = async (settings: any): Promise<void> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const enabledMap: Record<string, boolean> = {};
  Object.entries(settings.servers).forEach(([id, value]) => {
    if (typeof value === 'boolean') {
      enabledMap[id] = value;
    } else {
      enabledMap[id] = (value as any)?.config?.enabled ?? false;
    }
  });

  localStorage.setItem('macro_mcp_server_settings', JSON.stringify(enabledMap));
  return simulate(undefined);
};
