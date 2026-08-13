import { describe, expect, it } from 'bun:test';
import {
  buildMergeWorkflowRuntimeFromPersistedSession,
  overlayPersistedMergeWorkflowSession,
  type PersistedMergeWorkflowSession,
} from './mergeWorkflowPersistence';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';
import type { MergeWorkflowResolutionAction } from './mergeWorkflow';

const buildRuntime = (
  overrides: Partial<MergeWorkflowRuntimeState['repositories'][number]> = {}
): MergeWorkflowRuntimeState => {
  const repository = {
    id: 'project-1::/repos/web',
    projectId: 'project-1',
    repoPath: '/repos/web',
    repositoryRootPath: '/repos/web',
    integrationWorktreePath: null,
    sourceBranchName: 'feature/task',
    targetBranchName: 'main',
    progressState: 'pending' as const,
    hadChangesAtStart: true,
    mergeAppliedAt: null,
    isClean: true,
    hasChanges: true,
    ahead: 1,
    behind: 0,
    mergeable: true,
    conflictFiles: [],
    dirtyFiles: [],
    mergeInProgress: false,
    diff: 'diff',
    checkStatus: 'passed' as const,
    blockingKind: null,
    nextAction: null,
    blockingReason: null,
    isSourcePublished: false,
    mergeStrategy: 'merge_commit_available' as const,
    recommendedAction: 'merge_commit' as const,
    availableActions: ['merge_commit'] as MergeWorkflowResolutionAction[],
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
      repositoryRootPath: '/repos/web',
      integrationWorktreePath: null,
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

  it('does not let a persisted merged marker hide fresh branch changes', () => {
    const runtime = overlayPersistedMergeWorkflowSession({
      runtime: buildRuntime(),
      session: buildSession('merged'),
    });

    expect(runtime.phase).toBe('ready');
    expect(runtime.repositories[0]?.progressState).toBe('pending');
    expect(runtime.repositories[0]?.mergeAppliedAt).toBeNull();
    expect(runtime.repositories[0]?.blockingReason).toBeNull();
  });

  it('retains a completed marker only when the fresh Git review agrees', () => {
    const runtime = overlayPersistedMergeWorkflowSession({
      runtime: buildRuntime({
        progressState: 'merged',
        hasChanges: false,
        mergeAppliedAt: '2026-04-27T00:00:30.000Z',
      }),
      session: buildSession('merged'),
    });

    expect(runtime.repositories[0]?.progressState).toBe('merged');
    expect(runtime.repositories[0]?.mergeAppliedAt).toBe('2026-04-27T00:01:00.000Z');
  });
});

describe('buildMergeWorkflowRuntimeFromPersistedSession', () => {
  it('restores a resolved in-progress merge as ready to complete', () => {
    const session = buildSession('blocked');
    session.repositories[0] = {
      ...session.repositories[0]!,
      blockingKind: 'merge_in_progress',
      blockingReason: 'Old unfinished merge',
      conflictFiles: [],
      mergeInProgress: true,
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
    };

    const runtime = buildMergeWorkflowRuntimeFromPersistedSession({
      taskId: 'task-1',
      session,
    });

    expect(runtime.phase).toBe('ready');
    expect(runtime.blockedRepositories).toEqual([]);
    expect(runtime.repositories[0]).toMatchObject({
      repositoryRootPath: '/repos/web',
      integrationWorktreePath: null,
      progressState: 'pending',
      mergeInProgress: true,
      blockingKind: null,
      blockingReason: null,
      nextAction: 'complete_merge',
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
    });
  });

  it('keeps conflicted persisted merges blocked', () => {
    const session = buildSession('blocked');
    session.repositories[0] = {
      ...session.repositories[0]!,
      blockingKind: 'merge_conflict',
      blockingReason: 'Conflict in src/main.ts',
      conflictFiles: ['src/main.ts'],
      mergeInProgress: true,
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
    };

    const runtime = buildMergeWorkflowRuntimeFromPersistedSession({
      taskId: 'task-1',
      session,
    });

    expect(runtime.phase).toBe('blocked');
    expect(runtime.blockedRepositories).toHaveLength(1);
    expect(runtime.repositories[0]).toMatchObject({
      progressState: 'blocked',
      mergeInProgress: true,
      blockingKind: 'merge_conflict',
      nextAction: 'resolve_conflicts',
      conflictFiles: ['src/main.ts'],
      mergeStrategy: 'file_conflict',
    });
  });
});
