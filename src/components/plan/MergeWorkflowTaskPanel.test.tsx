import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MergeWorkflowRepositoryResult,
  MergeWorkflowRuntimeState,
} from '../../services/mergeWorkflow';
import type { ImplementTask } from '../../stores/useTaskStore';
import type { TaskStatus } from '../../types';
import type { MergeWorkflowTaskPanel as MergeWorkflowTaskPanelComponent } from './MergeWorkflowTaskPanel';

const taskId = 'task-a';
const repositoryId = 'repo-a';

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const repository: MergeWorkflowRepositoryResult = {
  id: repositoryId,
  projectId: 'project-a',
  repoPath: '/repos/project-a',
  repositoryRootPath: '/repos/project-a',
  integrationWorktreePath: null,
  sourceBranchName: 'feature/task-a',
  targetBranchName: 'develop',
  progressState: 'blocked' as const,
  hadChangesAtStart: true,
  mergeAppliedAt: null,
  isClean: false,
  hasChanges: true,
  ahead: 1,
  behind: 0,
  mergeable: false,
  conflictFiles: ['src/conflict.ts'],
  dirtyFiles: [],
  mergeInProgress: true,
  diff: '',
  checkStatus: 'failed' as const,
  blockingKind: 'merge_conflict' as const,
  nextAction: 'resolve_conflicts' as const,
  blockingReason: 'The merge has file conflicts.',
  isSourcePublished: false,
  mergeStrategy: 'file_conflict' as const,
  recommendedAction: 'assistant' as const,
  availableActions: ['assistant', 'retry_check'],
};

const runtime = (currentTaskId: string): MergeWorkflowRuntimeState => ({
  taskId: currentTaskId,
  kind: 'task_completion',
  phase: 'blocked',
  taskStatus: 'Blocked' as TaskStatus,
  review: {
    taskId: currentTaskId,
    title: currentTaskId,
    taskSource: 'standalone',
    targetBranch: 'develop',
  },
  repositories: [repository],
  blockedRepositories: [repository],
  message: null,
  lastLoadedAt: null,
});

const task = (id: string): ImplementTask => ({
  id,
  plan_id: 'plan-a',
  project_id: 'project-a',
  title: id,
  description: '',
  status: 'Blocked',
  dependencies: [],
  estimated_changes: [],
  task_source: 'standalone',
  draft: false,
  standalone_kind: 'legacy',
  plan_title: null,
  plan_status: null,
  plan_storage_branch: null,
  plan_target_branch: 'develop',
  plan_target_branches_by_project_id: null,
  has_mixed_target_branches: false,
  base_branch: 'develop',
  feature_slug: 'task-a',
  conversation_id: null,
  archived_at: null,
  archive_reason: null,
  merged_at: null,
  assigned_branch: 'feature/task-a',
  branch_name: 'feature/task-a',
  branch_id: 'branch-task-a',
  branch_task_index: 0,
  blocked_by_task_ids: [],
  blocked_by: [],
  is_blocked: true,
  is_ready: false,
  needs_revalidation: false,
  sequence_index: 0,
  execution_targets: [],
});

let assistantPhase: 'idle' | 'streaming' = 'idle';
let currentRuntimeByTaskId: Record<string, MergeWorkflowRuntimeState> = {
  [taskId]: runtime(taskId),
};
let loadMergeWorkflowReviewMock = mock(async () => null);
let resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
  conversationId: null,
  autoResolvedRepositoryCount: 0,
  remainingBlockedRepositoryCount: 1,
}));

const taskStoreState = {
  getMergeWorkflowRuntime: (id: string) => currentRuntimeByTaskId[id] ?? null,
  loadMergeWorkflowReview: (...args: Parameters<typeof loadMergeWorkflowReviewMock>) =>
    loadMergeWorkflowReviewMock(...args),
  runMergeWorkflow: mock(async () => undefined),
  archivePlanFromTask: mock(async () => undefined),
  resolveMergeWorkflowAutomatically: (...args: Parameters<typeof resolveMergeWorkflowAutomaticallyMock>) =>
    resolveMergeWorkflowAutomaticallyMock(...args),
  abortMergeWorkflowManualResolution: mock(async () => undefined),
};

let MergeWorkflowTaskPanel!: typeof MergeWorkflowTaskPanelComponent;
let importCounter = 0;

