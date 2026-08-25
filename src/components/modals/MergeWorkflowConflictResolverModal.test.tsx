import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MergeWorkflowRepositoryResult } from '../../services/mergeWorkflow';
import type { GitConflictFileDto } from '../../services/tauriIpc';
import type { MergeWorkflowConflictResolverModal as MergeWorkflowConflictResolverModalComponent } from './MergeWorkflowConflictResolverModal';

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

const buildRepository = (
  overrides: Partial<MergeWorkflowRepositoryResult> = {}
): MergeWorkflowRepositoryResult => ({
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
      path: 'src/conflict.ts',
    });
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).not.toBeNull();
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
      worktree: { exists: true, content: 'manual clean resolution' },
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
      worktree: { exists: true, content: 'manual clean resolution' },
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

  it('keeps direct side acceptance for non-renderable files', async () => {
    gitReadConflictFileMock.mockImplementation(async () => ({
      ...conflictFile,
      isBinary: true,
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

    const useIncomingButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Use all incoming'));
    await act(async () => {
      useIncomingButton?.click();
      await flushRender();
    });

    expect(gitAcceptConflictSideMock).toHaveBeenCalledWith({
      repoPath: '/repos/project',
      path: 'src/conflict.ts',
      side: 'theirs',
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
});
