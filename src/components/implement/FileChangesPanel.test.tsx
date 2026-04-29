import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileChangesPanel as FileChangesPanelComponent } from './FileChangesPanel';
import type { useAppStore as UseAppStoreHook } from '../../stores/useAppStore';
import type { useTaskStore as UseTaskStoreHook } from '../../stores/useTaskStore';
import {
  type ReviewRepositoryState,
} from '../../stores/useFileChangesStore';
import type { useFileChangesStore as UseFileChangesStoreHook } from '../../stores/useFileChangesStore';
import { buildReviewTaskSummary } from '../../services/implementMultiRepoSummary';

let FileChangesPanel!: typeof FileChangesPanelComponent;
let useAppStore!: typeof UseAppStoreHook;
let useTaskStore!: typeof UseTaskStoreHook;
let useFileChangesStore!: typeof UseFileChangesStoreHook;
let initialAppState: ReturnType<typeof useAppStore.getState> | null = null;
let initialTaskState: ReturnType<typeof useTaskStore.getState> | null = null;
let initialFileChangesState: ReturnType<typeof useFileChangesStore.getState> | null = null;
let notifySuccessMock: ReturnType<typeof mock>;
let notifyErrorMock: ReturnType<typeof mock>;
let notifyActionRequiredMock: ReturnType<typeof mock>;
let importCounter = 0;
let resizeObserverWidth = 640;

