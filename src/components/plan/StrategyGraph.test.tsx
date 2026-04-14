import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StrategyGraph } from './StrategyGraph';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
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

describe('StrategyGraph', () => {
  const initialAppState = useAppStore.getState();
  const initialChatState = useChatStore.getState();
  const initialTaskState = useTaskStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const seedStores = (taskStatus: TaskStatus, options?: { isStreaming?: boolean }) => {
    useAppStore.setState({
      ...useAppStore.getState(),
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [makeProject('project-1', '/tmp/project-1', 'Project One')],
        },
      ],
      planNodes: [
        {
          id: 'task-1',
          title: 'Architect node',
          type: 'task',
          status: 'in-progress',
          dependencies: [],
          projectId: 'project-1',
        },
      ],
      predictedBranches: [],
      activePlanContext: null,
    });

    useTaskStore.setState({
      ...useTaskStore.getState(),
      tasks: [
        {
          id: 'task-1',
          title: 'Architect node',
          status: taskStatus,
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/graph',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
        },
      ] as never,
    });

    useChatStore.setState({
      ...useChatStore.getState(),
      conversations: [
        {
          id: 'conversation-1',
          task_id: 'task-1',
        },
      ] as never,
      isStreaming: options?.isStreaming ?? false,
      selectedConversationId: 'conversation-1',
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '800px';
    container.style.width = '1000px';
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
    useTaskStore.setState(initialTaskState, true);
  });

  it('renders a fixed dot for idle prompt nodes', async () => {
    seedStores('Pending');

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
  });

  it('renders a pulsing dot when the linked task awaits a response', async () => {
    seedStores('AwaitingResponse');

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="awaiting_response"]')
    ).not.toBeNull();
  });

  it('renders a spinner when the linked task is streaming', async () => {
    seedStores('InProgress', { isStreaming: true });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });
});
