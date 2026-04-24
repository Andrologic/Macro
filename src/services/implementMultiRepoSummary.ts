import type { TaskExecutionTarget, TaskStatus } from '../types';

export type ReviewRepositoryUiState =
  | 'pending_validation'
  | 'ready_to_commit'
  | 'committed'
  | 'no_changes';

export type ReviewTaskNextAction =
  | 'validate_repository'
  | 'commit_repository'
  | 'complete_task'
  | 'complete_without_code_changes'
  | 'none';

export interface ReviewRepositoryLike {
  id: string;
  projectId: string;
  repoPath: string;
  branchName: string;
  stats: {
    pendingVisibleFileCount: number;
    validatedStagedFileCount: number;
  };
  commitState: 'idle' | 'committing' | 'committed' | 'no_changes';
}

export interface ReviewRepositorySummary {
  id: string;
  projectId: string;
  repoPath: string;
  branchName: string;
  state: ReviewRepositoryUiState;
  pendingVisibleFileCount: number;
  validatedStagedFileCount: number;
  hasPendingVisibleChanges: boolean;
  hasValidatedStagedChanges: boolean;
  isSelected: boolean;
  isNextAction: boolean;
  isCommitting: boolean;
}

export interface ReviewTaskSummary {
  repositoryCount: number;
  stateCounts: Record<ReviewRepositoryUiState, number>;
  actionCounts: {
    pending_validation: number;
    ready_to_commit: number;
  };
  repositories: ReviewRepositorySummary[];
  currentRepositoryId: string | null;
  nextRepositoryId: string | null;
  nextAction: ReviewTaskNextAction;
  hasCommittedRepositories: boolean;
  hasActionableRepositories: boolean;
  allRepositoriesResolved: boolean;
  allRepositoriesNoChanges: boolean;
}

export interface MultiRepoTaskLike {
  project_id?: string;
  project_ids?: string[];
  assigned_branch: string;
  execution_targets?: TaskExecutionTarget[];
  status: TaskStatus;
}

export interface TaskRepositoryDescriptor {
  id: string;
  projectId: string;
  branchName: string;
  repoPath: string | null;
  projectName: string | null;
  label: string;
}

const unique = (items: string[]): string[] => Array.from(new Set(items.filter((item) => item.trim().length > 0)));

export const EMPTY_REVIEW_TASK_SUMMARY: ReviewTaskSummary = {
  repositoryCount: 0,
  stateCounts: {
    pending_validation: 0,
    ready_to_commit: 0,
    committed: 0,
    no_changes: 0,
  },
  actionCounts: {
    pending_validation: 0,
    ready_to_commit: 0,
  },
  repositories: [],
  currentRepositoryId: null,
  nextRepositoryId: null,
  nextAction: 'none',
  hasCommittedRepositories: false,
  hasActionableRepositories: false,
  allRepositoriesResolved: false,
  allRepositoriesNoChanges: false,
};

export const getReviewRepositoryUiState = (
  repository: Pick<ReviewRepositoryLike, 'stats' | 'commitState'>
): ReviewRepositoryUiState => {
  if (repository.commitState === 'committed') {
    return 'committed';
  }
  if (
    repository.commitState === 'no_changes' ||
    (repository.stats.pendingVisibleFileCount === 0 && repository.stats.validatedStagedFileCount === 0)
  ) {
    return 'no_changes';
  }
  if (repository.stats.pendingVisibleFileCount === 0 && repository.stats.validatedStagedFileCount > 0) {
    return 'ready_to_commit';
  }
  return 'pending_validation';
};

const hasPendingVisibleChanges = (repository: Pick<ReviewRepositoryLike, 'stats' | 'commitState'>): boolean =>
  repository.commitState !== 'committed' &&
  repository.commitState !== 'no_changes' &&
  repository.stats.pendingVisibleFileCount > 0;

const hasValidatedStagedChanges = (repository: Pick<ReviewRepositoryLike, 'stats' | 'commitState'>): boolean =>
  repository.commitState !== 'committed' &&
  repository.stats.validatedStagedFileCount > 0;

export const selectReviewRepositoryId = (
  repositories: ReviewRepositoryLike[],
  preferredRepositoryId?: string | null
): string | null => {
  if (repositories.length === 0) {
    return null;
  }

  const actionableRepositories = repositories.filter((repository) =>
    hasPendingVisibleChanges(repository) || hasValidatedStagedChanges(repository)
  );

  if (preferredRepositoryId) {
    const preferredRepository = repositories.find((repository) => repository.id === preferredRepositoryId);
    if (preferredRepository) {
      if (
        hasPendingVisibleChanges(preferredRepository) ||
        hasValidatedStagedChanges(preferredRepository) ||
        actionableRepositories.length === 0
      ) {
        return preferredRepository.id;
      }
    }
  }

  return actionableRepositories[0]?.id ?? repositories[0]?.id ?? null;
};

