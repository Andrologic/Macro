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
  loadPlanLifecycleSagas,
  removePlanLifecycleSaga,
  upsertPlanLifecycleSaga,
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
> & {
  gitStatus: (repoPath: string) => Promise<ArchitectGitFlowGitStatus>;
  gitMergeCheck: (params: {
    repoPath: string;
    branchName: string;
    intoBranch: string;
  }) => Promise<ArchitectGitFlowMergeCheck>;
  gitBranchList: (repoPath: string) => Promise<ArchitectGitFlowGitBranches>;
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
  explicitRepoPath?: string
): Promise<ProvisionPlanBranchesResult> =>
  getDefaultArchitectGitFlowService().provisionPlanBranches(plan, explicitRepoPath);

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
}): Promise<{ plan: ArchitectPlanRecord; cleanup: CleanupPlanRepositoryResult[] }> =>
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

  const cleanupPlanBranchesInternalWithDeps = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string,
    options?: {
      allowRetained?: boolean;
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

          const removed = await deps.tauri.gitWorktreeRemove({
            repoPath: target.repoPath,
            taskId: worktree.worktreeKey,
            branchName: worktree.branchName,
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
          const removed = await deps.tauri.gitBranchWorktreeRemove({
            repoPath: target.repoPath,
            worktreeKey: target.integrationWorktree.worktreeKey,
            branchName: target.integrationWorktree.branchName,
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
          await deps.tauri.gitBranchDelete({
            repoPath: target.repoPath,
            branchName,
            force: false,
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

  const provisionPlanBranchesWithDeps = async (
    plan: ArchitectPlanRecord,
    explicitRepoPath?: string
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
    const createdBranches: Array<{ repoPath: string; branchName: string }> = [];
    const createdWorktrees: Array<{ repoPath: string; taskId: string; branchName: string }> = [];
    const rollbackCreatedGitResources = async (): Promise<void> => {
      await Promise.allSettled(
        [...createdWorktrees].reverse().map(({ repoPath, taskId, branchName }) =>
          deps.tauri.gitWorktreeRemove({ repoPath, taskId, branchName, force: true })
        )
      );
      await Promise.allSettled(
        [...createdBranches].reverse().map(({ repoPath, branchName }) =>
          deps.tauri.gitBranchDelete({ repoPath, branchName, force: true })
        )
      );
    };
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
          await deps.tauri.gitBranchCreate({
            repoPath: repository.repoPath,
            branchName: repositoryPlanBranchName,
            fromRef,
          });
          createdBranches.push({ repoPath: repository.repoPath, branchName: repositoryPlanBranchName });
          localBranchNames.add(repositoryPlanBranchName);
          createdPlanBranch = true;
        }

        for (const featureBranch of featureBranchesByProject.get(repository.projectId) || []) {
          if (localBranchNames.has(featureBranch)) {
            existingFeatureBranches.push(featureBranch);
            continue;
          }

          await deps.tauri.gitBranchCreate({
            repoPath: repository.repoPath,
            branchName: featureBranch,
            fromRef: repositoryPlanBranchName,
          });
          createdBranches.push({ repoPath: repository.repoPath, branchName: featureBranch });
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
          if (inspection.status === 'ready') {
            continue;
          }

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
          if (ensuredWorktree.status === 'created' || ensuredWorktree.status === 'repaired') {
            createdWorktrees.push({
              repoPath: repository.repoPath,
              taskId: worktreeKey,
              branchName: featureBranch,
            });
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
      await rollbackCreatedGitResources();
      throw error;
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

  const validatePlanAndProvisionBranchesWithDeps = async (params: {
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

    const provision = await provisionPlanBranchesWithDeps(normalizedPlan, params.repoPath);

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
      await rollbackProvisionResultWithDeps(provision);
      throw error;
    }

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

  const archivePlanAndCleanupBranchesWithDeps = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
    keepSaga?: boolean;
    requireMetadataCommit?: boolean;
  }): Promise<{ plan: ArchitectPlanRecord; cleanup: CleanupPlanRepositoryResult[] }> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || !getArchitectPlanCrudCapabilities(plan).canArchive) {
      throw new Error(`Plan ${params.planId} cannot be archived.`);
    }
    const now = new Date().toISOString();
    const saga: PlanLifecycleSaga = {
      planId: plan.id, branchName: params.branchName, operation: 'archive', phase: 'prepared',
      conversationId: plan.conversationId ?? null, requiresMetadataCommit: params.requireMetadataCommit === true, createdAt: now, updatedAt: now,
    };
    await upsertPlanLifecycleSaga(saga);
    const archived = plan.status === 'archived' ? plan : await deps.archiveArchitectPlan(params.branchName, plan.id);
    await upsertPlanLifecycleSaga({ ...saga, phase: 'metadata_written', updatedAt: new Date().toISOString() });
    const cleanup = await cleanupPlanBranchesWithDeps(archived, params.repoPath);
    const cleanedSaga = { ...saga, phase: 'git_cleanup_complete' as const, updatedAt: new Date().toISOString() };
    await upsertPlanLifecycleSaga(cleanedSaga);
    if (params.requireMetadataCommit) {
      await upsertPlanLifecycleSaga({ ...cleanedSaga, phase: 'metadata_commit_pending', updatedAt: new Date().toISOString() });
    } else if (!params.keepSaga) await removePlanLifecycleSaga(plan.id, 'archive', params.branchName);
    return { plan: archived, cleanup };
  };

  const restorePlanAndProvisionBranchesWithDeps = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
  }): Promise<ArchitectPlanRecord> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }
    if (plan.status !== 'archived') {
      await removePlanLifecycleSaga(plan.id, 'archive', params.branchName);
      return plan;
    }

    if (plan.archivedFromStatus === 'validated' || plan.archivedFromStatus === 'in_progress') {
      const provision = await provisionPlanBranchesWithDeps(plan, params.repoPath);
      let restored: ArchitectPlanRecord;
      try {
        restored = await deps.restoreArchitectPlan(params.branchName, params.planId);
      } catch (error) {
        await rollbackProvisionResultWithDeps(provision).catch(() => undefined);
        throw error;
      }
      await removePlanLifecycleSaga(plan.id, 'archive', params.branchName);
      return restored;
    }
    const restored = await deps.restoreArchitectPlan(params.branchName, params.planId);
    await removePlanLifecycleSaga(plan.id, 'archive', params.branchName);
    return restored;
  };

  const finalizePlanIntoBaseBranchWithDeps = async (params: {
    branchName: string;
    planId: string;
    repoPath?: string;
  }): Promise<{
    plan: ArchitectPlanRecord;
    repositories: FinalizedPlanRepositoryResult[];
    cleanup: CleanupPlanRepositoryResult[];
  }> => {
    const plan = await deps.getArchitectPlan(params.branchName, params.planId);
    if (!plan || plan.status === 'deleted') {
      throw new Error(`Plan ${params.planId} is unavailable.`);
    }
    assertPlanReadyForFinalization(plan);
    const repositories = await syncPlanRepositoriesToBaseBranchesWithDeps({
      plan,
      explicitRepoPath: params.repoPath,
    });

    const preflightRepositories = await preflightPlanRepositoriesWithDeps({
      plan,
      explicitRepoPath: params.repoPath,
      repositories,
    });

    if (preflightRepositories.some((repository) => repository.blockingReason)) {
      throw createPlanFinalizationBlockedError({
        planId: plan.id,
        branchName: params.branchName,
        repositories: preflightRepositories,
      });
    }

    await preflightPlanCleanupWithDeps(buildCleanupPlanTargetsWithDeps(plan, params.repoPath));

    const finalizedRepositories: FinalizedPlanRepositoryResult[] = [];
    for (const repository of preflightRepositories) {
      const mergeOutput = repository.hasChanges
        ? await deps.tauri.gitMerge({
          repoPath: repository.repoPath,
          branchName: repository.planBranchName,
          intoBranch: repository.baseBranchName,
        })
        : undefined;
      const backmergeBranchName = resolvePlanProjectBackmergeBranchName(
        plan,
        repository.projectId,
        deps.getAppState().getProjectById
      );
      let backmergeOutput: string | undefined;
      if (backmergeBranchName) {
        await deps.tauri.gitCheckout({
          repoPath: repository.repoPath,
          branchOrCommit: backmergeBranchName,
          create: false,
        });
        await deps.tauri.gitPull({
          repoPath: repository.repoPath,
        });
        backmergeOutput = await deps.tauri.gitMerge({
          repoPath: repository.repoPath,
          branchName: repository.baseBranchName,
          intoBranch: backmergeBranchName,
        });
      }

      finalizedRepositories.push({
        projectId: repository.projectId,
        repoPath: repository.repoPath,
        planBranchName: repository.planBranchName,
        baseBranchName: repository.baseBranchName,
        mergeOutput,
        ...(backmergeBranchName
          ? {
              backmergeBranchName,
              backmergeOutput,
            }
          : {}),
      });
    }

    await deps.updateArchitectPlan({
      branchName: params.branchName,
      planId: plan.id,
      status: 'completed',
      setActive: false,
    });
    const { plan: archivedPlan, cleanup } = await archivePlanAndCleanupBranchesWithDeps({
      branchName: params.branchName,
      planId: plan.id,
      repoPath: params.repoPath,
      requireMetadataCommit: true,
    });
    await deps.commitArchitectPlanMetadata({
      branchName: params.branchName,
      planId: plan.id,
      commitMessage: `chore(metadata): finalize architect plan ${plan.id}`,
    });
    await upsertPlanLifecycleSaga({
      planId: plan.id, branchName: params.branchName, operation: 'archive', phase: 'metadata_committed',
      conversationId: plan.conversationId ?? null, requiresMetadataCommit: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await removePlanLifecycleSaga(plan.id, 'archive', params.branchName);

    return {
      plan: archivedPlan,
      repositories: finalizedRepositories,
      cleanup,
    };
  };

  const deletePlanAndCleanupBranchesWithDeps = async (params: {
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

    if (plan.status === 'deleted') {
      await deps.deleteArchitectPlan({
        branchName: params.branchName,
        planId: params.planId,
        hardDelete: params.hardDelete !== false,
      });

      await removePlanLifecycleSaga(params.planId, 'delete', params.branchName);
      return {
        deletedBranches: [],
        deletedWorktreeKeys: [],
        repositories: [],
      };
    }

    if (!crudCapabilities.canDelete) {
      throw new Error('Archive the plan before deleting it.');
    }

    const now = new Date().toISOString();
    const saga: PlanLifecycleSaga = {
      planId: params.planId, branchName: params.branchName, operation: 'delete', phase: 'prepared',
      conversationId: plan.conversationId ?? null, createdAt: now, updatedAt: now,
    };
    await upsertPlanLifecycleSaga(saga);

    if (!crudCapabilities.deleteRequiresCleanup) {
      await deps.deleteArchitectPlan({
        branchName: params.branchName,
        planId: params.planId,
        hardDelete: params.hardDelete !== false,
      });

      await removePlanLifecycleSaga(params.planId, 'delete', params.branchName);
      return {
        deletedBranches: [],
        deletedWorktreeKeys: [],
        repositories: [],
      };
    }

    const repositories = await cleanupPlanBranchesWithDeps(plan, params.repoPath);
    await upsertPlanLifecycleSaga({ ...saga, phase: 'git_cleanup_complete', updatedAt: new Date().toISOString() });

    await deps.deleteArchitectPlan({
      branchName: params.branchName,
      planId: params.planId,
      hardDelete: params.hardDelete ?? true,
    });
    await upsertPlanLifecycleSaga({ ...saga, phase: 'metadata_deleted', updatedAt: new Date().toISOString() });
    await removePlanLifecycleSaga(params.planId, 'delete', params.branchName);

    return {
      deletedBranches: repositories.flatMap((repository) => repository.deletedBranches),
      deletedWorktreeKeys: repositories.flatMap((repository) =>
        repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)
      ),
      repositories,
    };
  };

  const resumePlanLifecycleSagasWithDeps = async (): Promise<void> => {
    const pending = await loadPlanLifecycleSagas();
    for (const saga of pending) {
      try {
        const plan = await deps.getArchitectPlan(saga.branchName, saga.planId);
        if (saga.operation === 'archive') {
          if (saga.phase === 'metadata_commit_pending') {
            await deps.commitArchitectPlanMetadata({ branchName: saga.branchName, planId: saga.planId, commitMessage: `chore(metadata): finalize architect plan ${saga.planId}` });
            await upsertPlanLifecycleSaga({ ...saga, phase: 'metadata_committed', updatedAt: new Date().toISOString() });
            await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
            continue;
          }
          if (saga.phase === 'metadata_committed') {
            await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
            continue;
          }
          if (!plan) {
            await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
            continue;
          }
          const archived = plan.status === 'archived'
            ? plan
            : await deps.archiveArchitectPlan(saga.branchName, saga.planId);
          await upsertPlanLifecycleSaga({ ...saga, phase: 'metadata_written', updatedAt: new Date().toISOString() });
          await cleanupPlanBranchesWithDeps(archived);
          const cleanedSaga = { ...saga, phase: 'git_cleanup_complete' as const, updatedAt: new Date().toISOString() };
          await upsertPlanLifecycleSaga(cleanedSaga);
          if (saga.requiresMetadataCommit) {
            await upsertPlanLifecycleSaga({ ...cleanedSaga, phase: 'metadata_commit_pending', updatedAt: new Date().toISOString() });
            await deps.commitArchitectPlanMetadata({ branchName: saga.branchName, planId: saga.planId, commitMessage: `chore(metadata): finalize architect plan ${saga.planId}` });
            await upsertPlanLifecycleSaga({ ...cleanedSaga, phase: 'metadata_committed', updatedAt: new Date().toISOString() });
          }
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
          continue;
        }
        if (!plan) {
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
          continue;
        }
        if (plan.status === 'deleted') {
          await deps.deleteArchitectPlan({ branchName: saga.branchName, planId: saga.planId, hardDelete: true });
          await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
          continue;
        }
        const capabilities = getArchitectPlanCrudCapabilities(plan);
        if (!capabilities.canDelete) {
          throw new Error('Archive the plan before deleting it.');
        }
        if (capabilities.deleteRequiresCleanup) {
          await cleanupPlanBranchesWithDeps(plan);
          await upsertPlanLifecycleSaga({ ...saga, phase: 'git_cleanup_complete', updatedAt: new Date().toISOString() });
        }
        await deps.deleteArchitectPlan({ branchName: saga.branchName, planId: saga.planId, hardDelete: true });
        await removePlanLifecycleSaga(saga.planId, saga.operation, saga.branchName);
      } catch (error) {
        await upsertPlanLifecycleSaga({ ...saga, updatedAt: new Date().toISOString(), lastError: toServiceError(error).message });
      }
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
