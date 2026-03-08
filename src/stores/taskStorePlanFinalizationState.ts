import type { PlanReviewRepositoryResult } from '../services/architectGitFlowService';
import { toServiceError } from '../services/contracts/errors';

export interface BlockedPlanFinalizationState {
  planId: string;
  branchName: string;
  message: string;
  repositories: PlanReviewRepositoryResult[];
  blockedRepositories: PlanReviewRepositoryResult[];
}

interface BlockedPlanFinalizationErrorLike extends Error {
  planId: string;
  branchName: string;
  repositories: PlanReviewRepositoryResult[];
  blockedRepositories: PlanReviewRepositoryResult[];
}

export const isBlockedPlanFinalizationErrorLike = (
  error: unknown
): error is BlockedPlanFinalizationErrorLike => {
  return (
    error instanceof Error &&
    error.name === 'PlanFinalizationBlockedError' &&
    'planId' in error &&
    'repositories' in error &&
    'blockedRepositories' in error
  );
};

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

export const buildPlanFinalizationFailureState = (error: unknown): {
  finalizingPlanId: null;
  blockedPlanFinalization: BlockedPlanFinalizationState | null;
  lastError: string;
} => ({
  finalizingPlanId: null,
  blockedPlanFinalization: toBlockedPlanFinalizationState(error),
  lastError: toServiceError(error).message,
});

export const buildPlanFinalizationSuccessState = (): {
  finalizingPlanId: null;
  blockedPlanFinalization: null;
  lastError: null;
} => ({
  finalizingPlanId: null,
  blockedPlanFinalization: null,
  lastError: null,
});

export const buildPlanFinalizationRefreshState = (): {
  blockedPlanFinalization: null;
  lastError: null;
} => ({
  blockedPlanFinalization: null,
  lastError: null,
});
