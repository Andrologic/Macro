/**
 * Public, type-safe Tauri IPC facade.
 * Domain implementations and DTOs live in ./ipc; transports stay in tauriRuntimeBridge.
 */

export type {
DbArchitectPlanConversationSync,DbChatBootstrapSnapshot,DbChatSnapshot,DbConversation,DbConversationCitation,DbConversationCompactionState,DbConversationToolboxState,DbImportMessageInput,DbInsertConversationCompactionEventInput,DbMessage,DbUpsertArchitectPlanConversationSyncInput,DbUpsertConversationCitationInput,DbUpsertConversationCompactionStateInput,DbUpsertConversationToolboxStateInput,MessageSearchPage,MessageSearchResult
} from "./ipc/conversations.types";

export type {
DbInitializationStatusDto
} from "./ipc/database.types";

export type {
CompleteToolInvocationInput,RecordToolInvocationInput,
RecordToolInvocationResult,ToolEffectClass,ToolInvocation,
ToolInvocationIdentity,
ToolInvocationStatus
} from "../types/generated/ipc";

export type {
ActivateConversationGoalInput,ApplyConversationGoalVerdictInput,
ClaimConversationGoalAuditInput,ConversationGoal,ConversationGoalAudit,
DeactivateConversationGoalInput,GoalAuditStatus,GoalAuditTransition,GoalCasOutcome,GoalStatus,GoalVerdict,RecordGoalAuditTransitionInput,ResumeConversationGoalAuditInput,UpdateConversationGoalInput
} from "../types/generated/ipc";
export {
activateConversationGoal,applyConversationGoalVerdict,createNativeGoalAuditVerdictPort,deactivateConversationGoal,
getConversationGoalAudit,getCurrentConversationGoal,listConversationGoalAudits,
listRecoverableConversationGoalAudits,updateConversationGoal
} from "./ipc/conversationGoals";
export {
executeGoalAuditorRead,linkGoalAuditChildConversation,recordGoalAuditTransition,reserveGoalAuditChildConversation
} from "./ipc/goalAudit";
export type { GoalAuditorReadInput } from "./ipc/goalAudit";

export type {
DbAiModel,DbProviderConfig,DbProviderModelInput,DbProviderSettings
} from "./ipc/providers.types";

export type {
DirectReviewSnapshotDto,GitAvailableTaskBranchDto,GitAvailableWorktreeDto,GitBranchDto,GitBranchWorktreeEnsureDto,GitBranchWorktreeInspectionDto,GitBranchWorktreeRemoveDto,GitBranchesDto,GitConflictFileDto,GitConflictFileSideDto,GitFilePairDto,GitFileStatus,GitGuardedMergeStateDto,GitLogPageDto,GitMergeCheckDto,GitPreparedBranchSyncDto,GitRebaseCheckDto,GitRemoteDto,GitReviewChangeDto,GitReviewDiffHunkDto,GitReviewDiffLineDto,GitReviewFileDto,GitReviewParsedDiffDto,GitReviewSnapshotDto,GitStartMergeResolutionDto,GitStatusDto,GitSyncDto,GitTaskStartPointsDto,GitWorkflowSessionDto,GitWorkflowSessionIdentity,GitWorktreeEnsureDto,GitWorktreeEnsureStatus,
GitWorktreeInspectionDto,GitWorktreeInspectionStatus,GitWorktreeRemoveDto
} from "./ipc/git.types";

export type {
MacroBranchSyncDto,MacroSyncNextAction,MacroSyncReason,MacroSyncState
} from "./ipc/metadataSync.types";

