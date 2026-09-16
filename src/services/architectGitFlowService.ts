import type { PlanNode, PredictedBranch, Project, ProjectGitFlowSettings, ProjectGroup } from '../types';
import { useAppStore } from '../stores/useAppStore';
import * as tauriIpc from './tauriIpc';
import {
  archiveArchitectPlan,
  commitArchitectPlanMetadata,
  deleteArchitectPlan,
  getArchitectPlanTargetBranchForProject,
  getArchitectPlanCrudCapabilities,
  getGitFlowBaseBranch,
  getArchitectPlan,
  restoreArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanRecord,
} from './architectPlanService';
import {
  collectRenderedPlanPredictedBranchDescriptors,
  getPredictedBranchLogicalIdentity,
} from './architectBranchIdentity';
import {
  normalizeNodeProjectIds,
  normalizeStrategyDependencies,
  toBranchWorktreeKey,
} from './implementTaskDerivation';
import {
  buildPlanIntegrationWorktreePath,
  ensurePlanIntegrationWorktree,
  resolveStableFallbackBranchesForProject,
  toPlanIntegrationWorktreeKey,
} from './planIntegrationWorktreeService';
import {
  renderGitFlowBranchName,
} from './architectGitNaming';
import {
  getArchitectPlanKind,
  getPlanKindBackmergeBranch,
  getPlanKindSourceBranch,
  renderArchitectPlanIntegrationBranchName,
} from './architectPlanKinds';
import { toServiceError } from './contracts/errors';
import {
  StalePlanLifecycleSagaError,
  PlanLifecycleSagaCorruptionError,
  getPlanLifecycleSagaGeneration,
  loadPlanLifecycleSagas,
  removePlanLifecycleSaga,
  startPlanLifecycleSaga,
  upsertPlanLifecycleSaga,
  type PlanLifecycleCleanupResource,
  type PlanFinalizationRepositoryCheckpoint,
  type PlanLifecycleSaga,
} from './planLifecycleSaga';
import { getPlanNodeBranchIntent, type WorkBranchIntent } from './gitFlowBranchIntents';
import {
  buildValidProjectRegistrySnapshot,
  isSyntheticProjectId,
  normalizeProjectRegistryPath,
} from './validProjectRegistry';
import { devLogger } from '../utils/devLogger';
import {
  isMergeWorkflowSourcePublished,
  resolveMergeWorkflowStrategy,
  shouldCheckMergeWorkflowRebase,
  type MergeWorkflowDirtyFile,
  type MergeWorkflowResolutionAction,
  type MergeWorkflowStrategy,
} from './mergeWorkflow';
import { resolvePlanProjectExecutionMode } from './planExecutionModes';

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

const getProjectGitFlowSettings = (
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined,
  projectId: string
): ProjectGitFlowSettings | undefined => getProjectById(projectId)?.gitFlowSettings ?? undefined;

const renderPlanBranchNameForProject = (params: {
  plan: Pick<ArchitectPlanRecord, 'slug' | 'title' | 'planKind' | 'gitFlowPlan'>;
  projectId: string;
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined;
}): string =>
  renderArchitectPlanIntegrationBranchName({
    plan: params.plan,
    projectId: params.projectId,
    settings: getProjectGitFlowSettings(params.getProjectById, params.projectId),
  });

const renderWorkBranchNameForProject = (params: {
  planSlug: string;
  projectId: string;
  intent: WorkBranchIntent;
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined;
}): string =>
  renderGitFlowBranchName({
    branchType: params.intent.branchType,
    planSlug: params.planSlug,
    branchSlug: params.intent.branchSlug,
    settings: getProjectGitFlowSettings(params.getProjectById, params.projectId),
  });

const resolvePlanProjectBaseBranchName = (
  plan: ArchitectPlanRecord,
  projectId: string,
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined
): string =>
  getArchitectPlanTargetBranchForProject(plan, projectId, {
    getProjectGitFlowSettings: (targetProjectId) =>
      getProjectGitFlowSettings(getProjectById, targetProjectId),
  });

const resolvePlanProjectSourceBranchName = (
  plan: ArchitectPlanRecord,
  projectId: string,
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined
): string => {
  const project = getProjectById(projectId);
  const settings = project?.gitFlowSettings;
  return plan.gitFlowPlan?.projects?.[projectId]?.sourceBranch ||
    getPlanKindSourceBranch({
      planKind: getArchitectPlanKind(plan),
      baseBranch: settings?.baseBranch || getArchitectPlanTargetBranchForProject(plan, projectId),
      mainBranch: settings?.mainBranch || 'main',
    });
};

const resolvePlanProjectBackmergeBranchName = (
  plan: ArchitectPlanRecord,
  projectId: string,
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined
): string | null => {
  const project = getProjectById(projectId);
  const settings = project?.gitFlowSettings;
  return plan.gitFlowPlan?.projects?.[projectId]?.backmergeBranch ??
    getPlanKindBackmergeBranch({
      planKind: getArchitectPlanKind(plan),
      baseBranch: settings?.baseBranch || 'main',
      mainBranch: settings?.mainBranch || 'main',
    });
};

const resolveBranchSourceRef = (
  branches: ArchitectGitFlowGitBranches,
  targetBranchName: string,
  projectLabel?: string
): string => {
  const local = new Set((branches.local || []).map((branch) => branch.name));
  const remote = new Set((branches.remote || []).map((branch) => branch.name));

  if (local.has(targetBranchName)) return targetBranchName;
  if (remote.has(`origin/${targetBranchName}`)) return `origin/${targetBranchName}`;

  throw new Error(
    `Missing target branch "${targetBranchName}". Create or fetch it before validating this plan${projectLabel ? `, or update Git workflow settings for ${projectLabel}` : ''}.`
  );
};

const buildPredictedBranchesForProjectPlan = (params: {
  nodes: PlanNode[];
  existingBranches: PredictedBranch[];
  plan: ArchitectPlanRecord;
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined;
}): PredictedBranch[] => {
  const renderedBranches = collectRenderedPlanPredictedBranchDescriptors({
    nodes: params.nodes,
    planSlug: params.plan.slug || params.plan.title,
    getProjectGitFlowSettings: (projectId) =>
      getProjectGitFlowSettings(params.getProjectById, projectId),
    getPlanIntegrationBranchName: (projectId) =>
      renderPlanBranchNameForProject({
        plan: params.plan,
        projectId,
        getProjectById: params.getProjectById,
      }),
  });
  const nodeById = new Map(params.nodes.map((node) => [node.id, node]));
  const resolveBranchStatus = (taskIds: string[]): PredictedBranch['status'] => {
    const branchNodes = taskIds
      .map((taskId) => nodeById.get(taskId))
      .filter((node): node is PlanNode => Boolean(node));
    if (branchNodes.length > 0 && branchNodes.every((node) => node.status === 'completed')) {
      return 'merged';
    }
    if (branchNodes.some((node) => node.status === 'in-progress')) {
      return 'active';
    }
    return 'pending';
  };

  const existingByKey = new Map(
    (params.existingBranches || []).map((branch) => [
      `${branch.projectId}::${getPredictedBranchLogicalIdentity({
        planSlug: params.plan.slug || params.plan.title,
        branch,
        settings: getProjectGitFlowSettings(
          params.getProjectById,
          branch.projectId,
        ),
      }).key}`,
      branch,
    ])
  );

  return renderedBranches.map((branch, index) => {
    const existing = existingByKey.get(branch.key);
    return {
      id: existing?.id || `branch-${branch.projectId}-${Date.now()}-${index}`,
      name: branch.name,
      color: existing?.color || BRANCH_COLORS[index % BRANCH_COLORS.length],
      parentBranch: branch.parentBranch,
      projectId: branch.projectId,
      taskIds: Array.from(new Set(branch.taskIds)),
      status: resolveBranchStatus(branch.taskIds),
      branchType: branch.branchType,
      branchSlug: branch.branchSlug,
    };
  });
};

const listPlanBranchNamesForProject = (params: {
  plan: ArchitectPlanRecord;
  projectId: string;
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined;
}): string[] => {
  const predictedBranchNames = (params.plan.predictedBranches || [])
    .filter((branch) => branch.projectId === params.projectId)
    .map((branch) => branch.name)
    .filter((name) => name.trim().length > 0);
  if (predictedBranchNames.length > 0) {
    return Array.from(new Set(predictedBranchNames));
  }

  const planSlug = params.plan.slug || params.plan.title;
  return Array.from(
    new Set(
      (params.plan.nodes || [])
        .filter((node) => normalizeNodeProjectIds(node).includes(params.projectId))
        .map((node) =>
          renderWorkBranchNameForProject({
            planSlug,
            projectId: params.projectId,
            intent: getPlanNodeBranchIntent(node),
            getProjectById: params.getProjectById,
          })
        )
    )
  );
};

export interface ProvisionedPlanRepositoryResult {
  projectId: string;
  repoPath: string;
  planBranchName: string;
  createdPlanBranch: boolean;
  createdFeatureBranches: string[];
  existingFeatureBranches: string[];
}

export interface ProvisionPlanBranchesResult {
  planBranchName: string;
  repositories: ProvisionedPlanRepositoryResult[];
  createdPlanBranch: boolean;
  createdFeatureBranches: string[];
  existingFeatureBranches: string[];
}

export interface CleanupPlanRepositoryResult {
  projectId: string;
  repoPath: string;
  deletedBranches: string[];
  deletedWorktrees: Array<{
    worktreeKey: string;
    branchName: string;
    worktreePath: string;
  }>;
  retainedBranches: string[];
  retainedWorktrees: Array<{
    worktreeKey: string;
    branchName: string;
    worktreePath: string;
  }>;
  cleanupError?: string | null;
}

export interface FinalizedPlanRepositoryResult {
  projectId: string;
  repoPath: string;
  planBranchName: string;
  baseBranchName: string;
  backmergeBranchName?: string | null;
  mergeOutput?: string;
  backmergeOutput?: string;
}

export interface PlanReviewTaskSummary {
  id: string;
  title: string;
  status: PlanNode['status'];
  branchName: string;
  projectIds: string[];
}

export interface PlanReviewRepositoryResult {
  id: string;
  projectId: string;
  repoPath: string;
  planBranchName: string;
  baseBranchName: string;
  isClean: boolean;
  hasChanges: boolean;
  ahead?: number;
  behind?: number;
  mergeable: boolean;
  conflictFiles: string[];
  dirtyFiles?: MergeWorkflowDirtyFile[];
  mergeInProgress: boolean;
  diff: string;
  checkStatus: 'not_run' | 'passed' | 'failed';
  blockingKind: PlanFinalizationBlockingKind | null;
  nextAction: PlanFinalizationNextAction | null;
  blockingReason: string | null;
  isSourcePublished?: boolean;
  mergeStrategy?: MergeWorkflowStrategy;
  recommendedAction?: MergeWorkflowResolutionAction | null;
  availableActions?: MergeWorkflowResolutionAction[];
}

export interface PlanReviewResult {
  plan: ArchitectPlanRecord;
  tasks: PlanReviewTaskSummary[];
  repositories: PlanReviewRepositoryResult[];
}

export type PlanFinalizationBlockingKind =
  | 'repository_dirty'
  | 'merge_conflict'
  | 'merge_in_progress';

export type PlanFinalizationNextAction =
  | 'clean_repository'
  | 'resolve_conflicts'
  | 'finish_or_abort_merge'
  | 'complete_merge';

export interface PlanFinalizationBlockedError extends Error {
  name: 'PlanFinalizationBlockedError';
  planId: string;
  branchName: string;
  repositories: PlanReviewRepositoryResult[];
  blockedRepositories: PlanReviewRepositoryResult[];
}

interface ResolvedProjectRepository {
  projectId: string;
  repoPath: string;
}

interface CleanupPlanWorktreeTarget {
  worktreeKey: string;
  branchName: string;
  worktreePath: string;
}

interface CleanupPlanRepositoryTarget extends ResolvedProjectRepository {
  planBranchName: string;
  featureBranchNames: string[];
  worktrees: CleanupPlanWorktreeTarget[];
  integrationWorktree: CleanupPlanWorktreeTarget;
}

interface ArchitectGitFlowProjectRef {
  path?: string | null;
  gitFlowSettings?: ProjectGitFlowSettings | null;
}

interface ArchitectGitFlowProjectGroup {
  id: string;
  name: string;
  isOpen: boolean;
  projects: Array<{
    id: string;
    name: string;
    mountName: string;
    path: string;
  }>;
}

interface ArchitectGitFlowGitStatus {
  branch: string;
  is_clean: boolean;
  staged_files?: Array<{ path: string; status?: string | null }>;
  stagedFiles?: Array<{ path: string; status?: string | null }>;
  unstaged_files?: Array<{ path: string; status?: string | null }>;
  unstagedFiles?: Array<{ path: string; status?: string | null }>;
  untracked_files?: Array<{ path: string; status?: string | null }>;
  untrackedFiles?: Array<{ path: string; status?: string | null }>;
  conflicted_files?: string[];
  conflictedFiles?: string[];
  merge_in_progress?: boolean;
  mergeInProgress?: boolean;
}

interface ArchitectGitFlowGitBranchRef {
  name: string;
  commit?: string;
}

