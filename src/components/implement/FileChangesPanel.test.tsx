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
let importCounter = 0;

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
  let stageAllChangesMock: ReturnType<typeof mock>;
  let loadCurrentChangesMock: ReturnType<typeof mock>;
  let finishTaskMock: ReturnType<typeof mock>;
  let commitStagedChangesMock: ReturnType<typeof mock>;

  const seedStores = (
    repository: ReviewRepositoryState,
    options: {
      loadState?: 'ready' | 'out_of_scope';
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
      ...options.taskStoreOverrides,
    });

    loadCurrentChangesMock = mock(async () => undefined);
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      repositories: options.loadState === 'out_of_scope' ? [] : [repository],
      selectedRepositoryId: options.loadState === 'out_of_scope' ? null : repository.id,
      reviewSummary: options.loadState === 'out_of_scope'
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
      stageAllChanges: stageAllChangesMock,
      revertChanges: mock(async () => undefined),
      commitStagedChanges: commitStagedChangesMock,
      setCommitMessageDraft: mock(() => undefined),
      getOverallStats: () => repository.stats,
    });
  };

  beforeEach(async () => {
    mock.restore();
    notifySuccessMock = mock(() => undefined);
    notifyErrorMock = mock(() => undefined);
    await loadFileChangesPanelModules();
    stageChangesMock = mock(async () => undefined);
    stageAllChangesMock = mock(async () => undefined);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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

    await act(async () => {
      validateButtons[0]?.click();
      await flushRender();
    });

    expect(stageChangesMock).toHaveBeenCalled();
  });

  it('hides scope actions once only staged changes remain', async () => {
    const repository = buildRepository(true);
    repository.changes = [];
    repository.stagedPaths = ['src/main.ts', 'src/nested/child.ts'];
    repository.selectedChangeId = null;
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

    expect(validateButtons).toHaveLength(0);
    expect(revertButtons).toHaveLength(0);
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

    expect(stageAllChangesMock).toHaveBeenCalledWith('repo-1');
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0]?.status).toBe('InProgress');
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
  });

  it('shows the backend commit error message when the commit rejects with an object payload', async () => {
    const repository = buildRepository(true);
    commitStagedChangesMock = mock(async () => {
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
  });

  it('renders the dedicated plan finalization panel instead of loading file changes', async () => {
    const repository = buildRepository(false);
    const planFinalizationRuntime = {
      planId: 'plan-1',
      branchName: 'develop',
      phase: 'ready',
      taskStatus: 'Pending',
      review: {
        plan: {
          id: 'plan-1',
          targetBranch: 'develop',
        },
        tasks: [],
        repositories: [
          {
            id: 'repo-1',
            projectId: 'project-1',
            repoPath: '/tmp/repo-1',
            planBranchName: 'plan/checkout-refresh',
            baseBranchName: 'develop',
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
      },
      repositories: [
        {
          id: 'repo-1',
          projectId: 'project-1',
          repoPath: '/tmp/repo-1',
          planBranchName: 'plan/checkout-refresh',
          baseBranchName: 'develop',
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
        getPlanFinalizationRuntime: (planId: string) =>
          planId === 'plan-1' ? planFinalizationRuntime : null,
        loadPlanFinalizationReview: loadPlanFinalizationReviewMock,
        finalizePlan: mock(async () => undefined),
        archivePlanFromTask: mock(async () => undefined),
        resolvePlanFinalizationAutomatically: mock(async () => 'conversation-plan-1'),
      },
    });

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Plan finalization');
    expect(document.body.textContent).toContain('Merge plan');
    expect(document.body.textContent).toContain('Archive');
    expect(loadPlanFinalizationReviewMock).toHaveBeenCalledWith('plan-1');
    expect(loadCurrentChangesMock).not.toHaveBeenCalled();
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