export type {
AiAuthCancelledEvent,
AiAuthErrorEvent,AiAuthStartedEvent,
AiAuthSuccessEvent,AiChatMessage,AiChatMessageContent,AiChatMessageImageUrl,
AiChatMessagePart,AiStreamChunkEvent,AiStreamDoneEvent,
AiStreamErrorEvent,
AiStreamTimelineEvent,AiStreamToolTraceEvent,AiToolCall,AiToolRequestEvent,CopilotAuthCancelledEvent,CopilotAuthCompleteEvent,CopilotAuthErrorEvent,CopilotAuthProgressEvent,CopilotDownloadCompleteEvent,
CopilotDownloadErrorEvent,CopilotDownloadProgressEvent,CopilotStatusDto,DevProviderOverrideConfig,
DevProviderOverridesFile,MacroAiProvisioningStatusDto
} from "./ipc/ai.types";

export type {
DbAppSetting,
DbCompareAndSwapAppSettingResult,
DbProjectContextState,DbProjectRegistryRepairReport,DbSessionContextState
} from "./ipc/settings.types";

export type {
ExternalAppCatalogDto,ExternalAppKind,
ExternalAppOptionDto,ExternalOpenAction
} from "./ipc/externalApps.types";

export type {
DebugResetProjectReportDto,ProjectIconDto,
ProjectIconResolutionDto,ProjectRegistryDiagnosticsDto,ProjectRegistryRepairReportDto,WorkspaceArchitectChatMessageDto,WorkspaceArchitectPlanActivationHeadDto,WorkspaceArchitectPlanListDto,WorkspaceArchitectPlanRecordDto,WorkspaceArchitectPlanReplicaDto,WorkspaceArchitectPlanRuntimeStatusDto,WorkspaceArchitectPlanSummaryDto,WorkspaceArchitectPlanTranscriptDto,WorkspaceBootstrapDto,WorkspaceManualFeatureDto,WorkspaceManualFeatureExecutionTargetDto,WorkspaceManualFeatureMergeWorkflowDto,WorkspaceManualFeatureMergeWorkflowRepositoryDto,WorkspaceMetadataDto,WorkspaceMetadataRecoveryHintDto,
WorkspaceMetadataRecoveryReportDto,WorkspaceProjectRegistryReconcileReportDto,WorkspaceProjectRegistryReconcileSkippedDto
} from "./ipc/workspace.types";

export {
aiCancelChatGptAuth,aiCancelCopilotAuth,aiCancelCopilotRuntimeDownload,aiCancelStream,aiDisconnectProviderAuth,aiDownloadCopilotRuntime,aiGetCopilotStatus,aiGetDevProviderOverrides,aiProvisionMacroAi,aiStartChatGptAuth,aiStartCopilotAuth,aiStreamChat,aiSubmitToolResult,aiSyncProviderModels,parseProviderInputItemsJson,
parseProviderTurnStateJson,
parseToolTracesJson
} from "./ipc/ai";

export type {
FsDirEntryDto,FsFileContentDto,FsFileStatsDto,
FsWriteResultDto,WorkspaceFileSearchResultDto,WorkspaceFileSearchRootDto
} from "./ipc/filesystem.types";

export type {
RepositoryInstructionIssueDto,
RepositoryInstructionLoadResultDto,RepositoryInstructionProjectInputDto,
RepositoryInstructionSourceDto
} from "./ipc/repositoryInstructions.types";

export type {
ToolModePolicyDto,ToolValidationResultDto,WorkspaceScope
} from "./ipc/workspaceTools.types";

export type {
MCPCallToolResponseDto
} from "./ipc/mcp.types";

export type {
SkillDetailResponseDto,SkillListResponseDto,SkillResourceReadResponseDto
} from "./ipc/skills.types";

export type {
TerminalOutputEvent,TerminalPromptContextInput,TerminalSessionDto,
TerminalTabDto
} from "./ipc/terminal.types";

export type {
AppDiagnosticReportPreviewDto,FrontendLogLevel,
FrontendLogParams
} from "./ipc/diagnostics.types";

