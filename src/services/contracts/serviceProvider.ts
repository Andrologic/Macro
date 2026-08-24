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
  MCPProtocolMode,
  ProjectAccessChangePreview,
  ProjectGitFlowDetection,
  ProjectGitFlowSettings,
  ProjectGitSetupAction,
  ProjectGitSetupCommitResult,
  ProjectGroup,
  SkillManifest,
  SkillLocationOpenRequest,
  SkillProjectRoot,
  SkillScriptRunRequest,
  SkillScriptRunResult,
  SkillTemplateCreateRequest,
  SkillTemplateCreateResult,
} from '../../types';

// ============ Persistent MCP runtime contracts ============
// Contracts for the persistent MCP runtime
// (docs/mcp-dual-era-implementation-plan.md, sections 4.2, 7 and 8).

export type { MCPProtocolMode } from '../../types';
export type MCPProtocolEra = 'legacy' | 'modern';
export type MCPRuntimeStatus =
  | 'disconnected'
  | 'probing'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed';

/**
 * Runtime identity used by frontend calls. The backend owns the resolved
 * server definition per config generation, so callers never transmit a full
 * server definition.
 */
export interface MCPRuntimeKey {
  serverId: string;
  /** `null`/`undefined` targets the global scope; otherwise a project scope. */
  projectId?: string | null;
  /** Sorted effective multi-project scope. Mutually exclusive with projectId. */
  projectIds?: string[];
  configGeneration: number;
}

export interface MCPRuntimeSelector {
  serverId: string;
  /** Sorted effective project scope. An empty array targets global configuration. */
  projectIds: string[];
}

export interface MCPRuntimeServerSnapshot {
  key: MCPRuntimeKey;
  status: MCPRuntimeStatus;
  requestedProtocolMode?: MCPProtocolMode | null;
  negotiatedEra?: MCPProtocolEra | null;
  negotiatedProtocolVersion?: string | null;
  protocolDecisionReason?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

export interface MCPRuntimeSnapshotDto {
  generatedAt: string;
  servers: MCPRuntimeServerSnapshot[];
}

export interface MCPCatalogDto {
  key: MCPRuntimeKey;
  tools: MCPTool[];
  refreshedAt?: string | null;
}

export type MCPRuntimeEvent =
  | {
      kind: 'status';
      key: MCPRuntimeKey;
      status: MCPRuntimeStatus;
      detail?: string | null;
      occurredAt: string;
    }
  | {
      kind: 'catalog';
      key: MCPRuntimeKey;
      catalog: MCPCatalogDto;
      occurredAt: string;
    };

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
    directEdit?: boolean;
    requestId?: string | null;
  }) => Promise<ProjectDto>;
  previewProjectGitSetup: (data: {
    path?: string;
    requestId?: string | null;
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
    requestId?: string | null;
  }) => Promise<ProjectGitSetupCommitResult>;
  createNewProjectRepo: (data: {
    repoName: string;
    parentPath: string;
    folderName: string;
    groupId: string | null;
    groupName?: string | null;
    gitFlowSettings?: ProjectGitFlowSettings;
    requestId?: string | null;
  }) => Promise<ProjectGitSetupCommitResult>;
  cancelProjectOperation: (requestId: string) => Promise<boolean>;
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
  createProjectGroup: (data: {
    name: string;
    projectIds: string[];
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
  moveProjectToGroup: (data: {
    projectId: string;
    groupId: string | null;
  }) => Promise<{ projectGroups: ProjectGroup[] }>;
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
    directEdit?: boolean;
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
  // Persistent MCP runtime (compatibility adapters mcpDiscoverTools/mcpCallTool
  // above stay unchanged until stores migrate to these methods).
  mcpRuntimeGetSnapshot: () => Promise<MCPRuntimeSnapshotDto>;
  mcpRuntimeConnect: (selector: MCPRuntimeSelector) => Promise<MCPRuntimeServerSnapshot>;
  mcpRuntimeDisconnect: (key: MCPRuntimeKey) => Promise<void>;
  mcpRuntimeRefreshCatalog: (key: MCPRuntimeKey) => Promise<MCPCatalogDto>;
  mcpRuntimeCallTool: (data: {
    key: MCPRuntimeKey;
    toolName: string;
    arguments: Record<string, unknown>;
    operationId: string;
  }) => Promise<{ content: string; isError?: boolean; rawResult?: unknown }>;
  mcpRuntimeCancelOperation: (operationId: string) => Promise<boolean>;
  listSkills: (data?: { projectRoots?: SkillProjectRoot[] }) => Promise<SkillListDto>;
  getSkill: (data: {
    skillId: string;
    projectRoots?: SkillProjectRoot[];
  }) => Promise<SkillDetailDto>;
  installSkillFromLocalPath: (data: { sourcePath: string }) => Promise<SkillManifest>;
  createSkillTemplate: (data: SkillTemplateCreateRequest) => Promise<SkillTemplateCreateResult>;
  openSkillLocation: (data: SkillLocationOpenRequest) => Promise<void>;
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
