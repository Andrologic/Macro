import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectGitFlowSettings, TaskStatus } from '../../types';

type AppMode = 'Chat' | 'Architect' | 'Implement';

type MockProject = {
  id: string;
  name: string;
  mountName: string;
  path: string;
  created_at: string;
  status: 'active';
  gitFlowSettings?: ProjectGitFlowSettings;
  metadata: {
    description: string;
    tags: string[];
    team_members: string[];
    api_contracts: string[];
    dependencies: string[];
  };
};

type MockProjectGroup = {
  id: string;
  name: string;
  isOpen: boolean;
  projects: MockProject[];
};

type MockPlanNode = {
  id: string;
  title: string;
  type: 'task';
  status: 'pending' | 'in-progress' | 'completed';
  dependencies: string[];
  projectId: string;
  projectIds?: string[];
  branchSlug?: string;
};

type MockPlanContext = {
  id: string;
  slug?: string;
  title: string;
  description: string;
  status: 'draft' | 'validated' | 'completed' | 'in_progress';
  targetBranch: string;
};

type MockConversation = {
  id: string;
  task_id: string | null;
};

type MockConversationRuntime = {
  phase: 'idle' | 'streaming';
  sessionId: string | null;
  assistantMessageId: string | null;
  abortController: AbortController | null;
  lastError: string | null;
};

type MockTask = {
  id: string;
  title: string;
  status: TaskStatus;
  task_source: 'architect';
  draft: boolean;
  archived_at: string | null;
  project_id: string;
  project_ids: string[];
  assigned_branch: string;
  blocked_by: string[];
  dependencies: string[];
  is_blocked: boolean;
  plan_id: string;
  plan_title: string;
  sequence_index?: number;
  execution_targets?: Array<{ projectId: string }>;
};

type AppStoreState = {
  mode: AppMode;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  projectGroups: MockProjectGroup[];
  planNodes: MockPlanNode[];
  predictedBranches: unknown[];
  strategyMutationPreview: {
    planId: string;
    status: 'valid' | 'blocked';
    autoProvisionBranches: boolean;
    frozenNodes: Array<{ id: string; title: string; reason: 'started' | 'completed' | 'dependency_locked' }>;
    rewrittenPendingNodes: Array<{ id: string; title: string }>;
    newNodes: Array<{ id: string; title: string }>;
    removedPendingNodes: Array<{ id: string; title: string }>;
    conflicts: string[];
  } | null;
  activePlanContext: MockPlanContext | null;
  setActivePlanContext: (context: MockPlanContext | null) => void;
  setPlanNodes: (nodes: MockPlanNode[]) => void;
  setPredictedBranches: (branches: unknown[]) => void;
  setStrategyMutationPreview: (preview: AppStoreState['strategyMutationPreview']) => void;
  setMode: (mode: AppMode) => void;
  setSelectedTask: (taskId: string | null) => void;
};

type ChatStoreState = {
  conversations: MockConversation[];
  conversationRuntimeById: Record<string, MockConversationRuntime>;
  selectedConversationId: string | null;
};

type TaskStoreState = {
  tasks: MockTask[];
  refreshFromPlan: ReturnType<typeof mock>;
  activateTask: ReturnType<typeof mock>;
};

const createStoreHook = <T extends object,>(
  getSnapshot: () => T,
  setSnapshot: (nextState: T) => void,
) => {
  const listeners = new Set<() => void>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & {
    getState: () => T;
    setState: (
      nextStateOrUpdater: Partial<T> | T | ((state: T) => Partial<T> | T),
      replace?: boolean,
    ) => void;
    subscribe: typeof subscribe;
    emit: () => void;
  };

  hook.getState = getSnapshot;
  hook.emit = () => {
    listeners.forEach((listener) => listener());
  };
  hook.setState = (nextStateOrUpdater, replace = false) => {
    const currentState = getSnapshot();
    const nextState =
      typeof nextStateOrUpdater === 'function'
        ? nextStateOrUpdater(currentState)
        : nextStateOrUpdater;
    setSnapshot((replace ? nextState : { ...currentState, ...nextState }) as T);
    hook.emit();
  };
  hook.subscribe = subscribe;

  return hook;
};

