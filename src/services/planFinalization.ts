import type {
  PlanReviewRepositoryResult,
  PlanReviewResult,
} from './architectGitFlowService';
import { toServiceError } from './contracts/errors';
import type { TaskExecutionTarget, TaskStatus } from '../types';

export const PLAN_FINALIZATION_TASK_PREFIX = 'plan-finalization:';
export const PLAN_FINALIZATION_TASK_DESCRIPTION =
  'Merge the plan branch into the configured development branches or archive the plan.';

export type PlanFinalizationTaskPhase =
  | 'idle'
  | 'loading_review'
  | 'ready'
  | 'blocked'
  | 'merging'
  | 'archiving'
  | 'failed';

export interface BlockedPlanFinalizationState {
  planId: string;
  branchName: string;
  message: string;
  repositories: PlanReviewRepositoryResult[];
  blockedRepositories: PlanReviewRepositoryResult[];
}

export interface PlanFinalizationRuntimeState {
  planId: string;
  branchName: string;
  phase: PlanFinalizationTaskPhase;
  taskStatus: TaskStatus;
  review: PlanReviewResult | null;
  repositories: PlanReviewRepositoryResult[];
  blockedRepositories: PlanReviewRepositoryResult[];
  message: string | null;
  lastLoadedAt: string | null;
}

export interface PlanFinalizationViewState {
  phase: PlanFinalizationTaskPhase | 'loading';
  isLoading: boolean;
  isBlocked: boolean;
  isMerging: boolean;
  isArchiving: boolean;
  isBusy: boolean;
  canMerge: boolean;
  canRetry: boolean;
  canResolveAutomatically: boolean;
  canArchive: boolean;
  shouldShowBlockedActions: boolean;
}

interface BlockedPlanFinalizationErrorLike extends Error {
  planId: string;
  branchName: string;
  repositories: PlanReviewRepositoryResult[];
  blockedRepositories: PlanReviewRepositoryResult[];
}

interface PlanFinalizationFocusableTargetLike {
  projectId: string;
  repoPath?: string | null;
  branchName?: string | null;
  targetBranchName?: string | null;
  baseBranchName?: string | null;
}

export const buildPlanFinalizationTaskId = (planId: string): string =>
  `${PLAN_FINALIZATION_TASK_PREFIX}${planId.trim()}`;

export const isPlanFinalizationTaskId = (taskId: string | null | undefined): boolean =>
  typeof taskId === 'string' && taskId.startsWith(PLAN_FINALIZATION_TASK_PREFIX);

export const isPlanFinalizationTaskSource = (
  taskSource: string | null | undefined
): taskSource is 'plan_finalization' => taskSource === 'plan_finalization';

export const isRepositoryRootExecutionTarget = (
  target: Pick<TaskExecutionTarget, 'executionKind'>
): boolean => target.executionKind === 'repository_root';

export const buildPlanFinalizationTaskTitle = (plan: {
  title: string;
  label?: string | null;
}): string => `Finalize plan: ${plan.label || plan.title}`;

export const shouldCreatePlanFinalizationTask = (params: {
  planStatus: string | null | undefined;
  taskCount: number;
  completedTaskCount: number;
}): boolean =>
  params.taskCount > 0 &&
  params.completedTaskCount === params.taskCount &&
  params.planStatus !== 'completed' &&
  params.planStatus !== 'archived' &&
  params.planStatus !== 'deleted';

export const shouldIncludeTaskInImplementationProgress = (task: {
  draft: boolean;
  archived_at?: string | null;
  task_source?: string | null;
}): boolean =>
  !task.draft &&
  !task.archived_at &&
  !isPlanFinalizationTaskSource(task.task_source);

export const canPlanFinalizationTaskReceiveMessages = (status: TaskStatus): boolean =>
  status !== 'Completed';

export const resolvePlanFinalizationTaskStatus = (
  phase: PlanFinalizationTaskPhase
): TaskStatus => {
  switch (phase) {
    case 'blocked':
      return 'Blocked';
    case 'merging':
    case 'archiving':
      return 'InProgress';
    case 'failed':
      return 'Failed';
    case 'idle':
    case 'loading_review':
    case 'ready':
    default:
      return 'Pending';
  }
};

export const isBlockedPlanFinalizationErrorLike = (
  error: unknown
): error is BlockedPlanFinalizationErrorLike =>
  error instanceof Error &&
  error.name === 'PlanFinalizationBlockedError' &&
  'planId' in error &&
  'repositories' in error &&
  'blockedRepositories' in error;

