/** workspace IPC wrappers and frontend adapters. */

import type {
  Project,
  ProjectAccessChangePreview,
  ProjectGitFlowDetection,
  ProjectGitFlowSettings,
  ProjectGitSetupAction,
  ProjectGitSetupCommitResult,
  ProjectGroup,
} from "../../types";
import type { TaskCatalogDto } from "../contracts/dtos";
import {
  getWorkspaceBasePath,
  remoteRequest,
  resolveRemoteConfig,
} from "../providers/remoteHttp";
import { invoke } from "../tauriRuntimeBridge";
import {
  isRemoteBackendAvailable,
  isTauriAvailable,
} from "./runtime";
import type {
  DebugResetProjectReportDto,
  ProjectIconResolutionDto,
  ProjectRegistryDiagnosticsDto,
  WorkspaceArchitectPlanActivationHeadDto,
  WorkspaceArchitectPlanListDto,
  WorkspaceArchitectPlanSummaryDto,
  WorkspaceArchitectPlanTranscriptDto,
  WorkspaceBootstrapDto,
  WorkspaceManualFeatureDto,
  WorkspaceManualFeatureMergeWorkflowDto,
  WorkspaceMetadataDto,
  WorkspaceMetadataRecoveryHintDto,
  WorkspaceMetadataRecoveryReportDto,
  WorkspaceProjectRegistryReconcileReportDto,
} from "./workspace.types";

export async function workspaceGetBootstrap(): Promise<WorkspaceBootstrapDto> {
  return invoke<WorkspaceBootstrapDto>("workspace_get_bootstrap");
}

export async function workspaceResolveProjectIcons(projectIds: string[]): Promise<ProjectIconResolutionDto[]> {
  return invoke<ProjectIconResolutionDto[]>("workspace_resolve_project_icons", { projectIds });
}

export async function workspaceListProjects(): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_list_projects");
}

export async function workspaceListTasks(): Promise<TaskCatalogDto> {
  return invoke<TaskCatalogDto>("workspace_list_tasks");
}

export async function workspaceGetMetadata(): Promise<WorkspaceMetadataDto> {
  return invoke<WorkspaceMetadataDto>("workspace_get_metadata");
}

export async function workspaceGetActiveRoot(): Promise<string> {
  return invoke<string>("workspace_get_active_root");
}

export async function workspaceQuarantineLegacyStateLock(): Promise<string> {
  return invoke<string>('workspace_quarantine_legacy_state_lock');
}

export async function workspaceArchitectListPlans(params: {
  branchName: string;
  includeDeleted?: boolean;
  includeArchived?: boolean;
  scopedProjectIdsHint?: string[];
  requestId?: string;
}): Promise<WorkspaceArchitectPlanListDto> {
  const request = {
    branchName: params.branchName,
    includeDeleted: params.includeDeleted ?? false,
    includeArchived: params.includeArchived ?? false,
    scopedProjectIdsHint: params.scopedProjectIdsHint ?? [],
    requestId: params.requestId ?? null,
  };
  if (!isTauriAvailable() && isRemoteBackendAvailable()) {
    const config = resolveRemoteConfig();
    if (config) {
      return remoteRequest<WorkspaceArchitectPlanListDto>(
        `${getWorkspaceBasePath(config)}/architect/plans/list`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      );
    }
  }
  return invoke<WorkspaceArchitectPlanListDto>("workspace_architect_list_plans", {
    request,
  });
}