let appState: AppStoreState;
let chatState: ChatStoreState;
let taskState: TaskStoreState;

const useAppStore = createStoreHook(() => appState, (nextState) => {
  appState = nextState;
});
const useChatStore = createStoreHook(() => chatState, (nextState) => {
  chatState = nextState;
});
const useTaskStore = createStoreHook(() => taskState, (nextState) => {
  taskState = nextState;
});

const PLAN_ACTIVATION_TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  InReview: 2,
  Pending: 3,
  Blocked: 4,
  Failed: 5,
  Completed: 6,
};

const taskMatchesScopedProject = (task: MockTask, scopedProjectIds: string[]): boolean =>
  scopedProjectIds.length === 0 ||
  scopedProjectIds.some((projectId) =>
    task.project_id === projectId ||
    task.project_ids.includes(projectId) ||
    (task.execution_targets || []).some((target) => target.projectId === projectId)
  );

const getPlanActivationCandidateTask = (
  tasks: MockTask[],
  planId: string,
  scopedProjectIds: string[] = [],
): MockTask | null => {
  const isEligible = (task: MockTask) =>
    task.plan_id === planId &&
    !task.draft &&
    !task.is_blocked &&
    task.status !== 'Completed' &&
    task.status !== 'InReview';
  const compareTasks = (left: MockTask, right: MockTask) => {
    const byStatus =
      PLAN_ACTIVATION_TASK_STATUS_ORDER[left.status] -
      PLAN_ACTIVATION_TASK_STATUS_ORDER[right.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    return (left.sequence_index ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence_index ?? Number.MAX_SAFE_INTEGER);
  };

  const scopedCandidate = tasks
    .filter((task) => isEligible(task) && taskMatchesScopedProject(task, scopedProjectIds))
    .sort(compareTasks)[0];

  if (scopedCandidate) {
    return scopedCandidate;
  }

  return tasks.filter(isEligible).sort(compareTasks)[0] ?? null;
};

const translationMock = {
  t: (
    key: string,
    fallbackOrOptions?: string | { defaultValue?: string },
    maybeOptions?: { defaultValue?: string },
  ) => {
    if (typeof fallbackOrOptions === 'string') {
      return fallbackOrOptions;
    }
    return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
  },
};

const validatePlanAndProvisionBranchesMock = mock(async (_params?: unknown) => ({
  plan: {
    id: 'plan-1',
    nodes: [] as MockPlanNode[],
    predictedBranches: [] as unknown[],
  },
  provision: {
    createdPlanBranch: false,
    createdFeatureBranches: [] as unknown[],
  },
}));
const applyStrategyMutationPreviewMock = mock(async (params: {
  preview: AppStoreState['strategyMutationPreview'];
}) => ({
  id: params.preview?.planId ?? 'plan-1',
  slug: 'plan-1',
  title: 'Plan One',
  label: 'Plan One',
  description: 'Updated preview',
  status: 'in_progress',
  targetBranch: 'develop',
  targetBranchesByProjectId: { 'project-1': 'develop' },
  nodes: appState.planNodes,
  predictedBranches: appState.predictedBranches,
}));
const buildFrozenPlanNodeMapMock = (params: {
  plan: { nodes: MockPlanNode[] };
  tasks?: Array<{ id: string; status: TaskStatus }>;
}) => {
  const nodeById = new Map(params.plan.nodes.map((node) => [node.id, node]));
  const frozen = new Map<
    string,
    { id: string; title: string; reason: 'started' | 'completed' | 'dependency_locked' }
  >();
  const visitDependencies = (nodeId: string, seen = new Set<string>()) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = nodeById.get(nodeId);
    if (!node) return;
    node.dependencies.forEach((dependencyId) => {
      const dependency = nodeById.get(dependencyId);
      if (!dependency) return;
      if (!frozen.has(dependencyId)) {
        frozen.set(dependencyId, {
          id: dependency.id,
          title: dependency.title,
          reason: 'dependency_locked',
        });
      }
      visitDependencies(dependencyId, seen);
    });
  };

  params.plan.nodes.forEach((node) => {
    const taskStatus = params.tasks?.find((task) => task.id === node.id)?.status;
    const reason =
      taskStatus === 'Completed'
        ? 'completed'
        : taskStatus === 'InProgress' ||
            taskStatus === 'AwaitingResponse' ||
            taskStatus === 'InReview'
          ? 'started'
          : null;
    if (!reason) return;
    frozen.set(node.id, { id: node.id, title: node.title, reason });
    visitDependencies(node.id);
  });
  return frozen;
};

