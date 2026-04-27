import { describe, expect, it } from 'bun:test';
import {
  overlayPersistedMergeWorkflowSession,
  type PersistedMergeWorkflowSession,
} from './mergeWorkflowPersistence';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';

const buildRuntime = (
  overrides: Partial<MergeWorkflowRuntimeState['repositories'][number]> = {}
): MergeWorkflowRuntimeState => {
  const repository = {
    id: 'project-1::/repos/web',
    projectId: 'project-1',
    repoPath: '/repos/web',
    sourceBranchName: 'feature/task',
    targetBranchName: 'main',
    progressState: 'pending' as const,
    hadChangesAtStart: true,
    mergeAppliedAt: null,
    isClean: true,
    hasChanges: true,
    mergeable: true,
    conflictFiles: [],
    mergeInProgress: false,
    diff: 'diff',
    checkStatus: 'passed' as const,
    blockingKind: null,
    nextAction: null,
    blockingReason: null,
    ...overrides,
  };

  return {
    taskId: 'task-1',
    kind: 'task_completion',
    phase: repository.blockingReason ? 'blocked' : 'ready',
    taskStatus: repository.blockingReason ? 'Blocked' : 'InProgress',
    review: null,
    repositories: [repository],
    blockedRepositories: repository.blockingReason ? [repository] : [],
    message: repository.blockingReason ? 'Blocked' : null,
    lastLoadedAt: '2026-04-27T00:00:00.000Z',
  };
};

const buildSession = (
  state: PersistedMergeWorkflowSession['repositories'][number]['state']
): PersistedMergeWorkflowSession => ({
  kind: 'task_completion',
  phase: state === 'blocked' ? 'blocked' : 'ready',
  taskStatus: state === 'blocked' ? 'Blocked' : 'InProgress',
  startedAt: '2026-04-27T00:00:00.000Z',
  updatedAt: '2026-04-27T00:00:00.000Z',
  lastLoadedAt: '2026-04-27T00:00:00.000Z',
  message: state === 'blocked' ? 'Old blocker' : null,
  repositories: [
    {
      id: 'project-1::/repos/web',
      projectId: 'project-1',
      repoPath: '/repos/web',
      sourceBranchName: 'feature/task',
      targetBranchName: 'main',
      state,
      hadChangesAtStart: true,
      mergeAppliedAt: state === 'merged' ? '2026-04-27T00:01:00.000Z' : null,
      blockingKind: state === 'blocked' ? 'repository_dirty' : null,
      blockingReason: state === 'blocked' ? 'Old dirty blocker' : null,
      conflictFiles: state === 'blocked' ? ['old.ts'] : [],
    },
  ],
});

describe('overlayPersistedMergeWorkflowSession', () => {
  it('does not reapply stale blocked state over a fresh clean review', () => {
    const runtime = overlayPersistedMergeWorkflowSession({
      runtime: buildRuntime(),
      session: buildSession('blocked'),
    });

    expect(runtime.phase).toBe('ready');
    expect(runtime.blockedRepositories).toEqual([]);
    expect(runtime.repositories[0]?.progressState).toBe('pending');
    expect(runtime.repositories[0]?.blockingReason).toBeNull();
    expect(runtime.repositories[0]?.conflictFiles).toEqual([]);
  });

  it('preserves completed repository state across fresh reviews', () => {
    const runtime = overlayPersistedMergeWorkflowSession({
      runtime: buildRuntime(),
      session: buildSession('merged'),
    });

    expect(runtime.phase).toBe('ready');
    expect(runtime.repositories[0]?.progressState).toBe('merged');
    expect(runtime.repositories[0]?.mergeAppliedAt).toBe('2026-04-27T00:01:00.000Z');
    expect(runtime.repositories[0]?.blockingReason).toBeNull();
  });
});
