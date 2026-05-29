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
  DebugResetProjectReportDto,
  ProvidersDto,
  SkillDetailDto,
  SkillListDto,
  SkillResourceReadDto,
  TaskCatalogDto,
  ToolSettingsDto,
} from '../contracts/dtos';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGitSetupCommitResult,
  ProjectGroup,
  SkillScriptRunResult,
} from '../../types';
import type { ServiceProvider } from '../contracts/serviceProvider';
import {
  buildMCPServerSettingsPayload,
  buildToolSettingsPayload,
  normalizeMCPServerSettingsInput,
  writeStoredMCPServers,
  writeStoredToolEnablement,
} from './clientSettingsStorage';
import {
  ensureRemoteConfig,
  getWorkspaceBasePath,
  remoteRequest,
  remoteUnsupported,
} from './remoteHttp';
import { REMOTE_UNSUPPORTED_IN_REMOTE_MODE } from '../serviceRuntime';

export { resolveRemoteConfig } from './remoteHttp';

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => {
  const config = ensureRemoteConfig();
  return remoteRequest<AppBootstrapDto>(`${getWorkspaceBasePath(config)}/bootstrap`);
};

export const listConversations = async (): Promise<ConversationsDto> =>
  remoteUnsupported('listConversations');

export const listMessages = async (_conversationId?: string): Promise<MessagesDto> =>
  remoteUnsupported('listMessages');

export const listTasks = async (): Promise<TaskCatalogDto> => {
  const config = ensureRemoteConfig();
  return remoteRequest<TaskCatalogDto>(`${getWorkspaceBasePath(config)}/tasks`);
};

export const getGitTreeForProject = async (projectId: string): Promise<GitTreeDto> => {
  return remoteRequest<GitTreeDto>(`/projects/${encodeURIComponent(projectId)}/git/tree`);
};

export const gitWorktreeCreate = async (
  _projectId: string,
  _taskId: string,
  _branchName: string,
  _fromRef?: string | null,
  _preferredCommitBranch?: string | null,
  _fallbackBranches?: string[] | null
): Promise<{
  taskId: string;
  worktreePath: string;
  branchName: string;
  status: 'created' | 'reused' | 'repaired';
}> => remoteUnsupported('gitWorktreeCreate');

export const gitWorktreeRemove = async (
  _projectId: string,
  _taskId: string
): Promise<{
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}> => remoteUnsupported('gitWorktreeRemove');

export const getFileContent = async (_path: string): Promise<FileContentDto> =>
  remoteUnsupported('getFileContent');

export const listCommits = async (projectId?: string): Promise<CommitsDto> => {
  if (!projectId) {
    throw {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project id is required',
    };
  }

  return remoteRequest<CommitsDto>(`/projects/${encodeURIComponent(projectId)}/git/commits`);
};

export const listProviders = async (): Promise<ProvidersDto> => remoteUnsupported('listProviders');

export const listModels = async (_providerId?: string): Promise<ModelsDto> =>
  remoteUnsupported('listModels');

export const sendChat = async (
  _request: ChatCompletionRequestDto
): Promise<ChatCompletionResponseDto> => remoteUnsupported('sendChat');

export const detectProjectGitFlow = async (_data: {
  path?: string;
}): Promise<ProjectGitFlowDetection> => remoteUnsupported('detectProjectGitFlow');

export const previewProjectGitSetup = async (_data: {
  path?: string;
}): Promise<ProjectGitFlowDetection> => remoteUnsupported('previewProjectGitSetup');

export const createProject = async (_data: {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: Project['gitFlowSettings'];
}): Promise<ProjectDto> => remoteUnsupported('createProject');

export const createProjectWithGitSetup = async (_data: {
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
}): Promise<ProjectGitSetupCommitResult> => remoteUnsupported('createProjectWithGitSetup');

export const importGitRepo = async (_data: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: Project['gitFlowSettings'];
}): Promise<ProjectDto> => remoteUnsupported('importGitRepo');

export const renameProjectGroup = async (_data: {
  groupId: string;
  name: string;
}): Promise<{ projectGroup: ProjectGroup }> => remoteUnsupported('renameProjectGroup');

export const renameProject = async (_data: {
  projectId: string;
  name: string;
}): Promise<ProjectDto> => remoteUnsupported('renameProject');

export const updateProjectGitFlow = async (_data: {
  projectId: string;
  gitFlowSettings: Project['gitFlowSettings'];
}): Promise<ProjectDto> => remoteUnsupported('updateProjectGitFlow');

export const updateProjectGitFlowWithSetup = async (_data: {
  projectId: string;
  gitFlowSettings: Project['gitFlowSettings'];
  gitSetupActions: ProjectGitFlowDetection['recommendedActionSequence'];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection['setupState'];
  expectedRecommendedActionSequence: ProjectGitFlowDetection['recommendedActionSequence'];
}): Promise<ProjectGitSetupCommitResult> =>
  remoteUnsupported('updateProjectGitFlowWithSetup');

