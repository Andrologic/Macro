/**
 * Public, type-safe Tauri IPC facade.
 * Domain implementations and DTOs live in ./ipc; transports stay in tauriRuntimeBridge.
 */

export type {
  DbConversation,
  DbMessage,
  DbConversationCitation,
  DbUpsertConversationCitationInput,
  DbConversationToolboxState,
  DbUpsertConversationToolboxStateInput,
  DbConversationCompactionState,
  DbImportMessageInput,
  DbChatSnapshot,
  DbChatBootstrapSnapshot,
  DbArchitectPlanConversationSync,
  DbUpsertArchitectPlanConversationSyncInput,
  DbUpsertConversationCompactionStateInput,
  DbInsertConversationCompactionEventInput,
  MessageSearchResult,
  MessageSearchPage,
} from "./ipc/conversations.types";

export type {
  DbInitializationStatusDto,
} from "./ipc/database.types";

export type {
  ToolInvocation,
  ToolInvocationIdentity,
  ToolInvocationStatus,
  ToolEffectClass,
  RecordToolInvocationInput,
  RecordToolInvocationResult,
  CompleteToolInvocationInput,
} from "../types/generated/ipc";

export type { GoalAuditTransition, RecordGoalAuditTransitionInput } from "../types/generated/ipc";
export { recordGoalAuditTransition, linkGoalAuditChildConversation } from "./ipc/goalAudit";

export type {
  DbProviderConfig,
  DbAiModel,
  DbProviderSettings,
  DbProviderModelInput,
} from "./ipc/providers.types";

export type {
  GitFileStatus,
  GitStatusDto,
  GitBranchDto,
  GitBranchesDto,
  GitWorktreeInspectionStatus,
  GitWorktreeEnsureStatus,
  GitWorktreeInspectionDto,
  GitAvailableWorktreeDto,
  GitAvailableTaskBranchDto,
  GitTaskStartPointsDto,
  GitWorktreeEnsureDto,
  GitWorktreeRemoveDto,
  GitBranchWorktreeInspectionDto,
  GitBranchWorktreeEnsureDto,
  GitBranchWorktreeRemoveDto,
  GitSyncDto,
  GitPreparedBranchSyncDto,
  GitRemoteDto,
  GitMergeCheckDto,
  GitGuardedMergeStateDto,
  GitRebaseCheckDto,
  GitFilePairDto,
  GitReviewDiffLineDto,
  GitReviewDiffHunkDto,
  GitReviewParsedDiffDto,
  GitReviewChangeDto,
  GitReviewSnapshotDto,
  DirectReviewSnapshotDto,
  GitReviewFileDto,
  GitStartMergeResolutionDto,
  GitConflictFileSideDto,
  GitConflictFileDto,
  GitLogPageDto,
  GitWorkflowSessionIdentity,
  GitWorkflowSessionDto,
} from "./ipc/git.types";

export type {
  MacroSyncState,
  MacroSyncReason,
  MacroSyncNextAction,
  MacroBranchSyncDto,
} from "./ipc/metadataSync.types";

export type {
  MacroAiProvisioningStatusDto,
  DevProviderOverrideConfig,
  DevProviderOverridesFile,
  AiChatMessageImageUrl,
  AiChatMessagePart,
  AiChatMessageContent,
  AiChatMessage,
  AiToolCall,
  AiStreamChunkEvent,
  AiStreamToolTraceEvent,
  AiToolRequestEvent,
  AiStreamDoneEvent,
  AiStreamErrorEvent,
  AiStreamTimelineEvent,
  AiAuthStartedEvent,
  AiAuthSuccessEvent,
  AiAuthCancelledEvent,
  AiAuthErrorEvent,
  CopilotStatusDto,
  CopilotDownloadProgressEvent,
  CopilotDownloadCompleteEvent,
  CopilotDownloadErrorEvent,
  CopilotAuthProgressEvent,
  CopilotAuthCompleteEvent,
  CopilotAuthCancelledEvent,
  CopilotAuthErrorEvent,
} from "./ipc/ai.types";

export type {
  DbAppSetting,
  DbCompareAndSwapAppSettingResult,
  DbProjectContextState,
  DbSessionContextState,
  DbProjectRegistryRepairReport,
} from "./ipc/settings.types";

export type {
  ExternalOpenAction,
  ExternalAppKind,
  ExternalAppOptionDto,
  ExternalAppCatalogDto,
} from "./ipc/externalApps.types";