export {
directAcceptChanges,directCheckpointEnsure,
directCheckpointRemove,
directCheckpointResolveId,directRestoreWorktreePaths,directReviewFile,directReviewSnapshot,directStagePaths,
directUnstagePaths,gitAbortMerge,gitAcceptConflictSide,gitAdd,gitBranchCreate,
gitBranchDelete,
gitBranchDeleteRemote,gitBranchList,gitBranchWorktreeCreate,gitBranchWorktreeInspect,gitBranchWorktreeRemove,gitCancelReview,gitCheckout,gitCommit,gitCompleteMerge,gitDiff,gitFastForward,gitFetch,gitGetTree,gitGuardedBranchSync,gitGuardedMergeState,gitLog,
gitLogPage,gitMerge,gitMergeCheck,gitPrepareGuardedBranchSync,gitPull,gitPush,gitReadConflictFile,gitReadFilePair,gitRebaseBranch,gitRebaseCheck,gitRemoteAddOrigin,gitReset,gitRestorePaths,gitReviewFile,gitReviewSnapshot,gitStartMergeResolution,gitStash,gitStatus,gitTaskStartPoints,gitWorkflow,
gitWorkflowCleanup,gitWorktreeCreate,gitWorktreeInspect,gitWorktreeRemove,gitWriteConflictResolution
} from "./ipc/git";

export {
appDiagnosticGenerate,
appDiagnosticSave,frontendLog
} from "./ipc/diagnostics";

export {
getDatabaseInitializationStatus,
retryDatabaseInitialization
} from "./ipc/database";

export {
completeToolInvocation,listUnresolvedToolInvocations,markToolInvocationUnknown,recordToolInvocation
} from "./ipc/toolInvocations";

export {
createConversation,createMessage,dbCompleteConversationReplay,dbDeleteArchitectPlanConversationSync,dbDeleteConversationCompactionState,dbFinalizeConversationReplay,dbGetArchitectPlanConversationSync,
dbGetArchitectPlanConversationSyncForPlan,dbGetConversationCompactionState,dbInsertConversationCompactionEvent,dbMarkConversationReplayLaunched,dbPrepareConversationReplay,
dbRestoreConversationReplay,dbTrimConversationReplay,dbUpsertArchitectPlanConversationSync,dbUpsertConversationCompactionState,deleteConversation,deleteConversationCitation,
deleteConversationCitations,deleteConversationToolboxState,deleteConversationTurn,deleteConversations,deleteMessagesAfter,getChatBootstrapSnapshot,getChatSnapshot,getConversation,getConversationCitationContent,getConversationSourceSnapshot,getConversationToolboxState,importMessages,listConversationCitations,listConversations,listMessages,renameConversation,searchMessages,togglePinConversation,updateConversationAISelection,updateConversationDetails,
updateConversationScope,updateMessage,upsertConversationCitation,upsertConversationToolboxState
} from "./ipc/conversations";

export {
fsCopy,fsCreateDir,fsDelete,fsExists,fsListDir,fsMove,fsReadFile,
fsReadFileWithOptions,fsSearchFiles,
fsStat,fsWriteFile
} from "./ipc/filesystem";

export {
repositoryInstructionsLoad
} from "./ipc/repositoryInstructions";

export {
createProviderConfig,deleteManualModel,deleteProviderConfig,getProviderConfig,getProviderSettings,listProviderConfigs,listProviderModels,registerManualModel,revealProviderApiKey,setAllProviderModelsEnabled,setProviderModelEnabled,updateManualModel,updateProviderConfig,updateProviderSettings,upsertProviderModels
} from "./ipc/providers";

export {
createSpeechProviderConfig,deleteSpeechProviderConfig,listSpeechProviderConfigs,transcribeSpeech,updateSpeechProviderConfig
} from "./ipc/speech";

export {
macroBranchCommitIfDirty,macroBranchEnsure,macroBranchPull,macroBranchPush,macroBranchStatus
} from "./ipc/metadataSync";

