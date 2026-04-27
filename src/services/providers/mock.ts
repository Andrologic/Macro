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
  DebugResetProjectReportDto,
  ProjectDto,
  ToolSettingsDto,
  MCPServerSettingsDto,
  FileContentDto,
} from '../contracts/dtos';
import type { ServiceProvider } from '../contracts/serviceProvider';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGitSetupCommitResult,
  ProjectGroup,
} from '../../types';
import { getDefaultProjectGitFlowSettings } from '../architectGitNaming';
import { delay, maybeFail } from '../utils';
import {
  buildMCPServerSettingsPayload,
  buildToolSettingsPayload,
  normalizeMCPServerEnablementInput,
  writeStoredMCPServerEnablement,
  writeStoredToolEnablement,
} from './clientSettingsStorage';

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

const withProjectAccessDefaults = (project: Project): Project => {
  const userReadOnly = project.userReadOnly ?? false;
  const gitSetupState = project.gitSetupState ?? 'ready';
  const isReadOnly = project.isReadOnly ?? (userReadOnly || gitSetupState !== 'ready');
  const readOnlyReason =
    project.readOnlyReason ??
    (userReadOnly
      ? 'manual'
      : gitSetupState === 'not_git'
        ? 'missing_git'
        : gitSetupState === 'unborn'
          ? 'missing_initial_commit'
          : null);

  return {
    ...project,
    userReadOnly,
    gitSetupState,
    isReadOnly,
    readOnlyReason,
  };
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
  return simulate({
    tasks: mockAuthPlan.tasks as TasksDto['tasks'],
    plans: [],
    hasStandaloneTasks: true,
    source: mockAuthPlan.tasks.length > 0 ? 'fallback' : 'empty',
  });
};

export const getGitTreeForProject = async (
  projectId: string
): Promise<GitTreeDto> => {
  return simulate({ tree: getGitTree(projectId) ?? null });
};

export const gitWorktreeCreate = async (
  _projectId: string,
  _taskId: string,
  _branchName: string,
  _fromRef?: string | null,
  _preferredCommitBranch?: string | null
): Promise<{
  taskId: string;
  worktreePath: string;
  branchName: string;
  status: 'created' | 'reused' | 'repaired';
}> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  return simulate({
    taskId: _taskId,
    worktreePath: `/path/to/mock/worktree/${_projectId}/${_taskId}/${_branchName}`,
    branchName: _branchName,
    status: 'created',
  });
};