interface ArchitectGitFlowGitBranches {
  local: ArchitectGitFlowGitBranchRef[];
  remote: ArchitectGitFlowGitBranchRef[];
  current: string | null;
}

type ArchitectGitFlowMergeCheck = Pick<tauriIpc.GitMergeCheckDto, 'mergeable' | 'conflictFiles' | 'hasChanges' | 'ahead' | 'behind'>;

type ArchitectGitFlowTauriDeps = Pick<
  typeof tauriIpc,
  | 'isTauriAvailable'
  | 'gitDiff'
  | 'gitMerge'
  | 'gitGuardedMergeState'
  | 'gitPrepareGuardedBranchSync'
  | 'gitGuardedBranchSync'
  | 'gitBranchDelete'
  | 'gitBranchDeleteRemote'
  | 'gitCheckout'
  | 'gitBranchCreate'
  | 'gitWorktreeInspect'
  | 'gitWorktreeCreate'
  | 'gitWorktreeRemove'
  | 'gitBranchWorktreeInspect'
  | 'gitBranchWorktreeCreate'
  | 'gitBranchWorktreeRemove'
  | 'gitPull'
  | 'gitRebaseCheck'
  | 'workspaceAcquirePlanLifecycleLock'
  | 'workspaceReleasePlanLifecycleLock'
> & {
  gitStatus: (repoPath: string) => Promise<ArchitectGitFlowGitStatus>;
  gitMergeCheck: (params: {
    repoPath: string;
    branchName: string;
    intoBranch: string;
  }) => Promise<ArchitectGitFlowMergeCheck>;
  gitBranchList: (repoPath: string) => Promise<ArchitectGitFlowGitBranches>;
  workspaceRenewPlanLifecycleLock?: (leaseId: string) => Promise<void>;
};

interface ArchitectGitFlowAppState {
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  standaloneProjects?: ProjectGroup['projects'];
  projectGroups: ArchitectGitFlowProjectGroup[];
  getProjectById: (projectId: string) => ArchitectGitFlowProjectRef | null | undefined;
}

interface ResolvePlanProjectRepoPathOptions {
  errorMessage?: string;
  logContext?: string;
}

export interface ArchitectGitFlowDependencies {
  tauri: ArchitectGitFlowTauriDeps;
  getAppState: () => ArchitectGitFlowAppState;
  getArchitectPlan: typeof getArchitectPlan;
  updateArchitectPlan: typeof updateArchitectPlan;
  archiveArchitectPlan: typeof archiveArchitectPlan;
  restoreArchitectPlan: typeof restoreArchitectPlan;
  deleteArchitectPlan: typeof deleteArchitectPlan;
  commitArchitectPlanMetadata: typeof commitArchitectPlanMetadata;
  getGitFlowBaseBranch: typeof getGitFlowBaseBranch;
}

const getDefaultArchitectGitFlowDependencies = (): ArchitectGitFlowDependencies => ({
  tauri: tauriIpc,
  getAppState: () => useAppStore.getState(),
  getArchitectPlan,
  updateArchitectPlan,
  archiveArchitectPlan,
  restoreArchitectPlan,
  deleteArchitectPlan,
  commitArchitectPlanMetadata,
  getGitFlowBaseBranch,
});

const withPlanLifecycleLock = async <T>(
  deps: ArchitectGitFlowDependencies,
  branchName: string,
  planId: string,
  operation: () => Promise<T>,
): Promise<T> => {
  if (!deps.tauri.isTauriAvailable()) return operation();
  const leaseId = await deps.tauri.workspaceAcquirePlanLifecycleLock({ branchName, planId });
  let renewalInFlight: Promise<void> | null = null;
  const renewLease = () => {
    if (!deps.tauri.workspaceRenewPlanLifecycleLock || renewalInFlight) return;
    renewalInFlight = deps.tauri.workspaceRenewPlanLifecycleLock(leaseId)
      .catch((error) => {
        devLogger.warn('[architectGitFlow] Could not renew the plan lifecycle lease.', {
          branchName,
          planId,
          error: toServiceError(error).message,
        });
      })
      .finally(() => {
        renewalInFlight = null;
      });
  };
  const heartbeat = globalThis.setInterval(renewLease, 30_000);
  try {
    return await operation();
  } finally {
    globalThis.clearInterval(heartbeat);
    await renewalInFlight;
    await deps.tauri.workspaceReleasePlanLifecycleLock(leaseId).catch((error) => {
      devLogger.warn('[architectGitFlow] Could not release the plan lifecycle lease.', {
        branchName,
        planId,
        error: toServiceError(error).message,
      });
    });
  }
};

const joinRepoPath = (repoPath: string, ...segments: string[]): string =>
  [repoPath.replace(/[\\/]+$/, ''), ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ''))]
    .filter(Boolean)
    .join('/');

const buildTaskWorktreePath = (repoPath: string, worktreeKey: string): string =>
  joinRepoPath(repoPath, '.macro', 'worktrees', `task${worktreeKey}`);

const isMissingGitTargetError = (error: unknown): boolean => {
  const message = toServiceError(error).message.toLowerCase();
  return (
    message.includes('repository not found') ||
    message.includes('does not exist') ||
    message.includes('not a git repository') ||
    message.includes('path not found')
  );
};

const resolveProjectRepoPathsFromAppState = (
  appState: ArchitectGitFlowAppState,
  projectIds: string[],
  explicitRepoPath?: string,
  options?: { allowMissing?: boolean }
): ResolvedProjectRepository[] => {
  const uniqueProjectIds = Array.from(new Set(projectIds.filter((projectId) => projectId.trim().length > 0)));
  if (uniqueProjectIds.length === 0) {
    const selectedProject = appState.selectedProjectId
      ? appState.getProjectById(appState.selectedProjectId)
      : null;
    const selectedRepoPath = normalizeProjectRegistryPath(selectedProject?.path);
    if (selectedRepoPath && appState.selectedProjectId) {
      return [{ projectId: appState.selectedProjectId, repoPath: selectedRepoPath }];
    }
  }
  const resolved: ResolvedProjectRepository[] = [];
  const missingProjectIds: string[] = [];

  for (const projectId of uniqueProjectIds) {
    const project = appState.getProjectById(projectId);
    const repoPath = normalizeProjectRegistryPath(project?.path);
    if (repoPath) {
      resolved.push({ projectId, repoPath });
    } else {
      missingProjectIds.push(projectId);
    }
  }

  if (missingProjectIds.length > 0) {
    if (explicitRepoPath && uniqueProjectIds.length <= 1) {
      const fallbackProjectId = uniqueProjectIds[0] || appState.selectedProjectId || 'default-project';
      return [{ projectId: fallbackProjectId, repoPath: explicitRepoPath }];
    }

    if (options?.allowMissing && resolved.length > 0) {
      return resolved;
    }

    throw new Error(
      `Unable to resolve repository path for project${missingProjectIds.length > 1 ? 's' : ''} ${missingProjectIds.join(', ')}.`
    );
  }

  if (resolved.length === 0 && explicitRepoPath) {
    const fallbackProjectId = uniqueProjectIds[0] || appState.selectedProjectId || 'default-project';
    resolved.push({ projectId: fallbackProjectId, repoPath: explicitRepoPath });
  }

  return resolved;
};

const logIgnoredPlanProjectIds = (
  plan: ArchitectPlanRecord,
  ignoredProjectIds: string[],
  logContext: string
): void => {
  if (ignoredProjectIds.length === 0) {
    return;
  }

  devLogger.info('[architectGitFlow] Ignoring invalid plan project ids.', {
    context: logContext,
    planId: plan.id,
    ignoredProjectIds,
  });
};

const resolvePlanProjectRepoPathsFromAppState = (
  appState: ArchitectGitFlowAppState,
  plan: ArchitectPlanRecord,
  explicitRepoPath?: string,
  options?: ResolvePlanProjectRepoPathOptions
): ResolvedProjectRepository[] => {
  const candidateProjectIds = getPlanProjectIds(plan);
  if (candidateProjectIds.length === 0) {
    return resolveProjectRepoPathsFromAppState(appState, [], explicitRepoPath);
  }

  const registrySnapshot = buildValidProjectRegistrySnapshot({
    standaloneProjects: (appState.standaloneProjects || []) as unknown as ProjectGroup['projects'],
    projectGroups: (appState.projectGroups || []) as unknown as ProjectGroup[],
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: appState.selectedProjectId,
  });

  const resolved: ResolvedProjectRepository[] = [];
  const ignoredProjectIds: string[] = [];
  const blockingProjectIds: string[] = [];
  let directProjectCount = 0;

  for (const projectId of candidateProjectIds) {
    if (isSyntheticProjectId(projectId)) {
      ignoredProjectIds.push(projectId);
      continue;
    }

    const project = appState.getProjectById(projectId);
    const executionMode = resolvePlanProjectExecutionMode({
      projectId,
      nodes: plan.nodes,
      executionModesByProjectId: plan.executionModesByProjectId,
      project: project as Project | null | undefined,
    });
    if (executionMode === 'direct') {
      directProjectCount += 1;
      continue;
    }
    if (executionMode !== 'git') {
      blockingProjectIds.push(projectId);
      continue;
    }
    const directRepoPath = normalizeProjectRegistryPath(project?.path);

    if (registrySnapshot.validProjectIdSet.has(projectId)) {
      const repoPath = registrySnapshot.repoPathByProjectId.get(projectId) || directRepoPath;
      if (repoPath) {
        resolved.push({ projectId, repoPath });
        continue;
      }
    }

    if (directRepoPath) {
      resolved.push({ projectId, repoPath: directRepoPath });
      continue;
    }

    if (project) {
      blockingProjectIds.push(projectId);
      continue;
    }

    ignoredProjectIds.push(projectId);
  }

  if (blockingProjectIds.length > 0) {
    throw new Error(
      `Unable to resolve repository path for project${blockingProjectIds.length > 1 ? 's' : ''} ${blockingProjectIds.join(', ')}.`
    );
  }

  if (resolved.length === 0 && directProjectCount === candidateProjectIds.length) {
    return [];
  }
  if (resolved.length === 0) {
    throw new Error(
      options?.errorMessage || 'Unable to resolve repository path for this plan. Select at least one project before continuing.'
    );
  }

  logIgnoredPlanProjectIds(plan, ignoredProjectIds, options?.logContext || 'plan_repositories');
  return resolved;
};

const getPlanProjectIds = (plan: ArchitectPlanRecord): string[] => {
  const nodeProjectIds = (plan.nodes || []).flatMap((node) => normalizeNodeProjectIds(node));
  const branchProjectIds = (plan.predictedBranches || []).map((branch) => branch.projectId).filter(Boolean);
  return Array.from(new Set([
    ...(plan.projectIds || []),
    ...(plan.projectId ? [plan.projectId] : []),
    ...nodeProjectIds,
    ...branchProjectIds,
  ]));
};

const getRepositoryConflictFiles = (status: ArchitectGitFlowGitStatus): string[] => {
  return Array.from(
    new Set([...(status.conflictedFiles || []), ...((status.conflicted_files as string[] | undefined) || [])])
  );
};

const isMergeInProgress = (status: ArchitectGitFlowGitStatus): boolean =>
  Boolean(status.mergeInProgress ?? status.merge_in_progress);

const formatMergeConflictMessage = (repositoryPath: string, conflictFiles: string[]): string => {
  if (conflictFiles.length === 0) {
    return `Cannot finalize plan because ${repositoryPath} would conflict during merge.`;
  }
  return `Cannot finalize plan because ${repositoryPath} would conflict in: ${conflictFiles.join(', ')}.`;
};

const formatDirtyRepositoryMessage = (repositoryPath: string): string =>
  `Cannot finalize plan because ${repositoryPath} has uncommitted changes.`;

const buildPlanRepositoryBlockingState = (params: {
  repositoryPath: string;
  status: ArchitectGitFlowGitStatus;
  mergeCheck: ArchitectGitFlowMergeCheck;
}): Pick<PlanReviewRepositoryResult, 'blockingKind' | 'blockingReason' | 'nextAction' | 'conflictFiles' | 'mergeInProgress'> => {
  const statusConflictFiles = getRepositoryConflictFiles(params.status);
  const mergeInProgress = isMergeInProgress(params.status);

  if (statusConflictFiles.length > 0) {
    return {
      blockingKind: 'merge_conflict',
      blockingReason: formatMergeConflictMessage(params.repositoryPath, statusConflictFiles),
      nextAction: 'resolve_conflicts',
      conflictFiles: statusConflictFiles,
      mergeInProgress,
    };
  }

  if (mergeInProgress) {
    return {
      blockingKind: null,
      blockingReason: null,
      nextAction: 'complete_merge',
      conflictFiles: [],
      mergeInProgress,
    };
  }

  if (!params.status.is_clean) {
    return {
      blockingKind: 'repository_dirty',
      blockingReason: formatDirtyRepositoryMessage(params.repositoryPath),
      nextAction: 'clean_repository',
      conflictFiles: [],
      mergeInProgress,
    };
  }

  if (!params.mergeCheck.mergeable) {
    return {
      blockingKind: 'merge_conflict',
      blockingReason: formatMergeConflictMessage(params.repositoryPath, params.mergeCheck.conflictFiles),
      nextAction: 'resolve_conflicts',
      conflictFiles: params.mergeCheck.conflictFiles,
      mergeInProgress,
    };
  }

  return {
    blockingKind: null,
    blockingReason: null,
    nextAction: null,
    conflictFiles: params.mergeCheck.conflictFiles,
    mergeInProgress,
  };
};

