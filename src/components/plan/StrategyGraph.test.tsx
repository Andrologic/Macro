import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TaskStatus } from '../../types';

type AppMode = 'Chat' | 'Architect' | 'Implement';

type MockProject = {
  id: string;
  name: string;
  mountName: string;
  path: string;
  created_at: string;
  status: 'active';
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
};

type MockPlanContext = {
  id: string;
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
  activePlanContext: MockPlanContext | null;
  setActivePlanContext: (context: MockPlanContext | null) => void;
  setPlanNodes: (nodes: MockPlanNode[]) => void;
  setPredictedBranches: (branches: unknown[]) => void;
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

const validatePlanAndProvisionBranchesMock = mock(async () => ({
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

const notifySuccessMock = mock(() => undefined);
const notifyErrorMock = mock(() => undefined);

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
  const conversationRuntimeById =
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