const notifySuccessMock = mock((..._args: unknown[]) => undefined);
const notifyErrorMock = mock((..._args: unknown[]) => undefined);

mock.restore();

mock.module('react-i18next', () => ({
  useTranslation: () => translationMock,
}));

mock.module('../../stores/useAppStore', () => ({
  useAppStore,
}));

mock.module('../../stores/useChatStore', () => ({
  useChatStore,
}));

mock.module('../../stores/useTaskStore', () => ({
  getPlanActivationCandidateTask,
  useTaskStore,
}));

mock.module('../../services/architectGitFlowService', () => ({
  validatePlanAndProvisionBranches: (params: unknown) =>
    validatePlanAndProvisionBranchesMock(params),
}));

mock.module('../../services/architectGitFlowService.ts', () => ({
  validatePlanAndProvisionBranches: (params: unknown) =>
    validatePlanAndProvisionBranchesMock(params),
}));

mock.module('../../services/architectStrategyMutationGuard', () => ({
  applyStrategyMutationPreview: (params: unknown) =>
    applyStrategyMutationPreviewMock(params as { preview: AppStoreState['strategyMutationPreview'] }),
  buildFrozenPlanNodeMap: (params: unknown) =>
    buildFrozenPlanNodeMapMock(
      params as {
        plan: { nodes: MockPlanNode[] };
        tasks?: Array<{ id: string; status: TaskStatus }>;
      }
    ),
}));

mock.module('../../services/architectStrategyMutationGuard.ts', () => ({
  applyStrategyMutationPreview: (params: unknown) =>
    applyStrategyMutationPreviewMock(params as { preview: AppStoreState['strategyMutationPreview'] }),
  buildFrozenPlanNodeMap: (params: unknown) =>
    buildFrozenPlanNodeMapMock(
      params as {
        plan: { nodes: MockPlanNode[] };
        tasks?: Array<{ id: string; status: TaskStatus }>;
      }
    ),
}));

mock.module('../ui/toastService', () => ({
  notify: {
    success: (...args: unknown[]) => notifySuccessMock(...args),
    error: (...args: unknown[]) => notifyErrorMock(...args),
  },
}));

const { StrategyGraph } = await import('./StrategyGraph');

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

const makeProject = (id: string, path: string, name: string): MockProject => ({
  id,
  name,
  mountName: id,
  path,
  created_at: '2026-04-14T00:00:00.000Z',
  status: 'active',
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
});

const resetState = () => {
  appState = {
    mode: 'Architect',
    selectedGroupId: null,
    selectedProjectId: null,
    selectedTaskId: null,
    projectGroups: [],
    planNodes: [],
    predictedBranches: [],
    strategyMutationPreview: null,
    activePlanContext: null,
    setActivePlanContext: (context) => {
      useAppStore.setState({ activePlanContext: context });
    },
    setPlanNodes: (nodes) => {
      useAppStore.setState({ planNodes: nodes });
    },
    setPredictedBranches: (branches) => {
      useAppStore.setState({ predictedBranches: branches });
    },
    setStrategyMutationPreview: (preview) => {
      useAppStore.setState({ strategyMutationPreview: preview });
    },
    setMode: (mode) => {
      useAppStore.setState({ mode });
    },
    setSelectedTask: (taskId) => {
      useAppStore.setState({ selectedTaskId: taskId });
    },
  };

  chatState = {
    conversations: [],
    conversationRuntimeById: {},
    selectedConversationId: null,
  };

  taskState = {
    tasks: [],
    refreshFromPlan: mock(async () => undefined),
    activateTask: mock(async (taskId: string) => {
      useAppStore.getState().setSelectedTask(taskId);
    }),
  };
};

