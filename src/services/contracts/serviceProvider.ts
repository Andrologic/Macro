import type {
  AppBootstrapDto,
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
  CommitsDto,
  DebugResetProjectReportDto,
  ConversationsDto,
  FileContentDto,
  GitTreeDto,
  MCPServerSettingsDto,
  MessagesDto,
  ModelsDto,
  ProjectDto,
  ProvidersDto,
  SkillDetailDto,
  SkillListDto,
  SkillResourceReadDto,
  TaskCatalogDto,
  ToolSettingsDto,
} from './dtos';
import type {
  MCPServer,
  MCPTool,
  ProjectAccessChangePreview,
  ProjectGitFlowDetection,
  ProjectGitFlowSettings,
  ProjectGitSetupAction,
  ProjectGitSetupCommitResult,
  ProjectGroup,
  SkillManifest,
  SkillProjectRoot,
  SkillScriptRunRequest,
  SkillScriptRunResult,
  SkillTemplateCreateResult,
} from '../../types';

export interface ServiceProvider {
  getAppBootstrap: () => Promise<AppBootstrapDto>;
  listConversations: () => Promise<ConversationsDto>;
  listMessages: (conversationId?: string) => Promise<MessagesDto>;
  listTasks: () => Promise<TaskCatalogDto>;
  getGitTreeForProject: (projectId: string) => Promise<GitTreeDto>;
  gitWorktreeCreate: (
    projectId: string,
    taskId: string,
    branchName: string,
    fromRef?: string | null,
    preferredCommitBranch?: string | null,
    fallbackBranches?: string[] | null
  ) => Promise<{
    taskId: string;
    worktreePath: string;
    branchName: string;
    status: 'created' | 'reused' | 'repaired';
  }>;
  gitWorktreeRemove: (
    projectId: string,
    taskId: string
  ) => Promise<{
    taskId: string;
    worktreePath: string;
    removedPath: boolean;
    prunedRegistration: boolean;
    alreadyAbsent: boolean;
  }>;
  getFileContent: (path: string) => Promise<FileContentDto>;
  listCommits: (projectId?: string) => Promise<CommitsDto>;
  listProviders: () => Promise<ProvidersDto>;
  listModels: (providerId?: string) => Promise<ModelsDto>;
  sendChat: (request: ChatCompletionRequestDto) => Promise<ChatCompletionResponseDto>;
  createProject: (data: {
    name: string;
    description: string;
    groupId: string | null;
    groupName?: string | null;
    path?: string;
    gitFlowSettings?: ProjectGitFlowSettings;
  }) => Promise<ProjectDto>;
  previewProjectGitSetup: (data: {
    path?: string;
  }) => Promise<ProjectGitFlowDetection>;
  createProjectWithGitSetup: (data: {
    name: string;
    description: string;
    groupId: string | null;
    groupName?: string | null;
    path: string;
    gitFlowSettings?: ProjectGitFlowSettings;
    gitSetupActions: ProjectGitSetupAction[];
    expectedRepoRootPath?: string | null;
    expectedSetupState: ProjectGitFlowDetection['setupState'];
    expectedRecommendedActionSequence: ProjectGitSetupAction[];
  }) => Promise<ProjectGitSetupCommitResult>;
  importGitRepo: (data: {
    gitUrl: string;
    projectName: string;
    branch: string;
    groupId: string | null;
    groupName?: string | null;
    path?: string;
    gitFlowSettings?: ProjectGitFlowSettings;
  }) => Promise<ProjectDto>;
  renameProjectGroup: (data: {
    groupId: string;
    name: string;
  }) => Promise<{ projectGroup: ProjectGroup }>;
  renameProject: (data: {
    projectId: string;
    name: string;
  }) => Promise<ProjectDto>;
  updateProjectGitFlow: (data: {
    projectId: string;
    gitFlowSettings: ProjectGitFlowSettings;
  }) => Promise<ProjectDto>;
  updateProjectGitFlowWithSetup: (data: {
    projectId: string;
    gitFlowSettings: ProjectGitFlowSettings;
    gitSetupActions: ProjectGitSetupAction[];
    expectedRepoRootPath?: string | null;
    expectedSetupState: ProjectGitFlowDetection['setupState'];
    expectedRecommendedActionSequence: ProjectGitSetupAction[];
  }) => Promise<ProjectGitSetupCommitResult>;
  updateProjectAccess: (data: {
    projectId: string;
    userReadOnly: boolean;
    confirmedMigration?: boolean;
  }) => Promise<ProjectDto>;
  previewProjectAccessChange: (data: {
    projectId: string;
    targetReadOnly: boolean;
  }) => Promise<ProjectAccessChangePreview>;
  archiveProjectGroup: (data: {
    groupId: string;
  }) => Promise<{ projectGroup: ProjectGroup }>;
  archiveProject: (data: {
    projectId: string;
  }) => Promise<ProjectDto>;
  removeProjectGroup: (data: {
    groupId: string;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  removeProject: (data: {
    projectId: string;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  debugResetProject: (data: {
    projectId: string;
    force: boolean;
  }) => Promise<DebugResetProjectReportDto>;
  closeProject: (data: {
    projectId: string;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  getToolSettings: () => Promise<ToolSettingsDto>;
  updateToolSettings: (settings: ToolSettingsDto) => Promise<void>;
  getMCPServerSettings: () => Promise<MCPServerSettingsDto>;
  updateMCPServerSettings: (settings: MCPServerSettingsDto) => Promise<void>;
  mcpDiscoverTools: (server: MCPServer) => Promise<{ tools: MCPTool[] }>;
  mcpCallTool: (data: {
    server: MCPServer;
    toolName: string;
    arguments: Record<string, unknown>;
    timeoutMs?: number | null;
  }) => Promise<{ content: string; isError?: boolean; rawResult?: unknown }>;
  listSkills: (data?: { projectRoots?: SkillProjectRoot[] }) => Promise<SkillListDto>;
  getSkill: (data: {
    skillId: string;
    projectRoots?: SkillProjectRoot[];
  }) => Promise<SkillDetailDto>;
  installSkillFromLocalPath: (data: { sourcePath: string }) => Promise<SkillManifest>;
  createSkillTemplate: () => Promise<SkillTemplateCreateResult>;
  readSkillResource: (data: {
    skillId: string;
    resourcePath: string;
    projectRoots?: SkillProjectRoot[];
  }) => Promise<SkillResourceReadDto>;
  runSkillScript: (
    data: SkillScriptRunRequest & {
      projectRoots?: SkillProjectRoot[];
      workspacePath?: string | null;
    }
  ) => Promise<SkillScriptRunResult>;
}
