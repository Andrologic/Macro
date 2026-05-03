import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { useAppStore as UseAppStoreHook } from '../../stores/useAppStore';
import type { useChatStore as UseChatStoreHook } from '../../stores/useChatStore';
import type { useFileChangesStore as UseFileChangesStoreHook } from '../../stores/useFileChangesStore';
import type { useTaskStore as UseTaskStoreHook } from '../../stores/useTaskStore';
import type { TaskStatus } from '../../types';

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

const makeProject = (id: string, path: string, name: string) => ({
  id,
  name,
  mountName: id,
  path,
  created_at: '2026-04-14T00:00:00.000Z',
  status: 'active' as const,
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
    options?: { isStreaming?: boolean; runtimePhase?: 'preparing' | 'streaming' }
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
    options?: { isStreaming?: boolean; runtimePhase?: 'preparing' | 'streaming' }
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
          task_id: 'task-1',
        },
      ] as never,
      conversationRuntimeById: conversationRuntimeById as never,
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

  beforeEach(async () => {
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
    expect(document.body.textContent).not.toContain('Implementation needs at least one editable repository.');
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
    expect(options.description).toContain('Implementation needs at least one editable repository.');
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

    await act(async () => {
      archiveToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(getLastVirtualListKeys()).toEqual(['section:archived', 'task:archived-task']);
    expect(getSectionSummaries()).toEqual([{ title: 'Archive', count: '1' }]);
    expect(document.body.textContent).not.toContain('Active task');
    expect(document.body.textContent).toContain('Archived task');
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
      { key: 'plan', text: 'Checkout refresh' },
    ]);
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
      { key: 'standalone', text: 'Standalone' },
    ]);
    expect(document.body.querySelector('[data-task-context-badge="plan"]')).toBeNull();
  });

  it('renders the synthetic plan finalization task without the legacy ready-for-validation callout and excludes it from progress', async () => {
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
    expect(document.body.textContent).toContain('1/1');
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
      { key: 'standalone', text: 'Standalone' },
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
