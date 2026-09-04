import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { useAppStore as UseAppStoreHook } from '../../stores/useAppStore';
import type { useChatStore as UseChatStoreHook } from '../../stores/useChatStore';
import type { useFileChangesStore as UseFileChangesStoreHook } from '../../stores/useFileChangesStore';
import type { useTaskStore as UseTaskStoreHook } from '../../stores/useTaskStore';
import {
  DEFAULT_IMPLEMENT_VIEW_FILTERS,
} from '../../services/viewFilterPreferences';
import { useViewFilterStore } from '../../stores/useViewFilterStore';
import type { ProjectGitFlowSettings, TaskStatus } from '../../types';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';

let useAppStore!: typeof UseAppStoreHook;
let useChatStore!: typeof UseChatStoreHook;
let useFileChangesStore!: typeof UseFileChangesStoreHook;
let useTaskStore!: typeof UseTaskStoreHook;
let TaskQueueComponent!: typeof import('./TaskQueue').TaskQueue;
let importCounter = 0;
let virtualListRowKeys: Array<Array<string | number>> = [];
let notifyMock!: {
  info: ReturnType<typeof mock>;
  success: ReturnType<typeof mock>;
  warning: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  actionRequired: ReturnType<typeof mock>;
  dismiss: ReturnType<typeof mock>;
};

const translationMock = createTranslationMock({
  'errors.degraded.worktree.checkedOut.title': 'Macro could not prepare the task workspace',
  'errors.degraded.worktree.checkedOut.body':
    'The branch needed for this task is still open in the main repository with local changes.',
  'errors.degraded.worktree.checkedOut.nextStep':
    'Commit, stash, or discard those local changes, then retry the task.',
  'errors.degraded.worktree.missingBase.title': 'Macro could not find the base branch',
  'errors.degraded.worktree.missingBase.body':
    'This task needs a base branch before its worktree can be created.',
  'errors.degraded.worktree.missingBase.nextStep':
    'Create the branch or update the project Git workflow settings, then retry.',
});

const createNotifyMock = () => ({
  info: mock(() => 'toast-info'),
  success: mock(() => 'toast-success'),
  warning: mock(() => 'toast-warning'),
  error: mock(() => 'toast-error'),
  actionRequired: mock(() => 'toast-action-required'),
  dismiss: mock(() => undefined),
});

const registerVirtualListMock = () => {
  mock.module('../../hooks/useVirtualList', () => ({
    useVirtualList: ({
      items,
      getItemKey,
    }: {
      items: unknown[];
      getItemKey?: (item: unknown, index: number) => string | number;
    }) => {
      const rowKeys = items.map((item, index) =>
        getItemKey ? getItemKey(item, index) : index
      );
      virtualListRowKeys.push(rowKeys);
      return {
      parentRef: { current: null },
      virtualItems: items.map((item, index) => ({
        index,
        key: rowKeys[index] ?? index,
        size: 112,
        start: index * 120,
        item,
      })),
      totalSize: items.length * 120,
      scrollToIndex: () => undefined,
      scrollToEnd: () => undefined,
      measureElement: () => undefined,
      };
    },
    useVirtualMessages: (messages: unknown[]) => ({
      parentRef: { current: null },
      virtualItems: messages.map((item, index) => ({
        index,
        key: index,
        size: 112,
        start: index * 120,
        item,
      })),
      totalSize: messages.length * 120,
      scrollToIndex: () => undefined,
      scrollToEnd: () => undefined,
      measureElement: () => undefined,
    }),
  }));
};

const loadTaskQueueModules = async () => {
  importCounter += 1;
  mock.restore();
  virtualListRowKeys = [];
  notifyMock = createNotifyMock();
  installReactI18nextMock(translationMock);
  registerVirtualListMock();
  mock.module('../ui/toastService', () => ({
    notify: notifyMock,
  }));

  const appStoreModule = await import(
    `../../stores/useAppStore.ts?task-queue-app-store-test=${importCounter}`
  );
  mock.module('../../stores/useAppStore', () => ({
    ...appStoreModule,
  }));

  const chatStoreModule = await import(
    `../../stores/useChatStore.ts?task-queue-chat-store-test=${importCounter}`
  );
  mock.module('../../stores/useChatStore', () => ({
    ...chatStoreModule,
  }));

  const fileChangesStoreModule = await import(
    `../../stores/useFileChangesStore.ts?task-queue-file-changes-store-test=${importCounter}`
  );
  mock.module('../../stores/useFileChangesStore', () => ({
    ...fileChangesStoreModule,
  }));

  const architectGitFlowServiceModule = await import(
    `../../services/architectGitFlowService.ts?task-queue-git-flow-service-test=${importCounter}`
  );
  mock.module('../../services/architectGitFlowService', () => ({
    ...architectGitFlowServiceModule,
  }));
  mock.module('../../services/architectGitFlowService.ts', () => ({
    ...architectGitFlowServiceModule,
  }));

  const taskStoreModule = await import(
    `../../stores/useTaskStore.ts?task-queue-task-store-test=${importCounter}`
  );
  mock.module('../../stores/useTaskStore', () => ({
    ...taskStoreModule,
  }));

  ({ TaskQueue: TaskQueueComponent } = await import(`./TaskQueue.tsx?task-queue-test=${importCounter}`));
  ({ useAppStore } = appStoreModule);
  ({ useChatStore } = chatStoreModule);
  ({ useFileChangesStore } = fileChangesStoreModule);
  ({ useTaskStore } = taskStoreModule);
};

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

const waitForCreateDialog = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) return dialog;
    await act(async () => {
      await flushRender();
    });
  }
  return null;
};

const makeGitFlowSettings = (
  baseBranch: string,
  mainBranch: string,
): ProjectGitFlowSettings => ({
  baseBranch,
  mainBranch,
  planBranchTemplate: 'plan/{planSlug}',
  featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
  standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
  releaseBranchTemplate: 'release/{releaseSlug}',
  hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
  bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
});