export const updateProjectAccess = async (_data: {
  projectId: string;
  userReadOnly: boolean;
  confirmedMigration?: boolean;
}): Promise<ProjectDto> => remoteUnsupported('updateProjectAccess');

export const previewProjectAccessChange = async (_data: {
  projectId: string;
  targetReadOnly: boolean;
}) => remoteUnsupported('previewProjectAccessChange');

export const archiveProjectGroup = async (_data: {
  groupId: string;
}): Promise<{ projectGroup: ProjectGroup }> => remoteUnsupported('archiveProjectGroup');

export const archiveProject = async (_data: {
  projectId: string;
}): Promise<ProjectDto> => remoteUnsupported('archiveProject');

export const removeProjectGroup = async (_data: {
  groupId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => remoteUnsupported('removeProjectGroup');

export const removeProject = async (_data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => remoteUnsupported('removeProject');

export const debugResetProject = async (_data: {
  projectId: string;
  force: boolean;
}): Promise<DebugResetProjectReportDto> => remoteUnsupported('debugResetProject');

export const closeProject = async (_data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => remoteUnsupported('closeProject');

export const getToolSettings = async (): Promise<ToolSettingsDto> => buildToolSettingsPayload();

export const updateToolSettings = async (settings: ToolSettingsDto): Promise<void> => {
  writeStoredToolEnablement(settings.tools || {});
};

export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> =>
  buildMCPServerSettingsPayload();

export const updateMCPServerSettings = async (settings: MCPServerSettingsDto): Promise<void> => {
  writeStoredMCPServers(normalizeMCPServerSettingsInput(settings));
};

export const mcpDiscoverTools: ServiceProvider['mcpDiscoverTools'] = async () =>
  remoteUnsupported('mcpDiscoverTools');

export const mcpCallTool: ServiceProvider['mcpCallTool'] = async () =>
  remoteUnsupported('mcpCallTool');

const isRemoteUnsupportedStatus = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return false;
  const status = (details as { status?: unknown }).status;
  return status === 404 || status === 405 || status === 501;
};

const remoteSkillsUnsupported = (feature: string): never => {
  throw {
    code: REMOTE_UNSUPPORTED_IN_REMOTE_MODE,
    message: `The current remote runtime does not support Macro skills (${feature}).`,
    details: { feature },
  };
};

const remoteSkillRequest = async <T>(
  feature: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> => {
  try {
    return await remoteRequest<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isRemoteUnsupportedStatus(error)) {
      return remoteSkillsUnsupported(feature);
    }
    throw error;
  }
};

export const listSkills: ServiceProvider['listSkills'] = async (data) => {
  const config = ensureRemoteConfig();
  return remoteSkillRequest<SkillListDto>(
    'listSkills',
    `${getWorkspaceBasePath(config)}/skills/list`,
    { projectRoots: data?.projectRoots ?? [] },
  );
};

export const getSkill: ServiceProvider['getSkill'] = async (data) => {
  const config = ensureRemoteConfig();
  return remoteSkillRequest<SkillDetailDto>(
    'getSkill',
    `${getWorkspaceBasePath(config)}/skills/get`,
    {
      skillId: data.skillId,
      projectRoots: data.projectRoots ?? [],
    },
  );
};

export const installSkillFromLocalPath: ServiceProvider['installSkillFromLocalPath'] = async () =>
  remoteUnsupported('installSkillFromLocalPath');

export const createSkillTemplate: ServiceProvider['createSkillTemplate'] = async () =>
  remoteUnsupported('createSkillTemplate');

export const openSkillLocation: ServiceProvider['openSkillLocation'] = async () =>
  remoteUnsupported('openSkillLocation');

export const readSkillResource: ServiceProvider['readSkillResource'] = async (data) => {
  const config = ensureRemoteConfig();
  return remoteSkillRequest<SkillResourceReadDto>(
    'readSkillResource',
    `${getWorkspaceBasePath(config)}/skills/read-resource`,
    {
      skillId: data.skillId,
      resourcePath: data.resourcePath,
      projectRoots: data.projectRoots ?? [],
    },
  );
};

export const runSkillScript: ServiceProvider['runSkillScript'] = async (data) => {
  const config = ensureRemoteConfig();
  return remoteSkillRequest<SkillScriptRunResult>(
    'runSkillScript',
    `${getWorkspaceBasePath(config)}/skills/run-script`,
    {
      skillId: data.skillId,
      scriptPath: data.scriptPath,
      args: data.args ?? [],
      timeoutMs: data.timeoutMs ?? null,
      allowWorkspace: data.allowWorkspace === true,
      workspacePath: data.workspacePath ?? null,
      projectRoots: data.projectRoots ?? [],
    },
  );
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
  debugResetProject,
  closeProject,
  getToolSettings,
  updateToolSettings,
  getMCPServerSettings,
  updateMCPServerSettings,
  mcpDiscoverTools,
  mcpCallTool,
  listSkills,
  getSkill,
  installSkillFromLocalPath,
  createSkillTemplate,
  openSkillLocation,
  readSkillResource,
  runSkillScript,
};
