/** workspace IPC DTOs. Kept separate for generated Rust binding integration. */

import type {
  Plan,
  PlanNode,
  PredictedBranch,
  Project,
  ProjectGroup,
} from "../../types";
import type { GitWorkflowSessionDto } from "./git.types";

export interface ProjectRegistryRepairReportDto {
  duplicate_paths_removed: number;
  empty_groups_removed: number;
  singleton_groups_migrated?: number;
  removed_synthetic_groups: number;
  removed_synthetic_projects: number;
  mount_names_assigned: number;
  removed_group_ids: string[];
  removed_project_ids: string[];
  current_plan_project_ids_removed: number;
  current_plan_tasks_removed: number;
  current_plan_task_targets_removed: number;
  plan_nodes_removed: number;
  predicted_branches_removed: number;
  git_flow_settings_auto_updated: number;
}

export interface ProjectRegistryDiagnosticsDto {
  rawStandaloneProjects?: Project[];
  rawProjectGroups: ProjectGroup[];
  sanitizedStandaloneProjects?: Project[];
  sanitizedProjectGroups: ProjectGroup[];
  rawGroupCount: number;
  rawProjectCount: number;
  sanitizedGroupCount: number;
  sanitizedProjectCount: number;
  repairReport: ProjectRegistryRepairReportDto;
}

export interface WorkspaceMetadataRecoveryHintDto {
  projectId: string;
  groupId: string | null;
  name: string;
  path: string;
}

export interface WorkspaceMetadataRecoveryReportDto {
  status:
    | "none"
    | "restored_from_history"
    | "reconstructed_from_hints"
    | "blocked_dirty"
    | "blocked_conflict";
  restoredCommit?: string | null;
  pullAttempted: boolean;
  pullSucceeded: boolean;
  message?: string | null;
}

export interface WorkspaceProjectRegistryReconcileSkippedDto {
  projectId?: string | null;
  path: string;
  reason: string;
}

export interface WorkspaceProjectRegistryReconcileReportDto {
  status: "unchanged" | "reconciled" | string;
  discoveredProjects: Project[];
  addedProjects: Project[];
  skippedProjects: WorkspaceProjectRegistryReconcileSkippedDto[];
  duplicatePaths: string[];
  invalidPaths: string[];
}

export interface WorkspaceBootstrapDto {
  plan: Plan | null;
  standaloneProjects: Project[];
  projectGroups: ProjectGroup[];
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
}

export interface ProjectIconDto {
  dataUrl: string;
  sourcePath: string;
  revision: string;
}

export interface ProjectIconResolutionDto {
  projectId: string;
  icon: ProjectIconDto | null;
}

export interface WorkspaceArchitectPlanReplicaDto {
  scopeKey: string;
  projectId: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  source: "local" | "project" | "workspace" | string;
  updatedAt?: string | null;
  missing?: boolean;
}

export interface WorkspaceArchitectPlanSummaryDto {
  id: string;
  slug: string;
  title: string;
  label?: string | null;
  description: string;
  planKind?: string | null;
  gitFlowPlan?: unknown;
  status: string;
  archivedAt?: string | null;
  archivedFromStatus?: string | null;
  deletedAt?: string | null;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string> | null;
  executionModesByProjectId?: Record<string, "git" | "direct"> | null;
  conversationId?: string | null;
  projectId?: string | null;
  projectIds?: string[];
  contextProjectIds?: string[];
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  predictedBranchCount?: number | null;
  chatMessageCount?: number | null;
  expectedProjectIds?: string[];
  availableProjectIds?: string[];
  missingProjectIds?: string[];
  replicationState?: string | null;
  revision?: number | null;
  replicas?: WorkspaceArchitectPlanReplicaDto[];
  hasReplicaDivergence?: boolean;
}