const makeProject = (
  id: string,
  path: string,
  name: string,
  gitFlowSettings?: ProjectGitFlowSettings,
) => ({
  id,
  name,
  mountName: id,
  path,
  created_at: '2026-04-14T00:00:00.000Z',
  status: 'active' as const,
  gitFlowSettings,
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const makeTask = (
  id: string,
  status: TaskStatus,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  title: `Task ${id}`,
  description: `Description for ${id}`,
  status,
  task_source: 'standalone' as const,
  draft: false,
  archived_at: null,
  archive_reason: null,
  merged_at: null,
  project_id: 'project-1',
  project_ids: ['project-1'],
  assigned_branch: `feature/${id}`,
  branch_name: `feature/${id}`,
  branch_id: null,
  branch_task_index: 0,
  sequence_index: 0,
  execution_targets: [
    {
      projectId: 'project-1',
      branchName: `feature/${id}`,
      worktreeKey: `project-1::feature/${id}`,
    },
  ],
  blocked_by: [],
  blocked_by_task_ids: [],
  dependencies: [],
  is_blocked: false,
  is_ready: status !== 'Completed' && status !== 'Failed' && status !== 'Blocked',
  needs_revalidation: false,
  plan_id: '',
  plan_title: null,
  plan_status: null,
  plan_target_branch: null,
  plan_target_branches_by_project_id: null,
  has_mixed_target_branches: false,
  standalone_kind: 'legacy' as const,
  base_branch: 'develop',
  feature_slug: id,
  conversation_id: `conversation-${id}`,
  ...overrides,
});

describe('TaskQueue', () => {
  let initialAppState: ReturnType<typeof useAppStore.getState> | null = null;
  let initialChatState: ReturnType<typeof useChatStore.getState> | null = null;
  let initialTaskState: ReturnType<typeof useTaskStore.getState> | null = null;
  let initialFileChangesState: ReturnType<typeof useFileChangesStore.getState> | null = null;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const seedStores = (
    taskStatus: TaskStatus,
    options?: {
      isStreaming?: boolean;
      runtimePhase?: 'preparing' | 'streaming';
      compactionPhase?:
        | 'compacting'
        | 'safety_compacting'
        | 'model_switch_compacting'
        | 'recovering_overflow'
        | 'compacted';
      compactionConversationId?: string;
      conversationTaskId?: string | null;
    }
  ) => {
    seedTasks([makeTask('task-1', taskStatus, {
      title: 'Render task status indicator',
      description: 'Check the status marker',
      task_source: 'architect',
      plan_id: 'plan-1',
      plan_title: 'Plan One',
    })], options);
  };

  const seedTasks = (
    tasks: Array<Record<string, unknown>>,
    options?: {
      isStreaming?: boolean;
      runtimePhase?: 'preparing' | 'streaming';
      compactionPhase?:
        | 'compacting'
        | 'safety_compacting'
        | 'model_switch_compacting'
        | 'recovering_overflow'
        | 'compacted';
      compactionConversationId?: string;
      conversationTaskId?: string | null;
    }
  ) => {
    const runtimePhase = options?.runtimePhase ?? (options?.isStreaming ? 'streaming' : null);
    const conversationRuntimeById = runtimePhase
      ? {
          'conversation-1': {
            phase: runtimePhase,
            sessionId: 'session-1',
            assistantMessageId: 'assistant-1',
            abortController: null,
            lastError: null,
          },
        }
      : {};

    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      selectedTaskId: 'task-1',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [makeProject('project-1', '/tmp/project-1', 'Project One')],
        },
      ],
    });

    useTaskStore.setState({
      ...useTaskStore.getState(),
      tasks: tasks as never,
      planSummaries: [],
      hasStandaloneTasks: false,
      publishedStandaloneTasks: {},
      taskCommandRuns: {},
      missingBaseBranchIssue: null,
      lastError: null,
    });

    useChatStore.setState({
      ...useChatStore.getState(),
      conversations: [
        {
          id: 'conversation-1',
          task_id:
            options?.conversationTaskId === undefined
              ? 'task-1'
              : options.conversationTaskId,
        },
      ] as never,
      conversationRuntimeById: conversationRuntimeById as never,
      conversationCompactionStatusById: options?.compactionPhase
        ? ({
            [options.compactionConversationId ?? 'conversation-1']: {
              phase: options.compactionPhase,
            },
          } as never)
        : {},
      isStreaming: runtimePhase === 'streaming',
      selectedConversationId: 'conversation-1',
    });

    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      currentTaskId: null,
    });
  };

  const getLastVirtualListKeys = () =>
    virtualListRowKeys[virtualListRowKeys.length - 1] ?? [];

  const getSectionSummaries = () =>
    Array.from(document.body.querySelectorAll('h2')).map((heading) => ({
      title: heading.textContent?.trim(),
      count: heading.parentElement?.querySelector('span')?.textContent?.trim(),
    }));

  const getTaskCardFooter = () =>
    document.body.querySelector('[data-task-card-footer="true"]');

  const getTaskCard = () =>
    document.body.querySelector('[role="button"][tabindex="0"]');

  const getTaskCardProgressLabel = () =>
    document.body.querySelector('[data-task-card-progress-label="true"]');

  const getTaskCardNextAction = () =>
    document.body.querySelector('[data-task-card-next-action="true"]');

  const getTaskContextBadges = () =>
    Array.from(document.body.querySelectorAll('[data-task-context-badge]')).map((badge) => ({
      key: badge.getAttribute('data-task-context-badge'),
      text: badge.textContent?.replace(/\s+/g, ' ').trim(),
    }));

  const getTaskContextBadgeIconIdentity = (key: string) => {
    const badge = document.body.querySelector(`[data-task-context-badge="${key}"]`);
    const icon = Array.from(badge?.children ?? []).find((child) =>
      ['svg', 'span'].includes(child.tagName.toLowerCase())
    );
    return {
      dataIcon: icon?.getAttribute('data-icon') ?? '',
      className: icon?.getAttribute('class') ?? '',
    };
  };

  beforeEach(async () => {
    useViewFilterStore.setState({
      implement: { ...DEFAULT_IMPLEMENT_VIEW_FILTERS },
      isHydrated: true,
    });
    installTauriRuntimeMock();
    await loadTaskQueueModules();
    initialAppState = useAppStore.getState();
    initialChatState = useChatStore.getState();
    initialTaskState = useTaskStore.getState();
    initialFileChangesState = useFileChangesStore.getState();
    container = document.createElement('div');
    container.style.height = '900px';
    container.style.width = '480px';
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    container = null;
    root = null;
    if (initialAppState) {
      useAppStore.setState(initialAppState, true);
    }
    if (initialChatState) {
      useChatStore.setState(initialChatState, true);
    }
    if (initialTaskState) {
      useTaskStore.setState(initialTaskState, true);
    }
    if (initialFileChangesState) {
      useFileChangesStore.setState(initialFileChangesState, true);
    }
    removeTauriRuntimeMock();
    mock.restore();
  });

  it('renders a fixed dot for pending tasks without streaming', async () => {
    seedStores('Pending');

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
    expect(document.body.querySelector('h2')?.parentElement?.className).toContain('h-7');
  });

  it('lets users clear a status filter from the compact status controls', async () => {
    seedTasks([
      makeTask('ready-task', 'Pending', { title: 'Ready task' }),
      makeTask('blocked-task', 'Blocked', { title: 'Blocked task', is_ready: false }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const readyFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Ready'));

    await act(async () => {
      readyFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(readyFilter?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('Ready task');
    expect(document.body.textContent).not.toContain('Blocked task');

    const clearFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('All statuses'));
    expect(clearFilter?.getAttribute('title')).toBe('Show all statuses');

    await act(async () => {
      clearFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(readyFilter?.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.textContent).toContain('Ready task');
    expect(document.body.textContent).toContain('Blocked task');
  });

  it('keeps reply-required, blocked and failed tasks in separate filter groups', async () => {
    seedTasks([
      makeTask('waiting-task', 'AwaitingResponse', { title: 'Reply required task' }),
      makeTask('blocked-task', 'Blocked', { title: 'Actually blocked task', is_ready: false }),
      makeTask('blocked-in-progress', 'InProgress', {
        title: 'Dependency blocked task',
        is_blocked: true,
        is_ready: false,
      }),
      makeTask('active-task', 'InProgress', { title: 'Active task' }),
      makeTask('failed-task', 'Failed', { title: 'Failed task', is_ready: false }),
      makeTask('merge-blocked-task', 'AwaitingResponse', {
        title: 'Merge blocked task',
        is_ready: false,
      }),
      makeTask('merge-failed-task', 'AwaitingResponse', {
        title: 'Merge failed task',
        is_ready: false,
      }),
      makeTask('legacy-task', 'Paused' as TaskStatus, {
        title: 'Legacy status task',
      }),
      makeTask('completed-blocked-task', 'Completed', {
        title: 'Reblocked completed task',
        is_blocked: true,
        is_ready: false,
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      mergeWorkflowRuntimeByTaskId: {
        'merge-blocked-task': {
          taskId: 'merge-blocked-task',
          kind: 'task_completion',
          phase: 'blocked',
          taskStatus: 'AwaitingResponse',
          review: {
            taskId: 'merge-blocked-task',
            title: 'Merge blocked task',
            taskSource: 'standalone',
            planId: null,
            planTitle: null,
            targetBranch: 'develop',
          },
          repositories: [],
          blockedRepositories: [],
          message: 'Resolve merge blockers.',
          lastLoadedAt: '2026-09-04T10:00:00.000Z',
        },
        'merge-failed-task': {
          taskId: 'merge-failed-task',
          kind: 'task_completion',
          phase: 'failed',
          taskStatus: 'AwaitingResponse',
          review: {
            taskId: 'merge-failed-task',
            title: 'Merge failed task',
            taskSource: 'standalone',
            planId: null,
            planTitle: null,
            targetBranch: 'develop',
          },
          repositories: [],
          blockedRepositories: [],
          message: 'Retry merge.',
          lastLoadedAt: '2026-09-04T10:00:00.000Z',
        },
      },
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const needsReplyFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Needs reply'));
    const blockedFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Blocked'));
    const inProgressFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('In progress'));
    const failedFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Failed'));

    expect(needsReplyFilter?.textContent).toContain('1');
    expect(blockedFilter?.textContent).toContain('4');
    expect(inProgressFilter?.textContent).toContain('1');
    expect(failedFilter?.textContent).toContain('2');
    expect(getSectionSummaries()).toContainEqual({ title: 'Blocked tasks', count: '4' });
    expect(getSectionSummaries()).toContainEqual({ title: 'Failed tasks', count: '2' });
    expect(getSectionSummaries().some((section) => section.title === 'Completed tasks')).toBe(false);
    expect(document.body.textContent).toContain('Legacy status task');

    await act(async () => {
      blockedFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.textContent).toContain('Actually blocked task');
    expect(document.body.textContent).toContain('Dependency blocked task');
    expect(document.body.textContent).toContain('Merge blocked task');
    expect(document.body.textContent).toContain('Reblocked completed task');
    expect(document.body.textContent).not.toContain('Reply required task');
    expect(document.body.textContent).not.toContain('Active task');
    expect(document.body.textContent).not.toContain('Failed task');
    expect(document.body.textContent).not.toContain('Merge failed task');
    expect(document.body.textContent).not.toContain('Legacy status task');

    await act(async () => {
      failedFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.textContent).toContain('Failed task');
    expect(document.body.textContent).toContain('Merge failed task');
    expect(document.body.textContent).not.toContain('Reply required task');
    expect(document.body.textContent).not.toContain('Merge blocked task');
    expect(document.body.textContent).not.toContain('Reblocked completed task');
    expect(document.body.textContent).not.toContain('Legacy status task');
  });

  it('searches within the active task filters and activates the selected result', async () => {
    const activateTask = mock(async () => undefined);
    seedTasks([
      makeTask('ready-task', 'Pending', { title: 'Préparer le déploiement' }),
      makeTask('blocked-task', 'Blocked', {
        title: 'Déploiement bloqué',
        is_blocked: true,
        is_ready: false,
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      activateTask: activateTask as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const readyFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Ready'));
    await act(async () => {
      readyFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.querySelector('[data-tour-id="implement-task-search"]')).toBeNull();
    const searchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-search-toggle"]'
    );
    expect(searchToggle?.className).toContain('h-7 w-7');
    await act(async () => {
      searchToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const searchInput = document.body.querySelector<HTMLInputElement>(
      '[data-tour-id="implement-task-search"] input'
    );
    const header = searchInput?.closest('.h-12');
    const openSearchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-search-toggle"]'
    );
    const searchBar = document.body.querySelector<HTMLElement>(
      '[data-tour-id="implement-task-search"]'
    );
    expect(header).not.toBeNull();
    expect(header?.className).toContain('gap-2');
    expect(openSearchToggle?.className).toContain('h-8 w-8');
    expect(searchBar?.className).toContain('focus-within:border-border');
    expect(searchBar?.className).toContain('focus-within:ring-0');
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(searchInput, 'DEPLOIEMENT');
      searchInput?.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.textContent).toContain('Préparer le déploiement');
    expect(document.body.textContent).not.toContain('Déploiement bloqué');

    const resultCard = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]')
    ).find((element) => element.textContent?.includes('Préparer le déploiement'));
    await act(async () => {
      resultCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });
    expect(activateTask).toHaveBeenCalledWith('ready-task');

    await act(async () => {
      valueSetter?.call(searchInput, 'conversation');
      searchInput?.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flushRender();
    });
    expect(document.body.textContent).toContain('No task matches this search.');
  });

  it('sends task workspace errors to an actionable retry notification', async () => {
    seedStores('Pending');
    const activateTask = mock(() => undefined);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      activateTask: activateTask as never,
      lastError:
        'Cannot create a task worktree for feature/demo because that branch is still checked out in the primary repository and has uncommitted changes',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Macro could not prepare the task workspace');
    expect(document.body.textContent).not.toContain('Commit, stash, or discard');
    expect(notifyMock.actionRequired).toHaveBeenCalledTimes(1);
    const [title, options] = notifyMock.actionRequired.mock.calls[0] as [
      string,
      {
        tone: string;
        notificationKey: string;
        description: string;
        actions: Array<{ label: string; onClick: () => void }>;
      },
    ];
    expect(title).toBe('Macro could not prepare the task workspace');
    expect(options.tone).toBe('error');
    expect(options.notificationKey).toContain('implement-task-error:');
    expect(options.description).toContain('Commit, stash, or discard');
    expect(options.actions[0]?.label).toBe('Retry');

    await act(async () => {
      options.actions[0]?.onClick();
      await flushRender();
    });
    expect(activateTask).toHaveBeenCalledWith('task-1');
  });

  it('suppresses a stale merge-runtime error on a Pending task without an active merge runtime', async () => {
    seedStores('Pending');
    useTaskStore.setState({
      ...useTaskStore.getState(),
      lastError: 'Cannot complete task while repository has uncommitted changes.',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(notifyMock.actionRequired).not.toHaveBeenCalled();
    expect(notifyMock.error).not.toHaveBeenCalled();
    expect(notifyMock.warning).not.toHaveBeenCalled();
  });

  it('ignores stale failed merge summaries after a task is reopened', async () => {
    seedTasks([
      makeTask('task-1', 'InProgress', {
        title: 'Reopened task',
        merge_workflow_summary: {
          kind: 'task_completion',
          phase: 'failed',
          taskStatus: 'Failed',
          repositoryCount: 2,
          mergedRepositoryCount: 0,
          blockedRepositoryCount: 0,
          unresolvedRepositoryCount: 2,
          updatedAt: '2026-04-23T09:00:00.000Z',
          message: 'Automatic merge failed',
        },
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      lastError: 'Cannot complete task while repository has uncommitted changes.',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="merge_failed"]')
    ).toBeNull();
    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
    expect(notifyMock.actionRequired).not.toHaveBeenCalled();
    expect(notifyMock.error).not.toHaveBeenCalled();
    expect(notifyMock.warning).not.toHaveBeenCalled();
  });

  it('suppresses a worktree-style error on a dependency-blocked task', async () => {
    seedTasks([makeTask('task-1', 'Pending', {
      is_blocked: true,
      blocked_by: ['task-0'],
      blocked_by_task_ids: ['task-0'],
    })]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      lastError: 'Cannot complete task while repository has uncommitted changes.',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(notifyMock.actionRequired).not.toHaveBeenCalled();
    expect(notifyMock.error).not.toHaveBeenCalled();
    expect(notifyMock.warning).not.toHaveBeenCalled();
  });

  it('surfaces a merge-runtime error when a task has an active failed merge runtime', async () => {
    seedTasks([makeTask('task-1', 'Failed', {
      is_blocked: false,
    })]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      lastError: 'Cannot complete task while repository has uncommitted changes.',
      mergeWorkflowRuntimeByTaskId: {
        'task-1': {
          taskId: 'task-1',
          kind: 'task_completion',
          phase: 'failed',
          taskStatus: 'Failed',
          review: {
            taskId: 'task-1',
            title: 'Task 1',
            taskSource: 'standalone',
            planId: null,
            planTitle: null,
            targetBranch: 'develop',
          },
          repositories: [],
          blockedRepositories: [],
          message: 'Resolve the repository blockers before retrying the merge.',
          lastLoadedAt: '2026-04-22T10:00:00.000Z',
        },
      },
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(notifyMock.actionRequired).toHaveBeenCalledTimes(1);
  });

  it('scopes the toast notification key to the selected task id', async () => {
    seedStores('Pending');
    useTaskStore.setState({
      ...useTaskStore.getState(),
      lastError: 'Cannot create a task worktree for feature/demo because that branch is still checked out in the primary repository and has uncommitted changes',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(notifyMock.actionRequired).toHaveBeenCalledTimes(1);
    const options = notifyMock.actionRequired.mock.calls[0]?.[1] as { notificationKey?: string };
    expect(options?.notificationKey).toContain('implement-task-error:task-1:');
  });

  it('sends read-only scope warnings to an actionable notification instead of rendering inline', async () => {
    seedStores('Pending');
    const setSelectedProject = mock(() => undefined);
    const openProjectGitFlowModal = mock(() => undefined);
    useAppStore.setState({
      ...useAppStore.getState(),
      setSelectedProject: setSelectedProject as never,
      openProjectGitFlowModal: openProjectGitFlowModal as never,
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [
            {
              ...makeProject('project-1', '/tmp/project-1', 'Project One'),
              isReadOnly: true,
              readOnlyReason: 'missing_git',
            },
          ],
        },
      ] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('This scope is currently read-only.');
    expect(document.body.textContent).not.toContain('Implementation needs at least one editable project.');
    expect(notifyMock.actionRequired).toHaveBeenCalledTimes(1);
    const [title, options] = notifyMock.actionRequired.mock.calls[0] as [
      string,
      {
        tone: string;
        notificationKey: string;
        description: string;
        actions: Array<{ label: string; onClick: () => void }>;
      },
    ];
    expect(title).toBe('This scope is currently read-only.');
    expect(options.tone).toBe('warning');
    expect(options.notificationKey).toBe('implement-read-only-scope:group-1');
    expect(options.description).toContain('Implementation needs at least one editable project.');
    expect(options.actions[0]?.label).toBe('Initialize Git');

    await act(async () => {
      options.actions[0]?.onClick();
      await flushRender();
    });
    expect(setSelectedProject).toHaveBeenCalledWith('project-1');
    expect(openProjectGitFlowModal).toHaveBeenCalledWith('project-1');
  });

  it('keeps task Git setup errors actionable through project settings notifications', async () => {
    seedStores('Pending');
    const setSelectedProject = mock(() => undefined);
    const openProjectGitFlowModal = mock(() => undefined);
    useAppStore.setState({
      ...useAppStore.getState(),
      setSelectedProject: setSelectedProject as never,
      openProjectGitFlowModal: openProjectGitFlowModal as never,
    });
    useTaskStore.setState({
      ...useTaskStore.getState(),
      lastError: 'Base branch develop does not exist in this repository.',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Macro could not find the base branch');
    expect(notifyMock.actionRequired).toHaveBeenCalledTimes(1);
    const [title, options] = notifyMock.actionRequired.mock.calls[0] as [
      string,
      {
        tone: string;
        notificationKey: string;
        actions: Array<{ label: string; onClick: () => void }>;
      },
    ];
    expect(title).toBe('Macro could not find the base branch');
    expect(options.tone).toBe('warning');
    expect(options.notificationKey).toContain('implement-task-error:');
    expect(options.actions[0]?.label).toBe('Project settings');

    await act(async () => {
      options.actions[0]?.onClick();
      await flushRender();
    });
    expect(setSelectedProject).toHaveBeenCalledWith('project-1');
    expect(openProjectGitFlowModal).toHaveBeenCalledWith('project-1');
  });

  it('toggles between active-only and archived-only task lists', async () => {
    seedTasks([
      makeTask('task-1', 'Pending', {
        title: 'Active task',
        sequence_index: 0,
      }),
      makeTask('archived-task', 'Completed', {
        title: 'Archived task',
        archived_at: '2026-04-30T10:00:00.000Z',
        archive_reason: 'Done',
        sequence_index: 1,
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(getLastVirtualListKeys()).toEqual(['section:ready', 'task:task-1']);
    expect(getSectionSummaries()).toEqual([{ title: 'Ready tasks', count: '1' }]);
    expect(document.body.textContent).toContain('Active task');
    expect(document.body.textContent).not.toContain('Archived task');

    const archiveToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-archive-toggle"]'
    );
    expect(archiveToggle).not.toBeNull();
    expect(archiveToggle?.textContent).toBe('');
    expect(archiveToggle?.getAttribute('aria-label')).toBe('Archives');
    expect(archiveToggle?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      archiveToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(getLastVirtualListKeys()).toEqual(['section:archived', 'task:archived-task']);
    expect(getSectionSummaries()).toEqual([{ title: 'Archive', count: '1' }]);
    expect(archiveToggle?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).not.toContain('Active task');
    expect(document.body.textContent).toContain('Archived task');
  });

  it('opens project management from an accessible compact header action', async () => {
    seedStores('Pending');

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const manageProjectsButton = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-manage-projects"]'
    );
    expect(manageProjectsButton).not.toBeNull();
    expect(manageProjectsButton?.tagName).toBe('BUTTON');
    expect(manageProjectsButton?.type).toBe('button');
    expect(manageProjectsButton?.tabIndex).toBe(0);
    expect(manageProjectsButton?.getAttribute('aria-label')).toBe('Manage projects');
    expect(manageProjectsButton?.getAttribute('title')).toBe('Manage projects');

    const searchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-search-toggle"]'
    );
    await act(async () => {
      searchToggle?.click();
      await flushRender();
    });
    expect(document.body.querySelector('[data-tour-id="implement-manage-projects"]')).toBeNull();

    await act(async () => {
      searchToggle?.click();
      await flushRender();
    });

    const restoredManageProjectsButton = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-manage-projects"]'
    );
    await act(async () => {
      restoredManageProjectsButton?.click();
      await flushRender();
    });

    expect(useAppStore.getState().projectNavigatorOpen).toBe(true);
  });

  it('shows tasks from every project by default and filters them by project', async () => {
    seedTasks([
      makeTask('task-project-1', 'Pending', { title: 'First project task' }),
      makeTask('task-project-2', 'Pending', {
        title: 'Second project task',
        project_id: 'project-2',
        project_ids: ['project-2'],
        execution_targets: [{
          projectId: 'project-2',
          branchName: 'feature/task-project-2',
          worktreeKey: 'project-2::feature/task-project-2',
        }],
      }),
    ]);
    useAppStore.setState({
      ...useAppStore.getState(),
      projectGroups: [
        {
          id: 'group-1',
          name: 'First group',
          isOpen: true,
          projects: [makeProject('project-1', '/tmp/project-1', 'Project One')],
        },
        {
          id: 'group-2',
          name: 'Second group',
          isOpen: true,
          projects: [makeProject('project-2', '/tmp/project-2', 'Project Two')],
        },
      ] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const projectFilter = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-project-filter"]'
    );
    expect(projectFilter?.textContent).toContain('All projects');
    expect(document.body.textContent).toContain('First project task');
    expect(document.body.textContent).toContain('Second project task');

    await act(async () => {
      projectFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const projectTwoOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')
    ).find((option) => option.textContent?.includes('Project Two'));
    expect(projectTwoOption).not.toBeUndefined();

    await act(async () => {
      projectTwoOption?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('First project task');
    expect(document.body.textContent).toContain('Second project task');

    await act(async () => {
      projectFilter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const allProjectsOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')
    ).find((option) => option.textContent?.includes('All projects'));
    expect(allProjectsOption?.querySelector('.tabular-nums')?.textContent).toBe('2');

    const searchInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search projects..."]'
    );
    await act(async () => {
      searchInput?.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }));
      await flushRender();
    });
    expect(document.activeElement).toBe(allProjectsOption ?? null);

    await act(async () => {
      allProjectsOption?.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
      await flushRender();
    });
    expect(document.activeElement).toBe(projectFilter);
  });

  it('preserves a remembered project filter across a failed bootstrap', async () => {
    useViewFilterStore.getState().setImplementProjectFilter('missing-project');
    useAppStore.setState({
      ...useAppStore.getState(),
      standaloneProjects: [],
      projectGroups: [],
      isLoading: false,
      lastError: 'Workspace bootstrap failed',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });
    expect(useViewFilterStore.getState().implement.projectId).toBe('missing-project');

    await act(async () => {
      useAppStore.setState({ lastError: null });
      await flushRender();
    });
    expect(useViewFilterStore.getState().implement.projectId)
      .toBe(DEFAULT_IMPLEMENT_VIEW_FILTERS.projectId);
  });

  it('requires an explicit project when creating from the all-projects view', async () => {
    seedTasks([makeTask('task-1', 'Pending')]);
    const createConversation = mock(async () => ({ id: 'conversation-created' }));
    const selectConversation = mock(async () => true);
    const createManualFeatureDraft = mock(async () => undefined);
    const activateTask = mock(async () => undefined);
    useChatStore.setState({
      ...useChatStore.getState(),
      createConversation: createConversation as never,
      selectConversation: selectConversation as never,
    });
    useTaskStore.setState({
      ...useTaskStore.getState(),
      createManualFeatureDraft: createManualFeatureDraft as never,
      activateTask: activateTask as never,
    });
    useAppStore.setState({
      ...useAppStore.getState(),
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [
            makeProject('project-1', '/tmp/project-1', 'Project One'),
            makeProject(
              'project-2',
              '/tmp/project-2',
              'Project Two',
              makeGitFlowSettings('integration', 'production'),
            ),
          ],
        },
      ] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const createButton = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-create-task"]'
    );
    expect(createButton).not.toBeNull();
    await act(async () => {
      createButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const dialog = await waitForCreateDialog();
    const confirmButton = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') || []
    ).find((button) => button.textContent?.includes('Create task'));
    expect(dialog?.textContent ?? '').toContain('Target project');
    expect(dialog?.querySelector('textarea')).toBeNull();
    expect(dialog?.textContent ?? '').not.toContain('Task type');
    expect(dialog?.textContent ?? '').not.toContain('Starting point');
    expect(dialog?.textContent ?? '').not.toContain('New work');
    expect(dialog?.textContent ?? '').not.toContain('Resume work');
    expect(confirmButton?.disabled).toBe(true);
    expect(dialog?.querySelector('[aria-pressed="true"]')).toBeNull();

    const projectTwoButton = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') || []
    ).find((button) => button.textContent?.includes('Project Two'));
    await act(async () => {
      projectTwoButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const bugfixButton = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') || []
    ).find((button) => button.textContent?.trim() === 'Bugfix');
    await act(async () => {
      bugfixButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(projectTwoButton?.getAttribute('aria-pressed')).toBe('true');
    expect(bugfixButton?.getAttribute('aria-pressed')).toBe('true');
    expect(confirmButton?.disabled).toBe(false);

    await act(async () => {
      confirmButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(createConversation).toHaveBeenCalledWith(
      'New bugfix',
      expect.stringContaining('manual-feature-'),
      'project-2',
      'group-1'
    );
    expect(createManualFeatureDraft).toHaveBeenCalledWith({
      taskId: expect.stringContaining('manual-feature-'),
      conversationId: 'conversation-created',
      groupId: 'group-1',
      projectIds: ['project-2'],
      contextProjectIds: [],
      baseBranch: 'integration',
      title: 'New bugfix',
      description: '',
      taskKind: 'bugfix',
      existingBranchName: null,
      baseCommitHash: null,
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('creates directly for a selected project without Git', async () => {
    const directProject = {
      ...makeProject('project-folder', '/tmp/project-folder', 'Folder project'),
      directEdit: true,
      gitSetupState: 'not_git' as const,
    };
    seedTasks([]);
    const createConversation = mock(async () => ({ id: 'conversation-created' }));
    const selectConversation = mock(async () => true);
    const createManualFeatureDraft = mock(async () => undefined);
    const activateTask = mock(async () => undefined);
    useChatStore.setState({
      ...useChatStore.getState(),
      createConversation: createConversation as never,
      selectConversation: selectConversation as never,
    });
    useTaskStore.setState({
      ...useTaskStore.getState(),
      createManualFeatureDraft: createManualFeatureDraft as never,
      activateTask: activateTask as never,
    });
    useAppStore.setState({
      ...useAppStore.getState(),
      projectGroups: [{
        id: 'group-folder',
        name: 'Folder group',
        isOpen: true,
        projects: [directProject],
      }] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-tour-id="implement-create-task"]'
      )?.click();
      await flushRender();
    });

    const dialog = await waitForCreateDialog();
    const findDialogButton = (text: string) => Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.includes(text));
    await act(async () => {
      findDialogButton('Folder project')?.click();
      await flushRender();
    });

    const confirmButton = findDialogButton('Create task');
    expect(dialog?.textContent ?? '').not.toContain('Task type');
    expect(dialog?.textContent ?? '').not.toContain('Starting point');
    expect(confirmButton?.disabled).toBe(false);

    await act(async () => {
      confirmButton?.click();
      confirmButton?.click();
      await flushRender();
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createManualFeatureDraft).toHaveBeenCalledTimes(1);
    expect(createManualFeatureDraft).toHaveBeenCalledWith({
      taskId: expect.stringContaining('manual-feature-'),
      conversationId: 'conversation-created',
      groupId: 'group-folder',
      projectIds: ['project-folder'],
      contextProjectIds: [],
      baseBranch: 'direct',
      title: 'New direct task',
      description: '',
      taskKind: 'direct',
      existingBranchName: 'direct',
      baseCommitHash: null,
    });
    expect(activateTask).toHaveBeenCalledWith(expect.stringContaining('manual-feature-'));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens task creation for a direct project without loading Git start points', async () => {
    const invokedCommands: string[] = [];
    installTauriRuntimeMock(mock(async (command) => {
      invokedCommands.push(command);
      return undefined;
    }));
    seedTasks([makeTask('task-1', 'Pending')]);
    useAppStore.setState({
      ...useAppStore.getState(),
      projectGroups: [{
        id: 'group-1',
        name: 'Project Group',
        isOpen: true,
        projects: [{
          ...makeProject('project-direct', '/tmp/project-direct', 'Direct Project'),
          directEdit: true,
          gitSetupState: 'not_git',
          isReadOnly: false,
        }],
      }] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-tour-id="implement-create-task"]',
      )?.click();
      await flushRender();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    const directProjectButton = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') || [],
    ).find((button) => button.textContent?.includes('Direct Project'));
    await act(async () => {
      directProjectButton?.click();
      await flushRender();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(directProjectButton?.getAttribute('aria-pressed')).toBe('true');
    expect(invokedCommands).not.toContain('git_task_start_points');
  });

  it('creates and activates a task on the branch of a selected existing worktree', async () => {
    const gitTaskStartPoints = {
      worktrees: [{
        name: 'editor-worktree',
        path: '/tmp/editor-worktree',
        branchName: 'feature/from-editor',
        isDirty: true,
      }],
      branches: [],
    };
    installTauriRuntimeMock(mock(async (command) => {
      if (command === 'git_task_start_points') {
        return gitTaskStartPoints;
      }
      if (command === 'git_status') {
        return {
          branch: 'main',
          head: 'abc123',
          is_clean: true,
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        };
      }
      return undefined;
    }));
    seedTasks([makeTask('task-1', 'Pending')]);
    useAppStore.setState({ selectedProjectId: 'project-1' });

    const createConversation = mock(async () => ({ id: 'conversation-created' }));
    const selectConversation = mock(async () => true);
    const createManualFeatureDraft = mock(async () => undefined);
    const activateTask = mock(async () => undefined);
    useChatStore.setState({
      ...useChatStore.getState(),
      createConversation: createConversation as never,
      selectConversation: selectConversation as never,
    });
    useTaskStore.setState({
      ...useTaskStore.getState(),
      createManualFeatureDraft: createManualFeatureDraft as never,
      activateTask: activateTask as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });
    const createButton = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="implement-create-task"]'
    );
    await act(async () => {
      createButton?.click();
      await flushRender();
    });

    const dialog = await waitForCreateDialog();
    const findDialogButton = (text: string) => Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.includes(text));
    await act(async () => {
      findDialogButton('Project One')?.click();
      await flushRender();
    });
    await act(async () => {
      findDialogButton('Resume work')?.click();
      await flushRender();
    });
    await act(async () => {
      findDialogButton('feature/from-editor')?.click();
      findDialogButton('Feature')?.click();
      await flushRender();
    });
    await act(async () => {
      findDialogButton('Create task')?.click();
      await flushRender();
    });

    expect(createManualFeatureDraft).toHaveBeenCalledWith({
      taskId: expect.stringContaining('manual-feature-'),
      conversationId: 'conversation-created',
      groupId: 'group-1',
      projectIds: ['project-1'],
      contextProjectIds: [],
      baseBranch: 'main',
      title: 'New feature',
      description: '',
      taskKind: 'feature',
      existingBranchName: 'feature/from-editor',
      baseCommitHash: null,
    });
    expect(activateTask).toHaveBeenCalledWith(expect.stringContaining('manual-feature-'));
    expect(selectConversation).toHaveBeenCalledWith('conversation-created');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders a pulsing dot for awaiting response tasks without streaming', async () => {
    seedStores('AwaitingResponse');

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const indicator = document.body.querySelector(
      '[data-task-status-indicator-state="awaiting_response"]'
    );
    const taskCard = document.body.querySelector('[role="button"][tabindex="0"]');

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-task-status-indicator-layout')).toBe('card');
    expect(indicator?.getAttribute('data-task-status-indicator-pulse')).toBe('awaiting_response');
    expect(indicator?.querySelectorAll('.task-status-awaiting-response__wave').length).toBe(1);
    expect(indicator?.className).toContain('text-amber-500');
    expect(taskCard?.className).not.toContain('bg-blue-500/5');
    expect(taskCard?.className).not.toContain('bg-amber-500/5');
  });

  it('renders a spinner only for the streamed task', async () => {
    seedStores('InProgress', { isStreaming: true });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('classifies a streamed task as in progress ahead of a stale waiting status', async () => {
    seedStores('AwaitingResponse', { isStreaming: true });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const needsReplyFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Needs reply'));
    const inProgressFilter = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('In progress'));

    expect(needsReplyFilter?.textContent).toContain('0');
    expect(inProgressFilter?.textContent).toContain('1');
    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('renders a running indicator while the task conversation is preparing', async () => {
    seedStores('InProgress', { runtimePhase: 'preparing' });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('renders a running indicator while the task conversation is compacting', async () => {
    seedStores('InProgress', { compactionPhase: 'compacting' });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('updates the task indicator when compaction starts and finishes after render', async () => {
    seedStores('InProgress');

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();

    await act(async () => {
      useChatStore.setState({
        ...useChatStore.getState(),
        conversationCompactionStatusById: {
          'conversation-1': { phase: 'compacting' },
        } as never,
      });
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();

    await act(async () => {
      useChatStore.setState({
        ...useChatStore.getState(),
        conversationCompactionStatusById: {
          'conversation-1': { phase: 'compacted' },
        } as never,
      });
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).toBeNull();
    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
  });

  it('runs the task indicator when compaction is linked through task conversation_id', async () => {
    seedTasks([makeTask('task-1', 'InProgress', {
      title: 'Render task status indicator',
      description: 'Check the status marker',
      task_source: 'architect',
      plan_id: 'plan-1',
      plan_title: 'Plan One',
      conversation_id: 'conversation-1',
    })], {
      compactionPhase: 'compacting',
      conversationTaskId: null,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('runs the selected standalone task indicator when compaction has no persisted task link yet', async () => {
    seedTasks([makeTask('task-1', 'InProgress', {
      title: 'Standalone task with stale links',
      description: 'Compaction should still mark it active',
      task_source: 'standalone',
      standalone_kind: 'manual_feature',
      conversation_id: null,
    })], {
      compactionPhase: 'compacting',
      conversationTaskId: null,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('stops the running indicator when task compaction completes', async () => {
    seedStores('InProgress', { compactionPhase: 'compacted' });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).toBeNull();
    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
  });

  it('does not mark a task running for another conversation compaction', async () => {
    seedStores('InProgress', {
      compactionPhase: 'compacting',
      compactionConversationId: 'other-conversation',
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).toBeNull();
    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
  });

  it('renders the architect plan badge in the task footer', async () => {
    seedTasks([
      makeTask('architect-1', 'Pending', {
        title: 'Architect task',
        task_source: 'architect',
        plan_id: '1710000000000',
        plan_title: '1710000000000',
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      planSummaries: [
        {
          id: '1710000000000',
          slug: '1710000000000',
          title: '1710000000000',
          label: 'Checkout refresh',
          planKind: 'release',
          status: 'in_progress',
          targetBranch: 'develop',
          projectIds: ['project-1'],
          taskCount: 1,
          completedTaskCount: 0,
          activeTaskCount: 1,
        },
      ] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(getTaskCardFooter()).not.toBeNull();
    expect(getTaskContextBadges()).toEqual([
      { key: 'project', text: 'Project One' },
      { key: 'plan', text: 'Checkout refresh' },
    ]);
    const projectBadge = document.body.querySelector('[data-task-context-badge="project"]');
    expect(projectBadge?.getAttribute('title')).toBe('Project One');
    const projectIcon = getTaskContextBadgeIconIdentity('project');
    expect(`${projectIcon.dataIcon} ${projectIcon.className}`).toContain('folder-git-2');
    const icon = getTaskContextBadgeIconIdentity('plan');
    expect(`${icon.dataIcon} ${icon.className}`).toContain('flag');
    expect(icon.className).not.toContain('border');
    expect(icon.className).not.toContain('rounded-full');
    expect(icon.className).not.toContain('bg-');
  });

  it('renders hotfix plan badges with the hotfix icon', async () => {
    seedTasks([
      makeTask('architect-hotfix', 'Pending', {
        title: 'Architect hotfix task',
        task_source: 'architect',
        plan_id: 'plan-hotfix',
        plan_title: 'Hotfix plan',
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      planSummaries: [
        {
          id: 'plan-hotfix',
          slug: 'plan-hotfix',
          title: 'Hotfix plan',
          label: 'Production patch',
          planKind: 'hotfix',
          status: 'in_progress',
          targetBranch: 'develop',
          projectIds: ['project-1'],
          taskCount: 1,
          completedTaskCount: 0,
          activeTaskCount: 1,
        },
      ] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const icon = getTaskContextBadgeIconIdentity('plan');
    expect(`${icon.dataIcon} ${icon.className}`).toContain('zap');
  });

  it('falls back to the feature icon when the plan kind is missing', async () => {
    seedTasks([
      makeTask('architect-feature', 'Pending', {
        title: 'Architect feature task',
        task_source: 'architect',
        plan_id: 'plan-feature',
        plan_title: 'Feature plan',
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      planSummaries: [
        {
          id: 'plan-feature',
          slug: 'plan-feature',
          title: 'Feature plan',
          label: 'Checkout refresh',
          status: 'in_progress',
          targetBranch: 'develop',
          projectIds: ['project-1'],
          taskCount: 1,
          completedTaskCount: 0,
          activeTaskCount: 1,
        },
      ] as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const icon = getTaskContextBadgeIconIdentity('plan');
    expect(`${icon.dataIcon} ${icon.className}`).toContain('sparkles');
  });

  it('renders the standalone badge without a plan badge for independent tasks', async () => {
    seedTasks([
      makeTask('standalone-1', 'Pending', {
        title: 'Standalone task',
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(getTaskCardFooter()).not.toBeNull();
    expect(getTaskContextBadges()).toEqual([
      { key: 'project', text: 'Project One' },
      { key: 'standalone', text: 'Standalone' },
    ]);
    expect(document.body.querySelector('[data-task-context-badge="plan"]')).toBeNull();
  });

  it('omits the project badge when the primary project no longer exists', async () => {
    seedTasks([
      makeTask('orphaned-project', 'Pending', {
        title: 'Task with a removed project',
        project_id: 'removed-project',
        project_ids: ['removed-project'],
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(document.body.querySelector('[data-task-context-badge="project"]')).toBeNull();
    expect(getTaskContextBadges()).toEqual([
      { key: 'standalone', text: 'Standalone' },
    ]);
  });

  it('shows only the primary project badge for a multi-project task', async () => {
    seedTasks([
      makeTask('multi-project', 'Pending', {
        title: 'Multi-project task',
        project_id: 'project-1',
        project_ids: ['project-1', 'project-2'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/multi-project',
            worktreeKey: 'project-1::feature/multi-project',
          },
          {
            projectId: 'project-2',
            branchName: 'feature/multi-project',
            worktreeKey: 'project-2::feature/multi-project',
          },
        ],
      }),
    ]);
    useAppStore.setState({
      ...useAppStore.getState(),
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [
            makeProject('project-1', '/tmp/project-1', 'Primary Project'),
            makeProject('project-2', '/tmp/project-2', 'Secondary Project'),
          ],
        },
      ],
    });
    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(getTaskContextBadges()).toEqual([
      { key: 'project', text: 'Primary Project' },
      { key: 'standalone', text: 'Standalone' },
    ]);
    expect(document.body.textContent).not.toContain('Secondary Project');
  });

  it('prioritizes dependency blockers in the next action for a waiting multi-project task', async () => {
    seedTasks([
      makeTask('blocked-multi-project', 'AwaitingResponse', {
        title: 'Blocked multi-project task',
        project_ids: ['project-1', 'project-2'],
        is_blocked: true,
        blocked_by: ['Upstream task'],
        blocked_by_task_ids: ['upstream-task'],
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'feature/blocked-multi-project',
            worktreeKey: 'project-1::feature/blocked-multi-project',
          },
          {
            projectId: 'project-2',
            branchName: 'feature/blocked-multi-project',
            worktreeKey: 'project-2::feature/blocked-multi-project',
          },
        ],
      }),
    ]);
    useAppStore.setState({
      ...useAppStore.getState(),
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [
            makeProject('project-1', '/tmp/project-1', 'Primary Project'),
            makeProject('project-2', '/tmp/project-2', 'Secondary Project'),
          ],
        },
      ],
    });
    useTaskStore.setState({
      ...useTaskStore.getState(),
      mergeWorkflowRuntimeByTaskId: {
        'blocked-multi-project': {
          taskId: 'blocked-multi-project',
          kind: 'task_completion',
          phase: 'blocked',
          taskStatus: 'AwaitingResponse',
          review: {
            taskId: 'blocked-multi-project',
            title: 'Blocked multi-project task',
            taskSource: 'standalone',
            planId: null,
            planTitle: null,
            targetBranch: 'develop',
          },
          repositories: [],
          blockedRepositories: [],
          message: 'Resolve dependencies first.',
          lastLoadedAt: '2026-09-04T10:00:00.000Z',
        },
      },
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(getTaskCardNextAction()?.textContent).toContain('Next: unblock task dependencies');
    expect(getTaskCardNextAction()?.textContent).not.toContain('answer the pending request');
  });

  it('renders the synthetic plan finalization task in the operational status summary', async () => {
    seedTasks([
      makeTask('architect-complete-1', 'Completed', {
        title: 'Architect task',
        task_source: 'architect',
        plan_id: 'plan-1',
        plan_title: 'Checkout refresh',
        sequence_index: 0,
      }),
      makeTask('plan-finalization:plan-1', 'Pending', {
        title: 'Finalize plan: Checkout refresh',
        description: 'Merge the plan branch into the configured development branches or archive the plan.',
        task_source: 'plan_finalization',
        plan_id: 'plan-1',
        plan_title: 'Checkout refresh',
        assigned_branch: 'develop',
        branch_name: 'develop',
        execution_targets: [
          {
            projectId: 'project-1',
            branchName: 'develop',
            targetBranchName: 'develop',
            executionKind: 'repository_root',
            worktreeKey: 'plan-finalization:project-1:project-1',
          },
        ],
        sequence_index: 1,
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Plan ready for validation');
    expect(
      document.body.querySelector('[aria-label="Task status summary"]')?.textContent
    ).toContain('Ready1');
    expect(document.body.querySelector('[data-task-context-badge="plan_finalization"]')?.textContent)
      .toContain('Plan finalization');
    expect(
      document.body.querySelector('[data-task-status-indicator-state="plan_finalization"]')
    ).not.toBeNull();
  });

  it('keeps the footer visible for standalone draft tasks even without a description', async () => {
    seedTasks([
      makeTask('draft-standalone-1', 'Pending', {
        title: 'Draft standalone task',
        description: '',
        draft: true,
        standalone_kind: 'manual_feature',
        assigned_branch: '',
        branch_name: '',
        execution_targets: [],
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const taskCard = getTaskCard();

    expect(taskCard?.querySelector('p')).toBeNull();
    expect(taskCard?.getAttribute('data-task-card-variant')).toBe('compact-draft');
    expect(taskCard?.className).toContain('h-[96px]');
    expect(getTaskCardFooter()).not.toBeNull();
    expect(getTaskContextBadges()).toEqual([
      { key: 'project', text: 'Project One' },
      { key: 'standalone', text: 'Agent classification' },
      { key: 'draft', text: 'Draft' },
    ]);
  });

  it('keeps the default card height for drafts that include a description', async () => {
    seedTasks([
      makeTask('draft-standalone-1', 'Pending', {
        title: 'Draft standalone task',
        description: 'Describe the feature before kickoff',
        draft: true,
        standalone_kind: 'manual_feature',
        assigned_branch: '',
        branch_name: '',
        execution_targets: [],
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    const taskCard = getTaskCard();
    const description = taskCard?.querySelector('p');

    expect(taskCard?.getAttribute('data-task-card-variant')).toBe('default');
    expect(taskCard?.className).toContain('h-[112px]');
    expect(description?.textContent).toBe('Describe the feature before kickoff');
  });

  it('renders merge partial progress from the live merge workflow runtime', async () => {
    seedTasks([
      makeTask('task-1', 'Blocked', {
        title: 'Merge blocked task',
      }),
    ]);
    useTaskStore.setState({
      ...useTaskStore.getState(),
      mergeWorkflowRuntimeByTaskId: {
        'task-1': {
          taskId: 'task-1',
          kind: 'task_completion',
          phase: 'partial',
          taskStatus: 'Blocked',
          review: null,
          repositories: [
            {
              id: 'repo-a',
              projectId: 'project-1',
              repoPath: '/tmp/project-1',
              sourceBranchName: 'feature/task-1',
              targetBranchName: 'develop',
              progressState: 'merged',
              hadChangesAtStart: true,
              mergeAppliedAt: '2026-04-23T09:00:00.000Z',
              isClean: true,
              hasChanges: true,
              mergeable: true,
              conflictFiles: [],
              mergeInProgress: false,
              diff: '',
              checkStatus: 'passed',
              blockingKind: null,
              nextAction: null,
              blockingReason: null,
            },
            {
              id: 'repo-b',
              projectId: 'project-1',
              repoPath: '/tmp/project-1',
              sourceBranchName: 'feature/task-1',
              targetBranchName: 'develop',
              progressState: 'blocked',
              hadChangesAtStart: true,
              mergeAppliedAt: null,
              isClean: false,
              hasChanges: true,
              mergeable: false,
              conflictFiles: ['src/conflict.ts'],
              mergeInProgress: false,
              diff: '',
              checkStatus: 'failed',
              blockingKind: 'merge_conflict',
              nextAction: 'resolve_conflicts',
              blockingReason: 'Conflict',
            },
          ],
          blockedRepositories: [],
          message: 'Conflict',
          lastLoadedAt: null,
        },
      } as never,
    });

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="merge_partial"]')
    ).not.toBeNull();
    expect(getTaskCardProgressLabel()?.textContent).toBe('1 merged, 1 remaining');
    expect(getTaskCardNextAction()?.textContent).toBe(
      'Next: resolve remaining merge blockers'
    );
  });

  it('renders merge partial progress from the persisted task summary after reload', async () => {
    seedTasks([
      makeTask('task-1', 'Blocked', {
        title: 'Persisted merge partial task',
        merge_workflow_summary: {
          kind: 'task_completion',
          phase: 'partial',
          taskStatus: 'Blocked',
          repositoryCount: 2,
          mergedRepositoryCount: 1,
          blockedRepositoryCount: 0,
          unresolvedRepositoryCount: 1,
          updatedAt: '2026-04-23T09:00:00.000Z',
          message: null,
        },
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="merge_partial"]')
    ).not.toBeNull();
    expect(getTaskCardProgressLabel()?.textContent).toBe('1 merged, 1 remaining');
    expect(getTaskCardNextAction()?.textContent).toBe(
      'Next: continue merge for remaining repositories'
    );
  });

  it('keeps virtual row keys stable when draft and blocked sections are inserted', async () => {
    seedTasks([
      makeTask('ready-1', 'Pending', {
        title: 'Ready task',
        sequence_index: 1,
      }),
    ]);

    await act(async () => {
      root?.render(<TaskQueueComponent />);
      await flushRender();
    });

    expect(getSectionSummaries()).toEqual([
      { title: 'Ready tasks', count: '1' },
    ]);
    expect(getLastVirtualListKeys()).toEqual([
      'section:ready',
      'task:ready-1',
    ]);

    await act(async () => {
      useTaskStore.setState({
        ...useTaskStore.getState(),
        tasks: [
          makeTask('draft-1', 'Pending', {
            title: 'Draft feature',
            description: '',
            draft: true,
            standalone_kind: 'manual_feature',
            assigned_branch: '',
            branch_name: '',
            execution_targets: [],
            sequence_index: 0,
          }),
          makeTask('ready-1', 'Pending', {
            title: 'Ready task',
            sequence_index: 1,
          }),
        ] as never,
      });
      await flushRender();
    });

    expect(getSectionSummaries()).toEqual([
      { title: 'Draft features', count: '1' },
      { title: 'Ready tasks', count: '1' },
    ]);
    expect(getLastVirtualListKeys()).toEqual([
      'section:drafts',
      'task:draft-1',
      'section:ready',
      'task:ready-1',
    ]);

    await act(async () => {
      useTaskStore.setState({
        ...useTaskStore.getState(),
        tasks: [
          makeTask('draft-1', 'Pending', {
            title: 'Draft feature',
            description: '',
            draft: true,
            standalone_kind: 'manual_feature',
            assigned_branch: '',
            branch_name: '',
            execution_targets: [],
            sequence_index: 0,
          }),
          makeTask('ready-1', 'Blocked', {
            title: 'Blocked task',
            is_blocked: true,
            blocked_by: ['Draft feature'],
            sequence_index: 1,
          }),
          makeTask('done-1', 'Completed', {
            title: 'Completed task',
            sequence_index: 2,
          }),
        ] as never,
      });
      await flushRender();
    });

    expect(getSectionSummaries()).toEqual([
      { title: 'Draft features', count: '1' },
      { title: 'Ready tasks', count: '0' },
      { title: 'Blocked tasks', count: '1' },
      { title: 'Completed tasks', count: '1' },
    ]);
    expect(getLastVirtualListKeys()).toEqual([
      'section:drafts',
      'task:draft-1',
      'section:ready',
      'section:blocked',
      'task:ready-1',
      'section:completed',
      'task:done-1',
    ]);
  });

});