const createPlanFinalizationBlockedError = (params: {
  planId: string;
  branchName: string;
  repositories: PlanReviewRepositoryResult[];
}): PlanFinalizationBlockedError => {
  const blockedRepositories = params.repositories.filter((repository) => Boolean(repository.blockingReason));
  const primaryReason = blockedRepositories[0]?.blockingReason || 'Plan finalization is blocked.';
  const message = blockedRepositories.length > 1
    ? `${primaryReason} ${blockedRepositories.length} repositories are currently blocked.`
    : primaryReason;

  return Object.assign(new Error(message), {
    name: 'PlanFinalizationBlockedError' as const,
    planId: params.planId,
    branchName: params.branchName,
    repositories: params.repositories,
    blockedRepositories,
  });
};

export const isPlanFinalizationBlockedError = (error: unknown): error is PlanFinalizationBlockedError => {
  return (
    error instanceof Error &&
    error.name === 'PlanFinalizationBlockedError' &&
    'planId' in error &&
    'repositories' in error
  );
};

const buildPlanReviewTasks = (plan: ArchitectPlanRecord): PlanReviewTaskSummary[] => {
  return (plan.nodes || []).map((node) => ({
    id: node.id,
    title: node.title,
    status: node.status,
    branchName: node.assignedBranch || 'work',
    projectIds: normalizeNodeProjectIds(node),
  }));
};

const assertPlanReadyForFinalization = (plan: ArchitectPlanRecord): void => {
  const incompleteNodes = (plan.nodes || []).filter((node) => node.status !== 'completed');
  if (incompleteNodes.length === 0) {
    return;
  }

  const titles = incompleteNodes.map((node) => node.title).join(', ');
  throw new Error(`Cannot finalize plan while tasks are incomplete: ${titles}.`);
};

export const provisionPlanBranches = async (
  plan: ArchitectPlanRecord,
  explicitRepoPath?: string,
  persistPlan?: () => Promise<void>,
): Promise<ProvisionPlanBranchesResult> =>
  getDefaultArchitectGitFlowService().provisionPlanBranches(plan, explicitRepoPath, persistPlan);

export const validatePlanAndProvisionBranches = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
  setActive?: boolean;
}): Promise<{ plan: ArchitectPlanRecord; provision: ProvisionPlanBranchesResult }> =>
  getDefaultArchitectGitFlowService().validatePlanAndProvisionBranches(params);

export const mergeFeatureBranchIntoPlanBranch = async (params: {
  projectId: string;
  branchName: string;
  planBranchName: string;
  repoPath?: string;
}): Promise<string> => getDefaultArchitectGitFlowService().mergeFeatureBranchIntoPlanBranch(params);

export const loadPlanReview = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
  syncBaseBranches?: boolean;
}): Promise<PlanReviewResult> => getDefaultArchitectGitFlowService().loadPlanReview(params);

export const finalizePlanIntoBaseBranch = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
}): Promise<{
  plan: ArchitectPlanRecord;
  repositories: FinalizedPlanRepositoryResult[];
  cleanup: CleanupPlanRepositoryResult[];
}> => getDefaultArchitectGitFlowService().finalizePlanIntoBaseBranch(params);

export const cleanupPlanBranches = async (
  plan: ArchitectPlanRecord,
  explicitRepoPath?: string,
  options?: {
    allowRetained?: boolean;
  }
): Promise<CleanupPlanRepositoryResult[]> =>
  getDefaultArchitectGitFlowService().cleanupPlanBranches(plan, explicitRepoPath, options);

export const archivePlanAndCleanupBranches = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
  keepSaga?: boolean;
  requireMetadataCommit?: boolean;
}): Promise<{
  plan: ArchitectPlanRecord;
  cleanup: CleanupPlanRepositoryResult[];
  lifecycleSaga: PlanLifecycleSaga;
}> =>
  getDefaultArchitectGitFlowService().archivePlanAndCleanupBranches(params);

export const restorePlanAndProvisionBranches = async (params: {
  branchName: string;
  planId: string;
  repoPath?: string;
}): Promise<ArchitectPlanRecord> =>
  getDefaultArchitectGitFlowService().restorePlanAndProvisionBranches(params);

export const deletePlanAndCleanupBranches = async (params: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
  repoPath?: string;
}): Promise<{
  deletedBranches: string[];
  deletedWorktreeKeys: string[];
  repositories: CleanupPlanRepositoryResult[];
}> => getDefaultArchitectGitFlowService().deletePlanAndCleanupBranches(params);

let pendingPlanLifecycleResume: Promise<void> | null = null;

export const resumePlanLifecycleSagas = async (): Promise<void> => {
  if (pendingPlanLifecycleResume) return pendingPlanLifecycleResume;
  const resume = getDefaultArchitectGitFlowService().resumePlanLifecycleSagas();
  pendingPlanLifecycleResume = resume;
  try {
    await resume;
  } finally {
    if (pendingPlanLifecycleResume === resume) pendingPlanLifecycleResume = null;
  }
};