export const gitWorktreeRemove = async (
  _projectId: string,
  _taskId: string
): Promise<{
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  return simulate({
    taskId: _taskId,
    worktreePath: `/path/to/mock/worktree/${_projectId}/${_taskId}`,
    removedPath: true,
    prunedRegistration: true,
    alreadyAbsent: false,
  });
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

const buildMockProjectGitFlowDetection = async (_data: {
  path?: string;
}): Promise<ProjectGitFlowDetection> => {
  return simulate({
    repoDetected: false,
    branches: [],
    currentBranch: null,
    suggestedMainBranch: 'main',
    suggestedBaseBranch: 'main',
    suggestedCommitBranch: 'main',
    requiresConfirmation: false,
    setupState: 'not_git',
    hasInitialCommit: false,
    resolvedRepoRootPath: null,
    repoResolution: 'none',
    initialCommitPreviewPaths: [],
    initialCommitPreviewCount: 0,
    initialCommitRiskFlags: [],
    recommendedActionSequence: ['initialize_repo', 'create_initial_commit'],
  });
};

export const previewProjectGitSetup = async (data: {
  path?: string;
}): Promise<ProjectGitFlowDetection> => {
  return simulate({
    ...(await buildMockProjectGitFlowDetection(data)),
    resolvedRepoRootPath: data.path ?? null,
    initialCommitPreviewPaths: ['README.md'],
    initialCommitPreviewCount: 1,
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
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const newProject: Project = withProjectAccessDefaults({
    id: `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: data.name,
    mountName: (data.path || data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project',
    path: data.path || data.name.toLowerCase().replace(/\s+/g, '-'),
    created_at: new Date().toISOString(),
    status: 'active',
    gitFlowSettings: data.gitFlowSettings || getDefaultProjectGitFlowSettings(),
    metadata: {
      description: data.description,
      tags: [],
      team_members: [],
      api_contracts: [],
      dependencies: [],
    },
  });

  return simulate({ project: newProject });
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
  const project = await createProject(data);
  const hasRepo = data.gitSetupActions.includes('initialize_repo')
    || data.gitSetupActions.includes('create_initial_commit')
    || data.gitSetupActions.includes('create_develop');
  const hasInitialCommit = data.gitSetupActions.includes('create_initial_commit')
    || data.gitSetupActions.includes('create_develop');
  const hasDevelop = data.gitSetupActions.includes('create_develop');

  return simulate({
    project: project.project,
    detection: {
      repoDetected: hasRepo,
      branches: hasDevelop ? ['main', 'develop'] : hasRepo ? ['main'] : [],
      currentBranch: hasRepo ? 'main' : null,
      suggestedMainBranch: 'main',
      suggestedBaseBranch: hasDevelop ? 'develop' : 'main',
      suggestedCommitBranch: hasDevelop ? 'develop' : 'main',
      requiresConfirmation: false,
      setupState: hasInitialCommit ? 'ready' : hasRepo ? 'unborn' : 'not_git',
      hasInitialCommit,
      resolvedRepoRootPath: data.expectedRepoRootPath ?? data.path,
      repoResolution: hasRepo ? 'selected_folder' : 'none',
      initialCommitPreviewPaths: [],
      initialCommitPreviewCount: 0,
      initialCommitRiskFlags: [],
      recommendedActionSequence: [],
    },
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
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const newProject: Project = withProjectAccessDefaults({
    id: `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: data.projectName,
    mountName: (data.path || data.projectName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project',
    path: data.path || data.projectName.toLowerCase().replace(/\s+/g, '-'),
    created_at: new Date().toISOString(),
    status: 'active',
    gitFlowSettings: data.gitFlowSettings || getDefaultProjectGitFlowSettings(),
    metadata: {
      description: `Imported from ${data.gitUrl}`,
      tags: [],
      team_members: [],
      api_contracts: [],
      dependencies: [],
    },
  });

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
    ? withProjectAccessDefaults({ ...existingProject, name: data.name })
    : withProjectAccessDefaults({
      id: data.projectId,
      name: data.name,
      mountName: data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project',
      path: '.',
      created_at: new Date().toISOString(),
      status: 'active',
      gitFlowSettings: getDefaultProjectGitFlowSettings(),
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    });

  return simulate({ project });
};

export const updateProjectGitFlow = async (data: {
  projectId: string;
  gitFlowSettings: Project['gitFlowSettings'];
}): Promise<ProjectDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const existingProject = mockProjects
    .flatMap((group) => group.projects)
    .find((project) => project.id === data.projectId);

  const project: Project = existingProject
    ? withProjectAccessDefaults({ ...existingProject, gitFlowSettings: data.gitFlowSettings })
    : withProjectAccessDefaults({
        id: data.projectId,
        name: 'Project',
        mountName: 'project',
        path: '.',
        created_at: new Date().toISOString(),
        status: 'active',
        gitFlowSettings: data.gitFlowSettings,
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      });

  return simulate({ project });
};

export const updateProjectGitFlowWithSetup = async (data: {
  projectId: string;
  gitFlowSettings: Project['gitFlowSettings'];
  gitSetupActions: ProjectGitFlowDetection['recommendedActionSequence'];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection['setupState'];
  expectedRecommendedActionSequence: ProjectGitFlowDetection['recommendedActionSequence'];
}): Promise<ProjectGitSetupCommitResult> => {
  const project = await updateProjectGitFlow({
    projectId: data.projectId,
    gitFlowSettings: data.gitFlowSettings,
  });
  const hasRepo = data.gitSetupActions.includes('initialize_repo')
    || data.gitSetupActions.includes('create_initial_commit')
    || data.gitSetupActions.includes('create_develop')
    || data.expectedSetupState !== 'not_git';
  const hasInitialCommit = data.gitSetupActions.includes('create_initial_commit')
    || data.gitSetupActions.includes('create_develop')
    || data.expectedSetupState === 'ready'
    || data.expectedSetupState === 'single_main_only';
  const hasDevelop = data.gitSetupActions.includes('create_develop')
    || data.gitFlowSettings?.baseBranch === 'develop';

  return simulate({
    project: project.project,
    detection: {
      repoDetected: hasRepo,
      branches: hasDevelop ? ['main', 'develop'] : hasRepo ? ['main'] : [],
      currentBranch: hasRepo ? 'main' : null,
      suggestedMainBranch: 'main',
      suggestedBaseBranch: hasDevelop ? 'develop' : 'main',
      suggestedCommitBranch: hasDevelop ? 'develop' : 'main',
      requiresConfirmation: false,
      setupState: hasInitialCommit ? 'ready' : hasRepo ? 'unborn' : 'not_git',
      hasInitialCommit,
      resolvedRepoRootPath: data.expectedRepoRootPath ?? null,
      repoResolution: hasRepo ? 'selected_folder' : 'none',
      initialCommitPreviewPaths: [],
      initialCommitPreviewCount: 0,
      initialCommitRiskFlags: [],
      recommendedActionSequence: [],
    },
  });
};

export const updateProjectAccess = async (data: {
  projectId: string;
  userReadOnly: boolean;
  confirmedMigration?: boolean;
}): Promise<ProjectDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const existingProject = mockProjects
    .flatMap((group) => group.projects)
    .find((project) => project.id === data.projectId);

  const project: Project = withProjectAccessDefaults(
    existingProject
      ? {
          ...existingProject,
          userReadOnly: data.userReadOnly,
          isReadOnly: data.userReadOnly || existingProject.gitSetupState !== 'ready',
          readOnlyReason:
            data.userReadOnly
              ? 'manual'
              : existingProject.gitSetupState === 'not_git'
                ? 'missing_git'
                : existingProject.gitSetupState === 'unborn'
                  ? 'missing_initial_commit'
                  : null,
        }
      : {
          id: data.projectId,
          name: 'Project',
          mountName: 'project',
          path: '.',
          created_at: new Date().toISOString(),
          status: 'active',
          gitFlowSettings: getDefaultProjectGitFlowSettings(),
          userReadOnly: data.userReadOnly,
          gitSetupState: 'ready',
          isReadOnly: data.userReadOnly,
          readOnlyReason: data.userReadOnly ? 'manual' : null,
          metadata: {
            description: '',
            tags: [],
            team_members: [],
            api_contracts: [],
            dependencies: [],
          },
        }
  );

  return simulate({ project });
};

export const previewProjectAccessChange = async (data: {
  projectId: string;
  targetReadOnly: boolean;
}) =>
  simulate({
    projectId: data.projectId,
    targetReadOnly: data.targetReadOnly,
    canApply: true,
    requiresConfirmation: data.targetReadOnly,
    blockingReasons: [],
    migrationSummary: {
      plans: { count: data.targetReadOnly ? 1 : 0, labels: data.targetReadOnly ? ['Checkout revamp'] : [] },
      manualFeatures: { count: 0, labels: [] },
      tasks: { count: 1, labels: data.targetReadOnly ? ['Refine API contract'] : [] },
      worktrees: { count: 0, labels: [] },
      predictedBranches: { count: 1, labels: data.targetReadOnly ? ['feature/checkout-rework'] : [] },
      planNodes: { count: 1, labels: data.targetReadOnly ? ['Scope edge cases'] : [] },
      executionTargets: { count: 0, labels: [] },
    },
  });

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
      mountName: 'archived-project',
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

export const removeProjectGroup = async (data: {
  groupId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);

  const projectGroups = mockProjects.filter((group) => group.id !== data.groupId);
  return simulate({ projectGroups });
};

export const removeProject = async (data: {
  projectId: string;
}): Promise<{ projectGroups: ProjectGroup[] }> => {
  return closeProject(data);
};

export const debugResetProject = async (data: {
  projectId: string;
  force: boolean;
}): Promise<DebugResetProjectReportDto> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  await closeProject({ projectId: data.projectId });
  return {
    projectId: data.projectId,
    projectName: 'Mock Project',
    removedRegistryEntry: true,
    removedTaskWorktrees: data.force ? 1 : 0,
    removedMetadataWorktree: false,
    removedMacroBranch: false,
    warnings: [],
  };
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
  return simulate(buildToolSettingsPayload());
};

export const updateToolSettings = async (settings: ToolSettingsDto): Promise<void> => {
  writeStoredToolEnablement(settings.tools || {});
  return simulate(undefined);
};

export const getMCPServerSettings = async (): Promise<MCPServerSettingsDto> => {
  return simulate(buildMCPServerSettingsPayload());
};

export const updateMCPServerSettings = async (settings: any): Promise<void> => {
  writeStoredMCPServerEnablement(normalizeMCPServerEnablementInput(settings));
  return simulate(undefined);
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