const registerMocks = () => {
  mock.module('../../stores/useTaskStore', () => ({
    useTaskStore: (selector: (state: typeof taskStoreState) => unknown) => selector(taskStoreState),
  }));

  mock.module('../../stores/useChatStore', () => ({
    useChatStore: (selector: (state: unknown) => unknown) => selector({
      conversations: [{ id: 'conversation-a', scope_mode: 'Implement', task_id: taskId }],
      conversationRuntimeById: {
        'conversation-a': {
          phase: assistantPhase,
        },
      },
    }),
  }));

  mock.module('../../services/mergeWorkflow', () => ({
    isMergeWorkflowFileConflictRepository: (value: typeof repository) =>
      value.mergeStrategy === 'file_conflict' && value.conflictFiles.length > 0,
    isMergeWorkflowStagedResolutionRepository: () => false,
    resolveMergeWorkflowViewState: () => ({
      isLoading: false,
      isBlocked: true,
      isFailed: false,
      isBusy: false,
      canArchive: false,
      canMerge: false,
      canRetry: true,
      canResolveAutomatically: true,
    }),
  }));

  mock.module('../../services/degradedErrorPresentation', () => ({
    presentGitFlowBlockingIssue: () => ({
      title: 'Merge blocked',
      body: 'The merge has file conflicts.',
      nextStep: 'Resolve the conflicts.',
      severity: 'danger',
    }),
    resolveDegradedErrorPresentation: (value: unknown) => value,
  }));

  mock.module('../../hooks/useElementSize', () => ({
    useElementSize: () => ({ ref: () => undefined, width: 800 }),
  }));

  mock.module('../modals/MergeWorkflowConflictResolverModal', () => ({
    MergeWorkflowConflictResolverModal: () => React.createElement('div', null, 'Conflict resolver'),
  }));

  mock.module('../ui/toastService', () => ({
    notify: {
      success: mock(() => undefined),
      error: mock(() => undefined),
      actionRequired: mock(() => undefined),
    },
  }));
};

const loadPanel = async () => {
  mock.restore();
  registerMocks();
  importCounter += 1;
  ({ MergeWorkflowTaskPanel } = await import(
    `./MergeWorkflowTaskPanel.tsx?merge-workflow-task-panel-test=${importCounter}`
  ));
};

const flushRender = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const renderPanel = async (root: Root, id = taskId) => {
  await act(async () => {
    root.render(<MergeWorkflowTaskPanel task={task(id)} />);
    await flushRender();
  });
};

const clickResolveWithAi = async () => {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes('Resolve with AI'));
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await flushRender();
  });
};

describe('MergeWorkflowTaskPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    assistantPhase = 'idle';
    currentRuntimeByTaskId = {
      [taskId]: runtime(taskId),
      'task-b': runtime('task-b'),
    };
    loadMergeWorkflowReviewMock = mock(async () => null);
    resolveMergeWorkflowAutomaticallyMock = mock(async () => ({
      conversationId: null,
      autoResolvedRepositoryCount: 0,
      remainingBlockedRepositoryCount: 1,
    }));
    await loadPanel();
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

  it('moves ai_resolving to checking_resolution and clears it after a successful review', async () => {
    const automaticResolution = createDeferred<{
      conversationId: null;
      autoResolvedRepositoryCount: number;
      remainingBlockedRepositoryCount: number;
    }>();
    const review = createDeferred<null>();
    resolveMergeWorkflowAutomaticallyMock.mockImplementationOnce(async () => automaticResolution.promise);
    loadMergeWorkflowReviewMock.mockImplementationOnce(async () => review.promise);
    assistantPhase = 'streaming';

    await renderPanel(root);
    await clickResolveWithAi();
    expect(document.body.textContent).toContain('AI resolving...');

    assistantPhase = 'idle';
    await renderPanel(root);
    expect(loadMergeWorkflowReviewMock).toHaveBeenCalledWith(taskId, { force: true });
    expect(document.body.textContent).toContain('Checking resolution...');

    await act(async () => {
      review.resolve(null);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Checking resolution...');
  });

  it('clears checking_resolution after a rejected review', async () => {
    const automaticResolution = createDeferred<{
      conversationId: null;
      autoResolvedRepositoryCount: number;
      remainingBlockedRepositoryCount: number;
    }>();
    const review = createDeferred<null>();
    resolveMergeWorkflowAutomaticallyMock.mockImplementationOnce(async () => automaticResolution.promise);
    loadMergeWorkflowReviewMock.mockImplementationOnce(async () => review.promise);
    assistantPhase = 'streaming';

    await renderPanel(root);
    await clickResolveWithAi();
    assistantPhase = 'idle';
    await renderPanel(root);
    expect(document.body.textContent).toContain('Checking resolution...');

    await act(async () => {
      review.reject(new Error('review failed'));
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Checking resolution...');
  });

  it('ignores a stale review completion after switching tasks', async () => {
    const automaticResolution = createDeferred<{
      conversationId: null;
      autoResolvedRepositoryCount: number;
      remainingBlockedRepositoryCount: number;
    }>();
    const review = createDeferred<null>();
    resolveMergeWorkflowAutomaticallyMock.mockImplementationOnce(async () => automaticResolution.promise);
    loadMergeWorkflowReviewMock.mockImplementationOnce(async () => review.promise);
    assistantPhase = 'streaming';

    await renderPanel(root);
    await clickResolveWithAi();
    assistantPhase = 'idle';
    await renderPanel(root);
    expect(document.body.textContent).toContain('Checking resolution...');

    await renderPanel(root, 'task-b');
    expect(document.body.textContent).not.toContain('Checking resolution...');

    await act(async () => {
      review.resolve(null);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Checking resolution...');
  });
});