export {
workspaceAcquirePlanLifecycleLock,workspaceAcquireTaskLifecycleLock,workspaceArchitectActivatePlanChat,workspaceArchitectActivatePlanHead,workspaceArchitectInvalidate,workspaceArchitectListPlans,workspaceArchiveManualFeature,workspaceArchiveProject,workspaceArchiveProjectGroup,workspaceBindManualFeatureDirectCheckpoint,workspaceCancelProjectOperation,workspaceCloseProject,workspaceCreateManualFeatureDraft,workspaceCreateNewProjectRepo,workspaceCreateProject,workspaceCreateProjectGroup,workspaceCreateProjectWithGitSetup,workspaceDebugResetProject,workspaceDeleteManualFeature,workspaceDeleteManualFeatureDraft,workspaceDiscoverRecoverableProjects,workspaceFinalizeManualFeature,workspaceGetActiveRoot,workspaceGetBootstrap,workspaceGetMetadata,workspaceGetProjectRegistryDiagnostics,workspaceImportGitRepo,workspaceListProjects,
workspaceListTasks,workspaceMoveProjectToGroup,workspacePreviewProjectAccessChange,workspacePreviewProjectGitSetup,workspaceQuarantineLegacyStateLock,workspaceReconcileProjectRegistryFromHints,workspaceRecoverMissingMetadata,workspaceReleasePlanLifecycleLock,workspaceReleaseTaskLifecycleLock,workspaceRemoveProject,workspaceRemoveProjectGroup,workspaceRenameManualFeature,workspaceRenameProject,workspaceRenameProjectGroup,workspaceRenewPlanLifecycleLock,workspaceRenewTaskLifecycleLock,workspaceResolveProjectIcons,workspaceRestoreManualFeature,workspaceRestoreProject,workspaceRestoreProjectGroup,workspaceRevertManualFeatureToDraft,workspaceSetActiveRoot,workspaceUpdateManualFeatureMergeWorkflow,workspaceUpdateProjectAccess,workspaceUpdateProjectGitFlow,workspaceUpdateProjectGitFlowWithSetup,workspaceUpdateStandaloneTaskStatus
} from "./ipc/workspace";

export {
dbCompareAndSwapAppSetting,dbDeleteAppSetting,dbDeleteProjectContextState,dbGetAppSetting,dbGetProjectContextState,dbGetSessionContextState,dbGetSetting,dbReconcileProjectRegistry,dbSetAppSetting,dbSetSetting,dbUpsertProjectContextState,dbUpsertSessionContextState
} from "./ipc/settings";

export {
listExternalApps,openExternalTarget
} from "./ipc/externalApps";

export {
cancelWorkspaceTool,executeWorkspaceTool,getToolModePolicy,validateToolExecution
} from "./ipc/workspaceTools";

export {
MCP_RUNTIME_EVENT_NAME,mcpDeleteEnvSecret,mcpDeleteOAuthClientSecret,
mcpOAuthAuthorize,
mcpOAuthLogout,mcpRuntimeCallTool,
mcpRuntimeCancelOperation,mcpRuntimeCloseInteractionPort,mcpRuntimeConnect,
mcpRuntimeDisconnect,mcpRuntimeGetSnapshot,mcpRuntimeListPendingInteractions,mcpRuntimeOpenInteractionPort,mcpRuntimeRefreshCatalog,mcpRuntimeRespondToInteraction,mcpStoreEnvSecret,mcpStoreOAuthClientSecret
} from "./ipc/mcp";

export {
skillsCreateTemplate,skillsGet,
skillsInstallFromLocalPath,skillsList,skillsOpenLocation,
skillsReadResource,
skillsRunScript
} from "./ipc/skills";

export {
terminalClearTab,
terminalCloseTab,terminalCreateSession,terminalCreateTab,terminalExecuteCommand,
terminalInterrupt,terminalKill,
terminalListTabs,terminalRead,terminalReadTab,terminalReconnectTab,terminalResize,terminalRun,terminalStartCommandTab,terminalUpdateTabMetadata,
terminalWriteInput
} from "./ipc/terminal";

export {
configAcceptPendingChange,configAgentGet,configAgentList,configAgentPatch,configAgentValidate,configApplyAgentPatch,configApplyPatch,configDeleteOrphanSecret,configGetDocument,
configGetSchema,configGetSnapshot,configListOrphanSecrets,configListPendingChanges,configOpenDirectory,configRejectPendingChange,configReload,configResetPath,configValidateDocument
} from "./ipc/config";

