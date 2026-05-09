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
  TaskCatalogDto,
  ToolSettingsDto,
} from '../contracts/dtos';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGitSetupCommitResult,
  ProjectGroup,
} from '../../types';
import type { ServiceProvider } from '../contracts/serviceProvider';
import {
  buildMCPServerSettingsPayload,
  buildToolSettingsPayload,
  normalizeMCPServerEnablementInput,
  writeStoredMCPServerEnablement,
  writeStoredToolEnablement,
} from './clientSettingsStorage';
import {
  ensureRemoteConfig,
  getWorkspaceBasePath,
  remoteRequest,
  remoteUnsupported,
} from './remoteHttp';

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
  writeStoredMCPServerEnablement(normalizeMCPServerEnablementInput(settings));
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
};