export async function workspaceArchitectActivatePlanHead(params: {
  branchName: string;
  planId: string;
  summaryHint?: WorkspaceArchitectPlanSummaryDto | null;
  scopedProjectIdsHint?: string[];
}): Promise<WorkspaceArchitectPlanActivationHeadDto | null> {
  const request = {
    branchName: params.branchName,
    planId: params.planId,
    summaryHint: params.summaryHint ?? null,
    scopedProjectIdsHint: params.scopedProjectIdsHint ?? [],
  };
  if (!isTauriAvailable() && isRemoteBackendAvailable()) {
    const config = resolveRemoteConfig();
    if (config) {
      return remoteRequest<WorkspaceArchitectPlanActivationHeadDto | null>(
        `${getWorkspaceBasePath(config)}/architect/plans/activate-head`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      );
    }
  }
  return invoke<WorkspaceArchitectPlanActivationHeadDto | null>(
    "workspace_architect_activate_plan_head",
    {
      request,
    },
  );
}

export async function workspaceArchitectActivatePlanChat(params: {
  branchName: string;
  planId: string;
  replicaScopeKey?: string | null;
  replicaProjectId?: string | null;
  expectedTranscriptRevision?: string | null;
  expectedMessageCount?: number | null;
}): Promise<WorkspaceArchitectPlanTranscriptDto | null> {
  const request = {
    branchName: params.branchName,
    planId: params.planId,
    replicaScopeKey: params.replicaScopeKey ?? null,
    replicaProjectId: params.replicaProjectId ?? null,
    expectedTranscriptRevision: params.expectedTranscriptRevision ?? null,
    expectedMessageCount: params.expectedMessageCount ?? null,
  };
  if (!isTauriAvailable() && isRemoteBackendAvailable()) {
    const config = resolveRemoteConfig();
    if (config) {
      return remoteRequest<WorkspaceArchitectPlanTranscriptDto | null>(
        `${getWorkspaceBasePath(config)}/architect/plans/activate-chat`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      );
    }
  }
  return invoke<WorkspaceArchitectPlanTranscriptDto | null>(
    "workspace_architect_activate_plan_chat",
    {
      request,
    },
  );
}

export async function workspaceArchitectInvalidate(params?: {
  branchName?: string | null;
}): Promise<void> {
  return invoke("workspace_architect_invalidate", {
    branchName: params?.branchName ?? null,
  });
}

export async function workspacePreviewProjectGitSetup(params: {
  path?: string;
  requestId?: string | null;
}): Promise<ProjectGitFlowDetection> {
  return invoke<ProjectGitFlowDetection>(
    "workspace_preview_project_git_setup",
    {
      path: params.path ?? null,
      requestId: params.requestId ?? null,
    },
  );
}

export async function workspaceCancelProjectOperation(
  requestId: string,
): Promise<boolean> {
  return invoke<boolean>("workspace_cancel_project_operation", { requestId });
}

export async function workspaceCreateProjectWithGitSetup(params: {
  name: string;
  description: string;
  groupId?: string | null;
  groupName?: string | null;
  path: string;
  gitFlowSettings?: ProjectGitFlowSettings | null;
  gitSetupActions: ProjectGitSetupAction[];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection["setupState"];
  expectedRecommendedActionSequence: ProjectGitSetupAction[];
  requestId?: string | null;
}): Promise<ProjectGitSetupCommitResult> {
  return invoke<ProjectGitSetupCommitResult>(
    "workspace_create_project_with_git_setup",
    {
      name: params.name,
      description: params.description,
      groupId: params.groupId ?? null,
      groupName: params.groupName ?? null,
      path: params.path,
      gitFlowSettings: params.gitFlowSettings ?? null,
      gitSetupActions: params.gitSetupActions,
      expectedRepoRootPath: params.expectedRepoRootPath ?? null,
      expectedSetupState: params.expectedSetupState,
      expectedRecommendedActionSequence:
        params.expectedRecommendedActionSequence,
      requestId: params.requestId ?? null,
    },
  );
}

