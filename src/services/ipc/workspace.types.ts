import type {
DebugResetProjectReportDto as NativeDebugResetProjectReportDto,
ProjectIconDto as NativeProjectIconDto,
ProjectIconResolutionDto as NativeProjectIconResolutionDto,
ProjectRegistryDiagnosticsDto as NativeProjectRegistryDiagnosticsDto,
ProjectRegistryRepairReportDto as NativeProjectRegistryRepairReportDto,
WorkspaceArchitectChatMessageDto as NativeWorkspaceArchitectChatMessageDto,
WorkspaceArchitectPlanActivationHeadDto as NativeWorkspaceArchitectPlanActivationHeadDto,
WorkspaceArchitectPlanListDto as NativeWorkspaceArchitectPlanListDto,
WorkspaceArchitectPlanRecordDto as NativeWorkspaceArchitectPlanRecordDto,
WorkspaceArchitectPlanReplicaDto as NativeWorkspaceArchitectPlanReplicaDto,
WorkspaceArchitectPlanRuntimeStatusDto as NativeWorkspaceArchitectPlanRuntimeStatusDto,
WorkspaceArchitectPlanSummaryDto as NativeWorkspaceArchitectPlanSummaryDto,
WorkspaceArchitectPlanTranscriptDto as NativeWorkspaceArchitectPlanTranscriptDto,
WorkspaceBootstrapDto as NativeWorkspaceBootstrapDto,
ManualFeatureDto as NativeWorkspaceManualFeatureDto,
WorkspaceTaskExecutionTargetDto as NativeWorkspaceManualFeatureExecutionTargetDto,
ManualFeatureMergeWorkflowDto as NativeWorkspaceManualFeatureMergeWorkflowDto,
ManualFeatureMergeWorkflowRepositoryDto as NativeWorkspaceManualFeatureMergeWorkflowRepositoryDto,
WorkspaceMetadataDto as NativeWorkspaceMetadataDto,
WorkspaceMetadataRecoveryHintDto as NativeWorkspaceMetadataRecoveryHintDto,
WorkspaceMetadataRecoveryReportDto as NativeWorkspaceMetadataRecoveryReportDto,
WorkspaceProjectRegistryReconcileReportDto as NativeWorkspaceProjectRegistryReconcileReportDto,
WorkspaceProjectRegistryReconcileSkippedDto as NativeWorkspaceProjectRegistryReconcileSkippedDto
} from '../../types/generated/ipc';
import type { OmitFields, OptionalFields } from './compatibility.types';

/** workspace IPC contracts and explicit frontend adaptations of generated native bindings. */

import type {
Plan,
PlanNode,
PredictedBranch,
Project,
ProjectGroup,
} from "../../types";
import type { GitWorkflowSessionDto } from "./git.types";

/** Frontend compatibility: preserves adapted fields and omission rules; exposes the existing public view. */
export type ProjectRegistryRepairReportDto = OptionalFields<OmitFields<NativeProjectRegistryRepairReportDto, "manual_features_removed" | "manual_feature_targets_removed" | "project_access_states_updated">, "singleton_groups_migrated">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type ProjectRegistryDiagnosticsDto = OmitFields<NativeProjectRegistryDiagnosticsDto,
  | "rawStandaloneProjects"
  | "rawProjectGroups"
  | "sanitizedStandaloneProjects"
  | "sanitizedProjectGroups"
  | "repairReport"
> & {
  rawStandaloneProjects?: Project[];
  rawProjectGroups: ProjectGroup[];
  sanitizedStandaloneProjects?: Project[];
  sanitizedProjectGroups: ProjectGroup[];
  repairReport: ProjectRegistryRepairReportDto;
};

