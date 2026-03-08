import type { TaskExecutionTarget, TaskStatus } from '../types';

export type ReviewRepositoryUiState =
  | 'pending_review'
  | 'ready_to_commit'
  | 'committed'
  | 'no_changes';

export type ReviewTaskNextAction =
  | 'review_repository'
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
    total: number;
    reviewed: number;
  };
  commitState: 'idle' | 'committing' | 'committed' | 'no_changes';
}

export interface ReviewRepositorySummary {
  id: string;
  projectId: string;
  repoPath: string;
  branchName: string;
  state: ReviewRepositoryUiState;
  totalFiles: number;
  reviewedFiles: number;
  isSelected: boolean;
  isNextAction: boolean;
  isCommitting: boolean;
}

export interface ReviewTaskSummary {
  repositoryCount: number;
  stateCounts: Record<ReviewRepositoryUiState, number>;
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

const isActionableReviewState = (state: ReviewRepositoryUiState): boolean =>
  state === 'pending_review' || state === 'ready_to_commit';

const unique = (items: string[]): string[] => Array.from(new Set(items.filter((item) => item.trim().length > 0)));

export const EMPTY_REVIEW_TASK_SUMMARY: ReviewTaskSummary = {
  repositoryCount: 0,
  stateCounts: {
    pending_review: 0,
    ready_to_commit: 0,
    committed: 0,
    no_changes: 0,
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
  if (repository.commitState === 'no_changes' || repository.stats.total === 0) {
    return 'no_changes';
  }
  if (repository.stats.reviewed >= repository.stats.total) {
    return 'ready_to_commit';
  }
  return 'pending_review';
};

export const selectReviewRepositoryId = (
  repositories: ReviewRepositoryLike[],
  preferredRepositoryId?: string | null
): string | null => {
  if (repositories.length === 0) {
    return null;
  }

  const actionableRepositories = repositories.filter((repository) =>
    isActionableReviewState(getReviewRepositoryUiState(repository))
  );

  if (preferredRepositoryId) {
    const preferredRepository = repositories.find((repository) => repository.id === preferredRepositoryId);
    if (preferredRepository) {
      const preferredState = getReviewRepositoryUiState(preferredRepository);
      if (isActionableReviewState(preferredState) || actionableRepositories.length === 0) {
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
  const currentRepositoryState = currentRepository ? getReviewRepositoryUiState(currentRepository) : null;
  const fallbackNextRepositoryId =
    repositories.find((repository) => isActionableReviewState(getReviewRepositoryUiState(repository)))?.id ?? null;
  const nextRepositoryId =
    currentRepository && currentRepositoryState && isActionableReviewState(currentRepositoryState)
      ? currentRepository.id
      : fallbackNextRepositoryId;

  const repositoriesSummary = repositories.map((repository) => {
    const state = getReviewRepositoryUiState(repository);
    return {
      id: repository.id,
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      branchName: repository.branchName,
      state,
      totalFiles: repository.stats.total,
      reviewedFiles: repository.stats.reviewed,
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
      pending_review: 0,
      ready_to_commit: 0,
      committed: 0,
      no_changes: 0,
    }
  );

  const hasCommittedRepositories = stateCounts.committed > 0;
  const hasActionableRepositories = stateCounts.pending_review > 0 || stateCounts.ready_to_commit > 0;
  const allRepositoriesResolved = repositoriesSummary.every(
    (repository) => repository.state === 'committed' || repository.state === 'no_changes'
  );
  const allRepositoriesNoChanges =
    repositoriesSummary.length > 0 &&
    repositoriesSummary.every((repository) => repository.state === 'no_changes');

  let nextAction: ReviewTaskNextAction = 'none';
  if (currentRepository && currentRepositoryState === 'ready_to_commit') {
    nextAction = 'commit_repository';
  } else if (currentRepository && currentRepositoryState === 'pending_review') {
    nextAction = 'review_repository';
  } else if (fallbackNextRepositoryId) {
    const nextRepository = repositories.find((repository) => repository.id === fallbackNextRepositoryId) ?? null;
    nextAction =
      nextRepository && getReviewRepositoryUiState(nextRepository) === 'ready_to_commit'
        ? 'commit_repository'
        : 'review_repository';
  } else if (allRepositoriesResolved && hasCommittedRepositories) {
    nextAction = 'complete_task';
  } else if (allRepositoriesResolved && allRepositoriesNoChanges) {
    nextAction = 'complete_without_code_changes';
  }

  return {
    repositoryCount: repositoriesSummary.length,
    stateCounts,
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
