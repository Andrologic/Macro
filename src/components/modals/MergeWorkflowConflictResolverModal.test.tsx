import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MergeWorkflowRepositoryResult } from '../../services/mergeWorkflow';
import type { GitConflictFileDto } from '../../services/tauriIpc';
import type { MergeWorkflowConflictResolverModal as MergeWorkflowConflictResolverModalComponent } from './MergeWorkflowConflictResolverModal';

const workflowSession = {
  taskId: 'task-1',
  sessionId: 'session-1',
  sourceBranch: 'feature/task',
  targetBranch: 'develop',
  sourceCommit: 'source-commit',
  targetCommit: 'target-commit',
  integratedCommit: null,
  status: 'conflicted' as const,
  output: 'Automatic merge failed',
};

const startManualResolutionMock = mock(async () => ({
  status: 'conflicted',
  conflictFiles: ['src/conflict.ts'],
  output: 'Automatic merge failed',
  workflowSession,
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
  base: { exists: true, content: 'base', sizeBytes: 4, isBinary: false, tooLarge: false },
  ours: { exists: true, content: 'ours', sizeBytes: 4, isBinary: false, tooLarge: false },
  theirs: { exists: true, content: 'theirs', sizeBytes: 6, isBinary: false, tooLarge: false },
  worktree: {
    exists: true,
    content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>>',
    sizeBytes: 43,
    isBinary: false,
    tooLarge: false,
  },
  isBinary: false,
  tooLarge: false,
};
const gitReadConflictFileMock = mock(async () => conflictFile);
const gitWriteConflictResolutionMock = mock(async () => undefined);
const gitAcceptConflictSideMock = mock(async () => undefined);
const loadPreferenceMock = mock(async () => 'focused');
const savePreferenceMock = mock(async () => undefined);
let diffMergeViewProps: Array<{
  original: string;
  modified: string;
  presentationMode?: string;
  revertControlLabel?: string;
  onChange?: (value: string) => void;
}> = [];

const taskStoreState = {
  startMergeWorkflowManualResolution: startManualResolutionMock,
  completeMergeWorkflowManualResolution: completeManualResolutionMock,
  abortMergeWorkflowManualResolution: abortManualResolutionMock,
  loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
};

let MergeWorkflowConflictResolverModal!: typeof MergeWorkflowConflictResolverModalComponent;
let importCounter = 0;

const registerMergeWorkflowConflictResolverMocks = () => {
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

  mock.module('../../services/preferences', () => ({
    PREF_KEYS: {
      IMPLEMENT_DIFF_PRESENTATION_MODE: 'implement.diff.presentationMode',
    },
    loadPreference: loadPreferenceMock,
    savePreference: savePreferenceMock,
  }));

  const diffMergeViewMock = () => ({
    DiffMergeView: (props: {
      original: string;
      modified: string;
      presentationMode?: string;
      revertControlLabel?: string;
      onChange?: (value: string) => void;
    }) => {
      diffMergeViewProps.push(props);
      return React.createElement(
        'div',
        {
          'data-diff-merge-view': 'true',
          'data-presentation-mode': props.presentationMode,
          'data-revert-control-label': props.revertControlLabel,
        },
        React.createElement('pre', null, props.modified),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => props.onChange?.('edited resolution'),
          },
          'Edit draft'
        )
      );
    },
  });

  mock.module('../ui/DiffMergeView', diffMergeViewMock);

  mock.module('../ui/toastService', () => ({
    notify: {
      success: mock(() => undefined),
      error: mock(() => undefined),
    },
  }));
};

const loadMergeWorkflowConflictResolverModal = async () => {
  mock.restore();
  registerMergeWorkflowConflictResolverMocks();
  importCounter += 1;
  ({ MergeWorkflowConflictResolverModal } = await import(
    `./MergeWorkflowConflictResolverModal.tsx?merge-workflow-conflict-resolver-test=${importCounter}`
  ));
};

