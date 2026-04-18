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

const registerVirtualListMock = () => {
  mock.module('../../hooks/useVirtualList', () => ({
    useVirtualList: ({ items }: { items: unknown[] }) => ({
      parentRef: { current: null },
      virtualItems: items.map((item, index) => ({
        index,
        key: index,
        size: 112,
        start: index * 120,
        item,
      })),
      totalSize: items.length * 120,
      scrollToIndex: () => undefined,
      scrollToEnd: () => undefined,
      measureElement: () => undefined,
    }),
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
  registerVirtualListMock();

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

describe('TaskQueue', () => {
  let initialAppState: ReturnType<typeof useAppStore.getState> | null = null;
  let initialChatState: ReturnType<typeof useChatStore.getState> | null = null;
  let initialTaskState: ReturnType<typeof useTaskStore.getState> | null = null;
  let initialFileChangesState: ReturnType<typeof useFileChangesStore.getState> | null = null;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const seedStores = (taskStatus: TaskStatus, options?: { isStreaming?: boolean }) => {
    const conversationRuntimeById = options?.isStreaming
      ? {
          'conversation-1': {
            phase: 'streaming' as const,
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
      tasks: [
        {
          id: 'task-1',
          title: 'Render task status indicator',
          description: 'Check the status marker',
          status: taskStatus,
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/task-status',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
        },
      ] as never,
      planSummaries: [],
      hasStandaloneTasks: false,
      publishedStandaloneTasks: {},
      finalizingPlanId: null,
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
      isStreaming: options?.isStreaming ?? false,
      selectedConversationId: 'conversation-1',
    });

    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      currentTaskId: null,
    });
  };

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
    expect(document.body.querySelector('h2')?.parentElement?.className).toContain('pt-1');
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

});