export async function workspaceUpdateProjectGitFlowWithSetup(params: {
  projectId: string;
  gitFlowSettings: ProjectGitFlowSettings;
  gitSetupActions: ProjectGitSetupAction[];
  expectedRepoRootPath?: string | null;
  expectedSetupState: ProjectGitFlowDetection["setupState"];
  expectedRecommendedActionSequence: ProjectGitSetupAction[];
}): Promise<ProjectGitSetupCommitResult> {
  return invoke<ProjectGitSetupCommitResult>(
    "workspace_update_project_git_flow_with_setup",
    {
      params: {
        projectId: params.projectId,
        gitFlowSettings: params.gitFlowSettings,
        gitSetupActions: params.gitSetupActions,
        expectedRepoRootPath: params.expectedRepoRootPath ?? null,
        expectedSetupState: params.expectedSetupState,
        expectedRecommendedActionSequence:
          params.expectedRecommendedActionSequence,
      },
    },
  );
}

export async function workspaceSetActiveRoot(path: string): Promise<string> {
  return invoke<string>("workspace_set_active_root", { path });
}

export async function workspaceCreateProject(params: {
  name: string;
  description: string;
  groupId?: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ProjectGitFlowSettings | null;
  directEdit?: boolean;
  requestId?: string | null;
}): Promise<Project> {
  return invoke<Project>("workspace_create_project", {
    name: params.name,
    description: params.description,
    groupId: params.groupId ?? null,
    groupName: params.groupName ?? null,
    path: params.path ?? null,
    gitFlowSettings: params.gitFlowSettings ?? null,
    ...(params.directEdit !== undefined ? { directEdit: params.directEdit } : {}),
    requestId: params.requestId ?? null,
  });
}

export async function workspaceCreateNewProjectRepo(params: {
  repoName: string;
  parentPath: string;
  folderName: string;
  groupId?: string | null;
  groupName?: string | null;
  gitFlowSettings?: ProjectGitFlowSettings | null;
  requestId?: string | null;
}): Promise<ProjectGitSetupCommitResult> {
  return invoke<ProjectGitSetupCommitResult>("workspace_create_new_project_repo", {
    repoName: params.repoName,
    parentPath: params.parentPath,
    folderName: params.folderName,
    groupId: params.groupId ?? null,
    groupName: params.groupName ?? null,
    gitFlowSettings: params.gitFlowSettings ?? null,
    requestId: params.requestId ?? null,
  });
}

export async function workspaceImportGitRepo(params: {
  gitUrl: string;
  projectName: string;
  branch: string;
  groupId?: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ProjectGitFlowSettings | null;
}): Promise<Project> {
  return invoke<Project>("workspace_import_git_repo", {
    gitUrl: params.gitUrl,
    projectName: params.projectName,
    branch: params.branch,
    groupId: params.groupId ?? null,
    groupName: params.groupName ?? null,
    path: params.path ?? null,
    gitFlowSettings: params.gitFlowSettings ?? null,
  });
}

export async function workspaceRenameProjectGroup(params: {
  groupId: string;
  name: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>("workspace_rename_project_group", {
    groupId: params.groupId,
    name: params.name,
  });
}

export async function workspaceCreateProjectGroup(params: {
  name: string;
  projectIds: string[];
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_create_project_group", {
    name: params.name,
    projectIds: params.projectIds,
  });
}

export async function workspaceMoveProjectToGroup(params: {
  projectId: string;
  groupId?: string | null;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_move_project_to_group", {
    projectId: params.projectId,
    groupId: params.groupId ?? null,
  });
}

export async function workspaceRenameProject(params: {
  projectId: string;
  name: string;
}): Promise<Project> {
  return invoke<Project>("workspace_rename_project", {
    projectId: params.projectId,
    name: params.name,
  });
}

export async function workspaceUpdateProjectGitFlow(params: {
  projectId: string;
  gitFlowSettings: ProjectGitFlowSettings;
}): Promise<Project> {
  return invoke<Project>("workspace_update_project_git_flow", {
    projectId: params.projectId,
    gitFlowSettings: params.gitFlowSettings,
  });
}

