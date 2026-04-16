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
      reviewed: reviewedMain,
      originalContent: 'before();',
      modifiedContent: 'after();',
      language: 'typescript',
      hunks: [],
      contextMode: 'focused',
      canEdit: true,
    },
    {
      id: 'change-2',
      path: 'src/nested/child.ts',
      status: 'added',
      additions: 4,
      deletions: 0,
      reviewed: false,
      originalContent: '',
      modifiedContent: 'export const child = true;',
      language: 'typescript',
      hunks: [],
      contextMode: 'focused',
      canEdit: true,
    },
  ],
  selectedChangeId: 'change-1',
  stats: {
    total: 2,
    reviewed: reviewedMain ? 1 : 0,
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
  let setReviewedStateMock: ReturnType<typeof mock>;
  let loadCurrentChangesMock: ReturnType<typeof mock>;

  const seedStores = (
    repository: ReviewRepositoryState,
    options: { loadState?: 'ready' | 'out_of_scope'; loadMessage?: string | null } = {}
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
          status: 'InReview',
          draft: false,
          project_id: 'project-1',
          assigned_branch: 'feature/review-actions',
          execution_targets: [],
        } as never,
      ],
      branchWorktrees: {},
      startReview: mock(async () => undefined),
      finishTask: mock(async () => undefined),
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
      executionRecords: {},
      loadCurrentChanges: loadCurrentChangesMock,
      resetReviewState: mock(() => undefined),
      selectRepository: mock(() => undefined),
      openDiffModal: mock(() => undefined),
      closeDiffModal: mock(() => undefined),
      setReviewedState: setReviewedStateMock,
      markAllAsReviewed: mock(() => undefined),
      revertChanges: mock(async () => undefined),
      commitReviewedChanges: mock(async () => {
        throw new Error('unused');
      }),
      setCommitMessageDraft: mock(() => undefined),
      getOverallStats: () => repository.stats,
    });
  };

  beforeEach(async () => {
    mock.restore();
    notifySuccessMock = mock(() => undefined);
    notifyErrorMock = mock(() => undefined);
    await loadFileChangesPanelModules();
    setReviewedStateMock = mock(() => undefined);
    loadCurrentChangesMock = mock(async () => undefined);
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

    expect(setReviewedStateMock).toHaveBeenCalled();
  });

  it('renders only invalidate for a fully validated repository scope', async () => {
    const repository = buildRepository(true);
    repository.changes[1] = {
      ...repository.changes[1],
      reviewed: true,
    };
    repository.stats.reviewed = 2;
    seedStores(repository);

    await act(async () => {
      root?.render(<FileChangesPanel />);
      await flushRender();
    });

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const invalidateButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Invalidate');
    const revertButtons = buttons.filter((button) => button.getAttribute('aria-label') === 'Revert');

    expect(invalidateButtons.length).toBeGreaterThan(0);
    expect(revertButtons).toHaveLength(0);
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