export type {
  ProjectRegistryRepairReportDto,
  ProjectRegistryDiagnosticsDto,
  WorkspaceMetadataRecoveryHintDto,
  WorkspaceMetadataRecoveryReportDto,
  WorkspaceProjectRegistryReconcileSkippedDto,
  WorkspaceProjectRegistryReconcileReportDto,
  WorkspaceBootstrapDto,
  ProjectIconDto,
  ProjectIconResolutionDto,
  WorkspaceArchitectPlanReplicaDto,
  WorkspaceArchitectPlanSummaryDto,
  WorkspaceArchitectPlanRecordDto,
  WorkspaceArchitectPlanRuntimeStatusDto,
  WorkspaceArchitectPlanListDto,
  WorkspaceArchitectPlanActivationHeadDto,
  WorkspaceArchitectChatMessageDto,
  WorkspaceArchitectPlanTranscriptDto,
  WorkspaceMetadataDto,
  WorkspaceManualFeatureExecutionTargetDto,
  WorkspaceManualFeatureMergeWorkflowRepositoryDto,
  WorkspaceManualFeatureMergeWorkflowDto,
  WorkspaceManualFeatureDto,
  DebugResetProjectReportDto,
} from "./ipc/workspace.types";

export {
  parseProviderInputItemsJson,
  parseProviderTurnStateJson,
  parseToolTracesJson,
  aiStartChatGptAuth,
  aiCancelChatGptAuth,
  aiGetCopilotStatus,
  aiDownloadCopilotRuntime,
  aiCancelCopilotRuntimeDownload,
  aiStartCopilotAuth,
  aiCancelCopilotAuth,
  aiDisconnectProviderAuth,
  aiSyncProviderModels,
  aiProvisionMacroAi,
  aiGetDevProviderOverrides,
  aiStreamChat,
  aiCancelStream,
  aiSubmitToolResult,
} from "./ipc/ai";

export type {
  FsFileContentDto,
  FsDirEntryDto,
  WorkspaceFileSearchRootDto,
  WorkspaceFileSearchResultDto,
  FsFileStatsDto,
  FsWriteResultDto,
} from "./ipc/filesystem.types";

export type {
  RepositoryInstructionProjectInputDto,
  RepositoryInstructionSourceDto,
  RepositoryInstructionIssueDto,
  RepositoryInstructionLoadResultDto,
} from "./ipc/repositoryInstructions.types";

export type {
  ToolValidationResultDto,
  ToolModePolicyDto,
  WorkspaceScope,
} from "./ipc/workspaceTools.types";

export type {
  MCPDiscoverToolsResponseDto,
  MCPCallToolResponseDto,
} from "./ipc/mcp.types";

export type {
  SkillListResponseDto,
  SkillDetailResponseDto,
  SkillResourceReadResponseDto,
} from "./ipc/skills.types";

export type {
  TerminalSessionDto,
  TerminalTabDto,
  TerminalPromptContextInput,
  TerminalOutputEvent,
} from "./ipc/terminal.types";

export type {
  FrontendLogLevel,
  FrontendLogParams,
  AppDiagnosticReportPreviewDto,
} from "./ipc/diagnostics.types";

export {
  gitStatus,
  gitLog,
  gitLogPage,
  gitBranchList,
  gitBranchCreate,
  gitBranchDelete,
  gitBranchDeleteRemote,
  gitCheckout,
  gitMerge,
  gitGuardedMergeState,
  gitWorkflow,
  gitWorkflowCleanup,
  gitStartMergeResolution,
  gitMergeCheck,
  gitFastForward,
  gitRebaseCheck,
  gitRebaseBranch,
  gitCommit,
  gitAdd,
  gitRestorePaths,
  gitReset,
  gitAbortMerge,
  gitStash,
  gitDiff,
  gitReadFilePair,
  gitReviewSnapshot,
  gitCancelReview,
  directCheckpointEnsure,
  directCheckpointRemove,
  directCheckpointResolveId,
  directReviewSnapshot,
  directReviewFile,
  directStagePaths,
  directUnstagePaths,
  directRestoreWorktreePaths,
  directAcceptChanges,
  gitReviewFile,
  gitReadConflictFile,
  gitWriteConflictResolution,
  gitAcceptConflictSide,
  gitCompleteMerge,
  gitGetTree,
  gitWorktreeInspect,
  gitTaskStartPoints,
  gitWorktreeCreate,
  gitWorktreeRemove,
  gitBranchWorktreeInspect,
  gitBranchWorktreeCreate,
  gitBranchWorktreeRemove,
  gitPush,
  gitRemoteAddOrigin,
  gitFetch,
  gitPull,
  gitPrepareGuardedBranchSync,
  gitGuardedBranchSync,
} from "./ipc/git";

export {
  frontendLog,
  appDiagnosticGenerate,
  appDiagnosticSave,
} from "./ipc/diagnostics";

export {
  getDatabaseInitializationStatus,
  retryDatabaseInitialization,
} from "./ipc/database";