const seedStores = (
  taskStatus: TaskStatus,
  options?: {
    isStreaming?: boolean;
    includeConversation?: boolean;
    selectedConversationId?: string | null;
  },
) => {
  const includeConversation = options?.includeConversation ?? true;
  const conversationRuntimeById: Record<string, MockConversationRuntime> =
    includeConversation && options?.isStreaming
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
    selectedGroupId: 'group-1',
    selectedProjectId: null,
    selectedTaskId: null,
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
    strategyMutationPreview: null,
    activePlanContext: null,
  });

  useTaskStore.setState({
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
        sequence_index: 0,
        execution_targets: [{ projectId: 'project-1' }],
      },
    ],
  });

  useChatStore.setState({
    conversations: includeConversation
      ? [
          {
            id: 'conversation-1',
            task_id: 'task-1',
          },
        ]
      : [],
    conversationRuntimeById,
    selectedConversationId: includeConversation
      ? options?.selectedConversationId ?? 'conversation-1'
      : options?.selectedConversationId ?? null,
  });
};

describe('StrategyGraph', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    validatePlanAndProvisionBranchesMock.mockClear();
    applyStrategyMutationPreviewMock.mockClear();
    notifySuccessMock.mockClear();
    notifyErrorMock.mockClear();
    resetState();
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
    document.body.innerHTML = '';
    resetState();
  });

  afterAll(() => {
    mock.restore();
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

    const indicator = document.body.querySelector(
      '[data-task-status-indicator-state="awaiting_response"]'
    );

    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-task-status-indicator-layout')).toBe('graph');
    expect(indicator?.getAttribute('data-task-status-indicator-pulse')).toBe('awaiting_response');
    expect(indicator?.querySelectorAll('.task-status-awaiting-response__wave').length).toBe(1);
    expect(indicator?.parentElement?.className).toContain('text-amber-500');
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

  it('shows the lock only inside the tooltip for frozen graph nodes', async () => {
    seedStores('InProgress');
    useAppStore.setState({
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'in_progress',
        targetBranch: 'develop',
      },
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    expect(document.body.querySelector('.lucide-lock')).toBeNull();

    const graphNode = Array.from(document.querySelectorAll('g')).find(
      (element) => (element as SVGGElement).style?.cursor === 'pointer'
    ) as SVGGElement | undefined;
    expect(graphNode).not.toBeUndefined();

    Object.defineProperty(graphNode!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 120,
        y: 120,
        top: 120,
        left: 120,
        right: 144,
        bottom: 144,
        width: 24,
        height: 24,
        toJSON: () => ({}),
      }),
    });

    await act(async () => {
      graphNode?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.querySelector('.lucide-lock')).not.toBeNull();
    expect(document.body.textContent).toContain('Locked');
    expect(document.body.textContent).toContain(
      'can no longer be modified automatically'
    );
  });

  it('explains locked badges on hover in the branch view', async () => {
    seedStores('InProgress');
    useAppStore.setState({
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'in_progress',
        targetBranch: 'develop',
      },
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/graph',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-1'],
          status: 'pending',
        },
      ],
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    await act(async () => {
      branchesButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Architect node');
    expect(document.body.textContent).toContain('Locked');

    const lockedBadge = document.querySelector(
      '[data-frozen-lock-badge="task-1"]'
    ) as HTMLSpanElement | null;
    expect(lockedBadge).not.toBeNull();

    Object.defineProperty(lockedBadge!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 240,
        y: 260,
        top: 260,
        left: 240,
        right: 300,
        bottom: 284,
        width: 60,
        height: 24,
        toJSON: () => ({}),
      }),
    });

    await act(async () => {
      lockedBadge?.dispatchEvent(
        new window.MouseEvent('mouseover', { bubbles: true })
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('Started work');
    expect(document.body.textContent).toContain(
      'can no longer be modified automatically'
    );
  });

  it('shortens branch card headers without changing raw branch data', async () => {
    seedStores('Pending');
    useAppStore.setState({
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'in_progress',
        targetBranch: 'develop',
      },
      planNodes: [
        {
          id: 'task-1',
          title: 'Checkout API',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-2',
          title: 'Graph cleanup',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-3',
          title: 'Plain branch task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-4',
          title: 'Branch slug wins',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/plan-1/checkout-api',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-1'],
          status: 'pending',
        },
        {
          id: 'branch-2',
          name: 'feature/graph',
          color: '#10b981',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-2'],
          status: 'pending',
        },
        {
          id: 'branch-3',
          name: 'plain-name',
          color: '#f59e0b',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-3'],
          status: 'pending',
        },
        {
          id: 'branch-4',
          name: 'feature/plan-1/internal-name',
          branchSlug: 'preferred-name',
          color: '#8b5cf6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-4'],
          status: 'pending',
        },
      ],
    });
    useTaskStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Checkout API',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/plan-1/checkout-api',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 0,
          execution_targets: [{ projectId: 'project-1' }],
        },
        {
          id: 'task-2',
          title: 'Graph cleanup',
          status: 'Pending',
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
          sequence_index: 1,
          execution_targets: [{ projectId: 'project-1' }],
        },
        {
          id: 'task-3',
          title: 'Plain branch task',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'plain-name',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 2,
          execution_targets: [{ projectId: 'project-1' }],
        },
        {
          id: 'task-4',
          title: 'Branch slug wins',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/plan-1/internal-name',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 3,
          execution_targets: [{ projectId: 'project-1' }],
        },
      ],
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    await act(async () => {
      branchesButton?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('checkout-api');
    expect(document.body.textContent).toContain('graph');
    expect(document.body.textContent).toContain('plain-name');
    expect(document.body.textContent).toContain('preferred-name');
    expect(document.body.textContent).not.toContain('feature/plan-1/checkout-api');
    expect(document.body.textContent).not.toContain('feature/graph');
    expect(document.body.textContent).not.toContain('feature/plan-1/internal-name');
  });

  it('merges exact same branch names into one mixed card with deduplicated tasks', async () => {
    seedStores('Pending');
    useAppStore.setState({
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [
            makeProject('project-1', '/tmp/project-1', 'Project One'),
            makeProject('project-2', '/tmp/project-2', 'Project Two'),
          ],
        },
      ],
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'in_progress',
        targetBranch: 'develop',
      },
      planNodes: [
        {
          id: 'task-1',
          title: 'Web task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-shared',
          title: 'Shared task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-2',
          title: 'API task',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'project-2',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/plan-1/shared-feature',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-1', 'task-shared'],
          status: 'pending',
        },
        {
          id: 'branch-2',
          name: 'feature/plan-1/shared-feature',
          color: '#10b981',
          parentBranch: 'plan/plan-1',
          projectId: 'project-2',
          taskIds: ['task-shared', 'task-2'],
          status: 'active',
        },
      ],
    });
    useTaskStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Web task',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/plan-1/shared-feature',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 0,
          execution_targets: [{ projectId: 'project-1' }],
        },
        {
          id: 'task-shared',
          title: 'Shared task',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1', 'project-2'],
          assigned_branch: 'feature/plan-1/shared-feature',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 1,
          execution_targets: [
            { projectId: 'project-1' },
            { projectId: 'project-2' },
          ],
        },
        {
          id: 'task-2',
          title: 'API task',
          status: 'Completed',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-2',
          project_ids: ['project-2'],
          assigned_branch: 'feature/plan-1/shared-feature',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 2,
          execution_targets: [{ projectId: 'project-2' }],
        },
      ],
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    await act(async () => {
      branchesButton?.click();
      await flushRender();
    });

    const branchCards = document.querySelectorAll('[data-branch-card="true"]');
    expect(branchCards).toHaveLength(1);
    expect(document.body.textContent).toContain('shared-feature');
    expect(document.body.textContent).toContain('Web task');
    expect(document.body.textContent).toContain('Shared task');
    expect(document.body.textContent).toContain('API task');
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(3);

    const mixedBadge = document.querySelector(
      '[data-branch-card-status-badge="mixed"]'
    ) as HTMLSpanElement | null;
    expect(mixedBadge).not.toBeNull();
    expect(branchCards[0]?.getAttribute('data-branch-card-status')).toBe('mixed');
    expect(mixedBadge?.textContent).toContain('Mixed');
    expect(mixedBadge?.className).toContain('bg-muted');
    expect(mixedBadge?.className).toContain('text-muted-foreground');

    const searchInput = document.querySelector('input') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    const setInputValue = (input: HTMLInputElement, value: string) => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    await act(async () => {
      if (searchInput) {
        setInputValue(searchInput, 'Shared');
      }
      await flushRender();
    });

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(1);

    await act(async () => {
      if (searchInput) {
        setInputValue(searchInput, '');
      }
      await flushRender();
    });

    const statusFilter = document.querySelector('select') as HTMLSelectElement | null;
    expect(statusFilter).not.toBeNull();
    const setSelectValue = (select: HTMLSelectElement, value: string) => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      )?.set;
      valueSetter?.call(select, value);
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };

    await act(async () => {
      if (statusFilter) {
        setSelectValue(statusFilter, 'completed');
      }
      await flushRender();
    });

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(1);
    expect(document.body.textContent).toContain('API task');
  });

  it('merges repo-specific branch names when they share the same explicit logical branch slug', async () => {
    seedStores('Pending');
    useAppStore.setState({
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      projectGroups: [
        {
          id: 'group-1',
          name: 'Project Group',
          isOpen: true,
          projects: [
            {
              id: 'project-1',
              name: 'Web',
              mountName: 'web',
              path: '/tmp/project-1',
              created_at: '2026-03-19T00:00:00.000Z',
              status: 'active',
              gitFlowSettings: {
                baseBranch: 'develop',
                mainBranch: 'main',
                planBranchTemplate: 'plan/{planSlug}',
                featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
                standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
                releaseBranchTemplate: 'release/{releaseSlug}',
                hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
                bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
              },
              metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
            },
            {
              id: 'project-2',
              name: 'API',
              mountName: 'api',
              path: '/tmp/project-2',
              created_at: '2026-03-19T00:00:00.000Z',
              status: 'active',
              gitFlowSettings: {
                baseBranch: 'develop',
                mainBranch: 'main',
                planBranchTemplate: 'roadmap/{planSlug}',
                featureBranchTemplate: 'work/{planSlug}/{featureSlug}',
                standaloneFeatureBranchTemplate: 'work/{featureSlug}',
                releaseBranchTemplate: 'release/{releaseSlug}',
                hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
                bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
              },
              metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
            },
          ],
        },
      ],
      activePlanContext: {
        id: 'plan-1',
        slug: 'plan-1',
        title: 'Plan One',
        description: '',
        status: 'draft',
        targetBranch: 'develop',
      },
      planNodes: [
        {
          id: 'task-1',
          title: 'Web task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          branchSlug: 'checkout-api',
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
        {
          id: 'task-2',
          title: 'API task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          branchSlug: 'checkout-api',
          projectId: 'project-2',
          projectIds: ['project-2'],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/plan-1/checkout-api',
          branchSlug: 'checkout-api',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-1'],
          status: 'pending',
        },
        {
          id: 'branch-2',
          name: 'work/plan-1/checkout-api',
          branchSlug: 'checkout-api',
          color: '#10b981',
          parentBranch: 'roadmap/plan-1',
          projectId: 'project-2',
          taskIds: ['task-2'],
          status: 'active',
        },
      ],
    });
    useTaskStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Web task',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/plan-1/checkout-api',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 0,
          execution_targets: [{ projectId: 'project-1' }],
        },
        {
          id: 'task-2',
          title: 'API task',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-2',
          project_ids: ['project-2'],
          assigned_branch: 'work/plan-1/checkout-api',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 1,
          execution_targets: [{ projectId: 'project-2' }],
        },
      ],
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    await act(async () => {
      branchesButton?.click();
      await flushRender();
    });

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('checkout-api');
    expect(document.body.textContent).toContain('Web task');
    expect(document.body.textContent).toContain('API task');
  });

  it('does not merge different full branch names that share the same short label', async () => {
    seedStores('Pending');
    useAppStore.setState({
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'in_progress',
        targetBranch: 'develop',
      },
      planNodes: [
        {
          id: 'task-1',
          title: 'Feature checkout',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-2',
          title: 'Bugfix checkout',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/plan-1/checkout-api',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-1'],
          status: 'pending',
        },
        {
          id: 'branch-2',
          name: 'bugfix/plan-1/checkout-api',
          color: '#10b981',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-2'],
          status: 'pending',
        },
      ],
    });
    useTaskStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Feature checkout',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/plan-1/checkout-api',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 0,
          execution_targets: [{ projectId: 'project-1' }],
        },
        {
          id: 'task-2',
          title: 'Bugfix checkout',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'bugfix/plan-1/checkout-api',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 1,
          execution_targets: [{ projectId: 'project-1' }],
        },
      ],
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    await act(async () => {
      branchesButton?.click();
      await flushRender();
    });

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(2);
    expect(document.body.textContent).toContain('checkout-api');
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(2);
  });

  it('renders and applies a staged strategy preview', async () => {
    seedStores('Pending');
    useAppStore.setState({
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'in_progress',
        targetBranch: 'develop',
      },
      strategyMutationPreview: {
        planId: 'plan-1',
        status: 'valid',
        autoProvisionBranches: true,
        frozenNodes: [{ id: 'task-1', title: 'Architect node', reason: 'started' }],
        rewrittenPendingNodes: [{ id: 'task-2', title: 'Rewrite checkout flow' }],
        newNodes: [{ id: 'task-3', title: 'Add regression coverage' }],
        removedPendingNodes: [{ id: 'task-4', title: 'Drop stale workaround' }],
        conflicts: [],
      },
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Regeneration preview');
    expect(document.body.textContent).toContain('Architect node');
    expect(document.body.textContent).toContain('Rewrite checkout flow');
    expect(document.body.textContent).toContain('Add regression coverage');
    expect(document.body.textContent).toContain('Drop stale workaround');

    const applyButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Apply regeneration')
    );
    expect(applyButton).not.toBeUndefined();

    await act(async () => {
      applyButton?.click();
      await flushRender();
    });

    expect(applyStrategyMutationPreviewMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().strategyMutationPreview).toBeNull();
    expect(taskState.refreshFromPlan).toHaveBeenCalledTimes(1);
    expect(notifySuccessMock).toHaveBeenCalledTimes(1);
  });

  it('validates the plan, switches to Implement, and activates the first task without auto execution', async () => {
    seedStores('Pending', {
      includeConversation: false,
      selectedConversationId: null,
    });

    const refreshFromPlanMock = mock(async () => undefined);
    const activateTaskMock = mock(async (taskId: string) => {
      useAppStore.getState().setSelectedTask(taskId);
    });

    useAppStore.setState({
      activePlanContext: {
        id: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'draft',
        targetBranch: 'develop',
      },
    });

    useTaskStore.setState({
      refreshFromPlan: refreshFromPlanMock,
      activateTask: activateTaskMock,
    });

    validatePlanAndProvisionBranchesMock.mockResolvedValue({
      plan: {
        id: 'plan-1',
        nodes: useAppStore.getState().planNodes,
        predictedBranches: [],
      },
      provision: {
        createdPlanBranch: false,
        createdFeatureBranches: [],
      },
    });

    await act(async () => {
      root?.render(<StrategyGraph />);
      await flushRender();
    });

    const validateButton = Array.from(
      document.body.querySelectorAll('button')
    ).find((button) => button.textContent?.includes('Validate Plan'));

    expect(validateButton).not.toBeUndefined();

    await act(async () => {
      validateButton?.click();
      await flushRender();
    });

    expect(validatePlanAndProvisionBranchesMock).toHaveBeenCalledWith({
      branchName: 'develop',
      planId: 'plan-1',
    });
    expect(refreshFromPlanMock).toHaveBeenCalledTimes(1);
    expect(activateTaskMock).toHaveBeenCalledWith('task-1');
    expect(useAppStore.getState().mode).toBe('Implement');
    expect(useAppStore.getState().selectedTaskId).toBe('task-1');
    expect(useChatStore.getState().selectedConversationId).toBeNull();
    expect(notifySuccessMock).toHaveBeenCalledTimes(1);
  });
});