export async function workspaceUpdateProjectAccess(params: {
  projectId: string;
  userReadOnly: boolean;
  directEdit?: boolean;
  confirmedMigration?: boolean;
}): Promise<Project> {
  return invoke<Project>("workspace_update_project_access", {
    projectId: params.projectId,
    userReadOnly: params.userReadOnly,
    ...(params.directEdit !== undefined ? { directEdit: params.directEdit } : {}),
    confirmedMigration: params.confirmedMigration ?? false,
  });
}

export async function workspacePreviewProjectAccessChange(params: {
  projectId: string;
  targetReadOnly: boolean;
}): Promise<ProjectAccessChangePreview> {
  return invoke<ProjectAccessChangePreview>(
    "workspace_preview_project_access_change",
    {
      projectId: params.projectId,
      targetReadOnly: params.targetReadOnly,
    },
  );
}

export async function workspaceArchiveProjectGroup(params: {
  groupId: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>("workspace_archive_project_group", {
    groupId: params.groupId,
  });
}

export async function workspaceArchiveProject(params: {
  projectId: string;
}): Promise<Project> {
  return invoke<Project>("workspace_archive_project", {
    projectId: params.projectId,
  });
}

export async function workspaceRestoreProjectGroup(params: {
  groupId: string;
}): Promise<ProjectGroup> {
  return invoke<ProjectGroup>("workspace_restore_project_group", {
    groupId: params.groupId,
  });
}

export async function workspaceRestoreProject(params: {
  projectId: string;
}): Promise<Project> {
  return invoke<Project>("workspace_restore_project", {
    projectId: params.projectId,
  });
}

export async function workspaceRemoveProjectGroup(params: {
  groupId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_remove_project_group", {
    groupId: params.groupId,
  });
}

export async function workspaceRemoveProject(params: {
  projectId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_remove_project", {
    projectId: params.projectId,
  });
}

export async function workspaceDebugResetProject(params: {
  projectId: string;
  force: boolean;
}): Promise<DebugResetProjectReportDto> {
  return invoke<DebugResetProjectReportDto>("workspace_debug_reset_project", {
    projectId: params.projectId,
    force: params.force,
  });
}

export async function workspaceCloseProject(params: {
  projectId: string;
}): Promise<ProjectGroup[]> {
  return invoke<ProjectGroup[]>("workspace_close_project", {
    projectId: params.projectId,
  });
}

export async function workspaceGetProjectRegistryDiagnostics(): Promise<ProjectRegistryDiagnosticsDto> {
  return invoke<ProjectRegistryDiagnosticsDto>(
    "workspace_get_project_registry_diagnostics",
  );
}

export async function workspaceRecoverMissingMetadata(params: {
  attemptPull: boolean;
  projects: WorkspaceMetadataRecoveryHintDto[];
}): Promise<WorkspaceMetadataRecoveryReportDto> {
  return invoke<WorkspaceMetadataRecoveryReportDto>(
    "workspace_recover_missing_metadata",
    {
      request: {
        attemptPull: params.attemptPull,
        projects: params.projects,
      },
    },
  );
}

export async function workspaceDiscoverRecoverableProjects(params: {
  maxChildrenPerRoot?: number;
} = {}): Promise<WorkspaceProjectRegistryReconcileReportDto> {
  return invoke<WorkspaceProjectRegistryReconcileReportDto>(
    "workspace_discover_recoverable_projects",
    {
      request: {
        maxChildrenPerRoot: params.maxChildrenPerRoot ?? null,
      },
    },
  );
}

export async function workspaceReconcileProjectRegistryFromHints(params: {
  projects: WorkspaceMetadataRecoveryHintDto[];
}): Promise<WorkspaceProjectRegistryReconcileReportDto> {
  return invoke<WorkspaceProjectRegistryReconcileReportDto>(
    "workspace_reconcile_project_registry_from_hints",
    {
      request: {
        projects: params.projects,
      },
    },
  );
}