export const createArchitectGitFlowService = (
  overrides: (Partial<ArchitectGitFlowDependencies> & {
    tauri?: Partial<ArchitectGitFlowTauriDeps>;
  }) = {}
) => {
  const defaultArchitectGitFlowDependencies = getDefaultArchitectGitFlowDependencies();
  const deps: ArchitectGitFlowDependencies = {
    ...defaultArchitectGitFlowDependencies,
    ...overrides,
    tauri: {
      ...defaultArchitectGitFlowDependencies.tauri,
      ...(overrides.tauri || {}),
    },
  };
  const provisionMatchesPersistedPlan = (saga: PlanLifecycleSaga, plan: ArchitectPlanRecord | null): boolean => {
    if (!plan || !['validated', 'in_progress'].includes(plan.status)) return false;
    const repositories = resolvePlanProjectRepoPathsWithDeps(plan);
    return (saga.cleanupResources ?? []).every((resource) => repositories.some((repository) =>
      repository.repoPath === resource.repoPath && [
        renderPlanBranchNameForProject({ plan, projectId: repository.projectId, getProjectById: deps.getAppState().getProjectById }),
        ...listPlanBranchNamesForProject({ plan, projectId: repository.projectId, getProjectById: deps.getAppState().getProjectById }),
      ].includes(resource.branchName),
    ));
  };

  const finishProvision = async (plan: ArchitectPlanRecord): Promise<void> => {
    const saga = (await loadPlanLifecycleSagas()).find((entry) => entry.operation === 'provision' &&
      entry.planId === plan.id && entry.branchName === plan.targetBranch);
    if (saga) await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(saga));
  };

  const rollbackProvisionSaga = async (saga: PlanLifecycleSaga): Promise<void> => {
    const errors: string[] = [];
    // Worktrees must be removed before their branches. Each successful removal
    // is durable; an interrupted rollback can resume without claiming new work.
    const resources = [...(saga.cleanupResources ?? [])].reverse().sort((a, b) =>
      Number(b.kind === 'worktree') - Number(a.kind === 'worktree'));
    for (const resource of resources) {
      try {
        if (resource.kind === 'worktree') {
          const inspection = await deps.tauri.gitWorktreeInspect({ repoPath: resource.repoPath,
            taskId: resource.worktreeKey!, branchName: resource.branchName, readOnly: true });
          if (inspection.status !== 'absent') {
            if (!resource.expectedCommit) throw new Error('Creation outcome is unconfirmed; inspect this resource before cleanup.');
            await deps.tauri.gitWorktreeRemove({ repoPath: resource.repoPath, taskId: resource.worktreeKey!,
            branchName: resource.branchName, force: false, expectedCommit: resource.expectedCommit,
            expectedWorktreePath: resource.expectedWorktreePath });
          }
        } else {
          if (saga.cleanupResources?.some((other) => other.kind === 'worktree' &&
            other.repoPath === resource.repoPath && other.branchName === resource.branchName)) {
            throw new Error('The worktree still requires cleanup.');
          }
          const branches = await deps.tauri.gitBranchList(resource.repoPath);
          if (branches.local.some((branch) => branch.name === resource.branchName)) {
            if (!resource.expectedCommit) throw new Error('Creation outcome is unconfirmed; inspect this resource before cleanup.');
            await deps.tauri.gitBranchDelete({ repoPath: resource.repoPath, branchName: resource.branchName,
              force: true, expectedCommit: resource.expectedCommit });
          }
        }
        saga.cleanupResources = saga.cleanupResources?.filter((entry) => entry !== resource);
        saga.updatedAt = new Date().toISOString();
        await upsertPlanLifecycleSaga(saga);
      } catch (error) {
        errors.push(`${resource.kind} ${resource.branchName} (${resource.repoPath}): ${toServiceError(error).message}`);
      }
    }
    if (errors.length) {
      saga.lastError = errors.join('\n');
      await upsertPlanLifecycleSaga(saga);
      throw new Error(`Git provisioning cleanup remains pending:\n${saga.lastError}`);
    }
    await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(saga));
  };

  const rollbackPreservingError = async (rollback: () => Promise<void>, error: unknown): Promise<never> => {
    try { await rollback(); } catch (cleanupError) {
      throw new Error(`${toServiceError(error).message}\n${toServiceError(cleanupError).message}`, { cause: error });
    }
    throw error;
  };

  const provisionRollbacks = new WeakMap<ProvisionPlanBranchesResult, () => Promise<void>>();
  const rollbackProvisionResultWithDeps = async (
    provision: ProvisionPlanBranchesResult,
  ): Promise<void> => {
    const rollback = provisionRollbacks.get(provision);
    if (!rollback) return;
    provisionRollbacks.delete(provision);
    await rollback();
  };

  const resolveProjectRepoPathsWithDeps = (
    projectIds: string[],
    explicitRepoPath?: string,
    options?: { allowMissing?: boolean }
  ): ResolvedProjectRepository[] => {
    return resolveProjectRepoPathsFromAppState(deps.getAppState(), projectIds, explicitRepoPath, options);
  };

  const resolvePlanProjectRepoPathsWithDeps = (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
    options?: ResolvePlanProjectRepoPathOptions
  ): ResolvedProjectRepository[] =>
    resolvePlanProjectRepoPathsFromAppState(deps.getAppState(), plan, explicitRepoPath, options);

  const normalizePlanNodesForGitFlowWithDeps = (plan: ArchitectPlanRecord): PlanNode[] => {
    return (plan.nodes || []).map((node) => {
      const projectIds = normalizeNodeProjectIds(node);
      const branchIntent = getPlanNodeBranchIntent(node);
      return {
        ...node,
        assignedBranch: branchIntent.label,
        branchType: branchIntent.branchType,
        branchSlug: branchIntent.branchSlug,
        projectId: projectIds[0],
        projectIds,
      };
    });
  };

  const resolveSafeCheckoutBeforeDeletionWithDeps = async (
    repoPath: string,
    branchesToDelete: Set<string>,
    branches: ArchitectGitFlowGitBranches,
    fallbackBranches: string[] = []
  ): Promise<string | null> => {
    const status = await deps.tauri.gitStatus(repoPath);
    const current = status.branch;
    if (!branchesToDelete.has(current)) return null;

    if (!status.is_clean) {
      throw new Error(`Cannot delete plan branches while currently on "${current}" with local changes. Commit or stash changes first.`);
    }

    const localNames = (branches.local || []).map((branch) => branch.name);
    const localSet = new Set(localNames);
    const fallbackCandidates = [
      ...fallbackBranches,
      deps.getGitFlowBaseBranch(),
      'main',
      'develop',
      ...localNames.filter((name) => !branchesToDelete.has(name)),
    ];
    const fallback = fallbackCandidates.find(
      (name, index) =>
        name.trim().length > 0 &&
        fallbackCandidates.indexOf(name) === index &&
        localSet.has(name) &&
        !branchesToDelete.has(name)
    );
    if (!fallback) {
      throw new Error(`Cannot delete active branch "${current}" because no safe fallback branch is available.`);
    }

    return fallback;
  };

  const ensureSafeCheckoutBeforeDeletionWithDeps = async (
    repoPath: string,
    branchesToDelete: Set<string>,
    branches: ArchitectGitFlowGitBranches,
    fallbackBranches: string[] = []
  ): Promise<void> => {
    const fallback = await resolveSafeCheckoutBeforeDeletionWithDeps(
      repoPath,
      branchesToDelete,
      branches,
      fallbackBranches
    );
    if (!fallback) {
      return;
    }

    await deps.tauri.gitCheckout({
      repoPath,
      branchOrCommit: fallback,
      create: false,
    });
  };

  const buildCleanupPlanTargetsWithDeps = (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string
  ): CleanupPlanRepositoryTarget[] => {
    const repositories = resolvePlanProjectRepoPathsWithDeps(plan, explicitRepoPath, {
      logContext: 'cleanup',
    });

    return repositories.map((repository) => {
      const planBranchName = renderPlanBranchNameForProject({
        plan,
        projectId: repository.projectId,
        getProjectById: deps.getAppState().getProjectById,
      });
      const featureBranchNames = listPlanBranchNamesForProject({
        plan,
        projectId: repository.projectId,
        getProjectById: deps.getAppState().getProjectById,
      });

      const worktrees = featureBranchNames.map((branchName) => ({
        worktreeKey: toBranchWorktreeKey(repository.projectId, branchName),
        branchName,
        worktreePath: buildTaskWorktreePath(repository.repoPath, toBranchWorktreeKey(repository.projectId, branchName)),
      }));
      const integrationWorktreeKey = toPlanIntegrationWorktreeKey(repository.projectId, planBranchName);

      return {
        ...repository,
        planBranchName,
        featureBranchNames,
        worktrees,
        integrationWorktree: {
          worktreeKey: integrationWorktreeKey,
          branchName: planBranchName,
          worktreePath: buildPlanIntegrationWorktreePath(repository.repoPath, integrationWorktreeKey),
        },
      };
    });
  };

  const preflightPlanCleanupWithDeps = async (targets: CleanupPlanRepositoryTarget[]): Promise<void> => {
    for (const target of targets) {
      const branches = await deps.tauri.gitBranchList(target.repoPath);
      const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
      const candidates = [...target.featureBranchNames, target.planBranchName].filter((name) => localBranchNames.has(name));

      if (candidates.length > 0) {
        await resolveSafeCheckoutBeforeDeletionWithDeps(
          target.repoPath,
          new Set(candidates),
          branches,
          resolveStableFallbackBranchesForProject({
            projectId: target.projectId,
            getProjectById: deps.getAppState().getProjectById,
            getGitFlowBaseBranch: deps.getGitFlowBaseBranch,
          })
        );
      }

      for (const worktree of target.worktrees) {
        try {
          const inspection = await deps.tauri.gitWorktreeInspect({
            repoPath: target.repoPath,
            taskId: worktree.worktreeKey,
            branchName: worktree.branchName,
          });
          if (inspection.status !== 'absent' && inspection.isDirty) {
            throw new Error(
              `Cannot clean up worktree ${inspection.worktreePath} because it has uncommitted changes.`
            );
          }
        } catch (error) {
          if (isMissingGitTargetError(error)) {
            continue;
          }
          throw error;
        }
      }

      try {
        const inspection = await deps.tauri.gitBranchWorktreeInspect({
          repoPath: target.repoPath,
          worktreeKey: target.integrationWorktree.worktreeKey,
          branchName: target.integrationWorktree.branchName,
        });
        if (inspection.status !== 'absent' && inspection.isDirty) {
          throw new Error(
            `Cannot clean up worktree ${inspection.worktreePath} because it has uncommitted changes.`
          );
        }
      } catch (error) {
        if (!isMissingGitTargetError(error)) {
          throw error;
        }
      }
    }
  };

  const capturePlanCleanupResourcesWithDeps = async (
    targets: CleanupPlanRepositoryTarget[],
  ): Promise<PlanLifecycleCleanupResource[]> => {
    const resources: PlanLifecycleCleanupResource[] = [];
    for (const target of targets) {
      const branches = await deps.tauri.gitBranchList(target.repoPath);
      const localBranches = new Map(
        (branches.local || []).map((branch) => [branch.name, branch.commit ?? null] as const),
      );
      for (const branchName of [...target.featureBranchNames, target.planBranchName]) {
        if (!localBranches.has(branchName)) continue;
        resources.push({
          kind: 'branch',
          projectId: target.projectId,
          repoPath: target.repoPath,
          branchName,
          expectedCommit: localBranches.get(branchName) ?? null,
        });
      }
      for (const worktree of target.worktrees) {
        let inspection: tauriIpc.GitWorktreeInspectionDto;
        try {
          inspection = await deps.tauri.gitWorktreeInspect({
            repoPath: target.repoPath,
            taskId: worktree.worktreeKey,
            branchName: worktree.branchName,
          });
        } catch (error) {
          if (isMissingGitTargetError(error)) continue;
          throw error;
        }
        if (inspection.status === 'absent') continue;
        resources.push({
          kind: 'worktree',
          projectId: target.projectId,
          repoPath: target.repoPath,
          branchName: worktree.branchName,
          expectedCommit: localBranches.get(worktree.branchName) ?? null,
          worktreeKey: worktree.worktreeKey,
          expectedWorktreePath: inspection.worktreePath,
        });
      }
      let integrationInspection: tauriIpc.GitBranchWorktreeInspectionDto;
      try {
        integrationInspection = await deps.tauri.gitBranchWorktreeInspect({
          repoPath: target.repoPath,
          worktreeKey: target.integrationWorktree.worktreeKey,
          branchName: target.integrationWorktree.branchName,
        });
      } catch (error) {
        if (isMissingGitTargetError(error)) continue;
        throw error;
      }
      if (integrationInspection.status !== 'absent') {
        resources.push({
          kind: 'worktree',
          projectId: target.projectId,
          repoPath: target.repoPath,
          branchName: target.integrationWorktree.branchName,
          expectedCommit: localBranches.get(target.integrationWorktree.branchName) ?? null,
          worktreeKey: target.integrationWorktree.worktreeKey,
          expectedWorktreePath: integrationInspection.worktreePath,
        });
      }
    }
    return resources;
  };

  const assertPlanWorktreeIdentityWithDeps = async (params: {
    target: CleanupPlanRepositoryTarget;
    worktree: CleanupPlanWorktreeTarget;
    inspection: tauriIpc.GitWorktreeInspectionDto | tauriIpc.GitBranchWorktreeInspectionDto;
    resources: PlanLifecycleCleanupResource[];
  }): Promise<PlanLifecycleCleanupResource> => {
    const expected = params.resources.find((resource) =>
      resource.kind === 'worktree' &&
      resource.repoPath === params.target.repoPath &&
      resource.worktreeKey === params.worktree.worktreeKey
    );
    const branches = await deps.tauri.gitBranchList(params.target.repoPath);
    const currentCommit = (branches.local || []).find(
      (branch) => branch.name === params.worktree.branchName,
    )?.commit ?? null;
    if (
      !expected ||
      expected.branchName !== params.worktree.branchName ||
      expected.expectedWorktreePath !== params.inspection.worktreePath ||
      expected.expectedCommit !== currentCommit
    ) {
      throw new Error(
        `Refusing to remove worktree ${params.worktree.worktreeKey} because its durable identity changed.`,
      );
    }
    return expected;
  };

  const assertPlanBranchIdentityWithDeps = async (params: {
    repoPath: string;
    branchName: string;
    resources: PlanLifecycleCleanupResource[];
  }): Promise<void> => {
    const expected = params.resources.find((resource) =>
      resource.kind === 'branch' &&
      resource.repoPath === params.repoPath &&
      resource.branchName === params.branchName
    );
    const branches = await deps.tauri.gitBranchList(params.repoPath);
    const currentCommit = (branches.local || []).find(
      (branch) => branch.name === params.branchName,
    )?.commit ?? null;
    if (!expected || expected.expectedCommit !== currentCommit) {
      throw new Error(
        `Refusing to remove branch ${params.branchName} because its durable identity changed.`,
      );
    }
  };

  const cleanupPlanBranchesInternalWithDeps = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
    options?: {
      allowRetained?: boolean;
      expectedResources?: PlanLifecycleCleanupResource[];
      onResourcesCaptured?: (resources: PlanLifecycleCleanupResource[]) => Promise<void>;
    }
  ): Promise<CleanupPlanRepositoryResult[]> => {
    const targets = buildCleanupPlanTargetsWithDeps(plan, explicitRepoPath);

    if (!deps.tauri.isTauriAvailable()) {
      return targets.map((repository) => ({
        projectId: repository.projectId,
        repoPath: repository.repoPath,
        deletedBranches: [],
        deletedWorktrees: [],
        retainedBranches: [],
        retainedWorktrees: [],
        cleanupError: null,
      }));
    }

    await preflightPlanCleanupWithDeps(targets);
    const cleanupResources = options?.expectedResources ??
      await capturePlanCleanupResourcesWithDeps(targets);
    if (!options?.expectedResources) {
      await options?.onResourcesCaptured?.(cleanupResources);
    }

    const allowRetained = options?.allowRetained === true;
    const results: CleanupPlanRepositoryResult[] = [];

    for (const target of targets) {
      const deletedWorktrees: CleanupPlanRepositoryResult['deletedWorktrees'] = [];
      const retainedWorktrees: CleanupPlanRepositoryResult['retainedWorktrees'] = [];
      const deletedBranches: string[] = [];
      const retainedBranches: string[] = [];
      let cleanupError: string | null = null;

      const branches = await deps.tauri.gitBranchList(target.repoPath);
      const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
      const branchCandidates = [...target.featureBranchNames, target.planBranchName].filter((name) => localBranchNames.has(name));

      if (branchCandidates.length > 0) {
        await ensureSafeCheckoutBeforeDeletionWithDeps(
          target.repoPath,
          new Set(branchCandidates),
          branches,
          resolveStableFallbackBranchesForProject({
            projectId: target.projectId,
            getProjectById: deps.getAppState().getProjectById,
            getGitFlowBaseBranch: deps.getGitFlowBaseBranch,
          })
        );
      }

      for (const worktree of target.worktrees) {
        try {
          const inspection = await deps.tauri.gitWorktreeInspect({
            repoPath: target.repoPath,
            taskId: worktree.worktreeKey,
            branchName: worktree.branchName,
          });
          if (inspection.status === 'absent') {
            continue;
          }

          const expectedResource = await assertPlanWorktreeIdentityWithDeps({
            target,
            worktree,
            inspection,
            resources: cleanupResources,
          });

          const removed = await deps.tauri.gitWorktreeRemove({
            repoPath: target.repoPath,
            taskId: worktree.worktreeKey,
            branchName: worktree.branchName,
            expectedCommit: expectedResource.expectedCommit,
            expectedWorktreePath: expectedResource.expectedWorktreePath,
          });
          if (!removed.alreadyAbsent) {
            deletedWorktrees.push({
              ...worktree,
              worktreePath: removed.worktreePath,
            });
          }
        } catch (error) {
          if (isMissingGitTargetError(error)) {
            continue;
        }
          if (!allowRetained) {
            throw error;
          }
          cleanupError = cleanupError || toServiceError(error).message;
          retainedWorktrees.push(worktree);
        }
      }

      try {
        const inspection = await deps.tauri.gitBranchWorktreeInspect({
          repoPath: target.repoPath,
          worktreeKey: target.integrationWorktree.worktreeKey,
          branchName: target.integrationWorktree.branchName,
        });
        if (inspection.status !== 'absent') {
          const expectedResource = await assertPlanWorktreeIdentityWithDeps({
            target,
            worktree: target.integrationWorktree,
            inspection,
            resources: cleanupResources,
          });
          const removed = await deps.tauri.gitBranchWorktreeRemove({
            repoPath: target.repoPath,
            worktreeKey: target.integrationWorktree.worktreeKey,
            branchName: target.integrationWorktree.branchName,
            expectedCommit: expectedResource.expectedCommit,
            expectedWorktreePath: expectedResource.expectedWorktreePath,
          });
          if (!removed.alreadyAbsent) {
            deletedWorktrees.push({
              ...target.integrationWorktree,
              worktreePath: removed.worktreePath,
            });
          }
        }
      } catch (error) {
        if (isMissingGitTargetError(error)) {
          // Nothing to clean up.
        } else if (!allowRetained) {
          throw error;
        } else {
          cleanupError = cleanupError || toServiceError(error).message;
          retainedWorktrees.push(target.integrationWorktree);
        }
      }

      for (const branchName of branchCandidates) {
        try {
          await assertPlanBranchIdentityWithDeps({
            repoPath: target.repoPath,
            branchName,
            resources: cleanupResources,
          });
          await deps.tauri.gitBranchDelete({
            repoPath: target.repoPath,
            branchName,
            force: false,
            expectedCommit: cleanupResources.find((resource) =>
              resource.kind === 'branch' &&
              resource.repoPath === target.repoPath &&
              resource.branchName === branchName
            )?.expectedCommit,
          });
          deletedBranches.push(branchName);
        } catch (error) {
          if (!allowRetained) {
            throw error;
          }
          cleanupError = cleanupError || toServiceError(error).message;
          retainedBranches.push(branchName);
        }
      }

      results.push({
        projectId: target.projectId,
        repoPath: target.repoPath,
        deletedBranches,
        deletedWorktrees,
        retainedBranches,
        retainedWorktrees,
        cleanupError,
      });
    }

    return results;
  };

  const preflightPlanRepositoriesWithDeps = async (params: {
    plan: ArchitectPlanRecord;
    explicitRepoPath?: string;
    repositories?: ResolvedProjectRepository[];
  }): Promise<PlanReviewRepositoryResult[]> => {
    const repositories =
      params.repositories ||
      resolvePlanProjectRepoPathsWithDeps(params.plan, params.explicitRepoPath, {
        logContext: 'preflight',
      });

    return Promise.all(
      repositories.map(async (repository) => {
        const repositoryPlanBranchName = renderPlanBranchNameForProject({
          plan: params.plan,
          projectId: repository.projectId,
          getProjectById: deps.getAppState().getProjectById,
        });
        const repositoryBaseBranchName = resolvePlanProjectBaseBranchName(
          params.plan,
          repository.projectId,
          deps.getAppState().getProjectById
        );
        const status = await deps.tauri.gitStatus(repository.repoPath);
        const diff = await deps.tauri.gitDiff({
          repoPath: repository.repoPath,
          base: repositoryBaseBranchName,
          head: repositoryPlanBranchName,
          contextLines: 3,
        });

        const mergeCheck = status.is_clean
          ? await deps.tauri.gitMergeCheck({
            repoPath: repository.repoPath,
            branchName: repositoryPlanBranchName,
            intoBranch: repositoryBaseBranchName,
          })
          : {
            mergeable: false,
            conflictFiles: [],
            hasChanges: diff.trim().length > 0,
            ahead: 0,
            behind: 0,
          };
        const branches = await deps.tauri.gitBranchList(repository.repoPath).catch(() => null);
        const isSourcePublished = branches
          ? isMergeWorkflowSourcePublished(branches, repositoryPlanBranchName)
          : true;
        const rebaseCheck =
          shouldCheckMergeWorkflowRebase({
            status,
            mergeCheck,
            isSourcePublished,
          })
            ? await deps.tauri.gitRebaseCheck({
                repoPath: repository.repoPath,
                branchName: repositoryPlanBranchName,
                ontoBranch: repositoryBaseBranchName,
              }).catch(() => null)
            : null;
        const strategy = resolveMergeWorkflowStrategy({
          status,
          mergeCheck,
          isSourcePublished,
          rebaseCheck,
        });
        const blocking = buildPlanRepositoryBlockingState({
          repositoryPath: repository.repoPath,
          status,
          mergeCheck,
        });

        return {
          id: `${repository.projectId}::${repository.repoPath}`,
          projectId: repository.projectId,
          repoPath: repository.repoPath,
          planBranchName: repositoryPlanBranchName,
          baseBranchName: repositoryBaseBranchName,
          isClean: status.is_clean,
          hasChanges: strategy.mergeStrategy !== 'no_source_changes' && mergeCheck.hasChanges,
          ahead: strategy.ahead,
          behind: strategy.behind,
          mergeable: mergeCheck.mergeable,
          conflictFiles: blocking.conflictFiles,
          dirtyFiles: strategy.dirtyFiles,
          mergeInProgress: blocking.mergeInProgress,
          diff,
          checkStatus: 'not_run' as const,
          blockingKind: blocking.blockingKind,
          nextAction: blocking.nextAction,
          blockingReason: blocking.blockingReason,
          isSourcePublished,
          mergeStrategy: strategy.mergeStrategy,
          recommendedAction: strategy.recommendedAction,
          availableActions: strategy.availableActions,
        };
      })
    );
  };

  const syncPlanRepositoriesToBaseBranchesWithDeps = async (params: {
    plan: ArchitectPlanRecord;
    explicitRepoPath?: string;
  }): Promise<ResolvedProjectRepository[]> => {
    const repositories = resolvePlanProjectRepoPathsWithDeps(params.plan, params.explicitRepoPath, {
      logContext: 'finalize_sync',
    });

    await Promise.all(
      repositories.map(async (repository) => {
        const baseBranchName = resolvePlanProjectBaseBranchName(
          params.plan,
          repository.projectId,
          deps.getAppState().getProjectById
        );
        await deps.tauri.gitCheckout({
          repoPath: repository.repoPath,
          branchOrCommit: baseBranchName,
          create: false,
        });
        await deps.tauri.gitPull({
          repoPath: repository.repoPath,
        });
      })
    );

    return repositories;
  };

  const provisionPlanBranchesUnlocked = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
    committedSaga?: PlanLifecycleSaga,
  ): Promise<ProvisionPlanBranchesResult> => {
    const featureBranchesByProject = new Map<string, string[]>(
      resolvePlanProjectRepoPathsWithDeps(plan, explicitRepoPath, {
        errorMessage: 'Unable to resolve repository path for this plan. Select at least one project before validating the plan.',
        logContext: 'provision',
      }).map((repository) => [
        repository.projectId,
        listPlanBranchNamesForProject({
          plan,
          projectId: repository.projectId,
          getProjectById: deps.getAppState().getProjectById,
        }),
      ])
    );

    if (!deps.tauri.isTauriAvailable()) {
      throw new Error('Plan execution preparation requires the desktop runtime.');
    }

    const repositories = resolvePlanProjectRepoPathsWithDeps(plan, explicitRepoPath, {
      errorMessage: 'Unable to resolve repository path for this plan. Select at least one project before validating the plan.',
      logContext: 'provision',
    });

    const results: ProvisionedPlanRepositoryResult[] = [];
    const previous = !committedSaga && (await loadPlanLifecycleSagas()).find((entry) => entry.operation === 'provision' &&
      entry.planId === plan.id && entry.branchName === plan.targetBranch);
    if (previous) {
      const persistedPlan = await deps.getArchitectPlan(previous.branchName, previous.planId);
      if (provisionMatchesPersistedPlan(previous, persistedPlan)) {
        await provisionPlanBranchesUnlocked(persistedPlan!, explicitRepoPath, previous);
        await finishProvision(persistedPlan!);
      } else await rollbackProvisionSaga(previous);
    }
    const now = new Date().toISOString();
    const saga: PlanLifecycleSaga = committedSaga ?? { planId: plan.id, branchName: plan.targetBranch,
      operation: 'provision', phase: 'prepared', cleanupResources: [], createdAt: now, updatedAt: now };
    if (!committedSaga) await startPlanLifecycleSaga(saga);
    const recordIntent = async (resource: PlanLifecycleCleanupResource) => {
      saga.cleanupResources!.push(resource);
      await upsertPlanLifecycleSaga(saga);
      return resource;
    };
    const confirmResource = async (resource: PlanLifecycleCleanupResource, worktreePath?: string) => {
      const branches = await deps.tauri.gitBranchList(resource.repoPath);
      resource.expectedCommit = branches.local.find((branch) => branch.name === resource.branchName)?.commit ?? null;
      if (worktreePath) resource.expectedWorktreePath = worktreePath;
      await upsertPlanLifecycleSaga(saga);
    };
    const rollbackCreatedGitResources = () => rollbackProvisionSaga(saga);
    try {
      for (const repository of repositories) {
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        const localBranchNames = new Set((branches.local || []).map((branch) => branch.name));
        const createdFeatureBranches: string[] = [];
        const existingFeatureBranches: string[] = [];
        const repositoryPlanBranchName = renderPlanBranchNameForProject({
          plan,
          projectId: repository.projectId,
          getProjectById: deps.getAppState().getProjectById,
        });
        const repositorySourceBranchName = resolvePlanProjectSourceBranchName(
          plan,
          repository.projectId,
          deps.getAppState().getProjectById
        );

        let createdPlanBranch = false;
        if (!localBranchNames.has(repositoryPlanBranchName)) {
          const fromRef = resolveBranchSourceRef(
            branches,
            repositorySourceBranchName,
            deps.getAppState().getProjectById(repository.projectId)?.path || repository.projectId
          );
          const intent = await recordIntent({ kind: 'branch', projectId: repository.projectId,
            repoPath: repository.repoPath, branchName: repositoryPlanBranchName, expectedCommit: null });
          await deps.tauri.gitBranchCreate({
            repoPath: repository.repoPath,
            branchName: repositoryPlanBranchName,
            fromRef,
          });
          await confirmResource(intent);
          localBranchNames.add(repositoryPlanBranchName);
          createdPlanBranch = true;
        }

        for (const featureBranch of featureBranchesByProject.get(repository.projectId) || []) {
          if (localBranchNames.has(featureBranch)) {
            existingFeatureBranches.push(featureBranch);
            continue;
          }

          const intent = await recordIntent({ kind: 'branch', projectId: repository.projectId,
            repoPath: repository.repoPath, branchName: featureBranch, expectedCommit: null });
          await deps.tauri.gitBranchCreate({
            repoPath: repository.repoPath,
            branchName: featureBranch,
            fromRef: repositoryPlanBranchName,
          });
          await confirmResource(intent);
          localBranchNames.add(featureBranch);
          createdFeatureBranches.push(featureBranch);
        }

        for (const featureBranch of featureBranchesByProject.get(repository.projectId) || []) {
          const worktreeKey = toBranchWorktreeKey(repository.projectId, featureBranch);
          const inspection = await deps.tauri.gitWorktreeInspect({
            repoPath: repository.repoPath,
            taskId: worktreeKey,
            branchName: featureBranch,
          });
          if (inspection.status === 'ready' && inspection.branchName === featureBranch) {
            continue;
          }

          const intent = await recordIntent({ kind: 'worktree', projectId: repository.projectId,
            repoPath: repository.repoPath, branchName: featureBranch, worktreeKey,
            expectedCommit: null, expectedWorktreePath: inspection.worktreePath });
          const ensuredWorktree = await deps.tauri.gitWorktreeCreate({
            repoPath: repository.repoPath,
            taskId: worktreeKey,
            branchName: featureBranch,
            fromRef: repositoryPlanBranchName,
            preferredCommitBranch: null,
            fallbackBranches: resolveStableFallbackBranchesForProject({
              projectId: repository.projectId,
              getProjectById: deps.getAppState().getProjectById,
              getGitFlowBaseBranch: deps.getGitFlowBaseBranch,
              extraBranches: [repositoryPlanBranchName],
            }),
          });
          if (ensuredWorktree.createdByThisCall ?? ensuredWorktree.status === 'created') {
            await confirmResource(intent, ensuredWorktree.worktreePath);
          } else {
            // Link repairs and concurrently reused worktrees did not originate here.
            saga.cleanupResources = saga.cleanupResources!.filter((resource) => resource !== intent);
            await upsertPlanLifecycleSaga(saga);
          }
        }

        results.push({
          projectId: repository.projectId,
          repoPath: repository.repoPath,
          planBranchName: repositoryPlanBranchName,
          createdPlanBranch,
          createdFeatureBranches,
          existingFeatureBranches,
        });
      }
    } catch (error) {
      if (committedSaga) {
        saga.lastError = toServiceError(error).message;
        await upsertPlanLifecycleSaga(saga);
        throw error;
      }
      return rollbackPreservingError(rollbackCreatedGitResources, error);
    }

    const result: ProvisionPlanBranchesResult = {
      planBranchName: results[0]?.planBranchName || renderPlanBranchNameForProject({
        plan,
        projectId: plan.projectId || plan.projectIds?.[0] || 'project',
        getProjectById: deps.getAppState().getProjectById,
      }),
      repositories: results,
      createdPlanBranch: results.some((result) => result.createdPlanBranch),
      createdFeatureBranches: results.flatMap((result) => result.createdFeatureBranches),
      existingFeatureBranches: results.flatMap((result) => result.existingFeatureBranches),
    };
    provisionRollbacks.set(result, rollbackCreatedGitResources);
    return result;
  };

  const provisionPlanBranchesWithDeps = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
    persistPlan?: () => Promise<void>,
  ): Promise<ProvisionPlanBranchesResult> =>
    withPlanLifecycleLock(deps, plan.targetBranch, plan.id, async () => {
      const result = await provisionPlanBranchesUnlocked(plan, explicitRepoPath);
      try {
        await persistPlan?.();
      } catch (error) {
        return rollbackPreservingError(() => rollbackProvisionResultWithDeps(result), error);
      }
      await finishProvision(plan);
      return result;
    });

  const validatePlanAndProvisionBranchesUnlocked = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
    setActive?: boolean;
  }): Promise<{ plan: ArchitectPlanRecord; provision: ProvisionPlanBranchesResult }> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }

    if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
      throw new Error('Cannot validate a plan without strategy nodes. Generate strategy first.');
    }

    const normalizedNodes = normalizePlanNodesForGitFlowWithDeps(plan);
    const normalizedPredictedBranches = buildPredictedBranchesForProjectPlan({
      nodes: normalizedNodes,
      existingBranches: plan.predictedBranches || [],
      plan,
      getProjectById: deps.getAppState().getProjectById,
    });
    const normalizedStrategy = normalizeStrategyDependencies(
      normalizedNodes,
      normalizedPredictedBranches,
      {
        planSlug: plan.slug,
      }
    );
    const projectIds = getPlanProjectIds({
      ...plan,
      nodes: normalizedStrategy.nodes,
      predictedBranches: normalizedStrategy.predictedBranches,
    });

    const normalizedPlan: ArchitectPlanRecord = {
      ...plan,
      projectId: projectIds[0],
      projectIds,
      nodes: normalizedStrategy.nodes,
      predictedBranches: normalizedStrategy.predictedBranches,
    };

    const provision = await provisionPlanBranchesUnlocked(normalizedPlan, params.repoPath);

    let validatedPlan: ArchitectPlanRecord;
    try {
      validatedPlan = await deps.updateArchitectPlan({
        branchName: params.branchName,
        planId: plan.id,
        status: 'validated',
        nodes: normalizedPlan.nodes,
        predictedBranches: normalizedPlan.predictedBranches,
        projectId: normalizedPlan.projectId,
        projectIds: normalizedPlan.projectIds,
        setActive: params.setActive !== false,
      });
    } catch (error) {
      return rollbackPreservingError(() => rollbackProvisionResultWithDeps(provision), error);
    }

    await finishProvision(normalizedPlan);
    return {
      plan: {
        ...validatedPlan,
        projectId: normalizedPlan.projectId,
        projectIds,
        nodes: normalizedPlan.nodes,
        predictedBranches: normalizedPlan.predictedBranches,
      },
      provision,
    };
  };

  const validatePlanAndProvisionBranchesWithDeps = async (
    params: Parameters<typeof validatePlanAndProvisionBranchesUnlocked>[0],
  ): ReturnType<typeof validatePlanAndProvisionBranchesUnlocked> =>
    withPlanLifecycleLock(deps, params.branchName, params.planId, () =>
      validatePlanAndProvisionBranchesUnlocked(params)
    );

  const mergeFeatureBranchIntoPlanBranchWithDeps = async (params: {
    projectId: string;
    branchName: string;
    planBranchName: string;
    repoPath?: string;
  }): Promise<string> => {
    const repository = resolveProjectRepoPathsWithDeps([params.projectId], params.repoPath)[0];
    if (!repository?.repoPath) {
      throw new Error(`Unable to resolve repository path for project ${params.projectId}.`);
    }

    const integrationWorktree = await ensurePlanIntegrationWorktree({
      tauri: deps.tauri,
      repositoryRootPath: repository.repoPath,
      projectId: params.projectId,
      planBranchName: params.planBranchName,
      getProjectById: deps.getAppState().getProjectById,
      getGitFlowBaseBranch: deps.getGitFlowBaseBranch,
    });

    return deps.tauri.gitMerge({
      repoPath: integrationWorktree.worktreePath,
      branchName: params.branchName,
      intoBranch: params.planBranchName,
    });
  };

  const loadPlanReviewWithDeps = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
    syncBaseBranches?: boolean;
  }): Promise<PlanReviewResult> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }

    const repositories = params.syncBaseBranches
      ? await syncPlanRepositoriesToBaseBranchesWithDeps({
        plan,
        explicitRepoPath: params.repoPath,
      })
      : undefined;

    return {
      plan,
      tasks: buildPlanReviewTasks(plan),
      repositories: await preflightPlanRepositoriesWithDeps({
        plan,
        explicitRepoPath: params.repoPath,
        repositories,
      }),
    };
  };

  const cleanupPlanBranchesWithDeps = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
    options?: {
      allowRetained?: boolean;
    }
  ): Promise<CleanupPlanRepositoryResult[]> => {
    return cleanupPlanBranchesInternalWithDeps(plan, explicitRepoPath, options);
  };

  const archivePlanAndCleanupBranchesUnlocked = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
    keepSaga?: boolean;
    requireMetadataCommit?: boolean;
  }): Promise<{
    plan: ArchitectPlanRecord;
    cleanup: CleanupPlanRepositoryResult[];
    lifecycleSaga: PlanLifecycleSaga;
  }> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || !getArchitectPlanCrudCapabilities(plan).canArchive) {
      throw new Error(`Plan ${params.planId} cannot be archived.`);
    }
    const cleanupTargets = buildCleanupPlanTargetsWithDeps(plan, params.repoPath);
    const cleanupResources = deps.tauri.isTauriAvailable()
      ? await (async () => {
          await preflightPlanCleanupWithDeps(cleanupTargets);
          return capturePlanCleanupResourcesWithDeps(cleanupTargets);
        })()
      : [];
    const now = new Date().toISOString();
    let saga: PlanLifecycleSaga = {
      planId: plan.id, branchName: params.branchName, operation: 'archive', phase: 'prepared',
      conversationId: plan.conversationId ?? null, requiresMetadataCommit: params.requireMetadataCommit === true,
      cleanupResources, createdAt: now, updatedAt: now,
    };
    await startPlanLifecycleSaga(saga);
    const archived = plan.status === 'archived' ? plan : await deps.archiveArchitectPlan(params.branchName, plan.id);
    saga = { ...saga, phase: 'metadata_written', updatedAt: new Date().toISOString() };
    await upsertPlanLifecycleSaga(saga);
    const cleanup = await cleanupPlanBranchesInternalWithDeps(archived, params.repoPath, {
      expectedResources: saga.cleanupResources,
    });
    const cleanedSaga = { ...saga, phase: 'git_cleanup_complete' as const, updatedAt: new Date().toISOString() };
    await upsertPlanLifecycleSaga(cleanedSaga);
    const lifecycleSaga: PlanLifecycleSaga = params.requireMetadataCommit
      ? { ...cleanedSaga, phase: 'metadata_commit_pending', updatedAt: new Date().toISOString() }
      : cleanedSaga;
    if (params.requireMetadataCommit) {
      await upsertPlanLifecycleSaga(lifecycleSaga);
    } else if (!params.keepSaga) {
      await removePlanLifecycleSaga(
        plan.id,
        'archive',
        params.branchName,
        getPlanLifecycleSagaGeneration(lifecycleSaga),
      );
    }
    return { plan: archived, cleanup, lifecycleSaga };
  };

  const archivePlanAndCleanupBranchesWithDeps = async (
    params: Parameters<typeof archivePlanAndCleanupBranchesUnlocked>[0],
  ): ReturnType<typeof archivePlanAndCleanupBranchesUnlocked> =>
    withPlanLifecycleLock(deps, params.branchName, params.planId, () =>
      archivePlanAndCleanupBranchesUnlocked(params)
    );

  const restorePlanAndProvisionBranchesUnlocked = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
  }): Promise<ArchitectPlanRecord> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }
    const pendingArchiveSaga = (await loadPlanLifecycleSagas()).find(
      (saga) => saga.planId === plan.id && saga.branchName === params.branchName && saga.operation === 'archive',
    );
    if (plan.status !== 'archived') {
      if (pendingArchiveSaga) {
        await removePlanLifecycleSaga(
          plan.id,
          'archive',
          params.branchName,
          getPlanLifecycleSagaGeneration(pendingArchiveSaga),
        );
      }
      return plan;
    }

    if (plan.archivedFromStatus === 'validated' || plan.archivedFromStatus === 'in_progress') {
      const provision = await provisionPlanBranchesUnlocked(plan, params.repoPath);
      let restored: ArchitectPlanRecord;
      try {
        restored = await deps.restoreArchitectPlan(params.branchName, params.planId);
      } catch (error) {
        return rollbackPreservingError(() => rollbackProvisionResultWithDeps(provision), error);
      }
      if (pendingArchiveSaga) {
        await removePlanLifecycleSaga(
          plan.id,
          'archive',
          params.branchName,
          getPlanLifecycleSagaGeneration(pendingArchiveSaga),
        );
      }
      await finishProvision(plan);
      return restored;
    }
    const restored = await deps.restoreArchitectPlan(params.branchName, params.planId);
    if (pendingArchiveSaga) {
      await removePlanLifecycleSaga(
        plan.id,
        'archive',
        params.branchName,
        getPlanLifecycleSagaGeneration(pendingArchiveSaga),
      );
    }
    return restored;
  };

  const restorePlanAndProvisionBranchesWithDeps = async (
    params: Parameters<typeof restorePlanAndProvisionBranchesUnlocked>[0],
  ): ReturnType<typeof restorePlanAndProvisionBranchesUnlocked> =>
    withPlanLifecycleLock(deps, params.branchName, params.planId, () =>
      restorePlanAndProvisionBranchesUnlocked(params)
    );

  const requireLocalBranchCommit = (
    branches: ArchitectGitFlowGitBranches,
    branchName: string,
    repoPath: string,
  ): string => {
    const commit = branches.local.find((branch) => branch.name === branchName)?.commit?.trim();
    if (!commit) {
      throw new Error(
        `Cannot finalize the plan because ${branchName} has no verifiable local commit in ${repoPath}.`,
      );
    }
    return commit;
  };

  const assertFinalizationBranchCommit = (
    branches: ArchitectGitFlowGitBranches,
    branchName: string,
    expectedCommit: string,
    repoPath: string,
  ): void => {
    const actualCommit = requireLocalBranchCommit(branches, branchName, repoPath);
    if (actualCommit !== expectedCommit) {
      throw new Error(
        `Plan finalization stopped because ${branchName} changed in ${repoPath}. Expected ${expectedCommit}, found ${actualCommit}.`,
      );
    }
  };

  const capturePlanFinalizationRepositoriesWithDeps = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
  ): Promise<PlanFinalizationRepositoryCheckpoint[]> => {
    const repositories = resolvePlanProjectRepoPathsWithDeps(plan, explicitRepoPath, {
      logContext: 'finalize_intent',
    });
    return Promise.all(repositories.map(async (repository) => {
      const planBranchName = renderPlanBranchNameForProject({
        plan,
        projectId: repository.projectId,
        getProjectById: deps.getAppState().getProjectById,
      });
      const baseBranchName = resolvePlanProjectBaseBranchName(
        plan,
        repository.projectId,
        deps.getAppState().getProjectById,
      );
      const backmergeBranchName = resolvePlanProjectBackmergeBranchName(
        plan,
        repository.projectId,
        deps.getAppState().getProjectById,
      );
      const branches = await deps.tauri.gitBranchList(repository.repoPath);
      return {
        projectId: repository.projectId,
        repoPath: repository.repoPath,
        planBranchName,
        baseBranchName,
        backmergeBranchName,
        expectedPlanCommit: requireLocalBranchCommit(branches, planBranchName, repository.repoPath),
        expectedBaseCommit: requireLocalBranchCommit(branches, baseBranchName, repository.repoPath),
        expectedBackmergeCommit: backmergeBranchName
          ? requireLocalBranchCommit(branches, backmergeBranchName, repository.repoPath)
          : null,
        phase: 'prepared' as const,
      };
    }));
  };

  const runPlanFinalizationGitWithDeps = async (
    plan: ArchitectPlanRecord,
    initialSaga: PlanLifecycleSaga,
    explicitRepoPath?: string,
  ): Promise<PlanLifecycleSaga> => {
    if (!initialSaga.finalizationRepositories) {
      throw new Error('The plan finalization journal does not contain repository identities.');
    }
    let saga = initialSaga;
    const persistSaga = async (nextSaga: PlanLifecycleSaga): Promise<void> => {
      await upsertPlanLifecycleSaga(nextSaga);
      saga = nextSaga;
    };
    const persistRepository = async (
      projectId: string,
      repoPath: string,
      update: (repository: PlanFinalizationRepositoryCheckpoint) => PlanFinalizationRepositoryCheckpoint,
    ): Promise<void> => {
      const nextSaga: PlanLifecycleSaga = {
        ...saga,
        finalizationRepositories: saga.finalizationRepositories!.map((repository) =>
          repository.projectId === projectId && repository.repoPath === repoPath
            ? update(repository)
            : repository
        ),
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      };
      await persistSaga(nextSaga);
    };

    for (const repositorySnapshot of saga.finalizationRepositories!) {
      let repository = saga.finalizationRepositories!.find((candidate) =>
        candidate.projectId === repositorySnapshot.projectId &&
        candidate.repoPath === repositorySnapshot.repoPath
      )!;
      if (repository.phase === 'prepared') {
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.planBranchName,
          repository.expectedPlanCommit,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          repository.expectedBaseCommit,
          repository.repoPath,
        );
        if (repository.backmergeBranchName && repository.expectedBackmergeCommit) {
          assertFinalizationBranchCommit(
            branches,
            repository.backmergeBranchName,
            repository.expectedBackmergeCommit,
            repository.repoPath,
          );
        }
        const preparedSync = await deps.tauri.gitPrepareGuardedBranchSync({
          repoPath: repository.repoPath,
          branchName: repository.baseBranchName,
          expectedBranchCommit: repository.expectedBaseCommit,
        });
        const branchesAfterPrepare = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branchesAfterPrepare,
          repository.planBranchName,
          repository.expectedPlanCommit,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branchesAfterPrepare,
          repository.baseBranchName,
          repository.expectedBaseCommit,
          repository.repoPath,
        );
        if (repository.backmergeBranchName && repository.expectedBackmergeCommit) {
          assertFinalizationBranchCommit(
            branchesAfterPrepare,
            repository.backmergeBranchName,
            repository.expectedBackmergeCommit,
            repository.repoPath,
          );
        }
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'base_sync_pending',
          baseSyncTargetCommit: preparedSync.targetCommit,
        }));
        repository = saga.finalizationRepositories!.find((candidate) =>
          candidate.projectId === repositorySnapshot.projectId &&
          candidate.repoPath === repositorySnapshot.repoPath
        )!;
      }

      if (repository.phase === 'base_sync_pending') {
        if (!repository.baseSyncTargetCommit) {
          throw new Error(`Plan finalization is missing the prepared base sync for ${repository.repoPath}.`);
        }
        const sync = await deps.tauri.gitGuardedBranchSync({
          repoPath: repository.repoPath,
          branchName: repository.baseBranchName,
          expectedBranchCommit: repository.expectedBaseCommit,
          syncTargetCommit: repository.baseSyncTargetCommit,
        });
        if (sync.status !== 'integrated') {
          throw new Error(`Plan finalization did not reconcile the base sync for ${repository.repoPath}.`);
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.planBranchName,
          repository.expectedPlanCommit,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          sync.targetCommit,
          repository.repoPath,
        );
        if (repository.backmergeBranchName && repository.expectedBackmergeCommit) {
          assertFinalizationBranchCommit(
            branches,
            repository.backmergeBranchName,
            repository.expectedBackmergeCommit,
            repository.repoPath,
          );
        }
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'base_synced',
          baseCommitAfterSync: sync.targetCommit,
        }));
      }
    }

    const resolvedRepositories = saga.finalizationRepositories!.map((repository) => ({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
    }));
    const preflightRepositories = await preflightPlanRepositoriesWithDeps({
      plan,
      explicitRepoPath,
      repositories: resolvedRepositories,
    });
    if (preflightRepositories.some((repository) => repository.blockingReason)) {
      throw createPlanFinalizationBlockedError({
        planId: plan.id,
        branchName: saga.branchName,
        repositories: preflightRepositories,
      });
    }
    await preflightPlanCleanupWithDeps(buildCleanupPlanTargetsWithDeps(plan, explicitRepoPath));
    const preflightByRepository = new Map(preflightRepositories.map((repository) => [
      `${repository.projectId}:${repository.repoPath}`,
      repository,
    ]));
    for (const repository of saga.finalizationRepositories!) {
      if (repository.phase !== 'base_synced' || repository.mergeRequired !== undefined) continue;
      const preflight = preflightByRepository.get(`${repository.projectId}:${repository.repoPath}`);
      if (!preflight) {
        throw new Error(`Plan finalization lost repository ${repository.repoPath} during preflight.`);
      }
      await persistRepository(repository.projectId, repository.repoPath, (current) => ({
        ...current,
        mergeRequired: preflight.hasChanges,
      }));
    }

    for (const repositorySnapshot of saga.finalizationRepositories!) {
      let repository = saga.finalizationRepositories!.find((candidate) =>
        candidate.projectId === repositorySnapshot.projectId &&
        candidate.repoPath === repositorySnapshot.repoPath
      )!;
      if (repository.phase === 'base_synced') {
        if (typeof repository.mergeRequired !== 'boolean' || !repository.baseCommitAfterSync) {
          throw new Error(`Plan finalization is missing the merge decision for ${repository.repoPath}.`);
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.planBranchName,
          repository.expectedPlanCommit,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          repository.baseCommitAfterSync,
          repository.repoPath,
        );
        if (repository.backmergeBranchName && repository.expectedBackmergeCommit) {
          assertFinalizationBranchCommit(
            branches,
            repository.backmergeBranchName,
            repository.expectedBackmergeCommit,
            repository.repoPath,
          );
        }
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'plan_merge_pending',
        }));
        repository = saga.finalizationRepositories!.find((candidate) =>
          candidate.projectId === repositorySnapshot.projectId &&
          candidate.repoPath === repositorySnapshot.repoPath
        )!;
      }

      if (repository.phase === 'plan_merge_pending') {
        if (typeof repository.mergeRequired !== 'boolean' || !repository.baseCommitAfterSync) {
          throw new Error(`Plan finalization is missing the merge intent for ${repository.repoPath}.`);
        }
        let mergeOutput = repository.mergeOutput;
        let baseCommitAfterMerge = repository.baseCommitAfterSync;
        if (repository.mergeRequired) {
          const mergeParams = {
            repoPath: repository.repoPath,
            branchName: repository.planBranchName,
            intoBranch: repository.baseBranchName,
            expectedBranchCommit: repository.expectedPlanCommit,
            expectedIntoCommit: repository.baseCommitAfterSync,
          };
          let mergeState = await deps.tauri.gitGuardedMergeState(mergeParams);
          if (mergeState.status === 'pending') {
            mergeOutput = await deps.tauri.gitMerge(mergeParams);
            mergeState = await deps.tauri.gitGuardedMergeState(mergeParams);
          }
          if (mergeState.status !== 'integrated') {
            throw new Error(`Plan finalization did not reconcile the plan merge for ${repository.repoPath}.`);
          }
          baseCommitAfterMerge = mergeState.targetCommit;
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.planBranchName,
          repository.expectedPlanCommit,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          baseCommitAfterMerge,
          repository.repoPath,
        );
        if (repository.backmergeBranchName && repository.expectedBackmergeCommit) {
          assertFinalizationBranchCommit(
            branches,
            repository.backmergeBranchName,
            repository.expectedBackmergeCommit,
            repository.repoPath,
          );
        }
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'plan_merged',
          baseCommitAfterMerge,
          mergeOutput,
        }));
        repository = saga.finalizationRepositories!.find((candidate) =>
          candidate.projectId === repositorySnapshot.projectId &&
          candidate.repoPath === repositorySnapshot.repoPath
        )!;
      }

      if (repository.phase === 'plan_merged' && repository.backmergeBranchName) {
        if (!repository.baseCommitAfterMerge || !repository.expectedBackmergeCommit) {
          throw new Error(`Plan finalization is missing backmerge identities for ${repository.repoPath}.`);
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          repository.baseCommitAfterMerge,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.backmergeBranchName,
          repository.expectedBackmergeCommit,
          repository.repoPath,
        );
        const preparedSync = await deps.tauri.gitPrepareGuardedBranchSync({
          repoPath: repository.repoPath,
          branchName: repository.backmergeBranchName,
          expectedBranchCommit: repository.expectedBackmergeCommit,
        });
        const branchesAfterPrepare = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branchesAfterPrepare,
          repository.baseBranchName,
          repository.baseCommitAfterMerge,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branchesAfterPrepare,
          repository.backmergeBranchName,
          repository.expectedBackmergeCommit,
          repository.repoPath,
        );
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'backmerge_sync_pending',
          backmergeSyncTargetCommit: preparedSync.targetCommit,
        }));
        repository = saga.finalizationRepositories!.find((candidate) =>
          candidate.projectId === repositorySnapshot.projectId &&
          candidate.repoPath === repositorySnapshot.repoPath
        )!;
      }

      if (repository.phase === 'backmerge_sync_pending') {
        if (
          !repository.backmergeBranchName || !repository.expectedBackmergeCommit ||
          !repository.baseCommitAfterMerge || !repository.backmergeSyncTargetCommit
        ) {
          throw new Error(`Plan finalization is missing the prepared backmerge sync for ${repository.repoPath}.`);
        }
        const sync = await deps.tauri.gitGuardedBranchSync({
          repoPath: repository.repoPath,
          branchName: repository.backmergeBranchName,
          expectedBranchCommit: repository.expectedBackmergeCommit,
          syncTargetCommit: repository.backmergeSyncTargetCommit,
        });
        if (sync.status !== 'integrated') {
          throw new Error(`Plan finalization did not reconcile the backmerge sync for ${repository.repoPath}.`);
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          repository.baseCommitAfterMerge,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.backmergeBranchName,
          sync.targetCommit,
          repository.repoPath,
        );
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'backmerge_synced',
          backmergeCommitAfterSync: sync.targetCommit,
        }));
        repository = saga.finalizationRepositories!.find((candidate) =>
          candidate.projectId === repositorySnapshot.projectId &&
          candidate.repoPath === repositorySnapshot.repoPath
        )!;
      }

      if (repository.phase === 'backmerge_synced') {
        if (
          !repository.backmergeBranchName || !repository.baseCommitAfterMerge ||
          !repository.backmergeCommitAfterSync
        ) {
          throw new Error(`Plan finalization is missing backmerge progress for ${repository.repoPath}.`);
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          repository.baseCommitAfterMerge,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.backmergeBranchName,
          repository.backmergeCommitAfterSync,
          repository.repoPath,
        );
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'backmerge_merge_pending',
        }));
        repository = saga.finalizationRepositories!.find((candidate) =>
          candidate.projectId === repositorySnapshot.projectId &&
          candidate.repoPath === repositorySnapshot.repoPath
        )!;
      }

      if (repository.phase === 'backmerge_merge_pending') {
        if (
          !repository.backmergeBranchName || !repository.baseCommitAfterMerge ||
          !repository.backmergeCommitAfterSync
        ) {
          throw new Error(`Plan finalization is missing the backmerge intent for ${repository.repoPath}.`);
        }
        const mergeParams = {
          repoPath: repository.repoPath,
          branchName: repository.baseBranchName,
          intoBranch: repository.backmergeBranchName,
          expectedBranchCommit: repository.baseCommitAfterMerge,
          expectedIntoCommit: repository.backmergeCommitAfterSync,
        };
        let backmergeOutput = repository.backmergeOutput;
        let mergeState = await deps.tauri.gitGuardedMergeState(mergeParams);
        if (mergeState.status === 'pending') {
          backmergeOutput = await deps.tauri.gitMerge(mergeParams);
          mergeState = await deps.tauri.gitGuardedMergeState(mergeParams);
        }
        if (mergeState.status !== 'integrated') {
          throw new Error(`Plan finalization did not reconcile the backmerge for ${repository.repoPath}.`);
        }
        const branches = await deps.tauri.gitBranchList(repository.repoPath);
        assertFinalizationBranchCommit(
          branches,
          repository.baseBranchName,
          repository.baseCommitAfterMerge,
          repository.repoPath,
        );
        assertFinalizationBranchCommit(
          branches,
          repository.backmergeBranchName,
          mergeState.targetCommit,
          repository.repoPath,
        );
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'complete',
          backmergeCommitAfterMerge: mergeState.targetCommit,
          backmergeOutput,
        }));
      } else if (repository.phase === 'plan_merged' && !repository.backmergeBranchName) {
        await persistRepository(repository.projectId, repository.repoPath, (current) => ({
          ...current,
          phase: 'complete',
        }));
      }
    }

    if (!saga.finalizationRepositories!.every((repository) => repository.phase === 'complete')) {
      throw new Error('Plan finalization did not checkpoint every repository merge.');
    }
    for (const repository of saga.finalizationRepositories!) {
      if (!repository.baseCommitAfterMerge) {
        throw new Error(`Plan finalization is missing its final base identity for ${repository.repoPath}.`);
      }
      const branches = await deps.tauri.gitBranchList(repository.repoPath);
      assertFinalizationBranchCommit(
        branches,
        repository.planBranchName,
        repository.expectedPlanCommit,
        repository.repoPath,
      );
      assertFinalizationBranchCommit(
        branches,
        repository.baseBranchName,
        repository.baseCommitAfterMerge,
        repository.repoPath,
      );
      if (repository.backmergeBranchName) {
        if (!repository.backmergeCommitAfterMerge) {
          throw new Error(`Plan finalization is missing its final backmerge identity for ${repository.repoPath}.`);
        }
        assertFinalizationBranchCommit(
          branches,
          repository.backmergeBranchName,
          repository.backmergeCommitAfterMerge,
          repository.repoPath,
        );
      }
    }
    await persistSaga({
      ...saga,
      phase: 'git_merges_complete',
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    });
    return saga;
  };

  const finalizePlanIntoBaseBranchUnlocked = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
  }): Promise<{
    plan: ArchitectPlanRecord;
    repositories: FinalizedPlanRepositoryResult[];
    cleanup: CleanupPlanRepositoryResult[];
  }> => {
    let plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }
    const pendingFinalization = (await loadPlanLifecycleSagas()).find(
      (saga) => saga.planId === plan!.id && saga.branchName === params.branchName &&
        saga.operation === 'finalize',
    );
    let finalizationSaga: PlanLifecycleSaga;
    if (pendingFinalization) {
      finalizationSaga = pendingFinalization;
    } else {
      assertPlanReadyForFinalization(plan);
      const now = new Date().toISOString();
      finalizationSaga = {
        planId: plan.id,
        branchName: params.branchName,
        operation: 'finalize',
        phase: 'prepared',
        finalizationRepositories: await capturePlanFinalizationRepositoriesWithDeps(
          plan,
          params.repoPath,
        ),
        createdAt: now,
        updatedAt: now,
      };
      await startPlanLifecycleSaga(finalizationSaga);
    }

    if (finalizationSaga.phase === 'prepared') {
      assertPlanReadyForFinalization(plan);
      finalizationSaga = await runPlanFinalizationGitWithDeps(
        plan,
        finalizationSaga,
        params.repoPath,
      );
    }
    if (finalizationSaga.phase === 'git_merges_complete') {
      if (plan.status !== 'completed' && plan.status !== 'archived') {
        plan = await deps.updateArchitectPlan({
          branchName: params.branchName,
          planId: plan.id,
          status: 'completed',
          setActive: false,
        });
      }
      const metadataWrittenSaga: PlanLifecycleSaga = {
        ...finalizationSaga,
        phase: 'metadata_written',
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      };
      await upsertPlanLifecycleSaga(metadataWrittenSaga);
      finalizationSaga = metadataWrittenSaga;
    }

    const finalizedRepositories: FinalizedPlanRepositoryResult[] = (
      finalizationSaga.finalizationRepositories ?? []
    ).map((repository) => ({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      planBranchName: repository.planBranchName,
      baseBranchName: repository.baseBranchName,
      mergeOutput: repository.mergeOutput,
      ...(repository.backmergeBranchName
        ? {
            backmergeBranchName: repository.backmergeBranchName,
            backmergeOutput: repository.backmergeOutput,
          }
        : {}),
    }));

    const pendingArchive = (await loadPlanLifecycleSagas()).find(
      (saga) => saga.planId === plan!.id && saga.branchName === params.branchName &&
        saga.operation === 'archive',
    );
    if (pendingArchive) {
      await resumePlanLifecycleSagaWithDeps(pendingArchive);
      const remainingArchive = (await loadPlanLifecycleSagas()).find(
        (saga) => saga.planId === plan!.id && saga.branchName === params.branchName &&
          saga.operation === 'archive',
      );
      if (remainingArchive) {
        throw new Error(
          remainingArchive.lastError || 'The archived plan cleanup remains pending.',
        );
      }
      await removePlanLifecycleSaga(
        plan.id,
        'finalize',
        params.branchName,
        getPlanLifecycleSagaGeneration(finalizationSaga),
      );
      plan = await deps.getArchitectPlan(params.branchName, params.planId) ?? plan;
      return { plan, repositories: finalizedRepositories, cleanup: [] };
    }
    if (plan.status === 'archived') {
      await removePlanLifecycleSaga(
        plan.id,
        'finalize',
        params.branchName,
        getPlanLifecycleSagaGeneration(finalizationSaga),
      );
      return { plan, repositories: finalizedRepositories, cleanup: [] };
    }

    const { plan: archivedPlan, cleanup, lifecycleSaga } = await archivePlanAndCleanupBranchesUnlocked({
      branchName: params.branchName,
      planId: plan.id,
      repoPath: params.repoPath,
      requireMetadataCommit: true,
    });
    await removePlanLifecycleSaga(
      plan.id,
      'finalize',
      params.branchName,
      getPlanLifecycleSagaGeneration(finalizationSaga),
    );
    await deps.commitArchitectPlanMetadata({
      branchName: params.branchName,
      planId: plan.id,
      commitMessage: `chore(metadata): finalize architect plan ${plan.id}`,
    });
    await upsertPlanLifecycleSaga({
      ...lifecycleSaga,
      phase: 'metadata_committed',
      updatedAt: new Date().toISOString(),
    });
    await removePlanLifecycleSaga(
      plan.id,
      'archive',
      params.branchName,
      getPlanLifecycleSagaGeneration(lifecycleSaga),
    );

    return {
      plan: archivedPlan,
      repositories: finalizedRepositories,
      cleanup,
    };
  };

  const finalizePlanIntoBaseBranchWithDeps = async (
    params: Parameters<typeof finalizePlanIntoBaseBranchUnlocked>[0],
  ): ReturnType<typeof finalizePlanIntoBaseBranchUnlocked> =>
    withPlanLifecycleLock(deps, params.branchName, params.planId, () =>
      finalizePlanIntoBaseBranchUnlocked(params)
    );

  const deletePlanAndCleanupBranchesUnlocked = async (params: {
    branchName: string;
    planId: string;
    hardDelete?: boolean;
    repoPath?: string;
  }): Promise<{
    deletedBranches: string[];
    deletedWorktreeKeys: string[];
    repositories: CleanupPlanRepositoryResult[];
  }> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan) {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }

    const crudCapabilities = getArchitectPlanCrudCapabilities(plan);
    const pendingDeleteSaga = (await loadPlanLifecycleSagas()).find(
      (saga) => saga.planId === params.planId && saga.branchName === params.branchName && saga.operation === 'delete',
    );

    if (plan.status === 'deleted') {
      await deps.deleteArchitectPlan({
        branchName: params.branchName,
        planId: params.planId,
        hardDelete: params.hardDelete !== false,
      });

      if (pendingDeleteSaga) {
        await removePlanLifecycleSaga(
          params.planId,
          'delete',
          params.branchName,
          getPlanLifecycleSagaGeneration(pendingDeleteSaga),
        );
      }
      return {
        deletedBranches: [],
        deletedWorktreeKeys: [],
        repositories: [],
      };
    }

    if (!crudCapabilities.canDelete) {
      throw new Error('Archive the plan before deleting it.');
    }

    const cleanupResources = crudCapabilities.deleteRequiresCleanup && deps.tauri.isTauriAvailable()
      ? await (async () => {
          const cleanupTargets = buildCleanupPlanTargetsWithDeps(plan, params.repoPath);
          await preflightPlanCleanupWithDeps(cleanupTargets);
          return capturePlanCleanupResourcesWithDeps(cleanupTargets);
        })()
      : [];
    const now = new Date().toISOString();
    let saga: PlanLifecycleSaga = {
      planId: params.planId, branchName: params.branchName, operation: 'delete', phase: 'prepared',
      conversationId: plan.conversationId ?? null, cleanupResources, createdAt: now, updatedAt: now,
    };
    await startPlanLifecycleSaga(saga);

    if (!crudCapabilities.deleteRequiresCleanup) {
      await deps.deleteArchitectPlan({
        branchName: params.branchName,
        planId: params.planId,
        hardDelete: params.hardDelete !== false,
      });

      await removePlanLifecycleSaga(
        params.planId,
        'delete',
        params.branchName,
        getPlanLifecycleSagaGeneration(saga),
      );
      return {
        deletedBranches: [],
        deletedWorktreeKeys: [],
        repositories: [],
      };
    }

    const repositories = await cleanupPlanBranchesInternalWithDeps(plan, params.repoPath, {
      expectedResources: saga.cleanupResources,
    });
    saga = { ...saga, phase: 'git_cleanup_complete', updatedAt: new Date().toISOString() };
    await upsertPlanLifecycleSaga(saga);

    await deps.deleteArchitectPlan({
      branchName: params.branchName,
      planId: params.planId,
      hardDelete: params.hardDelete ?? true,
    });
    saga = { ...saga, phase: 'metadata_deleted', updatedAt: new Date().toISOString() };
    await upsertPlanLifecycleSaga(saga);
    await removePlanLifecycleSaga(
      params.planId,
      'delete',
      params.branchName,
      getPlanLifecycleSagaGeneration(saga),
    );

    return {
      deletedBranches: repositories.flatMap((repository) => repository.deletedBranches),
      deletedWorktreeKeys: repositories.flatMap((repository) =>
        repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)
      ),
      repositories,
    };
  };

  const deletePlanAndCleanupBranchesWithDeps = async (
    params: Parameters<typeof deletePlanAndCleanupBranchesUnlocked>[0],
  ): ReturnType<typeof deletePlanAndCleanupBranchesUnlocked> =>
    withPlanLifecycleLock(deps, params.branchName, params.planId, () =>
      deletePlanAndCleanupBranchesUnlocked(params)
    );

  const resumePlanLifecycleSagaWithDeps = async (saga: PlanLifecycleSaga): Promise<void> => {
    let currentSaga = saga;
    try {
      const plan = await deps.getArchitectPlan(saga.branchName, saga.planId);
      if (saga.operation === 'provision') {
        if (provisionMatchesPersistedPlan(saga, plan)) {
          // Re-enumerate every expected branch and worktree from the persisted plan.
          // An empty or partial journal describes ownership, not completeness.
          await provisionPlanBranchesUnlocked(plan!, undefined, saga);
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(saga));
        } else {
          await rollbackProvisionSaga(saga);
        }
        return;
      }
      if (saga.operation === 'finalize') {
        await finalizePlanIntoBaseBranchUnlocked({
          branchName: saga.branchName,
          planId: saga.planId,
        });
        return;
      }
      if (saga.operation === 'archive') {
        if (saga.phase === 'metadata_commit_pending') {
          await deps.commitArchitectPlanMetadata({ branchName: saga.branchName, planId: saga.planId, commitMessage: `chore(metadata): finalize architect plan ${saga.planId}` });
          currentSaga = { ...saga, phase: 'metadata_committed', updatedAt: new Date().toISOString() };
          await upsertPlanLifecycleSaga(currentSaga);
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(currentSaga));
          return;
        }
        if (saga.phase === 'metadata_committed' || !plan) {
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(saga));
          return;
        }
        if (saga.phase === 'git_cleanup_complete') {
          if (saga.requiresMetadataCommit) {
            currentSaga = { ...saga, phase: 'metadata_commit_pending', updatedAt: new Date().toISOString() };
            await upsertPlanLifecycleSaga(currentSaga);
            await deps.commitArchitectPlanMetadata({ branchName: saga.branchName, planId: saga.planId, commitMessage: `chore(metadata): finalize architect plan ${saga.planId}` });
            currentSaga = { ...currentSaga, phase: 'metadata_committed', updatedAt: new Date().toISOString() };
            await upsertPlanLifecycleSaga(currentSaga);
          }
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(currentSaga));
          return;
        }
        if (!saga.cleanupResources) {
          throw new PlanLifecycleSagaCorruptionError();
        }
        const archived = plan.status === 'archived'
          ? plan
          : await deps.archiveArchitectPlan(saga.branchName, saga.planId);
        currentSaga = { ...saga, phase: 'metadata_written', updatedAt: new Date().toISOString() };
        await upsertPlanLifecycleSaga(currentSaga);
        await cleanupPlanBranchesInternalWithDeps(archived, undefined, {
          expectedResources: currentSaga.cleanupResources,
        });
        currentSaga = { ...currentSaga, phase: 'git_cleanup_complete', updatedAt: new Date().toISOString() };
        await upsertPlanLifecycleSaga(currentSaga);
        if (saga.requiresMetadataCommit) {
          currentSaga = { ...currentSaga, phase: 'metadata_commit_pending', updatedAt: new Date().toISOString() };
          await upsertPlanLifecycleSaga(currentSaga);
          await deps.commitArchitectPlanMetadata({ branchName: saga.branchName, planId: saga.planId, commitMessage: `chore(metadata): finalize architect plan ${saga.planId}` });
          currentSaga = { ...currentSaga, phase: 'metadata_committed', updatedAt: new Date().toISOString() };
          await upsertPlanLifecycleSaga(currentSaga);
        }
        await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(currentSaga));
        return;
      }
      if (!plan) {
        await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(currentSaga));
        return;
      }
      if (plan.status === 'deleted' || saga.phase === 'metadata_deleted') {
        await deps.deleteArchitectPlan({ branchName: saga.branchName, planId: saga.planId, hardDelete: true });
        await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(currentSaga));
        return;
      }
      const capabilities = getArchitectPlanCrudCapabilities(plan);
      if (!capabilities.canDelete) {
        throw new Error('Archive the plan before deleting it.');
      }
      if (capabilities.deleteRequiresCleanup && saga.phase === 'prepared') {
        if (!currentSaga.cleanupResources) {
          throw new PlanLifecycleSagaCorruptionError();
        }
        await cleanupPlanBranchesInternalWithDeps(plan, undefined, {
          expectedResources: currentSaga.cleanupResources,
        });
        currentSaga = { ...currentSaga, phase: 'git_cleanup_complete', updatedAt: new Date().toISOString() };
        await upsertPlanLifecycleSaga(currentSaga);
      }
      await deps.deleteArchitectPlan({ branchName: saga.branchName, planId: saga.planId, hardDelete: true });
      currentSaga = { ...currentSaga, phase: 'metadata_deleted', updatedAt: new Date().toISOString() };
      await upsertPlanLifecycleSaga(currentSaga);
      await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName, getPlanLifecycleSagaGeneration(currentSaga));
    } catch (error) {
      if (error instanceof StalePlanLifecycleSagaError) return;
      try {
        if (saga.operation === 'finalize') {
          currentSaga = (await loadPlanLifecycleSagas()).find(
            (candidate) => candidate.planId === saga.planId &&
              candidate.branchName === saga.branchName && candidate.operation === saga.operation,
          ) ?? currentSaga;
        }
        await upsertPlanLifecycleSaga({
          ...currentSaga,
          updatedAt: new Date().toISOString(),
          lastError: toServiceError(error).message,
        });
      } catch (journalError) {
        if (!(journalError instanceof StalePlanLifecycleSagaError)) throw journalError;
      }
    }
  };

  const resumePlanLifecycleSagasWithDeps = async (): Promise<void> => {
    const pending = await loadPlanLifecycleSagas();
    for (const saga of pending) {
      await withPlanLifecycleLock(deps, saga.branchName, saga.planId, async () => {
        const expectedGeneration = getPlanLifecycleSagaGeneration(saga);
        const activeSaga = (await loadPlanLifecycleSagas()).find((candidate) =>
          candidate.planId === saga.planId && candidate.branchName === saga.branchName &&
          candidate.operation === saga.operation &&
          getPlanLifecycleSagaGeneration(candidate) === expectedGeneration
        );
        if (!activeSaga) return;
        await resumePlanLifecycleSagaWithDeps(activeSaga);
      });
    }
  };

  return {
    provisionPlanBranches: provisionPlanBranchesWithDeps,
    validatePlanAndProvisionBranches: validatePlanAndProvisionBranchesWithDeps,
    mergeFeatureBranchIntoPlanBranch: mergeFeatureBranchIntoPlanBranchWithDeps,
    loadPlanReview: loadPlanReviewWithDeps,
    finalizePlanIntoBaseBranch: finalizePlanIntoBaseBranchWithDeps,
    cleanupPlanBranches: cleanupPlanBranchesWithDeps,
    archivePlanAndCleanupBranches: archivePlanAndCleanupBranchesWithDeps,
    restorePlanAndProvisionBranches: restorePlanAndProvisionBranchesWithDeps,
    deletePlanAndCleanupBranches: deletePlanAndCleanupBranchesWithDeps,
    resumePlanLifecycleSagas: resumePlanLifecycleSagasWithDeps,
  };
};

let defaultArchitectGitFlowService: ReturnType<typeof createArchitectGitFlowService> | null = null;

const getDefaultArchitectGitFlowService = () => {
  defaultArchitectGitFlowService ||= createArchitectGitFlowService();
  return defaultArchitectGitFlowService;
};
