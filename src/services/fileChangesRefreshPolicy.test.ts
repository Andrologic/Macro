import { describe, expect, it } from 'bun:test';
import { canAutoRefreshFileChangesForTask } from './fileChangesRefreshPolicy';

const base = {
  selectedTaskId: 'task-1',
  taskStatus: 'InProgress' as const,
  hasRepositoryScope: true,
};

describe('fileChangesRefreshPolicy', () => {
  it('allows automatic refresh for active reviewable task states', () => {
    expect(canAutoRefreshFileChangesForTask(base)).toBe(true);
    expect(canAutoRefreshFileChangesForTask({ ...base, taskStatus: 'InReview' })).toBe(true);
    expect(canAutoRefreshFileChangesForTask({ ...base, taskStatus: 'Blocked' })).toBe(true);
  });

  it('pauses automatic refresh for idle or user-blocked task states', () => {
    expect(canAutoRefreshFileChangesForTask({ ...base, taskStatus: 'AwaitingResponse' })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, taskStatus: 'Pending' })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, taskStatus: 'Failed' })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, hasPendingQuestionnaire: true })).toBe(false);
  });

  it('pauses automatic refresh while resource pressure or special workflows are active', () => {
    expect(canAutoRefreshFileChangesForTask({ ...base, hasResourcePressureError: true })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, isResourcePressureBackoffActive: true })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, isPlanFinalizationTask: true })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, hasActiveMergeWorkflow: true })).toBe(false);
    expect(canAutoRefreshFileChangesForTask({ ...base, isReadOnlyRemoteMode: true })).toBe(false);
  });
});