export const buildReviewTaskSummary = (
  repositories: ReviewRepositoryLike[],
  selectedRepositoryId?: string | null
): ReviewTaskSummary => {
  if (repositories.length === 0) {
    return EMPTY_REVIEW_TASK_SUMMARY;
  }

  const currentRepositoryId = selectReviewRepositoryId(repositories, selectedRepositoryId);
  const currentRepository = repositories.find((repository) => repository.id === currentRepositoryId) ?? null;
  const fallbackNextRepositoryId =
    repositories.find((repository) =>
      hasPendingVisibleChanges(repository) || hasValidatedStagedChanges(repository)
    )?.id ?? null;
  const nextRepositoryId =
    currentRepository &&
    (hasPendingVisibleChanges(currentRepository) || hasValidatedStagedChanges(currentRepository))
      ? currentRepository.id
      : fallbackNextRepositoryId;

  const repositoriesSummary = repositories.map((repository) => {
    const state = getReviewRepositoryUiState(repository);
    const repositoryHasPendingVisibleChanges = hasPendingVisibleChanges(repository);
    const repositoryHasValidatedStagedChanges = hasValidatedStagedChanges(repository);
    return {
      id: repository.id,
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      branchName: repository.branchName,
      state,
      pendingVisibleFileCount: repository.stats.pendingVisibleFileCount,
      validatedStagedFileCount: repository.stats.validatedStagedFileCount,
      hasPendingVisibleChanges: repositoryHasPendingVisibleChanges,
      hasValidatedStagedChanges: repositoryHasValidatedStagedChanges,
      isSelected: repository.id === currentRepositoryId,
      isNextAction: repository.id === nextRepositoryId,
      isCommitting: repository.commitState === 'committing',
    } satisfies ReviewRepositorySummary;
  });

  const stateCounts = repositoriesSummary.reduce<ReviewTaskSummary['stateCounts']>(
    (counts, repository) => ({
      ...counts,
      [repository.state]: counts[repository.state] + 1,
    }),
    {
      pending_validation: 0,
      ready_to_commit: 0,
      committed: 0,
      no_changes: 0,
    }
  );

  const actionCounts = repositoriesSummary.reduce<ReviewTaskSummary['actionCounts']>(
    (counts, repository) => ({
      pending_validation: counts.pending_validation + (repository.hasPendingVisibleChanges ? 1 : 0),
      ready_to_commit: counts.ready_to_commit + (repository.hasValidatedStagedChanges ? 1 : 0),
    }),
    {
      pending_validation: 0,
      ready_to_commit: 0,
    }
  );

  const hasCommittedRepositories = stateCounts.committed > 0;
  const hasActionableRepositories = actionCounts.pending_validation > 0 || actionCounts.ready_to_commit > 0;
  const allRepositoriesResolved = repositoriesSummary.every(
    (repository) => repository.state === 'committed' || repository.state === 'no_changes'
  );
  const allRepositoriesNoChanges =
    repositoriesSummary.length > 0 &&
    repositoriesSummary.every((repository) => repository.state === 'no_changes');

  let nextAction: ReviewTaskNextAction = 'none';
  if (currentRepository && hasPendingVisibleChanges(currentRepository)) {
    nextAction = 'validate_repository';
  } else if (currentRepository && hasValidatedStagedChanges(currentRepository)) {
    nextAction = 'commit_repository';
  } else if (fallbackNextRepositoryId) {
    const nextRepository = repositories.find((repository) => repository.id === fallbackNextRepositoryId) ?? null;
    nextAction =
      nextRepository && hasValidatedStagedChanges(nextRepository) && !hasPendingVisibleChanges(nextRepository)
        ? 'commit_repository'
        : 'validate_repository';
  } else if (allRepositoriesResolved && hasCommittedRepositories) {
    nextAction = 'complete_task';
  } else if (allRepositoriesResolved && allRepositoriesNoChanges) {
    nextAction = 'complete_without_code_changes';
  }

  return {
    repositoryCount: repositoriesSummary.length,
    stateCounts,
    actionCounts,
    repositories: repositoriesSummary,
    currentRepositoryId,
    nextRepositoryId,
    nextAction,
    hasCommittedRepositories,
    hasActionableRepositories,
    allRepositoriesResolved,
    allRepositoriesNoChanges,
  };
};

export const canRequestTaskChangesFromReview = (
  reviewSummary: Pick<ReviewTaskSummary, 'hasCommittedRepositories'>
): boolean => {
  return !reviewSummary.hasCommittedRepositories;
};

export const getTaskRepositoryDescriptors = (
  task: MultiRepoTaskLike,
  resolveProject?: (projectId: string) => { name?: string | null; path?: string | null } | null | undefined
): TaskRepositoryDescriptor[] => {
  const executionTargets = task.execution_targets?.length
    ? task.execution_targets
    : unique([
      ...(Array.isArray(task.project_ids) ? task.project_ids : []),
      ...(task.project_id ? [task.project_id] : []),
    ]).map((projectId) => ({
      projectId,
      branchName: task.assigned_branch,
      worktreeKey: `${projectId}:${task.assigned_branch}`,
      repoPath: undefined,
    }));

  return executionTargets.map((target) => {
    const project = resolveProject?.(target.projectId) ?? null;
    const projectName = typeof project?.name === 'string' && project.name.trim().length > 0
      ? project.name.trim()
      : null;
    return {
      id: `${target.projectId}:${target.branchName}`,
      projectId: target.projectId,
      branchName: target.branchName,
      repoPath: target.repoPath ?? project?.path ?? null,
      projectName,
      label: projectName || target.projectId,
    };
  });
};
