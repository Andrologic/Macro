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
} from '../contracts/dtos';
import type { ProjectGroup } from '../../types';
import type { ServiceProvider } from '../contracts/serviceProvider';

interface RemoteConfig {
  baseUrl: string;
  apiPrefix: string;
  workspaceId?: string;
  authToken?: string;
  timeoutMs: number;
}

const DEFAULT_API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 15000;

const readEnv = (key: string): string | undefined => {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const viteValue = viteEnv?.[key];
  if (typeof viteValue === 'string' && viteValue.trim().length > 0) {
    return viteValue.trim();
  }

  if (typeof process !== 'undefined' && process.env) {
    const processValue = process.env[key];
    if (typeof processValue === 'string' && processValue.trim().length > 0) {
      return processValue.trim();
    }
  }

  return undefined;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

export const resolveRemoteConfig = (): RemoteConfig | null => {
  const baseUrl = readEnv('VITE_REMOTE_API_BASE_URL') ?? readEnv('VITE_REMOTE_BACKEND_URL');
  if (!baseUrl) {
    return null;
  }

  const apiPrefix = readEnv('VITE_REMOTE_API_PREFIX') ?? DEFAULT_API_PREFIX;
  const timeoutRaw = readEnv('VITE_REMOTE_TIMEOUT_MS');
  const timeoutNumber = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(timeoutNumber) && timeoutNumber > 0
    ? timeoutNumber
    : DEFAULT_TIMEOUT_MS;

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiPrefix: apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`,
    workspaceId: readEnv('VITE_REMOTE_WORKSPACE_ID'),
    authToken: readEnv('VITE_REMOTE_AUTH_TOKEN'),
    timeoutMs,
  };
};

const notConfigured = (): never => {
  throw {
    code: 'REMOTE_NOT_CONFIGURED',
    message: 'Remote backend transport is not configured yet',
  };
};

const notReady = (): never => {
  throw {
    code: 'REMOTE_ENDPOINT_NOT_IMPLEMENTED',
    message: 'This remote endpoint is not implemented yet',
  };
};

const getWorkspaceBasePath = (config: RemoteConfig): string => {
  if (!config.workspaceId) {
    return '/workspace';
  }
  return `/workspaces/${encodeURIComponent(config.workspaceId)}`;
};

const toAbsoluteApiUrl = (config: RemoteConfig, path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${config.baseUrl}${config.apiPrefix}${normalizedPath}`;
};

const extractPayload = <T>(payload: unknown, key?: string): T => {
  if (!key) {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  }

  if (payload && typeof payload === 'object') {
    const direct = payload as Record<string, unknown>;
    if (key in direct) {
      return direct[key] as T;
    }

    if ('data' in direct && direct.data && typeof direct.data === 'object') {
      const nested = direct.data as Record<string, unknown>;
      if (key in nested) {
        return nested[key] as T;
      }
    }
  }

  throw {
    code: 'REMOTE_INVALID_RESPONSE',
    message: `Remote response did not include expected field: ${key}`,
    details: payload,
  };
};

const remoteRequest = async <T>(
  path: string,
  options: RequestInit = {},
  payloadKey?: string,
): Promise<T> => {
  const config = resolveRemoteConfig();
  if (!config) {
    return notConfigured();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const url = toAbsoluteApiUrl(config, path);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

    if (!response.ok) {
      throw {
        code: 'REMOTE_REQUEST_FAILED',
        message: `Remote request failed (${response.status})`,
        details: {
          status: response.status,
          url,
          body,
        },
      };
    }

    return extractPayload<T>(body, payloadKey);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'REMOTE_REQUEST_FAILED'
    ) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw {
        code: 'REMOTE_TIMEOUT',
        message: `Remote request timed out after ${config.timeoutMs}ms`,
        details: { url },
      };
    }

    throw {
      code: 'REMOTE_REQUEST_ERROR',
      message: 'Remote request failed to execute',
      details: {
        url,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => {
  const config = resolveRemoteConfig();
  if (!config) {
    return notConfigured();
  }

  return remoteRequest<AppBootstrapDto>(`${getWorkspaceBasePath(config)}/bootstrap`);
};
export const listConversations = async (): Promise<ConversationsDto> => notReady();
export const listMessages = async (_conversationId?: string): Promise<MessagesDto> => notReady();
export const listTasks = async (): Promise<TaskCatalogDto> => {
  const config = resolveRemoteConfig();
  if (!config) {
    return notConfigured();
  }

  return remoteRequest<TaskCatalogDto>(`${getWorkspaceBasePath(config)}/tasks`);
};
export const getGitTreeForProject = async (projectId: string): Promise<GitTreeDto> => {
  return remoteRequest<GitTreeDto>(`/projects/${encodeURIComponent(projectId)}/git/tree`);
};
export const gitWorktreeCreate = async (
  _projectId: string,
  _taskId: string,
  _branchName: string,
  _fromRef?: string | null
): Promise<{
  taskId: string;
  worktreePath: string;
  branchName: string;
  status: 'created' | 'reused' | 'repaired';
}> => notReady();
export const gitWorktreeRemove = async (
  _projectId: string,
  _taskId: string
): Promise<{
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}> => notReady();
export const getFileContent = async (_path: string): Promise<FileContentDto> => notReady();
export const listCommits = async (projectId?: string): Promise<CommitsDto> => {
  if (!projectId) {
    throw {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project id is required',
    };
  }

  return remoteRequest<CommitsDto>(`/projects/${encodeURIComponent(projectId)}/git/commits`);
};
export const listProviders = async (): Promise<ProvidersDto> => notReady();
export const listModels = async (_providerId?: string): Promise<ModelsDto> => notReady();
export const sendChat = async (
  _request: ChatCompletionRequestDto
): Promise<ChatCompletionResponseDto> => notReady();

export const createProject = async (_data: {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
}): Promise<ProjectDto> => notReady();

export const importGitRepo = async (_data: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
}): Promise<ProjectDto> => notReady();

export const renameProjectGroup = async (_data: {
  groupId: string;
  name: string;
}): Promise<{ projectGroup: ProjectGroup }> => notReady();

export const renameProject = async (_data: {
  projectId: string;
  name: string;
}): Promise<ProjectDto> => notReady();

export const archiveProjectGroup = async (_data: {
  groupId: string;
}): Promise<{ projectGroup: ProjectGroup }> => notReady();

export const archiveProject = async (_data: {
  projectId: string;
}): Promise<ProjectDto> => notReady();

export const removeProjectGroup = async (_data: {
  groupId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => notReady();

export const removeProject = async (_data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => notReady();

export const closeProject = async (_data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => notReady();

export const getToolSettings = async (): Promise<ToolSettingsDto> => notReady();
export const updateToolSettings = async (_settings: ToolSettingsDto): Promise<void> => notReady();
export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> => notReady();
export const updateMCPServerSettings = async (_settings: MCPServerSettingsDto): Promise<void> => notReady();

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
  removeProjectGroup,
  removeProject,
  closeProject,
  getToolSettings,
  updateToolSettings,
  getMCPServerSettings,
  updateMCPServerSettings,
};
