//! Authoritative native wire contracts grouped by domain.
//! These reexports expose data shapes, not application execution or transport authority.

pub mod db {
    pub use crate::db::models::{
        AgentRun, AgentRunStatus, AgentRunUsageInput, AiModel, AppSettingRecord,
        ArchitectPlanConversationSyncRecord, CancelAgentRunInput, ChatBootstrapSnapshot,
        ChatSnapshot, CompareAndSwapAppSettingResult, CompleteAgentRunInput, Conversation,
        ConversationCitation, ConversationCompactionStateRecord, ConversationToolboxStateRecord,
        CreateAgentRunInput, CreateConversationInput, CreateGitRepositoryInput,
        CreateGitWorktreeInput, CreateMessageInput, FailAgentRunInput, GitRepositoryRecord,
        GitWorktreeRecord, ImportMessageInput, InsertConversationCompactionEventInput, Message,
        MessageSearchPage, MessageSearchResult, ProjectContextStateRecord,
        ProjectRegistryDbRepairReport, ProviderAuthMetadata, ProviderConfig, ProviderModelInput,
        ProviderSettings, ReconcileProjectRegistryInput, SessionContextStateRecord,
        SpeechProviderConfig, TerminalTabRecord, TimeOutAgentRunInput, UpdateProviderConfigInput,
        UpsertArchitectPlanConversationSyncInput, UpsertConversationCitationInput,
        UpsertConversationCompactionStateInput, UpsertConversationToolboxStateInput,
        UpsertProjectContextStateInput, UpsertSessionContextStateInput,
    };
    pub use crate::db::tool_invocations::{
        CompleteToolInvocationInput, RecordToolInvocationInput, RecordToolInvocationResult,
        ToolEffectClass, ToolInvocation, ToolInvocationIdentity, ToolInvocationStatus,
    };
}

pub mod workspace {
    pub use crate::workspace::metadata::{
        CreateNewProjectRepoRequest, CreateProjectRequest, DebugResetProjectReportDto,
        ImportGitRepoRequest, ManualFeatureDto, ManualFeatureMergeWorkflowDirtyFileDto,
        ManualFeatureMergeWorkflowDto, ManualFeatureMergeWorkflowGitSessionDto,
        ManualFeatureMergeWorkflowRepositoryDto, PlanDto, PlanNodeDto, PredictedBranchDto,
        ProjectAccessChangePreviewDto, ProjectAccessMigrationItemDto,
        ProjectAccessMigrationSummaryDto, ProjectDto, ProjectGitFlowDetectionDto,
        ProjectGitFlowSettingsDto, ProjectGitSetupCommitResultDto, ProjectGroupDto,
        ProjectMetadataDto, ProjectRegistryDiagnosticsDto, ProjectRegistryRepairReportDto,
        WorkspaceArchitectActivatePlanChatRequestDto, WorkspaceArchitectActivatePlanHeadRequestDto,
        WorkspaceArchitectChatMessageDto, WorkspaceArchitectListPlansRequestDto,
        WorkspaceArchitectPlanActivationHeadDto, WorkspaceArchitectPlanListDto,
        WorkspaceArchitectPlanRecordDto, WorkspaceArchitectPlanReplicaDto,
        WorkspaceArchitectPlanRuntimeStatusDto, WorkspaceArchitectPlanSummaryDto,
        WorkspaceArchitectPlanTranscriptDto, WorkspaceBootstrapDto, WorkspaceMetadataDto,
        WorkspaceMetadataRecoveryHintDto, WorkspaceMetadataRecoveryReportDto,
        WorkspaceProjectRegistryReconcileReportDto, WorkspaceProjectRegistryReconcileSkippedDto,
        WorkspaceReconcileProjectRegistryFromHintsRequestDto,
        WorkspaceReconcileProjectRegistryFromKnownParentsRequestDto,
        WorkspaceRecoverMissingMetadataRequestDto, WorkspaceState, WorkspaceTaskCatalogDto,
        WorkspaceTaskExecutionTargetDto, WorkspaceTaskPlanSummaryDto,
    };
}

pub mod files {
    pub use crate::fs::dto::{
        DirEntryDto, FileContentDto, FileStatsDto, FsEventDto, WorkspaceFileSearchResultDto,
        WorkspaceFileSearchRootDto, WriteResultDto,
    };
}

pub mod chat {
    pub use crate::ai::types::{
        AiAuthCancelledEvent, AiAuthErrorEvent, AiAuthStartedEvent, AiAuthSuccessEvent,
        AiChatImageUrl, AiChatMessage, AiChatMessageContent, AiChatMessagePart, AiChatRequest,
        AiProjectMount, AiStreamChunkEvent, AiStreamDoneEvent, AiStreamErrorEvent,
        AiStreamTimelineEvent, AiStreamToolTraceEvent, AiToolCall, AiToolCallFunction, AiToolTrace,
    };
}

