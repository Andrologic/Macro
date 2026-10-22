import { describe, expect, it } from 'bun:test';
import { visibleTaskQueueTasks } from './taskQueueVisibility';

type QueueTask = Parameters<typeof visibleTaskQueueTasks>[0][number];
const parent: QueueTask = { id: 'parent', status: 'InProgress' };
const later: QueueTask = { id: 'later', status: 'Blocked', is_blocked: true, blocked_by_task_ids: ['parent'] };
const defaults = () => ({ showBlockedTasks: false, showWithoutInteraction: true, showArchived: false, runningTaskIds: new Set<string>(), attentionByTaskId: new Map<string, unknown>(), mergeWorkflowRuntimeByTaskId: {} });
const ids = (tasks: QueueTask[], options = defaults()) => visibleTaskQueueTasks(tasks, options).map(task => task.id);

describe('task queue display filters', () => {
  it('filters blocked tasks independently from tasks without interaction, without changing execution state', () => {
    expect(ids([parent, later])).toEqual(['parent']);
    expect(later.status).toBe('Blocked');
    expect(ids([parent, later], { ...defaults(), showBlockedTasks: true })).toEqual(['parent', 'later']);
    expect(ids([parent, later], { ...defaults(), showBlockedTasks: true, showWithoutInteraction: false })).toEqual(['later']);
    expect(ids([parent, later], { ...defaults(), showWithoutInteraction: false })).toEqual([]);
    expect(ids([{ ...later, status: 'Pending', is_blocked: false }])).toEqual(['later']);
  });

  it('keeps launch actions, drafts, requests, failures and revalidation visible', () => {
    const options = { ...defaults(), showWithoutInteraction: false };
    for (const task of [
      { ...parent, status: 'Pending' }, { ...parent, status: 'AwaitingResponse' },
      { ...parent, status: 'Failed' }, { ...later, needs_revalidation: true }, { ...parent, draft: true },
    ] as QueueTask[]) expect(ids([task], options)).toEqual([task.id]);
    expect(ids([later], { ...options, attentionByTaskId: new Map([['later', { kind: 'approval' }]]) })).toEqual(['later']);
    expect(ids([{ ...parent, status: 'InReview' }], { ...options, attentionByTaskId: new Map([['parent', { kind: 'review' }]]) })).toEqual(['parent']);
    expect(ids([{ ...later, merge_workflow_summary: { kind: 'task_completion', phase: 'blocked', taskStatus: 'Blocked', repositoryCount: 1, mergedRepositoryCount: 0, blockedRepositoryCount: 1, unresolvedRepositoryCount: 1, updatedAt: null, message: null } }], options)).toEqual(['later']);
  });

  it('treats active execution as activity, even if an old dependency flag remains', () => {
    expect(ids([later], { ...defaults(), runningTaskIds: new Set(['later']) })).toEqual(['later']);
    expect(ids([later], { ...defaults(), showWithoutInteraction: false, runningTaskIds: new Set(['later']) })).toEqual([]);
  });

  it('adds archives independently, deduplicates them, and hides them again without affecting active tasks', () => {
    const archived = { ...later, archived_at: '2026-01-01' };
    expect(ids([parent, archived, archived])).toEqual(['parent']);
    expect(ids([parent, archived, archived], { ...defaults(), showArchived: true })).toEqual(['parent', 'later']);
    expect(ids([parent, archived], { ...defaults(), showArchived: true, showWithoutInteraction: false })).toEqual(['later']);
  });
});
