import type { TaskStatus } from '../types';

export const FILE_CHANGES_REFRESHABLE_TASK_STATUSES = new Set<TaskStatus>([
  'InProgress',
  'InReview',
  'Blocked',
]);

export const canAutoRefreshFileChangesForTask = (params: {
  taskStatus?: TaskStatus | null;
  hasPendingQuestionnaire?: boolean;
  isPlanFinalizationTask?: boolean;
  hasActiveMergeWorkflow?: boolean;
  hasResourcePressureError?: boolean;
  isResourcePressureBackoffActive?: boolean;
  hasRepositoryScope?: boolean;
  selectedTaskId?: string | null;
  isReadOnlyRemoteMode?: boolean;
}): boolean =>
  Boolean(params.selectedTaskId) &&
  params.hasRepositoryScope !== false &&
  params.isReadOnlyRemoteMode !== true &&
  FILE_CHANGES_REFRESHABLE_TASK_STATUSES.has(params.taskStatus as TaskStatus) &&
  params.hasPendingQuestionnaire !== true &&
  params.isPlanFinalizationTask !== true &&
  params.hasActiveMergeWorkflow !== true &&
  params.hasResourcePressureError !== true &&
  params.isResourcePressureBackoffActive !== true;

export const __testables = {
  FILE_CHANGES_REFRESHABLE_TASK_STATUSES,
};