class ResizeObserverTestMock {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    Object.defineProperty(target, 'clientWidth', {
      configurable: true,
      value: resizeObserverWidth,
    });
    Object.defineProperty(target, 'clientHeight', {
      configurable: true,
      value: 720,
    });
    this.callback([
      {
        target,
        contentRect: {
          width: resizeObserverWidth,
          height: 720,
        },
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}
}

const loadFileChangesPanelModules = async () => {
  importCounter += 1;

  const tauriWindowModule = await import(
    `../../services/tauriWindow.ts?file-changes-panel-tauri-window-test=${importCounter}`
  );
  mock.module('../../services/tauriWindow', () => ({
    ...tauriWindowModule,
  }));
  mock.module('../../services/tauriWindow.ts', () => ({
    ...tauriWindowModule,
  }));

  const preferencesModule = await import(
    `../../services/preferences.ts?file-changes-panel-preferences-test=${importCounter}`
  );
  mock.module('../../services/preferences', () => ({
    ...preferencesModule,
  }));

  const appStoreModule = await import(
    `../../stores/useAppStore.ts?file-changes-panel-app-store-test=${importCounter}`
  );
  mock.module('../../stores/useAppStore', () => ({
    ...appStoreModule,
  }));

  const taskStoreModule = await import(
    `../../stores/useTaskStore.ts?file-changes-panel-task-store-test=${importCounter}`
  );
  mock.module('../../stores/useTaskStore', () => ({
    ...taskStoreModule,
  }));

  const fileChangesStoreModule = await import(
    `../../stores/useFileChangesStore.ts?file-changes-panel-store-test=${importCounter}`
  );
  mock.module('../../stores/useFileChangesStore', () => ({
    ...fileChangesStoreModule,
  }));

  const fileChangesDiffModalModule = await import(
    `../modals/FileChangesDiffModal.tsx?file-changes-panel-diff-modal-test=${importCounter}`
  );
  mock.module('../modals/FileChangesDiffModal', () => ({
    ...fileChangesDiffModalModule,
  }));

  mock.module('../ui/toastService', () => ({
    notify: {
      success: (...args: unknown[]) => notifySuccessMock(...args),
      error: (...args: unknown[]) => notifyErrorMock(...args),
      info: mock(() => undefined),
      warning: mock(() => undefined),
      actionRequired: (...args: unknown[]) => notifyActionRequiredMock(...args),
    },
  }));

  ({ FileChangesPanel } = await import(`./FileChangesPanel.tsx?file-changes-panel-test=${importCounter}`));
  ({ useAppStore } = appStoreModule);
  ({ useTaskStore } = taskStoreModule);
  ({ useFileChangesStore } = fileChangesStoreModule);
  initialAppState = useAppStore.getState();
  initialTaskState = useTaskStore.getState();
  initialFileChangesState = useFileChangesStore.getState();
};

const buildRepository = (reviewedMain: boolean): ReviewRepositoryState => ({
  id: 'repo-1',
  projectId: 'project-1',
  repoPath: '/tmp/repo-1',
  worktreePath: '/tmp/worktree-1',
  branchName: 'feature/review-actions',
  planBranchName: null,
  changes: [
    {
      id: 'change-1',
      path: 'src/main.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      originalContent: 'before();',
      indexContent: reviewedMain ? 'validated();' : 'before();',
      modifiedContent: 'after();',
      language: 'typescript',
      hunks: [],
      contextMode: 'focused',
      canEdit: true,
      hasPendingVisibleChange: true,
      hasValidatedStage: reviewedMain,
      validatedRemovedLineNumbers: reviewedMain ? [1] : [],
      validatedAddedLineNumbers: reviewedMain ? [1] : [],
    },
    {
      id: 'change-2',
      path: 'src/nested/child.ts',
      status: 'added',
      additions: 4,
      deletions: 0,
      originalContent: '',
      indexContent: '',
      modifiedContent: 'export const child = true;',
      language: 'typescript',
      hunks: [],
      contextMode: 'focused',
      canEdit: true,
      hasPendingVisibleChange: true,
      hasValidatedStage: false,
      validatedRemovedLineNumbers: [],
      validatedAddedLineNumbers: [],
    },
  ],
  stagedPaths: reviewedMain ? ['src/main.ts'] : [],
  selectedChangeId: 'change-1',
  stats: {
    pendingVisibleFileCount: 2,
    validatedStagedFileCount: reviewedMain ? 1 : 0,
    additions: 7,
    deletions: 1,
  },
  commitMessageDraft: 'feat: review actions',
  commitState: 'idle',
  loadingChangeId: null,
  savingChangeId: null,
  lastError: null,
  lastCommitHash: null,
});

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('FileChangesPanel', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let stageChangesMock: ReturnType<typeof mock>;
  let unstageChangesMock: ReturnType<typeof mock>;
  let stageAllChangesMock: ReturnType<typeof mock>;
  let stageAllTaskChangesMock: ReturnType<typeof mock>;
  let loadCurrentChangesMock: ReturnType<typeof mock>;
  let finishTaskMock: ReturnType<typeof mock>;
  let commitStagedChangesMock: ReturnType<typeof mock>;
  let commitAllReadyTaskRepositoriesMock: ReturnType<typeof mock>;

  const seedStores = (
    repository: ReviewRepositoryState,
    options: {
      loadState?: 'ready' | 'out_of_scope' | 'awaiting_worktree' | 'invalid_mapping';
      loadMessage?: string | null;
      taskOverrides?: Record<string, unknown>;
      taskStoreOverrides?: Record<string, unknown>;
      executionRecords?: Record<string, import('../../stores/useTaskStore').TaskCompletionRepositoryRecord>;
    } = {}
  ) => {
    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      selectedTaskId: 'task-1',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project One',
          isOpen: true,
          projects: [
            {
              id: 'project-1',
              name: 'Project One',
              mountName: 'project-one',
              path: '/tmp/repo-1',
              isReadOnly: false,
              created_at: '2026-04-08T00:00:00.000Z',
              status: 'active',
              metadata: {
                description: '',
                tags: [],
                team_members: [],
                api_contracts: [],
                dependencies: [],
              },
            },
          ],
        },
      ],
      getProjectById: () => ({
        id: 'project-1',
        name: 'Project One',
        mountName: 'project-one',
        path: '/tmp/repo-1',
        created_at: '2026-04-08T00:00:00.000Z',
        status: 'active',
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      }),
    });

    useTaskStore.setState({
      ...useTaskStore.getState(),
      tasks: [
        {
          id: 'task-1',
          title: 'Review panel actions',
          status: 'InProgress',
          draft: false,
          project_id: 'project-1',
          assigned_branch: 'feature/review-actions',
          execution_targets: [],
          ...options.taskOverrides,
        } as never,
      ],
      branchWorktrees: {},
      finishTask: finishTaskMock,
      loadMergeWorkflowReview: mock(async () => null),
      ...options.taskStoreOverrides,
    });

    loadCurrentChangesMock = mock(async () => undefined);
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      repositories: options.loadState && options.loadState !== 'ready' ? [] : [repository],
      selectedRepositoryId: options.loadState && options.loadState !== 'ready' ? null : repository.id,
      reviewSummary: options.loadState && options.loadState !== 'ready'
        ? buildReviewTaskSummary([], null)
        : buildReviewTaskSummary([repository], repository.id),
      currentTaskLoadState: options.loadState ?? 'ready',
      currentTaskLoadMessage: options.loadMessage ?? null,
      isLoading: false,
      isCommitting: false,
      isDiffModalOpen: false,
      lastError: null,
      executionRecords: options.executionRecords ?? {},
      loadCurrentChanges: loadCurrentChangesMock,
      resetReviewState: mock(() => undefined),
      selectRepository: mock(() => undefined),
      openDiffModal: mock(() => undefined),
      closeDiffModal: mock(() => undefined),
      stageChanges: stageChangesMock,
      unstageChanges: unstageChangesMock,
      stageAllChanges: stageAllChangesMock,
      stageAllTaskChanges: stageAllTaskChangesMock,
      revertChanges: mock(async () => undefined),
      commitStagedChanges: commitStagedChangesMock,
      commitAllReadyTaskRepositories: commitAllReadyTaskRepositoriesMock,
      setCommitMessageDraft: mock(() => undefined),
      getOverallStats: () => repository.stats,
    });
  };

  const buildBlockedMergeWorkflowRuntime = (
    overrides: Partial<{
      blockingKind: 'repository_dirty' | 'merge_conflict' | 'merge_in_progress' | null;
      nextAction: 'clean_repository' | 'resolve_conflicts' | 'finish_or_abort_merge' | null;
      mergeInProgress: boolean;
      conflictFiles: string[];
      blockingReason: string | null;
    }> = {}
  ) => {
    const dirtyRepository = {
      id: 'repo-1',
      projectId: 'project-1',
      repoPath: '/repos/project',
      sourceBranchName: 'feature/review-actions',
      targetBranchName: 'plan/review-actions',
      progressState: 'blocked',
      hadChangesAtStart: true,
      mergeAppliedAt: null,
      isClean: false,
      hasChanges: true,
      ahead: 1,
      behind: 0,
      mergeable: false,
      conflictFiles: [],
      dirtyFiles: [{ path: 'src/local.ts', status: 'modified', area: 'unstaged' }],
      mergeInProgress: false,
      diff: '',
      checkStatus: 'not_run',
      blockingKind: 'repository_dirty',
      nextAction: 'clean_repository',
      blockingReason: 'Cannot continue merge because /repos/project has uncommitted changes.',
      isSourcePublished: false,
      mergeStrategy: 'dirty',
      recommendedAction: 'stash_dirty',
      availableActions: ['stash_dirty', 'revert_dirty', 'assistant', 'retry_check'],
      ...overrides,
    };

    return {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Task 1',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [dirtyRepository],
      blockedRepositories: [dirtyRepository],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };
  };

  beforeEach(async () => {
    mock.restore();
    resizeObserverWidth = 640;
    globalThis.ResizeObserver = ResizeObserverTestMock as unknown as typeof ResizeObserver;
    notifySuccessMock = mock(() => undefined);
    notifyErrorMock = mock(() => undefined);
    notifyActionRequiredMock = mock(() => undefined);
    await loadFileChangesPanelModules();
    stageChangesMock = mock(async () => undefined);
    unstageChangesMock = mock(async () => undefined);
    stageAllChangesMock = mock(async () => undefined);
    stageAllTaskChangesMock = mock(async () => undefined);
    loadCurrentChangesMock = mock(async () => undefined);
    finishTaskMock = mock(async () => undefined);
    commitStagedChangesMock = mock(async () => ({
      hash: 'abc123',
      taskId: 'task-1',
      taskCompleted: false,
      taskStatus: 'InProgress',
      committedRepositoryId: 'repo-1',
      repositories: [],
    }));
    commitAllReadyTaskRepositoriesMock = mock(async () => ({
      taskId: 'task-1',
      taskCompleted: false,
      taskStatus: 'InProgress',
      commits: [
        {
          hash: 'abc123',
          taskId: 'task-1',
          taskCompleted: false,
          taskStatus: 'InProgress',
          committedRepositoryId: 'repo-1',
          repositories: [],
        },
      ],
      repositories: [],
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.setItem('macro_smartCommitModelConfig', JSON.stringify({ mode: 'conversation' }));
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    root = null;
    container = null;
    if (initialAppState) {
      useAppStore.setState(initialAppState, true);
    }
    if (initialTaskState) {
      useTaskStore.setState(initialTaskState, true);
    }
    if (initialFileChangesState) {
      useFileChangesStore.setState(initialFileChangesState, true);
    }
    delete process.env.VITE_BACKEND_TRANSPORT;
    delete process.env.VITE_DATA_PROVIDER;
    window.localStorage.removeItem('macro_smartCommitModelConfig');
    mock.restore();
  });

  it('renders validate and revert actions for pending scopes', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const validateButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Validate');
    const revertButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Revert');

    expect(validateButtons.length).toBeGreaterThan(0);
    expect(revertButtons.length).toBeGreaterThan(0);
    expect(document.body.querySelectorAll('[data-pending-validation-indicator="true"]').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('{{pending}}');
    expect(document.body.textContent).not.toContain('{{validated}}');

    await act(async () => {
      validateButtons[0]?.click();
      await flushRender();
    });

    expect(stageChangesMock).toHaveBeenCalled();
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('hides scope actions once only staged changes remain', async () => {
    const repository = buildRepository(true);
    repository.changes = repository.changes.map((change) => ({
      ...change,
      indexContent: change.modifiedContent,
      hasPendingVisibleChange: false,
      hasValidatedStage: true,
    }));
    repository.stagedPaths = ['src/main.ts', 'src/nested/child.ts'];
    repository.selectedChangeId = 'change-1';
    repository.stats = {
      pendingVisibleFileCount: 0,
      validatedStagedFileCount: 2,
      additions: 0,
      deletions: 0,
    };
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const validateButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Validate');
    const revertButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Revert');
    const unstageButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Unstage');

    expect(validateButtons).toHaveLength(0);
    expect(revertButtons).toHaveLength(0);
    expect(unstageButtons.length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('main.ts');
    expect(document.body.textContent).toContain('child.ts');
    expect(document.body.querySelectorAll('[data-pending-validation-indicator="true"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('validated file(s) staged and ready to commit');
    expect(document.body.textContent).not.toContain('All visible changes are already validated');

    await act(async () => {
      unstageButtons[0]?.click();
      await flushRender();
    });

    expect(unstageChangesMock).toHaveBeenCalled();
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('validates the current diff state without moving the task into a review status', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const validateButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Validate changes');
    expect(validateButton).toBeDefined();
    loadCurrentChangesMock.mockClear();

    await act(async () => {
      validateButton?.click();
      await flushRender();
    });

    expect(stageAllTaskChangesMock).toHaveBeenCalledTimes(1);
    expect(stageAllChangesMock).not.toHaveBeenCalled();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0]?.status).toBe('InProgress');
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('keeps Commit as the primary action while a repository is ready to commit', async () => {
    const repository = buildRepository(true);
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttonTexts = Array.from(document.body.querySelectorAll('button'))
      .map((button) => button.textContent?.trim())
      .filter((value): value is string => Boolean(value));

    expect(buttonTexts).toContain('Commit');
    expect(buttonTexts).not.toContain('Finish task');

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(commitStagedChangesMock).not.toHaveBeenCalled();
  });

  it('asks for the smart commit model choice the first time a commit is generated', async () => {
    window.localStorage.removeItem('macro_smartCommitModelConfig');
    const repository = buildRepository(true);
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Choose commit message model');
    expect(document.body.textContent).toContain('Conversation model');
    expect(commitAllReadyTaskRepositoriesMock).not.toHaveBeenCalled();

    const continueButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Continue');
    expect(continueButton).toBeDefined();

    await act(async () => {
      continueButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('macro_smartCommitModelConfig')).toContain('conversation');
  });

  it('shows the backend commit error message when the commit rejects with an object payload', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      throw { message: 'Backend exploded' };
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(notifyErrorMock).toHaveBeenCalledWith('Backend exploded');
    expect(notifyErrorMock).not.toHaveBeenCalledWith('[object Object]');
  });

  it('shows a retry modal when commit message generation fails', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('model unavailable');
      error.name = 'SmartCommitMessageGenerationError';
      throw error;
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Couldn’t generate commit messages');
    expect(document.body.textContent).toContain('Retry');
    expect(document.body.textContent).toContain('Cancel');
    expect(notifyErrorMock).not.toHaveBeenCalled();

    const retryButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton?.click();
      await flushRender();
    });

    expect(commitAllReadyTaskRepositoriesMock).toHaveBeenCalledTimes(2);
  });

  it('shows structured commit message editing when generated fields are invalid', async () => {
    const repository = buildRepository(true);
    commitAllReadyTaskRepositoriesMock = mock(async () => {
      const error = new Error('Commit type must be one of: feat, fix, perf, build, chore, ci, docs, refactor, style, test, revert');
      error.name = 'SmartCommitMessageGenerationError';
      Object.assign(error, {
        generatedMessages: {
          repositories: [
            {
              repositoryId: repository.id,
              type: 'release',
              scope: 'project-one',
              subject: 'update generated messages',
              body: null,
            },
          ],
        },
      });
      throw error;
    });
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const commitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Commit');
    expect(commitButton).toBeDefined();

    await act(async () => {
      commitButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Review commit messages');
    expect(document.body.textContent).toContain('Type');
    expect(document.body.textContent).toContain('Subject');
    expect(document.body.textContent).toContain('Body');
    expect(document.body.textContent).toContain('Commit type must be one of');
    const modalCommitButton = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Commit')
      .at(-1) as HTMLButtonElement | undefined;
    expect(modalCommitButton?.disabled).toBe(true);
  });

  it('switches the primary action to Finish task once the task is fully resolved', async () => {
    const repository: ReviewRepositoryState = {
      ...buildRepository(true),
      id: 'project-1::repo-1',
      changes: [],
      selectedChangeId: null,
      stats: {
        pendingVisibleFileCount: 0,
        validatedStagedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
      stagedPaths: [],
      commitState: 'committed',
    };
    seedStores(repository, {
      taskOverrides: {
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            worktreeKey: 'repo-1',
          },
        ],
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const buttonTexts = buttons
      .map((button) => button.textContent?.trim())
      .filter((value): value is string => Boolean(value));

    expect(buttonTexts).toContain('Finish task');
    expect(buttonTexts).not.toContain('Commit');

    const finishButton = buttons.find((button) => button.textContent?.trim() === 'Finish task');
    expect(finishButton).toBeDefined();

    await act(async () => {
      finishButton?.click();
      await flushRender();
    });

    expect(finishTaskMock).toHaveBeenCalledWith('task-1');
    expect(commitStagedChangesMock).not.toHaveBeenCalled();
    expect(commitAllReadyTaskRepositoriesMock).not.toHaveBeenCalled();
  });

  it('renders the dedicated plan finalization panel instead of loading file changes', async () => {
    const repository = buildRepository(false);
    const planFinalizationRuntime = {
      taskId: 'task-1',
      kind: 'plan_finalization',
      phase: 'ready',
      taskStatus: 'Pending',
      review: {
        taskId: 'task-1',
        title: 'Finalize plan: Checkout refresh',
        taskSource: 'plan_finalization',
        planId: 'plan-1',
        planTitle: 'Checkout refresh',
        targetBranch: 'develop',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'plan/checkout-refresh',
          targetBranchName: 'develop',
          isClean: true,
          hasChanges: true,
          mergeable: true,
          conflictFiles: [],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'passed',
          blockingKind: null,
          nextAction: null,
          blockingReason: null,
        },
      ],
      blockedRepositories: [],
      message: null,
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };
    const loadPlanFinalizationReviewMock = mock(async () => planFinalizationRuntime);
    seedStores(repository, {
      taskOverrides: {
        title: 'Finalize plan: Checkout refresh',
        description: 'Merge the plan branch into the configured development branches or archive the plan.',
        task_source: 'plan_finalization',
        plan_id: 'plan-1',
        assigned_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'develop',
            targetBranchName: 'develop',
            executionKind: 'repository_root',
            worktreeKey: 'plan-finalization:project-1:project-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? planFinalizationRuntime : null,
        loadMergeWorkflowReview: loadPlanFinalizationReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        archivePlanFromTask: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-plan-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Plan finalization');
    expect(document.body.textContent).toContain('Merge plan');
    expect(document.body.textContent).toContain('Archive');
    expect(loadPlanFinalizationReviewMock).not.toHaveBeenCalled();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('renders the merge workflow panel for a normal task with merge blockers', async () => {
    const mergeWorkflowRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Review panel actions',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      blockedRepositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Merge workflow');
    expect(document.body.querySelector('[data-merge-workflow-layout="wide"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-repository-sidebar="true"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-repository-rail="true"]')).toBeNull();
    expect(document.body.textContent).toContain('Retry merge');
    expect(document.body.textContent).toContain('Resolve automatically');
    expect(document.body.textContent).toContain('Conflict files');
    expect(document.body.textContent).not.toContain('Resolve the repository blockers before retrying the merge.');
    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Resolve these conflicts before finishing',
      expect.objectContaining({
        category: 'task_attention_required',
        notificationKey: expect.stringContaining('merge-workflow-blocker:task-1:repo-1'),
      })
    );
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('does not reload the merge review again while it is already loading', async () => {
    const loadMergeWorkflowReviewMock = mock(async () => null);
    const loadingRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'loading_review',
      taskStatus: 'InProgress',
      review: null,
      repositories: [],
      blockedRepositories: [],
      message: null,
      lastLoadedAt: null,
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? loadingRuntime : null,
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Loading merge review...');
    expect(loadMergeWorkflowReviewMock).not.toHaveBeenCalled();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('asks before stashing dirty merge blockers automatically', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime();

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local changes need attention');
    expect(resolveMergeWorkflowAutomaticallyMock).not.toHaveBeenCalled();

    const stashButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Stash and retry'));

    await act(async () => {
      stashButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'stash_dirty',
    });
  });

  it('asks before fast-forwarding ready merge repositories', async () => {
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = {
      ...buildBlockedMergeWorkflowRuntime(),
      phase: 'ready',
      taskStatus: 'InProgress',
      blockedRepositories: [],
      message: null,
    };
    mergeWorkflowRuntime.repositories = [
      {
        ...mergeWorkflowRuntime.repositories[0],
        progressState: 'pending',
        isClean: true,
        mergeable: true,
        blockingKind: null,
        nextAction: null,
        blockingReason: null,
        dirtyFiles: [],
        mergeStrategy: 'fast_forward_available',
        recommendedAction: 'fast_forward',
        availableActions: ['fast_forward', 'merge_commit'],
      },
    ];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: mock(async () => ({
          conversationId: null,
          autoResolvedRepositoryCount: 0,
          remainingBlockedRepositoryCount: 0,
        })),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const chooseButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Choose merge strategy'));

    await act(async () => {
      chooseButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Fast-forward available');

    const fastForwardButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Fast-forward and continue'));

    await act(async () => {
      fastForwardButton?.click();
      await flushRender();
    });

    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1', {
      mergeStrategyAction: 'fast_forward',
    });
  });

  it('opens the assistant when a rebase strategy fails', async () => {
    const runMergeWorkflowMock = mock(async () => {
      throw new Error('rebase conflict');
    });
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: 'conversation-1',
      autoResolvedRepositoryCount: 0,
      remainingBlockedRepositoryCount: 1,
    }));
    const mergeWorkflowRuntime = {
      ...buildBlockedMergeWorkflowRuntime(),
      phase: 'ready',
      taskStatus: 'InProgress',
      blockedRepositories: [],
      message: null,
    };
    mergeWorkflowRuntime.repositories = [
      {
        ...mergeWorkflowRuntime.repositories[0],
        progressState: 'pending',
        isClean: true,
        mergeable: true,
        blockingKind: null,
        nextAction: null,
        blockingReason: null,
        dirtyFiles: [],
        mergeStrategy: 'rebase_available',
        recommendedAction: 'rebase_then_continue',
        availableActions: ['rebase_then_continue', 'merge_commit', 'assistant'],
        isSourcePublished: false,
      },
    ];

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const chooseButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Choose merge strategy'));

    await act(async () => {
      chooseButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Rebase available');

    const rebaseButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Rebase then continue'));

    await act(async () => {
      rebaseButton?.click();
      await flushRender();
    });

    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1', {
      mergeStrategyAction: 'rebase_then_continue',
    });
    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'assistant',
    });
  });

  it('offers revert for dirty merge blockers', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime();

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    const revertButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Revert and retry'));

    await act(async () => {
      revertButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'revert_dirty',
    });
  });

  it('asks before stashing dirty merge blockers from retry merge and then retries', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime();

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local changes need attention');
    expect(resolveMergeWorkflowAutomaticallyMock).not.toHaveBeenCalled();
    expect(runMergeWorkflowMock).not.toHaveBeenCalled();

    const stashButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Stash and retry'));

    await act(async () => {
      stashButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'stash_dirty',
    });
    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1');
  });

  it('asks before aborting an in-progress merge from retry merge and then retries', async () => {
    const resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 1,
      remainingBlockedRepositoryCount: 0,
    }));
    const runMergeWorkflowMock = mock(async () => undefined);
    const mergeWorkflowRuntime = buildBlockedMergeWorkflowRuntime({
      blockingKind: 'merge_in_progress',
      nextAction: 'finish_or_abort_merge',
      mergeInProgress: true,
      blockingReason: 'Cannot continue merge because /repos/project already has a merge in progress.',
    });

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: runMergeWorkflowMock,
        resolveMergeWorkflowAutomatically: resolveMergeWorkflowAutomaticallyMock,
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const resolveButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Resolve'));

    await act(async () => {
      resolveButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('A merge is already in progress');
    expect(resolveMergeWorkflowAutomaticallyMock).not.toHaveBeenCalled();
    expect(runMergeWorkflowMock).not.toHaveBeenCalled();

    const abortButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Abort merge and retry'));

    await act(async () => {
      abortButton?.click();
      await flushRender();
    });

    expect(resolveMergeWorkflowAutomaticallyMock).toHaveBeenCalledWith('task-1', {
      blockerResolutionAction: 'abort_merge',
    });
    expect(runMergeWorkflowMock).toHaveBeenCalledWith('task-1');
  });

  it('loads the merge review once when an existing runtime has no review yet', async () => {
    const loadMergeWorkflowReviewMock = mock(async () => null);
    const idleRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'idle',
      taskStatus: 'InProgress',
      review: null,
      repositories: [],
      blockedRepositories: [],
      message: null,
      lastLoadedAt: null,
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'InProgress',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? idleRuntime : null,
        loadMergeWorkflowReview: loadMergeWorkflowReviewMock,
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledTimes(1);
    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledWith('task-1');
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
  });

  it('stacks the merge workflow repository selector above the diff in compact width', async () => {
    resizeObserverWidth = 360;
    const mergeWorkflowRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Review panel actions',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      blockedRepositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: 'diff --git a/src/main.ts b/src/main.ts',
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.querySelector('[data-merge-workflow-layout="compact"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-repository-rail="true"]')).not.toBeNull();
    expect(document.body.querySelector('[data-merge-repository-sidebar="true"]')).toBeNull();
    expect(document.body.textContent).toContain('Retry merge');
    expect(document.body.textContent).toContain('Resolve automatically');
    expect(document.body.textContent).toContain('Conflict files');
    expect(document.body.textContent).not.toContain('Resolve the repository blockers before retrying the merge.');
    expect(notifyActionRequiredMock).toHaveBeenCalledWith(
      'Resolve these conflicts before finishing',
      expect.objectContaining({
        category: 'task_attention_required',
        notificationKey: expect.stringContaining('merge-workflow-blocker:task-1:repo-1'),
      })
    );
  });

  it('shows a lightweight preview instead of rendering very large merge diffs', async () => {
    const largeDiff = `${'diff --git a/src/main.ts b/src/main.ts\n'.repeat(4000)}END-OF-LARGE-DIFF`;
    const mergeWorkflowRuntime = {
      taskId: 'task-1',
      kind: 'task_completion',
      phase: 'blocked',
      taskStatus: 'Blocked',
      review: {
        taskId: 'task-1',
        title: 'Review panel actions',
        taskSource: 'architect',
        planId: 'plan-1',
        planTitle: 'Plan 1',
        targetBranch: 'plan/review-actions',
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: largeDiff,
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      blockedRepositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          sourceBranchName: 'feature/review-actions',
          targetBranchName: 'plan/review-actions',
          isClean: true,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/main.ts'],
          mergeInProgress: false,
          diff: largeDiff,
          checkStatus: 'failed',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot continue merge because /tmp/repo-1 would conflict in: src/main.ts.',
        },
      ],
      message: 'Resolve the repository blockers before retrying the merge.',
      lastLoadedAt: '2026-04-22T10:00:00.000Z',
    };

    seedStores(buildRepository(false), {
      taskOverrides: {
        task_source: 'architect',
        status: 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan 1',
        plan_target_branch: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/review-actions',
            planBranchName: 'plan/review-actions',
            executionKind: 'worktree',
            worktreeKey: 'repo-1',
          },
        ],
      },
      taskStoreOverrides: {
        getMergeWorkflowRuntime: (taskId: string) =>
          taskId === 'task-1' ? mergeWorkflowRuntime : null,
        loadMergeWorkflowReview: mock(async () => mergeWorkflowRuntime),
        runMergeWorkflow: mock(async () => undefined),
        resolveMergeWorkflowAutomatically: mock(async () => 'conversation-task-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Diff too large to render fully. Showing a preview.');
    expect(document.body.textContent).not.toContain('END-OF-LARGE-DIFF');
    expect(document.body.textContent).toContain('Retry merge');
    expect(document.body.textContent).toContain('Resolve automatically');
  });

  it('renders the scoped empty-state message when the task is outside the current repository scope', async () => {
    seedStores(buildRepository(false), {
      loadState: 'out_of_scope',
      loadMessage: 'This task has no changes in Project One.',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('This task has no changes in Project One.');
    expect(document.body.textContent).not.toContain('No pending file changes for this task yet.');
  });

  it('renders an actionable callout when the task worktree is not ready', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage:
        'Cannot create a task worktree for feature/demo because that branch is still checked out in the primary repository and has uncommitted changes',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).toContain('Commit, stash, or discard');
    expect(document.body.textContent).toContain('Retry');
  });

  it('renders a plain empty state for a manual feature draft without a prompt', async () => {
    seedStores(buildRepository(false), {
      loadState: 'awaiting_worktree',
      loadMessage: 'Make your first changes to this task to see them here.',
      taskOverrides: {
        status: 'Pending',
        draft: true,
        task_source: 'standalone',
        standalone_kind: 'manual_feature',
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Make your first changes to this task to see them here.');
    expect(document.body.textContent).not.toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).not.toContain('Retry');
  });

  it('reloads repository changes when the focused subproject changes', async () => {
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    loadCurrentChangesMock.mockClear();

    await act(async () => {
      useAppStore.setState({
        ...useAppStore.getState(),
        selectedProjectId: 'project-1',
      });
      await flushRender();
    });

    expect(loadCurrentChangesMock).toHaveBeenCalledTimes(1);
  });

  it('loads changes when only a focused subproject is selected', async () => {
    seedStores(buildRepository(false));
    loadCurrentChangesMock.mockClear();

    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: null,
      selectedProjectId: 'project-1',
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(loadCurrentChangesMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Select a project to view changes');
  });

  it('renders a read-only remote empty state and hides validation actions in remote mode', async () => {
    process.env.VITE_BACKEND_TRANSPORT = 'remote';
    seedStores(buildRepository(false));

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Local validation is not available in remote mode yet.');
    expect(document.body.textContent).toContain('This action is not available in remote mode yet.');
    expect(document.body.textContent).not.toContain('Validate changes');
    expect(document.body.textContent).not.toContain('Commit');
    expect(document.body.textContent).not.toContain('Finish task');
    expect(document.querySelector('[aria-label="Validate"]')).toBeNull();
    expect(document.querySelector('[aria-label="Revert"]')).toBeNull();
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });
});
