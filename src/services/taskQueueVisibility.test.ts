import { describe, expect, it } from 'bun:test';
import { visibleTaskQueueTasks } from './taskQueueVisibility';

type QueueTask = Parameters<typeof visibleTaskQueueTasks>[0][number];
const parent: QueueTask = { id: 'parent', status: 'InProgress' };
const later: QueueTask = { id: 'later', status: 'Blocked', is_blocked: true, blocked_by_task_ids: ['parent'] };
const defaults = () => ({ showAllTasks: false, showArchived: false, runningTaskIds: new Set<string>(), attentionByTaskId: new Map<string, unknown>(), mergeWorkflowRuntimeByTaskId: {} });
const ids = (tasks: QueueTask[], options = defaults()) => visibleTaskQueueTasks(tasks, options).map(task => task.id);

describe('task queue dependency visibility', () => {
  it('hides an unstarted dependent task without changing its engine state, and reveals it when it becomes ready', () => {
    expect(ids([parent, later])).toEqual(['parent']);
    expect(later.status).toBe('Blocked');
    expect(later.is_blocked).toBe(true);
    expect(ids([{ ...parent, status: 'Completed' }, { ...later, status: 'Pending', is_blocked: false, blocked_by_task_ids: [] }])).toEqual(['parent', 'later']);
    expect(ids([parent, later], { ...defaults(), showAllTasks: true })).toEqual(['parent', 'later']);
    expect(ids([parent, { ...later, archived_at: '2026-01-01' }], { ...defaults(), showArchived: true })).toEqual(['parent', 'later']);
  });

  it.each(['Failed', 'AwaitingResponse', 'InProgress', 'InReview', 'Completed'] as const)('keeps the %s task visible even when a dependency is also blocked', status => {
    expect(ids([parent, { ...later, status }])).toContain('later');
  });

  it('keeps live activity, approvals, revalidation and merge issues visible', () => {
    expect(ids([parent, later], { ...defaults(), runningTaskIds: new Set(['later']) })).toContain('later');
    expect(ids([parent, later], { ...defaults(), attentionByTaskId: new Map([['later', { kind: 'approval' }]]) })).toContain('later');
    expect(ids([parent, { ...later, needs_revalidation: true }])).toContain('later');
    expect(ids([parent, { ...later, merge_workflow_summary: { kind: 'task_completion', phase: 'blocked', taskStatus: 'Blocked', repositoryCount: 1, mergedRepositoryCount: 0, blockedRepositoryCount: 1, unresolvedRepositoryCount: 1, updatedAt: null, message: null } }])).toContain('later');
  });

  it('keeps unknown, ambiguous and stale blockers available for inspection', () => {
    for (const blocked_by_task_ids of [[], ['missing'], ['later']]) {
      expect(ids([parent, { ...later, blocked_by_task_ids }])).toContain('later');
    }
    expect(ids([{ ...parent, status: 'Completed' }, later])).toContain('later');
    expect(ids([{ ...parent, archived_at: '2026-01-01' }, later])).toContain('later');
    expect(ids([{ ...parent, node_id: 'shared' }, { id: 'another', node_id: 'shared', status: 'Pending' }, { ...later, blocked_by_task_ids: ['shared'] }])).toContain('later');
  });
});
