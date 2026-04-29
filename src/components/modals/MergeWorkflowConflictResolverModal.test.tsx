import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MergeWorkflowRepositoryResult } from '../../services/mergeWorkflow';
import type { GitConflictFileDto } from '../../services/tauriIpc';

const startManualResolutionMock = mock(async () => ({
  status: 'conflicted',
  conflictFiles: ['src/conflict.ts'],
  output: 'Automatic merge failed',
}));
const completeManualResolutionMock = mock(async () => 'Merge completed');
const abortManualResolutionMock = mock(async () => undefined);
const loadMergeWorkflowReviewMock = mock(async () => null);
const gitStatusMock = mock(async () => ({
  branch: 'develop',
  is_clean: false,
  conflicted_files: ['src/conflict.ts'],
  conflictedFiles: ['src/conflict.ts'],
  merge_in_progress: true,
  mergeInProgress: true,
}));
const conflictFile: GitConflictFileDto = {
  path: 'src/conflict.ts',
  base: { exists: true, content: 'base' },
  ours: { exists: true, content: 'ours' },
  theirs: { exists: true, content: 'theirs' },
  worktree: { exists: true, content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>>' },
  isBinary: false,
  tooLarge: false,
};
const gitReadConflictFileMock = mock(async () => conflictFile);
const gitWriteConflictResolutionMock = mock(async () => undefined);
const gitAcceptConflictSideMock = mock(async () => undefined);

const taskStoreState = {
  startMergeWorkflowManualResolution: startManualResolutionMock,
  completeMergeWorkflowManualResolution: completeManualResolutionMock,
  abortMergeWorkflowManualResolution: abortManualResolutionMock,
  loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
};

mock.module('../../stores/useTaskStore', () => ({
  useTaskStore: (selector: (state: typeof taskStoreState) => unknown) =>
    selector(taskStoreState),
}));

mock.module('../../services/tauriIpc', () => ({
  gitStatus: gitStatusMock,
  gitReadConflictFile: gitReadConflictFileMock,
  gitWriteConflictResolution: gitWriteConflictResolutionMock,
  gitAcceptConflictSide: gitAcceptConflictSideMock,
}));

mock.module('../ui/DiffMergeView', () => ({
  DiffMergeView: ({ modified }: { modified: string }) =>
    React.createElement('pre', { 'data-diff-merge-view': 'true' }, modified),
}));

mock.module('../ui/toastService', () => ({
  notify: {
    success: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { MergeWorkflowConflictResolverModal } = await import(
  './MergeWorkflowConflictResolverModal'
);

const flushRender = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const buildRepository = (
  overrides: Partial<MergeWorkflowRepositoryResult> = {}
): MergeWorkflowRepositoryResult => ({
  id: 'repo-1',
  projectId: 'project-1',
  repoPath: '/repos/project',
  sourceBranchName: 'feature/task',
  targetBranchName: 'develop',
  progressState: 'blocked',
  hadChangesAtStart: true,
  mergeAppliedAt: null,
  isClean: true,
  hasChanges: true,
  ahead: 1,
  behind: 0,
  mergeable: false,
  conflictFiles: ['src/conflict.ts'],
  dirtyFiles: [],
  mergeInProgress: true,
  diff: '',
  checkStatus: 'failed',
  blockingKind: 'merge_conflict',
  nextAction: 'resolve_conflicts',
  blockingReason: 'Cannot continue merge because /repos/project would conflict in: src/conflict.ts.',
  isSourcePublished: false,
  mergeStrategy: 'file_conflict',
  recommendedAction: 'assistant',
  availableActions: ['assistant', 'retry_check'],
  ...overrides,
});

describe('MergeWorkflowConflictResolverModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    startManualResolutionMock.mockClear();
    completeManualResolutionMock.mockClear();
    abortManualResolutionMock.mockClear();
    loadMergeWorkflowReviewMock.mockClear();
    gitStatusMock.mockClear();
    gitReadConflictFileMock.mockClear();
    gitReadConflictFileMock.mockImplementation(async () => conflictFile);
    gitWriteConflictResolutionMock.mockClear();
    gitAcceptConflictSideMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushRender();
    });
    container.remove();
  });

  it('loads existing materialized conflicts without starting a second merge resolution', async () => {
    await act(async () => {
      root.render(
        <MergeWorkflowConflictResolverModal
          taskId="task-1"
          repository={buildRepository()}
          onClose={mock(() => undefined)}
        />
      );
      await flushRender();
    });

    expect(startManualResolutionMock).not.toHaveBeenCalled();
    expect(gitReadConflictFileMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      path: 'src/conflict.ts',
    });
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).not.toBeNull();
  });

  it('shows a recoverable file-load error with retry controls', async () => {
    gitReadConflictFileMock.mockImplementationOnce(async () => {
      throw new Error('staged file disappeared');
    }).mockImplementationOnce(async () => conflictFile);

    await act(async () => {
      root.render(
        <MergeWorkflowConflictResolverModal
          taskId="task-1"
          repository={buildRepository()}
          onClose={mock(() => undefined)}
        />
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('staged file disappeared');
    const retryButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry file'));

    await act(async () => {
      retryButton?.click();
      await flushRender();
    });

    expect(gitReadConflictFileMock).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).not.toBeNull();
  });
});