export async function workspaceCreateManualFeatureDraft(params: {
  taskId: string;
  conversationId: string;
  groupId?: string | null;
  projectIds: string[];
  contextProjectIds?: string[];
  baseBranch?: string | null;
  title?: string | null;
  description?: string | null;
  taskKind: 'feature' | 'bugfix' | 'hotfix' | 'direct';
  existingBranchName?: string | null;
  baseCommitHash?: string | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    "workspace_create_manual_feature_draft",
    {
      taskId: params.taskId,
      conversationId: params.conversationId,
      groupId: params.groupId ?? null,
      projectIds: params.projectIds,
      contextProjectIds: params.contextProjectIds ?? [],
      baseBranch: params.baseBranch ?? null,
      title: params.title ?? null,
      description: params.description ?? null,
      taskKind: params.taskKind,
      existingBranchName: params.existingBranchName ?? null,
      baseCommitHash: params.baseCommitHash ?? null,
    },
  );
}

export async function workspaceFinalizeManualFeature(params: {
  taskId: string;
  conversationId?: string | null;
  title: string;
  description: string;
  featureSlug: string;
  taskKind: 'feature' | 'bugfix' | 'hotfix' | 'direct';
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    "workspace_finalize_manual_feature",
    {
      taskId: params.taskId,
      conversationId: params.conversationId ?? null,
      title: params.title,
      description: params.description,
      featureSlug: params.featureSlug,
      taskKind: params.taskKind,
    },
  );
}

type PilotManualTaskMutation =
  | { action: 'rename'; title: string }
  | { action: 'archive'; reason: string | null; mergedAt: string | null }
  | { action: 'delete'; draftOnly: boolean }
  | { action: 'bind_checkpoint'; projectId: string; checkpointId: string };

async function workspacePilotMutateManualTask(
  taskId: string,
  mutation: PilotManualTaskMutation,
): Promise<WorkspaceManualFeatureDto | null> {
  const result = await invoke<WorkspaceManualFeatureDto | null>('workspace_pilot_mutate_manual_task', { taskId, mutation });
  if (mutation.action !== 'delete' && !result) throw new Error('content_unavailable');
  return result;
}

export async function workspaceBindManualFeatureDirectCheckpoint(params: {
  taskId: string;
  projectId: string;
  checkpointId: string;
  pilotOnly?: boolean;
}): Promise<WorkspaceManualFeatureDto> {
  if (params.pilotOnly) return (await workspacePilotMutateManualTask(params.taskId, { action: 'bind_checkpoint', projectId: params.projectId, checkpointId: params.checkpointId }))!;
  return invoke<WorkspaceManualFeatureDto>(
    'workspace_bind_manual_feature_direct_checkpoint',
    params,
  );
}

export async function workspaceRevertManualFeatureToDraft(params: {
  taskId: string;
  conversationId?: string | null;
  title?: string | null;
  description?: string | null;
  taskLifecycleLeaseId?: string | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    "workspace_revert_manual_feature_to_draft",
    {
      taskId: params.taskId,
      conversationId: params.conversationId ?? null,
      title: params.title ?? null,
      description: params.description ?? null,
      taskLifecycleLeaseId: params.taskLifecycleLeaseId ?? null,
    },
  );
}

export async function workspaceDeleteManualFeatureDraft(
  params: { taskId: string; taskLifecycleLeaseId?: string | null } | string,
  pilotOnly = false,
): Promise<boolean> {
  if (typeof params === 'string') {
    if (pilotOnly) {
      await workspacePilotMutateManualTask(params, { action: 'delete', draftOnly: true });
      return true;
    }
    params = { taskId: params };
  }
  return invoke<boolean>('workspace_delete_manual_feature_draft', {
    taskId: params.taskId,
    taskLifecycleLeaseId: params.taskLifecycleLeaseId ?? null,
  });
}

