import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanNodeArtifactContract, ProjectGitFlowSettings, TaskStatus } from '../../types';

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
  description?: string;
  type: 'task' | 'milestone';
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
  dependencies: string[];
  projectId: string;
  projectIds?: string[];
  branchSlug?: string;
  todos?: Array<{
    id: string;
    title: string;
    description?: string;
    status: 'pending' | 'in-progress' | 'done';
  }>;
  artifactContracts?: PlanNodeArtifactContract[];
  archivedAt?: string | null;
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
  task_source: 'architect' | 'plan_finalization';
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

let StrategyGraph!: typeof import('./StrategyGraph').StrategyGraph;
let importCounter = 0;

const loadStrategyGraphModule = async () => {
  importCounter += 1;
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

  const actualPlanArtifactService = await import(
    `../../services/architectPlanArtifactService.ts?strategy-graph-artifacts=${importCounter}`
  );
  const planArtifactServiceMock = {
    ...actualPlanArtifactService,
    listPlanArtifactOverview: mock(async () => ({ entries: [], expected: [] })),
  };
  mock.module('../../services/architectPlanArtifactService', () => planArtifactServiceMock);
  mock.module('../../services/architectPlanArtifactService.ts', () => planArtifactServiceMock);

  const planRuntimeServiceMock = {
    persistArchitectPlanStrategyPreview: mock(async () => undefined),
  };
  mock.module('../../services/architectPlanRuntimeService', () => planRuntimeServiceMock);
  mock.module('../../services/architectPlanRuntimeService.ts', () => planRuntimeServiceMock);

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

  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../ui/toastService', () => ({
    notify: {
      success: (...args: unknown[]) => notifySuccessMock(...args),
      error: (...args: unknown[]) => notifyErrorMock(...args),
    },
  }));

  ({ StrategyGraph } = await import(`./StrategyGraph.tsx?strategy-graph-test=${importCounter}`));
};

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
        todos: [{ id: 'todo-1', title: 'Architect node todo', status: 'pending' }],
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

const seedEmptyStrategy = () => {
  useAppStore.setState({
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
    planNodes: [],
    predictedBranches: [],
    activePlanContext: {
      id: 'plan-1',
      slug: 'plan-1',
      title: 'Plan One',
      description: 'Plan description',
      status: 'draft',
      targetBranch: 'develop',
    },
  });
};