export {
  recordToolInvocation,
  completeToolInvocation,
  markToolInvocationUnknown,
  listUnresolvedToolInvocations,
} from "./ipc/toolInvocations";

export {
  listConversations,
  getChatSnapshot,
  getChatBootstrapSnapshot,
  getConversation,
  createConversation,
  renameConversation,
  updateConversationDetails,
  updateConversationScope,
  updateConversationAISelection,
  deleteConversation,
  deleteConversations,
  togglePinConversation,
  listMessages,
  searchMessages,
  dbGetArchitectPlanConversationSync,
  dbGetArchitectPlanConversationSyncForPlan,
  dbUpsertArchitectPlanConversationSync,
  dbDeleteArchitectPlanConversationSync,
  dbGetConversationCompactionState,
  dbUpsertConversationCompactionState,
  dbDeleteConversationCompactionState,
  dbInsertConversationCompactionEvent,
  listConversationCitations,
  getConversationCitationContent,
  upsertConversationCitation,
  deleteConversationCitation,
  deleteConversationCitations,
  getConversationToolboxState,
  upsertConversationToolboxState,
  deleteConversationToolboxState,
  createMessage,
  importMessages,
  updateMessage,
  deleteMessagesAfter,
  deleteConversationTurn,
  dbTrimConversationReplay,
  dbPrepareConversationReplay,
  dbRestoreConversationReplay,
  dbCompleteConversationReplay,
  dbMarkConversationReplayLaunched,
  dbFinalizeConversationReplay,
} from "./ipc/conversations";

export {
  fsReadFile,
  fsReadFileWithOptions,
  fsWriteFile,
  fsListDir,
  fsSearchFiles,
  fsStat,
  fsExists,
  fsDelete,
  fsCreateDir,
  fsCopy,
  fsMove,
} from "./ipc/filesystem";

export {
  repositoryInstructionsLoad,
} from "./ipc/repositoryInstructions";

export {
  listProviderConfigs,
  getProviderConfig,
  revealProviderApiKey,
  updateProviderConfig,
  createProviderConfig,
  deleteProviderConfig,
  listProviderModels,
  upsertProviderModels,
  registerManualModel,
  updateManualModel,
  deleteManualModel,
  setProviderModelEnabled,
  setAllProviderModelsEnabled,
  getProviderSettings,
  updateProviderSettings,
} from "./ipc/providers";

export {
  listSpeechProviderConfigs,
  createSpeechProviderConfig,
  updateSpeechProviderConfig,
  deleteSpeechProviderConfig,
  transcribeSpeech,
} from "./ipc/speech";

export {
  macroBranchEnsure,
  macroBranchStatus,
  macroBranchCommitIfDirty,
  macroBranchPush,
  macroBranchPull,
} from "./ipc/metadataSync";

export {
  workspaceGetBootstrap,
  workspaceResolveProjectIcons,
  workspaceListProjects,
  workspaceListTasks,
  workspaceGetMetadata,
  workspaceGetActiveRoot,
  workspaceQuarantineLegacyStateLock,
  workspaceArchitectListPlans,
  workspaceArchitectActivatePlanHead,
  workspaceArchitectActivatePlanChat,
  workspaceArchitectInvalidate,
  workspacePreviewProjectGitSetup,
  workspaceCancelProjectOperation,
  workspaceCreateProjectWithGitSetup,
  workspaceUpdateProjectGitFlowWithSetup,
  workspaceSetActiveRoot,
  workspaceCreateProject,
  workspaceCreateNewProjectRepo,
  workspaceImportGitRepo,
  workspaceRenameProjectGroup,
  workspaceCreateProjectGroup,
  workspaceMoveProjectToGroup,
  workspaceRenameProject,
  workspaceUpdateProjectGitFlow,
  workspaceUpdateProjectAccess,
  workspacePreviewProjectAccessChange,
  workspaceArchiveProjectGroup,
  workspaceArchiveProject,
  workspaceRestoreProjectGroup,
  workspaceRestoreProject,
  workspaceRemoveProjectGroup,
  workspaceRemoveProject,
  workspaceDebugResetProject,
  workspaceCloseProject,
  workspaceGetProjectRegistryDiagnostics,
  workspaceRecoverMissingMetadata,
  workspaceDiscoverRecoverableProjects,
  workspaceReconcileProjectRegistryFromHints,
  workspaceCreateManualFeatureDraft,
  workspaceFinalizeManualFeature,
  workspaceBindManualFeatureDirectCheckpoint,
  workspaceRevertManualFeatureToDraft,
  workspaceDeleteManualFeatureDraft,
  workspaceAcquirePlanLifecycleLock,
  workspaceRenewPlanLifecycleLock,
  workspaceReleasePlanLifecycleLock,
  workspaceAcquireTaskLifecycleLock,
  workspaceRenewTaskLifecycleLock,
  workspaceReleaseTaskLifecycleLock,
  workspaceRenameManualFeature,
  workspaceArchiveManualFeature,
  workspaceRestoreManualFeature,
  workspaceDeleteManualFeature,
  workspaceUpdateStandaloneTaskStatus,
  workspaceUpdateManualFeatureMergeWorkflow,
} from "./ipc/workspace";