pub mod copilot {
    pub use crate::ai::copilot::protocol::{
        BridgeHealthResult, BridgeModelsResponse, BridgeSendEvent, BridgeToolResultMessage,
    };
    pub use crate::ai::copilot::{
        CopilotAuthCancelledEvent, CopilotAuthCompleteEvent, CopilotAuthErrorEvent,
        CopilotAuthProgressEvent, CopilotDownloadCompleteEvent, CopilotDownloadErrorEvent,
        CopilotDownloadProgressEvent, CopilotStatus, CopilotToolRequestEvent,
        CopilotToolResultRequest,
    };
}

pub mod provider {
    pub use crate::ai::macro_ai::MacroAiProvisioningStatus;
}

pub mod skills {
    pub use crate::commands::skills::{
        SkillDetailResponse, SkillDiagnosticDto, SkillListResponse, SkillLocationDto,
        SkillManifestDto, SkillProjectRootDto, SkillResourceDto, SkillResourceReadResponse,
        SkillScriptRunResponse, SkillScriptWorkspaceDto, SkillSourceDto,
        SkillTemplateCreateRequest, SkillTemplateCreateResponse,
    };
}

pub mod mcp {
    pub use crate::commands::mcp::{
        McpCallToolResponse, McpCatalogDto, McpDiscoverToolsResponse, McpElicitationAction,
        McpElicitationAnswer, McpElicitationPrompt, McpInteractionRequest, McpInteractionResponse,
        McpProtocolEra, McpProtocolMode, McpRuntimeKey, McpRuntimeSelector,
        McpRuntimeServerSnapshot, McpRuntimeSnapshotDto, McpRuntimeStatus, McpServerDto,
        McpToolDto, McpTransportDto,
    };
}

pub mod terminal {
    pub use crate::commands::terminal::{
        TerminalOutputEvent, TerminalPromptContext, TerminalSessionDto, TerminalTabDto,
    };
}

pub mod speech {
    pub use crate::commands::speech::UpdateSpeechProviderParams;
}

pub mod web {
    pub use crate::commands::web_search::{
        WebFetchResourceDto, WebSearchResultDto, WebSearchSecretInput, WebSearchSecretStatus,
    };
}

pub mod instructions {
    pub use crate::commands::repository_instructions::{
        RepositoryInstructionIssue, RepositoryInstructionLoadInput,
        RepositoryInstructionLoadResult, RepositoryInstructionProjectInput,
        RepositoryInstructionSource,
    };
}

pub mod external {
    pub use crate::commands::{ExternalAppCatalogDto, ExternalAppOptionDto};
}

pub mod development {
    pub use crate::dev_overrides::{DevProviderOverrideConfig, DevProviderOverridesFile};
}

pub mod speech_result {
    pub use crate::speech::TranscriptionResult;
}

pub mod state {
    pub use crate::state_manager::StateSnapshot;
}

pub mod updates {
    pub use crate::app_updates::{AppUpdateSnapshot, StagedUpdateManifest, StagedUpdatePhase};
}

pub mod backup {
    pub use crate::local_backup::{BackupStatus, BackupStatusCode};
}

pub mod icons {
    pub use crate::project_icon::{ProjectIconDto, ProjectIconResolutionDto};
}

pub mod config_extra {
    pub use crate::config::{DeleteOrphanSecretRequest, OrphanSecretDto};
}

pub mod errors {
    pub use crate::core::command_error::CommandErrorPayload;
}

pub mod tools {
    pub use crate::core::tool_policy::{ToolModePolicyResult, ToolValidationResult};
}

pub mod diagnostics {
    pub use crate::diagnostics::DiagnosticReportPreview;
}

#[cfg(test)]
mod tests;

pub mod git {
    pub use crate::git::operations::{
        GitBranch, GitCommitDto, GitFilePairDto, GitFileStatus, GitMergeCheckDto, GitNode,
        GitStartMergeResolutionDto, GitStatusDto, PredictedGitTreeDto,
    };
}

pub mod git_commands {
    pub use crate::commands::git::{
        DirectReviewSnapshotDto, GitAvailableTaskBranchDto, GitAvailableWorktreeDto,
        GitBranchWorktreeEnsureDto, GitBranchWorktreeInspectionDto, GitBranchWorktreeRemoveDto,
        GitBranchesDto, GitConflictFileDto, GitConflictFileSideDto, GitGuardedMergeStateDto,
        GitLogPageDto, GitPreparedBranchSyncDto, GitRebaseCheckDto, GitRemoteDto,
        GitReviewChangeDto, GitReviewDiffHunkDto, GitReviewDiffLineDto, GitReviewFileDto,
        GitReviewParsedDiffDto, GitReviewSnapshotDto, GitSyncDto, GitTaskStartPointsDto,
        GitWorktreeEnsureDto, GitWorktreeInspectionDto, GitWorktreeRemoveDto, MacroBranchSyncDto,
    };
}

pub mod workflow {
    pub use crate::git::operations::workflow::{GitWorkflowSessionDto, GitWorkflowSessionIdentity};
}

pub mod command_inputs {
    pub use crate::commands::{
        DbCreateMessageParams, DbInitializationStatusDto, DbPrepareConversationReplayParams,
        DbUpdateMessageParams, DbUpdateProviderConfigParams, ManualModelReasoningInput,
    };
}

pub mod mounts {
    pub use crate::core::workspace_execution::workspace_tools::WorkspaceProjectMount;
}