describe('StrategyGraph', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(async () => {
    await loadStrategyGraphModule();
  });

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
    act(() => {
      root?.unmount();
    });
    await flushRender();
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    expect(
      document.body.querySelector('[data-task-status-indicator-state="idle_prompt"]')
    ).not.toBeNull();
  });

  it('centers the empty strategy state on discussion and generation', async () => {
    seedEmptyStrategy();

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    expect(document.body.textContent).toContain(
      'Discuss the plan with Architect, then generate the strategy when the scope is clear.'
    );
  });

  it('renders a synthetic finalization node after terminal strategy leaves only', async () => {
    useAppStore.setState({
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
      activePlanContext: {
        id: 'plan-1',
        slug: 'plan-1',
        title: 'Plan One',
        description: 'Plan description',
        status: 'validated',
        targetBranch: 'develop',
      },
      planNodes: [
        {
          id: 'task-a',
          title: 'Foundation',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-b',
          title: 'Dependent leaf',
          type: 'task',
          status: 'pending',
          dependencies: ['task-a'],
          projectId: 'project-1',
        },
        {
          id: 'task-c',
          title: 'Independent leaf',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-a',
          name: 'feature/plan-1/foundation',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-a'],
          status: 'merged',
        },
        {
          id: 'branch-b',
          name: 'feature/plan-1/dependent-leaf',
          color: '#10b981',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-b'],
          status: 'pending',
        },
        {
          id: 'branch-c',
          name: 'feature/plan-1/independent-leaf',
          color: '#f59e0b',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-c'],
          status: 'pending',
        },
      ],
    });

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    expect(document.querySelector('[data-graph-node-id="plan-finalization:plan-1"]')).not.toBeNull();
    expect(
      document.querySelector('[data-graph-edge-source="task-b"][data-graph-edge-target="plan-finalization:plan-1"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-graph-edge-source="task-c"][data-graph-edge-target="plan-finalization:plan-1"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-graph-edge-source="task-a"][data-graph-edge-target="plan-finalization:plan-1"]')
    ).toBeNull();
    expect(
      document.body.querySelector('[data-task-status-indicator-state="plan_finalization"]')
    ).not.toBeNull();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(3);
    expect(document.querySelector('[data-branch-task="plan-finalization:plan-1"]')).toBeNull();
  });

  it('renders a pulsing dot when the linked task awaits a response', async () => {
    seedStores('AwaitingResponse');

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    expect(
      document.body.querySelector('[data-task-status-indicator-state="running"]')
    ).not.toBeNull();
  });

  const renderStatusEdgeGraph = async (
    nodes: MockPlanNode[],
    taskStatuses: Record<string, TaskStatus>,
    hoverNodeId: string,
  ) => {
    seedStores('Pending', { includeConversation: false, selectedConversationId: null });
    useAppStore.setState({
      activePlanContext: null,
      planNodes: nodes,
      predictedBranches: [],
    });
    useTaskStore.setState({
      tasks: nodes.map((node, index) => ({
        id: node.id,
        title: node.title,
        status: taskStatuses[node.id] ?? 'Pending',
        task_source: 'architect',
        draft: false,
        archived_at: null,
        project_id: 'project-1',
        project_ids: ['project-1'],
        assigned_branch: `feature/${node.id}`,
        blocked_by: [],
        dependencies: node.dependencies,
        is_blocked: (taskStatuses[node.id] ?? 'Pending') === 'Blocked',
        plan_id: 'plan-1',
        plan_title: 'Plan One',
        sequence_index: index,
        execution_targets: [{ projectId: 'project-1' }],
      })),
    });

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const graphNode = document.querySelector(
      `[data-graph-node-id="${hoverNodeId}"]`
    ) as SVGGElement | null;
    expect(graphNode).not.toBeNull();

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

    act(() => {
      graphNode?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    });
    await flushRender();
  };

  it('marks completed-to-pending graph edge flow as normal and animated', async () => {
    await renderStatusEdgeGraph(
      [
        {
          id: 'task-a',
          title: 'Foundation',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-b',
          title: 'Follow-up',
          type: 'task',
          status: 'pending',
          dependencies: ['task-a'],
          projectId: 'project-1',
        },
      ],
      { 'task-a': 'Completed', 'task-b': 'Pending' },
      'task-b',
    );

    const edge = document.querySelector(
      '[data-graph-edge-source="task-a"][data-graph-edge-target="task-b"]'
    );
    expect(edge?.getAttribute('data-graph-edge-flow-tone')).toBe('normal');
    expect(edge?.getAttribute('data-graph-edge-flow-animated')).toBe('true');
    expect(edge?.getAttribute('stroke-opacity')).toBe('0.6');
    expect(edge?.getAttribute('stroke-width')).toBe('2');
  });

  it('disables motion on graph edge flow when either endpoint is blocked or failed', async () => {
    await renderStatusEdgeGraph(
      [
        {
          id: 'task-a',
          title: 'Blocked source',
          type: 'task',
          status: 'blocked',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-b',
          title: 'Dependent',
          type: 'task',
          status: 'pending',
          dependencies: ['task-a'],
          projectId: 'project-1',
        },
      ],
      { 'task-a': 'Blocked', 'task-b': 'Pending' },
      'task-b',
    );

    const edge = document.querySelector(
      '[data-graph-edge-source="task-a"][data-graph-edge-target="task-b"]'
    );
    expect(edge?.getAttribute('data-graph-edge-flow-tone')).toBe('blocked');
    expect(edge?.getAttribute('data-graph-edge-flow-animated')).toBe('false');
    expect(document.querySelector('animateMotion')).toBeNull();
  });

  it('uses waiting graph edge flow when either endpoint awaits a response', async () => {
    await renderStatusEdgeGraph(
      [
        {
          id: 'task-a',
          title: 'Foundation',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-b',
          title: 'Needs response',
          type: 'task',
          status: 'in-progress',
          dependencies: ['task-a'],
          projectId: 'project-1',
        },
      ],
      { 'task-a': 'Completed', 'task-b': 'AwaitingResponse' },
      'task-b',
    );

    const edge = document.querySelector(
      '[data-graph-edge-source="task-a"][data-graph-edge-target="task-b"]'
    );
    expect(edge?.getAttribute('data-graph-edge-flow-tone')).toBe('waiting');
    expect(edge?.getAttribute('data-graph-edge-flow-animated')).toBe('true');
  });

  it('keeps upstream and downstream hovered graph edges at matching base opacity and width', async () => {
    await renderStatusEdgeGraph(
      [
        {
          id: 'task-a',
          title: 'Upstream',
          type: 'task',
          status: 'completed',
          dependencies: [],
          projectId: 'project-1',
        },
        {
          id: 'task-b',
          title: 'Middle',
          type: 'task',
          status: 'in-progress',
          dependencies: ['task-a'],
          projectId: 'project-1',
        },
        {
          id: 'task-c',
          title: 'Downstream',
          type: 'task',
          status: 'pending',
          dependencies: ['task-b'],
          projectId: 'project-1',
        },
      ],
      { 'task-a': 'Completed', 'task-b': 'InProgress', 'task-c': 'Pending' },
      'task-b',
    );

    const upstreamEdge = document.querySelector(
      '[data-graph-edge-source="task-a"][data-graph-edge-target="task-b"]'
    );
    const downstreamEdge = document.querySelector(
      '[data-graph-edge-source="task-b"][data-graph-edge-target="task-c"]'
    );
    expect(upstreamEdge?.getAttribute('stroke-opacity')).toBe('0.6');
    expect(downstreamEdge?.getAttribute('stroke-opacity')).toBe('0.6');
    expect(upstreamEdge?.getAttribute('stroke-width')).toBe('2');
    expect(downstreamEdge?.getAttribute('stroke-width')).toBe('2');
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    expect(document.body.querySelector('[data-icon="lock"], .lucide-lock')).toBeNull();

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

    act(() => {
      graphNode?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    });
    await flushRender();

    expect(document.body.querySelector('[data-icon="lock"], .lucide-lock')).not.toBeNull();
    expect(document.body.textContent).toContain('Locked');
    expect(document.body.textContent).toContain(
      'can no longer be modified automatically'
    );
  });

  it('shows expected artifact contracts inside graph node tooltips', async () => {
    seedStores('Pending');
    useAppStore.setState({
      planNodes: appState.planNodes.map((node) =>
        node.id === 'task-1'
          ? {
              ...node,
              artifactContracts: [
                {
                  id: 'contract-audit',
                  title: 'Audit findings',
                  kind: 'audit_findings',
                  description: 'Capture the risky flows found during the audit.',
                  required: true,
                },
                {
                  id: 'contract-ux',
                  title: 'Notes de cadrage UX',
                  kind: 'ux_notes',
                  required: false,
                },
              ],
            }
          : node
      ),
    });

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

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

    act(() => {
      graphNode?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    });
    await flushRender();

    expect(document.body.textContent).toContain('Expected artifacts');
    expect(document.body.textContent).toContain('Audit findings');
    expect(document.body.textContent).toContain('Notes de cadrage UX');
    expect(document.body.textContent).not.toContain('Required: Audit findings');
    expect(document.body.textContent).not.toContain('Optional: Notes de cadrage UX');
    expect(document.body.textContent).not.toContain('Capture the risky flows found during the audit.');
  });

  it('omits the expected artifact section when graph nodes have no contracts', async () => {
    seedStores('Pending');

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

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

    act(() => {
      graphNode?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    });
    await flushRender();

    expect(document.body.textContent).not.toContain('Expected artifacts');
  });

  it('shows branch view task todos before expected artifact contracts', async () => {
    seedStores('Pending');
    useAppStore.setState({
      planNodes: appState.planNodes.map((node) =>
        node.id === 'task-1'
          ? {
              ...node,
              artifactContracts: [
                {
                  id: 'contract-audit',
                  title: 'Audit findings',
                  kind: 'audit_findings',
                  description: 'Capture the risky flows found during the audit.',
                  required: true,
                },
              ],
            }
          : node
      ),
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    const taskElement = document.querySelector('[data-branch-task="task-1"]');
    const taskText = taskElement?.textContent || '';
    expect(taskText).toContain('TODO attaché');
    expect(taskText).toContain('Architect node todo');
    expect(taskText).toContain('Expected artifacts');
    expect(taskText).toContain('Audit findings');
    expect(taskText.indexOf('TODO attaché')).toBeLessThan(taskText.indexOf('Architect node todo'));
    expect(taskText.indexOf('Architect node todo')).toBeLessThan(
      taskText.indexOf('Expected artifacts')
    );
    expect(taskText.indexOf('Expected artifacts')).toBeLessThan(
      taskText.indexOf('Audit findings')
    );
    expect(taskText).not.toContain('Required: Audit findings');
    expect(taskText).not.toContain('Capture the risky flows found during the audit.');
  });

  it('groups branch view artifacts with the task that owns them', async () => {
    seedStores('Pending');
    useAppStore.setState({
      planNodes: [
        {
          id: 'task-a',
          title: 'Audit API',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          todos: [{ id: 'todo-a', title: 'Audit API todo', status: 'pending' }],
          artifactContracts: [
            {
              id: 'api-audit',
              title: 'API audit findings',
              kind: 'audit',
              required: true,
            },
          ],
        },
        {
          id: 'task-b',
          title: 'Map UI',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          todos: [{ id: 'todo-b', title: 'Map UI todo', status: 'pending' }],
          artifactContracts: [
            {
              id: 'ui-map',
              title: 'UI migration map',
              kind: 'migration_map',
              required: true,
            },
          ],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/shared',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-a', 'task-b'],
          status: 'pending',
        },
      ],
    });

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(2);
    const auditTaskText = document.querySelector('[data-branch-task="task-a"]')?.textContent || '';
    const mapTaskText = document.querySelector('[data-branch-task="task-b"]')?.textContent || '';
    expect(auditTaskText).toContain('TODO attaché');
    expect(auditTaskText).toContain('Audit API todo');
    expect(auditTaskText).toContain('Expected artifacts');
    expect(auditTaskText).toContain('API audit findings');
    expect(mapTaskText).toContain('TODO attaché');
    expect(mapTaskText).toContain('Map UI todo');
    expect(mapTaskText).toContain('Expected artifacts');
    expect(mapTaskText).toContain('UI migration map');
    expect(auditTaskText.indexOf('Audit API')).toBeLessThan(auditTaskText.indexOf('TODO attaché'));
    expect(auditTaskText.indexOf('TODO attaché')).toBeLessThan(
      auditTaskText.indexOf('Audit API todo')
    );
    expect(auditTaskText.indexOf('Audit API todo')).toBeLessThan(
      auditTaskText.indexOf('Expected artifacts')
    );
    expect(auditTaskText.indexOf('Expected artifacts')).toBeLessThan(
      auditTaskText.indexOf('API audit findings')
    );
    expect(mapTaskText.indexOf('Map UI')).toBeLessThan(mapTaskText.indexOf('TODO attaché'));
    expect(mapTaskText.indexOf('TODO attaché')).toBeLessThan(mapTaskText.indexOf('Map UI todo'));
    expect(mapTaskText.indexOf('Map UI todo')).toBeLessThan(
      mapTaskText.indexOf('Expected artifacts')
    );
    expect(mapTaskText.indexOf('Expected artifacts')).toBeLessThan(
      mapTaskText.indexOf('UI migration map')
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

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

    act(() => {
      lockedBadge?.dispatchEvent(
        new window.MouseEvent('mouseover', { bubbles: true })
      );
    });
    await flushRender();

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
          todos: [
            { id: 'todo-1', title: 'Wire API', status: 'done' },
            { id: 'todo-2', title: 'Update tests', status: 'in-progress' },
            { id: 'todo-3', title: 'Polish responsive states', status: 'pending' },
          ],
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
        {
          id: 'task-5',
          title: 'Empty checklist',
          description: 'Do not render this as an implicit todo',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          todos: [],
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
        {
          id: 'branch-5',
          name: 'feature/empty-checklist',
          color: '#06b6d4',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-5'],
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
        {
          id: 'task-5',
          title: 'Empty checklist',
          status: 'Pending',
          task_source: 'architect',
          draft: false,
          archived_at: null,
          project_id: 'project-1',
          project_ids: ['project-1'],
          assigned_branch: 'feature/empty-checklist',
          blocked_by: [],
          dependencies: [],
          is_blocked: false,
          plan_id: 'plan-1',
          plan_title: 'Plan One',
          sequence_index: 4,
          execution_targets: [{ projectId: 'project-1' }],
        },
      ],
    });

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    expect(document.body.textContent).toContain('Checkout API');
    expect(document.body.textContent).toContain('Wire API');
    expect(document.body.textContent).toContain('Update tests');
    expect(document.body.textContent).toContain('Polish responsive states');
    expect(document.body.textContent).toContain('Progress: 1/3');
    expect(document.body.textContent).toContain('Graph cleanup');
    expect(document.body.textContent).toContain('Plain branch task');
    expect(document.body.textContent).toContain('Branch slug wins');
    expect(document.body.textContent).toContain('Empty checklist');
    expect(document.body.textContent).not.toContain('Sans todo généré');
    expect(document.body.textContent).not.toContain('Do not render this as an implicit todo');
    expect(document.body.textContent).not.toContain('checkout-api');
    expect(document.body.textContent).not.toContain('plain-name');
    expect(document.body.textContent).not.toContain('preferred-name');
    expect(document.body.textContent).not.toContain('feature/plan-1/checkout-api');
    expect(document.body.textContent).not.toContain('feature/graph');
    expect(document.body.textContent).not.toContain('feature/plan-1/internal-name');
  });

  it('does not merge legacy branch cards that contain different task sets', async () => {
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    const branchCards = document.querySelectorAll('[data-branch-card="true"]');
    expect(branchCards).toHaveLength(2);
    expect(document.body.textContent).toContain('shared-feature');
    expect(document.body.textContent).not.toContain('Sans todo généré');
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(0);

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

    act(() => {
      if (searchInput) {
        setInputValue(searchInput, 'Shared');
      }
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(0);

    act(() => {
      if (searchInput) {
        setInputValue(searchInput, '');
      }
    });
    await flushRender();

    const statusFilter = document.querySelector('select') as HTMLSelectElement | null;
    expect(statusFilter).not.toBeNull();
    expect(statusFilter?.parentElement?.className).toContain('min-w-0');
    expect(statusFilter?.parentElement?.className).not.toContain('flex-wrap');
    expect(searchInput?.className).toContain('min-w-0');
    expect(searchInput?.className).toContain('flex-1');
    expect(statusFilter?.className).toContain('w-fit');
    expect(statusFilter?.className).toContain('shrink-0');
    expect(statusFilter?.className).toContain('pr-8');
    expect(statusFilter?.className).toContain('truncate');
    const setSelectValue = (select: HTMLSelectElement, value: string) => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      )?.set;
      valueSetter?.call(select, value);
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };

    act(() => {
      if (statusFilter) {
        setSelectValue(statusFilter, 'completed');
      }
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Sans todo généré');
  });

  it('keeps different tasks separate even when they share the same explicit logical branch slug', async () => {
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Web task');
    expect(document.body.textContent).toContain('API task');
  });

  it('groups repo-specific branch cards for the same multi-project task', async () => {
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
            makeProject('project-1', '/tmp/project-1', 'Web'),
            makeProject('project-2', '/tmp/project-2', 'API'),
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
          id: 'task-shared',
          title: 'Shared task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          branchSlug: 'checkout-api',
          projectId: 'project-1',
          projectIds: ['project-1', 'project-2'],
          todos: [{ id: 'todo-shared', title: 'Shared task todo', status: 'pending' }],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-web',
          name: 'feature/plan-1/checkout-api',
          branchSlug: 'checkout-api',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['task-shared'],
          status: 'pending',
        },
        {
          id: 'branch-api',
          name: 'work/plan-1/checkout-api',
          branchSlug: 'checkout-api',
          color: '#10b981',
          parentBranch: 'roadmap/plan-1',
          projectId: 'project-2',
          taskIds: ['task-shared'],
          status: 'active',
        },
      ],
    });

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-branch-task]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Shared task');
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
          todos: [{ id: 'todo-feature', title: 'Feature checkout todo', status: 'pending' }],
        },
        {
          id: 'task-2',
          title: 'Bugfix checkout',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          todos: [{ id: 'todo-bugfix', title: 'Bugfix checkout todo', status: 'pending' }],
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const branchesButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Branches')
    );
    expect(branchesButton).not.toBeUndefined();

    act(() => {
      branchesButton?.click();
    });
    await flushRender();

    expect(document.querySelectorAll('[data-branch-card="true"]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Feature checkout');
    expect(document.body.textContent).toContain('Bugfix checkout');
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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    expect(document.body.textContent).toContain('Regeneration preview');
    expect(document.body.textContent).toContain('Architect node');
    expect(document.body.textContent).toContain('Rewrite checkout flow');
    expect(document.body.textContent).toContain('Add regression coverage');
    expect(document.body.textContent).toContain('Drop stale workaround');

    const applyButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Apply regeneration')
    );
    expect(applyButton).not.toBeUndefined();

    act(() => {
      applyButton?.click();
    });
    await flushRender();

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

    act(() => {
      root?.render(<StrategyGraph />);
    });
    await flushRender();

    const validateButton = Array.from(
      document.body.querySelectorAll('button')
    ).find((button) => button.textContent?.includes('Validate Plan'));

    expect(validateButton).not.toBeUndefined();

    act(() => {
      validateButton?.click();
    });
    await flushRender();

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