export const toBlockedPlanFinalizationState = (
  error: unknown
): BlockedPlanFinalizationState | null => {
  if (!isBlockedPlanFinalizationErrorLike(error)) {
    return null;
  }

  return {
    planId: error.planId,
    branchName: error.branchName,
    message: error.message,
    repositories: error.repositories,
    blockedRepositories: error.blockedRepositories,
  };
};

export const buildInitialPlanFinalizationRuntimeState = (params: {
  planId: string;
  branchName: string;
}): PlanFinalizationRuntimeState => ({
  planId: params.planId,
  branchName: params.branchName,
  phase: 'idle',
  taskStatus: 'Pending',
  review: null,
  repositories: [],
  blockedRepositories: [],
  message: null,
  lastLoadedAt: null,
});

export const toPlanFinalizationRuntimeStateFromReview = (
  review: PlanReviewResult,
  loadedAt: string = new Date().toISOString()
): PlanFinalizationRuntimeState => {
  const blockedRepositories = review.repositories.filter((repository) =>
    Boolean(repository.blockingReason)
  );
  const phase: PlanFinalizationTaskPhase =
    blockedRepositories.length > 0 ? 'blocked' : 'ready';

  return {
    planId: review.plan.id,
    branchName: review.plan.targetBranch,
    phase,
    taskStatus: resolvePlanFinalizationTaskStatus(phase),
    review,
    repositories: review.repositories,
    blockedRepositories,
    message:
      blockedRepositories.length > 0
        ? 'Resolve the repository blockers before retrying the plan merge.'
        : null,
    lastLoadedAt: loadedAt,
  };
};

export const mergePlanFinalizationRuntimeState = (
  currentState: PlanFinalizationRuntimeState | undefined,
  nextState: Partial<PlanFinalizationRuntimeState> &
    Pick<PlanFinalizationRuntimeState, 'planId' | 'branchName'>
): PlanFinalizationRuntimeState => ({
  ...(currentState || buildInitialPlanFinalizationRuntimeState(nextState)),
  ...nextState,
});

export const buildPlanFinalizationFailureState = (error: unknown): {
  lastError: string;
  runtimePatch: Partial<PlanFinalizationRuntimeState>;
} => {
  const blocked = toBlockedPlanFinalizationState(error);
  return {
    lastError: toServiceError(error).message,
    runtimePatch: blocked
      ? {
          phase: 'blocked',
          taskStatus: resolvePlanFinalizationTaskStatus('blocked'),
          repositories: blocked.repositories,
          blockedRepositories: blocked.blockedRepositories,
          message: blocked.message,
          lastLoadedAt: new Date().toISOString(),
        }
      : {
          phase: 'failed',
          taskStatus: resolvePlanFinalizationTaskStatus('failed'),
          message: toServiceError(error).message,
        },
  };
};

export const resolvePlanFinalizationViewState = (
  runtime: PlanFinalizationRuntimeState | null | undefined
): PlanFinalizationViewState => {
  const phase = runtime?.phase ?? 'loading';
  const isLoading = phase === 'loading' || phase === 'idle' || phase === 'loading_review';
  const isMerging = phase === 'merging';
  const isArchiving = phase === 'archiving';
  const isBusy = isMerging || isArchiving;
  const isBlocked =
    phase === 'blocked' || Boolean(runtime?.blockedRepositories.length);

  return {
    phase,
    isLoading,
    isBlocked,
    isMerging,
    isArchiving,
    isBusy,
    canMerge: !isLoading && !isBusy && !isBlocked,
    canRetry: !isLoading && !isBusy && isBlocked,
    canResolveAutomatically: !isLoading && !isBusy && isBlocked,
    canArchive: !isLoading && !isBusy,
    shouldShowBlockedActions: !isLoading && !isBusy && isBlocked,
  };
};

export const selectPlanFinalizationFocusTarget = <
  Target extends PlanFinalizationFocusableTargetLike,
>(
  targets: Target[],
  preferredProjectId?: string | null
): Target | null => {
  if (targets.length === 0) {
    return null;
  }

  if (preferredProjectId) {
    const matchingTarget = targets.find(
      (target) => target.projectId === preferredProjectId
    );
    if (matchingTarget) {
      return matchingTarget;
    }
  }

  return targets[0] || null;
};

export const resolvePlanFinalizationFocusContext = <
  Target extends PlanFinalizationFocusableTargetLike,
>(
  targets: Target[],
  preferredProjectId?: string | null
): { repoPath: string | null; branchName: string | null; target: Target | null } => {
  const target = selectPlanFinalizationFocusTarget(targets, preferredProjectId);
  return {
    repoPath: target?.repoPath || null,
    branchName:
      target?.baseBranchName ||
      target?.targetBranchName ||
      target?.branchName ||
      null,
    target,
  };
};