export type {
OrphanSecretDto
} from "./ipc/config.types";

export type {
NativeWebFetchResource,NativeWebSearchResult,WebSearchSecretStatus
} from "./ipc/web.types";

export {
cancelWebSearchExecution,webFetchExecute,webSearchExecute,webSearchGetSecretStatus,
webSearchSetSecret
} from "./ipc/web";

export type {
StateSnapshotDto
} from "./ipc/state.types";

export {
stateClear,stateDeleteValue,stateGetSnapshot,
stateSetValue
} from "./ipc/state";

export {
appExitCleanly,appShutdownActiveRuns,appShutdownPrepare,appInstallerCloseRequestPending,
appInstallerCloseRespond,appUpdateCheckAndStage,appUpdateDiscard,appUpdateExitAfterCleanShutdown,appUpdateInstallNow,appUpdateStatus
} from "./ipc/updates";

export type {
NativeAppUpdateSnapshotDto,NativeStagedUpdateDto
} from "./ipc/updates.types";

export {
isRemoteBackendAvailable,isTauriAvailable,safeInvoke
} from "./ipc/runtime";

export type {
LocalBackupStatus
} from "./ipc/backup.types";

export {
localBackupAcknowledge,localBackupSchedule,
localBackupStatus,getProfileStartupRecovery
} from "./ipc/backup";

export type {
MCPCatalogDto,
MCPProtocolEra,
MCPProtocolMode,
MCPRuntimeEvent,MCPRuntimeKey,
MCPRuntimeSelector,
MCPRuntimeServerSnapshot,
MCPRuntimeSnapshotDto,
MCPRuntimeStatus,McpInteractionRequest,
McpInteractionResponse
} from "./contracts/serviceProvider";

export { executionModelChoices,preflightExecution,stopExecution } from './ipc/agsdlExecution';
export { httpReleaseWebviewResource } from "./ipc/httpResources";



export { closeExecutionIntentVersioned,readExecutionIntentVersioned,readExecutionIntentsVersioned,stageExecutionIntentVersioned,submitExecutionIntentVersioned } from './ipc/agsdlExecutionIntentVersioned';

export * from "./ipc/pilot";

export { conversationAcknowledge,conversationAction,conversationImportArchives,conversationMetadata,conversationResponseVersion,conversationSetArchives,getMessage,getPilotReflectionMessage,listMessagesBounded } from './ipc/conversationManagement';
export type { ConversationActionInput,ConversationActionResult,ConversationMetadata,PilotReflectionMessage,PilotReflectionMessageRead,PilotReflectionToolAnchor } from './ipc/conversationManagement';

export type { HostTelemetryAvailability,HostTelemetryDto,HostTelemetryReason } from "../types/generated/ipc";

export { hostTelemetryRead } from "./ipc/hostTelemetry";

export * from "./ipc/pilotFiles";
export * from "./ipc/connectArchive";

export * from './ipc/conversationContent';

export * from './ipc/conversationCatalog';

export * from './ipc/chatAdmission';

// Versioned transport uses the same native Start/snapshot commands and rejects
// a historical snapshot. Native qualification still gates 0.3 admission.
export type { ExecutionRunCorrelation030 } from '../types/generated/ipc';
export { architectLaunch } from './ipc/architectLaunch';
export { listExecutionRuns030,readExecutionHumans030,readExecutionRunCorrelation030,readExecutionRuntimeProjection030,readExecutionSnapshot030,startExecution030,stopExecution030,submitExecutionHuman030 } from './ipc/agsdlExecution030';
export type { PublicSnapshot030,PublicStartReceipt030,StartRequest030 } from './ipc/agsdlExecution030';

export { deliverExecution030, updateOperateInbox } from './ipc/agsdlExecution030';

export * from "./ipc/architectLibrary";
