import type { MergeWorkflowRuntimeState } from './mergeWorkflow';
import type { MergeWorkflowSummary } from './mergeWorkflowPersistence';
import type { TaskStatus } from '../types';

export interface TaskMergeWorkflowPresentationState {
  phase: MergeWorkflowRuntimeState['phase'];
  repositoryCount: number;
  mergedRepositoryCount: number;
  blockedRepositoryCount: number;
  unresolvedRepositoryCount: number;
}

type Translate = (
  key: string,
  fallback: string,
  options?: Record<string, unknown>
) => string;

export const resolveTaskMergeWorkflowPresentationState = (
  runtime?: Pick<MergeWorkflowRuntimeState, 'phase' | 'repositories' | 'taskStatus'> | null,
  summary?: MergeWorkflowSummary | null,
  currentTaskStatus?: TaskStatus | null
): TaskMergeWorkflowPresentationState | null => {
  if (runtime) {
    if (currentTaskStatus && runtime.taskStatus !== currentTaskStatus) {
      return null;
    }

    const mergedRepositoryCount = runtime.repositories.filter(
      (repository) => repository.progressState === 'merged'
    ).length;
    const blockedRepositoryCount = runtime.repositories.filter(
      (repository) => repository.progressState === 'blocked'
    ).length;
    const unresolvedRepositoryCount = runtime.repositories.filter(
      (repository) =>
        repository.progressState === 'pending' ||
        repository.progressState === 'blocked'
    ).length;

    return {
      phase: runtime.phase,
      repositoryCount: runtime.repositories.length,
      mergedRepositoryCount,
      blockedRepositoryCount,
      unresolvedRepositoryCount,
    };
  }

  if (!summary) {
    return null;
  }
  if (currentTaskStatus && summary.taskStatus !== currentTaskStatus) {
    return null;
  }

  return {
    phase: summary.phase,
    repositoryCount: summary.repositoryCount,
    mergedRepositoryCount: summary.mergedRepositoryCount,
    blockedRepositoryCount: summary.blockedRepositoryCount,
    unresolvedRepositoryCount: summary.unresolvedRepositoryCount,
  };
};

export const resolveTaskMergeWorkflowProgressLabel = (
  state: TaskMergeWorkflowPresentationState,
  t: Translate
): string => {
  if (state.phase === 'partial') {
    return t(
      'implement.taskMergeWorkflowPartialProgress',
      '{{merged}} merged, {{remaining}} remaining',
      {
        merged: state.mergedRepositoryCount,
        remaining: state.unresolvedRepositoryCount,
      }
    );
  }

  return t(
    'implement.taskMergeWorkflowProgress',
    '{{count}} repositories in merge workflow',
    {
      count: state.repositoryCount,
    }
  );
};

export const resolveTaskMergeWorkflowNextActionLabel = (
  state: TaskMergeWorkflowPresentationState,
  t: Translate,
  options?: {
    isPlanFinalizationTask?: boolean;
  }
): string => {
  switch (state.phase) {
    case 'partial':
      return state.blockedRepositoryCount > 0
        ? t(
            'implement.taskNextActionResolveRemainingMergeBlocked',
            'Next: resolve remaining merge blockers'
          )
        : t(
            'implement.taskNextActionContinuePartialMerge',
            'Next: continue merge for remaining repositories'
          );
    case 'blocked':
      return t(
        'implement.taskNextActionResolveMergeBlocked',
        'Next: resolve merge blockers'
      );
    case 'failed':
      return t(
        'implement.taskNextActionRetryMerge',
        'Next: retry merge'
      );
    case 'merging':
      return t(
        'implement.taskNextActionMerging',
        'Next: merging repositories'
      );
    case 'archiving':
      return t(
        'implement.taskNextActionArchivingMerge',
        'Next: archiving merged repositories'
      );
    case 'loading_review':
      return t(
        'implement.taskNextActionPreparingMerge',
        'Next: preparing merge review'
      );
    case 'idle':
    case 'ready':
    default:
      return options?.isPlanFinalizationTask
        ? t('implement.taskNextActionMergePlan', 'Next: merge plan')
        : t('implement.taskNextActionMergeTask', 'Next: merge task branches');
  }
};