export type WorkspaceMetadataRecoveryHintDto = NativeWorkspaceMetadataRecoveryHintDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceMetadataRecoveryReportDto = OptionalFields<OmitFields<NativeWorkspaceMetadataRecoveryReportDto, "status">, "restoredCommit" | "message"> & {
  status:
    | "none"
    | "restored_from_history"
    | "reconstructed_from_hints"
    | "blocked_dirty"
    | "blocked_conflict";
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceProjectRegistryReconcileSkippedDto = OptionalFields<NativeWorkspaceProjectRegistryReconcileSkippedDto, "projectId">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceProjectRegistryReconcileReportDto = OmitFields<NativeWorkspaceProjectRegistryReconcileReportDto, "discoveredProjects" | "addedProjects" | "skippedProjects"> & {
  discoveredProjects: Project[];
  addedProjects: Project[];
  skippedProjects: WorkspaceProjectRegistryReconcileSkippedDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceBootstrapDto = OmitFields<NativeWorkspaceBootstrapDto,
  | "plan"
  | "standaloneProjects"
  | "projectGroups"
  | "planNodes"
  | "predictedBranches"
> & {
  plan: Plan | null;
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
};

export type ProjectIconDto = NativeProjectIconDto;

export type ProjectIconResolutionDto = NativeProjectIconResolutionDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceArchitectPlanReplicaDto = OptionalFields<NativeWorkspaceArchitectPlanReplicaDto, "updatedAt" | "missing">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceArchitectPlanSummaryDto = OptionalFields<OmitFields<NativeWorkspaceArchitectPlanSummaryDto, "gitFlowPlan" | "executionModesByProjectId" | "replicas">,
  | "label"
  | "planKind"
  | "archivedAt"
  | "archivedFromStatus"
  | "deletedAt"
  | "targetBranchesByProjectId"
  | "conversationId"
  | "projectId"
  | "projectIds"
  | "contextProjectIds"
  | "predictedBranchCount"
  | "chatMessageCount"
  | "expectedProjectIds"
  | "availableProjectIds"
  | "missingProjectIds"
  | "replicationState"
  | "revision"
  | "hasReplicaDivergence"
> & {
  gitFlowPlan?: unknown;
  executionModesByProjectId?: Record<string, "git" | "direct"> | null;
  replicas?: WorkspaceArchitectPlanReplicaDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceArchitectPlanRecordDto = OptionalFields<OmitFields<NativeWorkspaceArchitectPlanRecordDto,
  | "gitFlowPlan"
  | "executionModesByProjectId"
  | "nodes"
  | "predictedBranches"
  | "replicas"
>,
  | "label"
  | "planKind"
  | "archivedAt"
  | "archivedFromStatus"
  | "deletedAt"
  | "targetBranchesByProjectId"
  | "conversationId"
  | "projectId"
  | "projectIds"
  | "contextProjectIds"
  | "expectedProjectIds"
  | "availableProjectIds"
  | "missingProjectIds"
  | "replicationState"
  | "revision"
  | "hasReplicaDivergence"
> & {
  gitFlowPlan?: unknown;
  executionModesByProjectId?: Record<string, "git" | "direct"> | null;
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  replicas?: WorkspaceArchitectPlanReplicaDto[];
};

export type WorkspaceArchitectPlanRuntimeStatusDto = NativeWorkspaceArchitectPlanRuntimeStatusDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceArchitectPlanListDto = OptionalFields<OmitFields<NativeWorkspaceArchitectPlanListDto, "plans">, "runtimeStatus"> & {
  plans: WorkspaceArchitectPlanSummaryDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceArchitectPlanActivationHeadDto = OptionalFields<OmitFields<NativeWorkspaceArchitectPlanActivationHeadDto, "plan">, "replicaScopeKey" | "replicaProjectId"> & {
  plan: WorkspaceArchitectPlanRecordDto;
};

export type WorkspaceArchitectChatMessageDto = NativeWorkspaceArchitectChatMessageDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceArchitectPlanTranscriptDto = OptionalFields<NativeWorkspaceArchitectPlanTranscriptDto, "replicaScopeKey" | "replicaProjectId">;

export type WorkspaceMetadataDto = NativeWorkspaceMetadataDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceManualFeatureExecutionTargetDto = OptionalFields<OmitFields<NativeWorkspaceManualFeatureExecutionTargetDto, "executionMode" | "executionKind">,
  | "targetBranchName"
  | "checkpointId"
  | "baseCommitHash"
  | "repoPath"
> & {
  executionMode?: 'git' | 'direct' | null;
  executionKind?: 'worktree' | 'repository_root' | null;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceManualFeatureMergeWorkflowRepositoryDto = OptionalFields<OmitFields<NativeWorkspaceManualFeatureMergeWorkflowRepositoryDto, "workflowSession" | "repositoryRootPath" | "mergeStrategy">,
  | "integrationWorktreePath"
  | "mergeInProgress"
  | "hadChangesAtStart"
  | "mergeAppliedAt"
  | "blockingKind"
  | "blockingReason"
  | "conflictFiles"
  | "dirtyFiles"
  | "ahead"
  | "behind"
  | "isSourcePublished"
  | "recommendedAction"
  | "availableActions"
> & {
  workflowSession?: GitWorkflowSessionDto;
  repositoryRootPath?: string | null;
  mergeStrategy?: string;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceManualFeatureMergeWorkflowDto = OptionalFields<OmitFields<NativeWorkspaceManualFeatureMergeWorkflowDto, "repositories">, "lastLoadedAt" | "message"> & {
  repositories: WorkspaceManualFeatureMergeWorkflowRepositoryDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WorkspaceManualFeatureDto = OmitFields<NativeWorkspaceManualFeatureDto, "taskKind" | "executionTargets" | "mergeWorkflow"> & {
  taskKind: 'feature' | 'bugfix' | 'hotfix' | 'direct' | null;
  executionTargets: WorkspaceManualFeatureExecutionTargetDto[];
  mergeWorkflow?: WorkspaceManualFeatureMergeWorkflowDto | null;
};

export type DebugResetProjectReportDto = NativeDebugResetProjectReportDto;