export {
  dbGetSetting,
  dbSetSetting,
  dbGetAppSetting,
  dbSetAppSetting,
  dbDeleteAppSetting,
  dbCompareAndSwapAppSetting,
  dbGetProjectContextState,
  dbUpsertProjectContextState,
  dbDeleteProjectContextState,
  dbGetSessionContextState,
  dbUpsertSessionContextState,
  dbReconcileProjectRegistry,
} from "./ipc/settings";

export {
  openExternalTarget,
  listExternalApps,
} from "./ipc/externalApps";

export {
  validateToolExecution,
  getToolModePolicy,
  executeWorkspaceTool,
  cancelWorkspaceTool,
} from "./ipc/workspaceTools";

export {
  mcpDiscoverTools,
  mcpCallTool,
  mcpStoreEnvSecret,
  mcpDeleteEnvSecret,
  mcpStoreOAuthClientSecret,
  mcpDeleteOAuthClientSecret,
  mcpOAuthAuthorize,
  mcpOAuthLogout,
  MCP_RUNTIME_EVENT_NAME,
  mcpRuntimeGetSnapshot,
  mcpRuntimeConnect,
  mcpRuntimeDisconnect,
  mcpRuntimeRefreshCatalog,
  mcpRuntimeCallTool,
  mcpRuntimeCancelOperation,
} from "./ipc/mcp";

export {
  skillsList,
  skillsGet,
  skillsInstallFromLocalPath,
  skillsCreateTemplate,
  skillsOpenLocation,
  skillsReadResource,
  skillsRunScript,
} from "./ipc/skills";

export {
  terminalCreateSession,
  terminalRun,
  terminalRead,
  terminalKill,
  terminalListTabs,
  terminalCreateTab,
  terminalStartCommandTab,
  terminalReconnectTab,
  terminalReadTab,
  terminalUpdateTabMetadata,
  terminalWriteInput,
  terminalResize,
  terminalExecuteCommand,
  terminalInterrupt,
  terminalClearTab,
  terminalCloseTab,
} from "./ipc/terminal";

export {
  configGetSnapshot,
  configGetDocument,
  configGetSchema,
  configValidateDocument,
  configApplyPatch,
  configApplyAgentPatch,
  configResetPath,
  configReload,
  configOpenDirectory,
  configAcceptPendingChange,
  configRejectPendingChange,
  configListPendingChanges,
  configListOrphanSecrets,
  configDeleteOrphanSecret,
  configAgentList,
  configAgentGet,
  configAgentValidate,
  configAgentPatch,
} from "./ipc/config";

export type {
  OrphanSecretDto,
} from "./ipc/config.types";

export type {
  WebSearchSecretStatus,
  NativeWebSearchResult,
  NativeWebFetchResource,
} from "./ipc/web.types";

export {
  webSearchGetSecretStatus,
  webSearchSetSecret,
  webSearchExecute,
  webFetchExecute,
  cancelWebSearchExecution,
} from "./ipc/web";

export type {
  StateSnapshotDto,
} from "./ipc/state.types";

export {
  stateGetSnapshot,
  stateSetValue,
  stateDeleteValue,
  stateClear,
} from "./ipc/state";

export {
  updaterTarget,
  appUpdateStatus,
  appUpdateCheckAndStage,
  appUpdateExitAfterCleanShutdown,
  appExitCleanly,
  appUpdateDiscard,
  appUpdateInstallNow,
  appInstallerCloseRequestPending,
  appInstallerCloseRespond,
} from "./ipc/updates";

export type {
  NativeStagedUpdateDto,
  NativeAppUpdateSnapshotDto,
} from "./ipc/updates.types";

export {
  isTauriAvailable,
  isRemoteBackendAvailable,
  safeInvoke,
} from "./ipc/runtime";

export type {
  LocalBackupStatus,
} from "./ipc/backup.types";

export {
  localBackupSchedule,
  localBackupStatus,
  localBackupAcknowledge,
} from "./ipc/backup";

export type {
  MCPCatalogDto,
  MCPProtocolEra,
  MCPProtocolMode,
  MCPRuntimeEvent,
  MCPRuntimeKey,
  MCPRuntimeSelector,
  MCPRuntimeServerSnapshot,
  MCPRuntimeSnapshotDto,
  MCPRuntimeStatus,
} from "./contracts/serviceProvider";
