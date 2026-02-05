import {
  mockAuthPlan,
  mockProjects,
  mockConversations,
  mockChatMessages,
  mockCommits,
  getGitTree,
} from '../../mock-data/auth-scenario';
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
import type { Project } from '../../types';
import { delay, maybeFail } from '../utils';

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
  return simulate({ plan: mockAuthPlan, projectGroups: mockProjects });
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
  return simulate({ models: models.map((model) => ({
    id: model.id,
    name: model.name,
    provider_id: model.providerId,
    description: model.description,
    capabilities: model.capabilities,
  })) });
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

// Tools & MCP Settings
export const getToolSettings = async (): Promise<any> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  
  // Return mock tool settings from localStorage or defaults
  const savedTools = localStorage.getItem('macro_tool_settings');
  let enabledTools: Record<string, boolean> = {};
  
  try {
    if (savedTools && savedTools !== "undefined") {
      enabledTools = JSON.parse(savedTools);
    }
  } catch (e) {
    console.error("Failed to parse tool settings", e);
  }

  const tools: Record<string, any> = {};
  Object.entries(mockInternalTools).forEach(([id, tool]) => {
    tools[id] = {
      ...tool,
      status: enabledTools[id] !== false ? 'enabled' : 'disabled',
      config: {
        ...tool.config,
        enabled: enabledTools[id] !== false,
      }
    };
  });
  
  return simulate({ tools });
};

export const updateToolSettings = async (settings: ToolSettingsDto): Promise<void> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  
  localStorage.setItem('macro_tool_settings', JSON.stringify(settings.tools || {}));
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