const flushRender = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const buildRepository = (
  overrides: Partial<MergeWorkflowRepositoryResult> = {}
): MergeWorkflowRepositoryResult => ({
  workflowSession,
  id: 'repo-1',
  projectId: 'project-1',
  repoPath: '/repos/project',
  repositoryRootPath: '/repos/project',
  integrationWorktreePath: null,
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

  beforeEach(async () => {
    await loadMergeWorkflowConflictResolverModal();
    startManualResolutionMock.mockClear();
    completeManualResolutionMock.mockClear();
    abortManualResolutionMock.mockClear();
    loadMergeWorkflowReviewMock.mockClear();
    gitStatusMock.mockClear();
    gitReadConflictFileMock.mockClear();
    gitReadConflictFileMock.mockImplementation(async () => conflictFile);
    gitWriteConflictResolutionMock.mockClear();
    gitAcceptConflictSideMock.mockClear();
    loadPreferenceMock.mockClear();
    loadPreferenceMock.mockImplementation(async () => 'focused');
    savePreferenceMock.mockClear();
    diffMergeViewProps = [];
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
    mock.restore();
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
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
    });
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).not.toBeNull();
  });

  it('waits for a native session before reading files and uses the returned identity', async () => {
    const preparation = createDeferred<{
      status: string;
      conflictFiles: string[];
      output: string;
      workflowSession: typeof workflowSession;
    }>();
    startManualResolutionMock.mockImplementationOnce(async () => preparation.promise);

    await act(async () => {
      root.render(
        <MergeWorkflowConflictResolverModal
          taskId="task-1"
          repository={buildRepository({ workflowSession: undefined })}
          onClose={mock(() => undefined)}
        />
      );
      await flushRender();
    });

    expect(startManualResolutionMock).toHaveBeenCalledTimes(1);
    expect(gitReadConflictFileMock).not.toHaveBeenCalled();

    await act(async () => {
      preparation.resolve({
        status: 'conflicted',
        conflictFiles: ['src/conflict.ts'],
        output: 'Automatic merge failed',
        workflowSession,
      });
      await flushRender();
    });

    expect(startManualResolutionMock).toHaveBeenCalledTimes(1);
    expect(gitReadConflictFileMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
    });
  });

  it('refuses a conflict session owned by another task', async () => {
    await act(async () => {
      root.render(
        <MergeWorkflowConflictResolverModal
          taskId="task-1"
          repository={buildRepository({
            workflowSession: { ...workflowSession, taskId: 'task-2' },
          })}
          onClose={mock(() => undefined)}
        />
      );
      await flushRender();
    });

    expect(startManualResolutionMock).not.toHaveBeenCalled();
    expect(gitReadConflictFileMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('belongs to another task');
  });

  it('starts the resolution draft from current when the worktree still has Git conflict markers', async () => {
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

    expect(diffMergeViewProps.at(-1)?.original).toBe('theirs');
    expect(diffMergeViewProps.at(-1)?.modified).toBe('ours');
    expect(diffMergeViewProps.at(-1)?.modified).not.toContain('<<<<<<<');
    expect(diffMergeViewProps.at(-1)?.modified).not.toContain('=======');
    expect(diffMergeViewProps.at(-1)?.modified).not.toContain('>>>>>>>');
  });

  it('preserves a clean worktree draft when one already exists', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      worktree: { ...conflictFile.worktree, content: 'manual clean resolution', sizeBytes: 23 },
    }));

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

    expect(diffMergeViewProps.at(-1)?.modified).toBe('manual clean resolution');
  });

  it('shows incoming against the clean current-based result on first render', async () => {
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

    expect(diffMergeViewProps.at(-1)?.original).toBe('theirs');
    expect(diffMergeViewProps.at(-1)?.modified).toBe('ours');
    expect(document.body.textContent).toContain('Compare incoming');
    expect(document.body.textContent).toContain('Result starts from Current');
  });

  it('renders focused/full controls and passes the selected presentation mode to the diff view', async () => {
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

    expect(document.body.textContent).toContain('Focused diff');
    expect(document.body.textContent).toContain('Full file context');
    expect(diffMergeViewProps.at(-1)?.presentationMode).toBe('focused');

    const fullContextButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Full file context'));

    await act(async () => {
      fullContextButton?.click();
      await flushRender();
    });

    expect(savePreferenceMock).toHaveBeenCalledWith(
      'implement.diff.presentationMode',
      'full'
    );
    expect(diffMergeViewProps.at(-1)?.presentationMode).toBe('full');
  });

  it('uses current and incoming chunk labels for the merge-view block controls', async () => {
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

    expect(diffMergeViewProps.at(-1)?.revertControlLabel).toBe('Use incoming block');

    const editButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton?.click();
      await flushRender();
    });

    const currentButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Compare current'));

    await act(async () => {
      currentButton?.click();
      await flushRender();
    });

    expect(diffMergeViewProps.at(-1)?.revertControlLabel).toBe('Use current block');
  });

  it('asks before switching files when the resolution draft has unsaved edits', async () => {
    await act(async () => {
      root.render(
        <MergeWorkflowConflictResolverModal
          taskId="task-1"
          repository={buildRepository({
            conflictFiles: ['src/conflict.ts', 'src/other.ts'],
          })}
          onClose={mock(() => undefined)}
        />
      );
      await flushRender();
    });

    const editButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton?.click();
      await flushRender();
    });

    const otherFileButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('other.ts'));
    await act(async () => {
      otherFileButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Discard unsaved changes?');
  });

  it('uses all current as a text draft change without staging immediately', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      worktree: { ...conflictFile.worktree, content: 'manual clean resolution', sizeBytes: 23 },
    }));

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

    expect(diffMergeViewProps.at(-1)?.modified).toBe('manual clean resolution');

    const useCurrentButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Use all current'));
    await act(async () => {
      useCurrentButton?.click();
      await flushRender();
    });

    expect(gitAcceptConflictSideMock).not.toHaveBeenCalled();
    expect(diffMergeViewProps.at(-1)?.original).toBe('theirs');
    expect(diffMergeViewProps.at(-1)?.modified).toBe('ours');
  });

  it('uses all incoming as a text draft change without staging immediately', async () => {
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

    const useIncomingButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Use all incoming'));
    await act(async () => {
      useIncomingButton?.click();
      await flushRender();
    });

    expect(gitAcceptConflictSideMock).not.toHaveBeenCalled();
    expect(diffMergeViewProps.at(-1)?.original).toBe('ours');
    expect(diffMergeViewProps.at(-1)?.modified).toBe('theirs');
  });

  it('allows presentation mode changes while the resolution draft is dirty', async () => {
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

    const editButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton?.click();
      await flushRender();
    });

    const fullContextButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Full file context'));
    await act(async () => {
      fullContextButton?.click();
      await flushRender();
    });

    expect(savePreferenceMock).toHaveBeenCalledWith(
      'implement.diff.presentationMode',
      'full'
    );
    expect(diffMergeViewProps.at(-1)?.presentationMode).toBe('full');
  });

  it('preserves a dirty draft when the published repository object is equivalent', async () => {
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

    const editButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton?.click();
      await flushRender();
    });
    const readCount = gitReadConflictFileMock.mock.calls.length;

    await act(async () => {
      root.render(
        <MergeWorkflowConflictResolverModal
          taskId="task-1"
          repository={buildRepository({ workflowSession: { ...workflowSession } })}
          onClose={mock(() => undefined)}
        />
      );
      await flushRender();
    });

    expect(gitReadConflictFileMock).toHaveBeenCalledTimes(readCount);
    expect(diffMergeViewProps.at(-1)?.modified).toBe('edited resolution');
    expect(document.body.textContent).toContain('Unsaved draft');
  });

  it('defers deletion of either absent text side until Save', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      ours: { ...conflictFile.ours, exists: false, content: 'stale content', sizeBytes: 0 },
      theirs: { ...conflictFile.theirs, exists: false, content: 'stale content', sizeBytes: 0 },
    }));

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

    const useCurrentButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Use all current'));
    const saveButton = () => Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Save resolution'));

    await act(async () => {
      useCurrentButton?.click();
      await flushRender();
    });
    expect(gitAcceptConflictSideMock).not.toHaveBeenCalled();

    await act(async () => {
      saveButton()?.click();
      await flushRender();
    });

    await act(async () => {
      const useIncomingButton = Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Use all incoming'));
      useIncomingButton?.click();
      await flushRender();
    });
    await act(async () => {
      saveButton()?.click();
      await flushRender();
    });

    expect(gitWriteConflictResolutionMock).not.toHaveBeenCalled();
    expect(gitAcceptConflictSideMock).toHaveBeenNthCalledWith(1, {
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
      side: 'ours',
    });
    expect(gitAcceptConflictSideMock).toHaveBeenNthCalledWith(2, {
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
      side: 'theirs',
    });
  });

  it('writes an existing empty text file instead of treating it as deletion', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      ours: { ...conflictFile.ours, content: '', sizeBytes: 0 },
      worktree: { ...conflictFile.worktree, content: '<<<<<<< HEAD\n\n=======\ntheirs\n>>>>>>>' },
    }));

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

    const saveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Save resolution'));
    await act(async () => {
      saveButton?.click();
      await flushRender();
    });

    expect(gitWriteConflictResolutionMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
      content: '',
      stage: true,
    });
    expect(gitAcceptConflictSideMock).not.toHaveBeenCalled();
  });

  it('keeps direct side acceptance for non-renderable files', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      isBinary: true,
      ours: { ...conflictFile.ours, content: '', sizeBytes: 3_145_728, isBinary: true },
      theirs: { ...conflictFile.theirs, content: '', sizeBytes: 4_194_304, isBinary: true },
    }));

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

    expect(document.body.querySelector('[data-diff-merge-view="true"]')).toBeNull();
    expect(document.body.textContent).toContain('This is a binary conflict.');
    expect(document.body.textContent).toContain('Current');
    expect(document.body.textContent).toContain('Binary · 3 MB');
    expect(document.body.textContent).toContain('Incoming');
    expect(document.body.textContent).toContain('Binary · 4 MB');

    const useIncomingButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Choose incoming version'));
    await act(async () => {
      useIncomingButton?.click();
      await flushRender();
    });

    expect(gitAcceptConflictSideMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
      side: 'theirs',
    });
  });

  it('presents an oversized text conflict without rendering empty file content', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      tooLarge: true,
      ours: {
        ...conflictFile.ours,
        content: '',
        sizeBytes: 1_500_000,
        tooLarge: true,
      },
      theirs: {
        ...conflictFile.theirs,
        content: '',
        sizeBytes: 1_700_000,
        tooLarge: true,
      },
    }));

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

    expect(document.body.querySelector('[data-diff-merge-view="true"]')).toBeNull();
    expect(document.body.textContent).toContain('This file is too large to edit here.');
    expect(document.body.textContent).toContain('Text');
    expect(document.body.textContent).toContain('over editor limit');

    const chooseCurrentButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Choose current version'));
    await act(async () => {
      chooseCurrentButton?.click();
      await flushRender();
    });

    expect(gitAcceptConflictSideMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
      side: 'ours',
    });
  });

  it('saves the edited resolution draft', async () => {
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

    const editButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton?.click();
      await flushRender();
    });

    const saveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Save resolution'));
    await act(async () => {
      saveButton?.click();
      await flushRender();
    });

    expect(gitWriteConflictResolutionMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      workflowSession: {
        taskId: 'task-1',
        sessionId: 'session-1',
        sourceBranch: 'feature/task',
        targetBranch: 'develop',
      },
      path: 'src/conflict.ts',
      content: 'edited resolution',
      stage: true,
    });
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

  it('confirms abandoning a dirty draft when status removes the selected file after save failure', async () => {
    gitWriteConflictResolutionMock.mockImplementationOnce(async () => {
      throw new Error('save failed');
    });

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

    const editButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton?.click();
      await flushRender();
    });
    const saveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Save resolution'));
    await act(async () => {
      saveButton?.click();
      await flushRender();
    });
    expect(document.body.textContent).toContain('save failed');

    gitStatusMock.mockImplementationOnce(async () => ({
      branch: 'develop',
      is_clean: true,
      conflicted_files: [],
      conflictedFiles: [],
      merge_in_progress: true,
      mergeInProgress: true,
    }));
    const refreshButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Refresh conflicts'));
    await act(async () => {
      refreshButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Discard unsaved changes?');
    expect(document.body.textContent).toContain('Unsaved draft');

    const discardButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Discard changes'));
    await act(async () => {
      discardButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Unsaved draft');
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).toBeNull();
  });
});
