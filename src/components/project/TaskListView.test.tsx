import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TaskListView } from './TaskListView';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import type { TaskStatus } from '../../types';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('TaskListView', () => {
  const initialAppState = useAppStore.getState();
  const initialChatState = useChatStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let setSelectedTaskMock: ReturnType<typeof mock>;
  let selectConversationMock: ReturnType<typeof mock>;
  let conversationsData: Array<Record<string, unknown>> = [];

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

    setSelectedTaskMock = mock(() => undefined);
    selectConversationMock = mock(() => undefined);
    conversationsData = [
      {
        id: 'conversation-1',
        task_id: 'task-1',
        message_count: 3,
        last_message: 'Waiting for input',
        updated_at: '2026-04-14T10:00:00.000Z',
        is_unread: false,
      },
    ];

    useAppStore.setState({
      ...useAppStore.getState(),
      currentPlan: {
        id: 'plan-1',
        tasks: [
          {
            id: 'task-1',
            title: 'Implement task indicator',
            status: taskStatus,
            project_id: 'project-1',
            dependencies: [],
          },
        ],
      } as never,
      setSelectedTask: setSelectedTaskMock,
    });

    useChatStore.setState({
      ...useChatStore.getState(),
      conversations: conversationsData as never,
      conversationRuntimeById: conversationRuntimeById as never,
      isStreaming: options?.isStreaming ?? false,
      selectedConversationId: 'conversation-1',
      selectConversation: selectConversationMock,
      getConversationByTask: (taskId: string) =>
        (conversationsData.find((conversation) => conversation.task_id === taskId) ??
          null) as never,
    });
  };

  beforeEach(() => {
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
    container = null;
    root = null;
    useAppStore.setState(initialAppState, true);
    useChatStore.setState(initialChatState, true);
  });

  it('renders a fixed dot for idle prompt tasks', async () => {
    seedStores('Pending');

    await act(async () => {
      root?.render(<TaskListView projectId="project-1" />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
  });

  it('renders a pulsing dot for awaiting response tasks', async () => {
    seedStores('AwaitingResponse');

    await act(async () => {
      root?.render(<TaskListView projectId="project-1" />);
      await flushRender();
    });

    const indicator = document.body.querySelector(
      '[data-task-status-indicator-state="awaiting_response"]'
    );

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-task-status-indicator-layout')).toBe('compact');
    expect(indicator?.getAttribute('data-task-status-indicator-pulse')).toBe('awaiting_response');
    expect(indicator?.querySelectorAll('.task-status-awaiting-response__wave').length).toBe(1);
    expect(indicator?.className).toContain('text-amber-500');
  });

  it('renders a spinner for the task that is currently streaming', async () => {
    seedStores('InProgress', { isStreaming: true });

    await act(async () => {
      root?.render(<TaskListView projectId="project-1" />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  it('keeps task selection behavior intact', async () => {
    seedStores('Pending');

    await act(async () => {
      root?.render(<TaskListView projectId="project-1" />);
      await flushRender();
    });

    await act(async () => {
      document.body.querySelector('button')?.click();
      await flushRender();
    });

    expect(setSelectedTaskMock).toHaveBeenCalledWith('task-1');
    expect(selectConversationMock).toHaveBeenCalledWith('conversation-1');
  });
});