export interface WorkspaceArchitectPlanRecordDto {
  id: string;
  slug: string;
  title: string;
  label?: string | null;
  description: string;
  planKind?: string | null;
  gitFlowPlan?: unknown;
  status: string;
  archivedAt?: string | null;
  archivedFromStatus?: string | null;
  deletedAt?: string | null;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string> | null;
  executionModesByProjectId?: Record<string, "git" | "direct"> | null;
  conversationId?: string | null;
  projectId?: string | null;
  projectIds?: string[];
  contextProjectIds?: string[];
  createdAt: string;
  updatedAt: string;
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  expectedProjectIds?: string[];
  availableProjectIds?: string[];
  missingProjectIds?: string[];
  replicationState?: string | null;
  revision?: number | null;
  replicas?: WorkspaceArchitectPlanReplicaDto[];
  hasReplicaDivergence?: boolean;
}

export interface WorkspaceArchitectPlanRuntimeStatusDto {
  branchName: string;
  branchGeneration: number;
  branchStamp: string;
  planCount: number;
  scopeCount: number;
  rebuilt: boolean;
}

export interface WorkspaceArchitectPlanListDto {
  activePlanId: string | null;
  plans: WorkspaceArchitectPlanSummaryDto[];
  runtimeStatus?: WorkspaceArchitectPlanRuntimeStatusDto | null;
}

export interface WorkspaceArchitectPlanActivationHeadDto {
  plan: WorkspaceArchitectPlanRecordDto;
  conversationId: string | null;
  sharedConversation: boolean;
  targetBranch: string;
  replicaScopeKey?: string | null;
  replicaProjectId?: string | null;
  resolutionMode: string;
  chatTranscriptRevision: string | null;
  chatMessageCount: number;
}

export interface WorkspaceArchitectChatMessageDto {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  createdAt: string;
}

export interface WorkspaceArchitectPlanTranscriptDto {
  planId: string;
  targetBranch: string;
  replicaScopeKey?: string | null;
  replicaProjectId?: string | null;
  transcriptRevision: string | null;
  messageCount: number;
  messages: WorkspaceArchitectChatMessageDto[];
}

export interface WorkspaceMetadataDto {
  workspace_path: string;
  metadata_path: string;
  project_count: number;
}

export interface WorkspaceManualFeatureExecutionTargetDto {
  projectId: string;
  branchName: string;
  targetBranchName?: string | null;
  executionMode?: 'git' | 'direct' | null;
  executionKind?: 'worktree' | 'repository_root' | null;
  checkpointId?: string | null;
  baseCommitHash?: string | null;
  worktreeKey: string;
  repoPath?: string | null;
}

export interface WorkspaceManualFeatureMergeWorkflowRepositoryDto {
  workflowSession?: GitWorkflowSessionDto;
  repositoryRootPath?: string | null;
  integrationWorktreePath?: string | null;
  mergeInProgress?: boolean;
  id: string;
  projectId: string;
  repoPath: string;
  sourceBranchName: string;
  targetBranchName: string;
  state: string;
  hadChangesAtStart?: boolean;
  mergeAppliedAt?: string | null;
  blockingKind?: string | null;
  blockingReason?: string | null;
  conflictFiles?: string[];
  dirtyFiles?: Array<{ path: string; status: string; area: string }>;
  ahead?: number;
  behind?: number;
  isSourcePublished?: boolean;
  mergeStrategy?: string;
  recommendedAction?: string | null;
  availableActions?: string[];
}

export interface WorkspaceManualFeatureMergeWorkflowDto {
  kind: string;
  phase: string;
  taskStatus: string;
  startedAt: string;
  updatedAt: string;
  lastLoadedAt?: string | null;
  message?: string | null;
  repositories: WorkspaceManualFeatureMergeWorkflowRepositoryDto[];
}

export interface WorkspaceManualFeatureDto {
  id: string;
  conversationId: string;
  draft: boolean;
  title: string;
  description: string;
  status: string;
  featureSlug: string | null;
  taskKind: 'feature' | 'bugfix' | 'hotfix' | 'direct' | null;
  branchName: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  mergedAt: string | null;
  baseBranch: string;
  projectIds: string[];
  contextProjectIds: string[];
  executionTargets: WorkspaceManualFeatureExecutionTargetDto[];
  mergeWorkflow?: WorkspaceManualFeatureMergeWorkflowDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface DebugResetProjectReportDto {
  projectId: string;
  projectName: string;
  removedRegistryEntry: boolean;
  removedTaskWorktrees: number;
  removedMetadataWorktree: boolean;
  removedMacroBranch: boolean;
  warnings: string[];
}