export async function workspaceAcquirePlanLifecycleLock(params: {
  branchName: string;
  planId: string;
}): Promise<string> {
  return invoke<string>('workspace_acquire_plan_lifecycle_lock', params);
}

export async function workspaceRenewPlanLifecycleLock(leaseId: string): Promise<void> {
  return invoke<void>('workspace_renew_plan_lifecycle_lock', { leaseId });
}

export async function workspaceReleasePlanLifecycleLock(leaseId: string): Promise<void> {
  return invoke<void>('workspace_release_plan_lifecycle_lock', { leaseId });
}

export async function workspaceAcquireTaskLifecycleLock(taskId: string, directProjectPaths?: string[]): Promise<string> {
  return invoke<string>('workspace_acquire_task_lifecycle_lock', { taskId, ...(directProjectPaths?.length ? { directProjectPaths } : {}) });
}

export async function workspaceRenewTaskLifecycleLock(leaseId: string): Promise<void> {
  return invoke<void>('workspace_renew_task_lifecycle_lock', { leaseId });
}

export async function workspaceReleaseTaskLifecycleLock(leaseId: string): Promise<void> {
  return invoke<void>('workspace_release_task_lifecycle_lock', { leaseId });
}

export async function workspaceRenameManualFeature(params: {
  taskId: string;
  title: string;
  pilotOnly?: boolean;
}): Promise<WorkspaceManualFeatureDto> {
  if (params.pilotOnly) return (await workspacePilotMutateManualTask(params.taskId, { action: 'rename', title: params.title }))!;
  return invoke<WorkspaceManualFeatureDto>("workspace_rename_manual_feature", {
    taskId: params.taskId,
    title: params.title,
  });
}

export async function workspaceArchiveManualFeature(params: {
  taskId: string;
  reason?: string | null;
  mergedAt?: string | null;
  pilotOnly?: boolean;
}): Promise<WorkspaceManualFeatureDto> {
  if (params.pilotOnly) return (await workspacePilotMutateManualTask(params.taskId, { action: 'archive', reason: params.reason ?? null, mergedAt: params.mergedAt ?? null }))!;
  return invoke<WorkspaceManualFeatureDto>("workspace_archive_manual_feature", {
    taskId: params.taskId,
    reason: params.reason ?? null,
    mergedAt: params.mergedAt ?? null,
  });
}

export async function workspaceRestoreManualFeature(
  taskId: string,
): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>("workspace_restore_manual_feature", {
    taskId,
  });
}

export async function workspaceDeleteManualFeature(
  params: { taskId: string; taskLifecycleLeaseId?: string | null } | string,
  pilotOnly = false,
): Promise<void> {
  if (typeof params === 'string') {
    if (pilotOnly) {
      await workspacePilotMutateManualTask(params, { action: 'delete', draftOnly: false });
      return;
    }
    params = { taskId: params };
  }
  return invoke<void>('workspace_delete_manual_feature', {
    taskId: params.taskId,
    taskLifecycleLeaseId: params.taskLifecycleLeaseId ?? null,
  });
}

export async function workspaceUpdateStandaloneTaskStatus(params: {
  taskId: string;
  status: string;
  expectedRevision?: number;
  expectedStatus?: string;
}): Promise<number | null> {
  return invoke("workspace_update_standalone_task_status", {
    taskId: params.taskId,
    status: params.status,
    ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
    ...(params.expectedStatus !== undefined ? { expectedStatus: params.expectedStatus } : {}),
  });
}

export async function workspaceUpdateManualFeatureMergeWorkflow(params: {
  taskId: string;
  mergeWorkflow?: WorkspaceManualFeatureMergeWorkflowDto | null;
}): Promise<WorkspaceManualFeatureDto> {
  return invoke<WorkspaceManualFeatureDto>(
    'workspace_update_manual_feature_merge_workflow',
    {
      taskId: params.taskId,
      mergeWorkflow: params.mergeWorkflow ?? null,
    }
  );
}
