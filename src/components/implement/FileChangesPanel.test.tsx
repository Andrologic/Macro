import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileChangesPanel } from './FileChangesPanel';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useFileChangesStore, type ReviewRepositoryState } from '../../stores/useFileChangesStore';
import { buildReviewTaskSummary } from '../../services/implementMultiRepoSummary';

const initialAppState = useAppStore.getState();
const initialTaskState = useTaskStore.getState();
const initialFileChangesState = useFileChangesStore.getState();

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

  const seedStores = (repository: ReviewRepositoryState) => {
    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: 'group-1',
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

    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      repositories: [repository],
      selectedRepositoryId: repository.id,
      reviewSummary: buildReviewTaskSummary([repository], repository.id),
      currentTaskLoadState: 'ready',
      currentTaskLoadMessage: null,
      isLoading: false,
      isCommitting: false,
      isDiffModalOpen: false,
      lastError: null,
      loadCurrentChanges: mock(async () => undefined),
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

  beforeEach(() => {
    setReviewedStateMock = mock(() => undefined);
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
    useAppStore.setState(initialAppState, true);
    useTaskStore.setState(initialTaskState, true);
    useFileChangesStore.setState(initialFileChangesState, true);
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
});
