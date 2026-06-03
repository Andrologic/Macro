import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Project, Task, TaskExecutionTarget } from '../types';
import * as tauriIpc from '../services/tauriIpc';
import {
  getTerminalScopeKey,
  resolvePreferredManualProjectId,
  resolveSelectedTaskTerminalScope,
  resolveTerminalProjectForRequestedId,
  type LastManualProjectIdByTaskId,
  type TerminalTaskScope,
} from '../services/manualTerminalTargets';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';
import { resolveProjectExecutionContext } from '../services/projectExecutionContext';
import { buildTerminalDisplayMetadata } from '../services/terminalDisplayMetadata';
import { isManualDraftPendingInitialization } from '../services/manualDraftInitialization';
import { useAppStore } from './useAppStore';
import { useChatStore } from './useChatStore';
import { useTaskStore } from './useTaskStore';

const DEFAULT_PANEL_HEIGHT = 280;
const MIN_PANEL_HEIGHT = 180;
const MAX_PANEL_HEIGHT = 520;
const DB_READY_RETRIES = 30;
const DB_READY_DELAY_MS = 200;

export interface TerminalTab {
  id: string;
  kind: 'manual' | 'task';
  taskId: string | null;
  projectId: string;
  projectName: string;
  mountName: string;
  workspacePath: string;
  cwd: string;
  title: string;
  status: string;
  snapshot: string;
  lastCommand: string | null;
  lastExitCode: number | null;
  hasLiveSession: boolean;
  isRestored: boolean;
  outputSequence: number;
  hasUnreadOutput: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ManualTerminalContext extends TerminalTaskScope {
  cwd: string;
  projectLabel: string | null;
  taskLabel: string | null;
  promptContext: tauriIpc.TerminalPromptContextInput | null;
}

type TaskWithTargets = Task & { execution_targets?: TaskExecutionTarget[] };

interface TerminalVisibilityState {
  tabs: Record<string, TerminalTab>;
  tabOrder: string[];
  panelOpen: boolean;
  activeTabId: string | null;
  activeTabIdByScope: Record<string, string>;
  lastManualProjectIdByTaskId: LastManualProjectIdByTaskId;
}

interface TerminalStore extends TerminalVisibilityState {
  initialized: boolean;
  initializing: boolean;
  sessions: Record<string, tauriIpc.TerminalSessionDto>;
  lastSessionIdByProjectId: Record<string, string>;
  panelHeight: number;
  hiddenTerminalTabCount: number;
  lastManualContext: ManualTerminalContext | null;
  upsertSession: (session: tauriIpc.TerminalSessionDto) => tauriIpc.TerminalSessionDto;
  createSession: (params: {
    projectId: string;
    cwd?: string | null;
  }) => Promise<tauriIpc.TerminalSessionDto>;
  runCommand: (params: {
    sessionId: string;
    command: string;
    timeoutMs?: number | null;
  }) => Promise<tauriIpc.TerminalSessionDto>;
  readSession: (sessionId: string) => Promise<tauriIpc.TerminalSessionDto>;
  killSession: (sessionId: string) => Promise<tauriIpc.TerminalSessionDto>;
  initialize: () => Promise<void>;
  togglePanel: () => Promise<void>;
  setPanelOpen: (open: boolean) => void;
  setPanelHeight: (height: number) => void;
  activateTab: (tabId: string) => void;
  getSelectedTaskTerminalScope: () => TerminalTaskScope | null;
  getVisibleTabsForScope: (scope?: TerminalTaskScope | null) => TerminalTab[];
  getTabsForTask: (taskId: string | null) => TerminalTab[];
  hasAnyTabForTask: (taskId: string | null) => boolean;
  getVisibleActiveTabId: (scope?: TerminalTaskScope | null) => string | null;
  getHiddenTerminalTabCount: (scope?: TerminalTaskScope | null) => number;
  getPreferredManualProjectId: (params?: {
    taskId?: string | null;
    selectedProjectId?: string | null;
    projects?: Project[];
  }) => string | null;
  rememberManualProjectForTask: (taskId: string, projectId: string) => void;
  openManualTabForProject: (params: {
    projectId: string;
    groupId?: string | null;
  }) => Promise<TerminalTab>;
  createManualTab: (params?: {
    projectId?: string | null;
    groupId?: string | null;
  }) => Promise<TerminalTab>;
  ensureTaskTab: (params: {
    taskId: string;
    projectId: string;
    cwd: string;
    title: string;
    reveal: boolean;
    promptContext?: tauriIpc.TerminalPromptContextInput | null;
  }) => Promise<TerminalTab>;
  startTaskCommandTab: (params: {
    taskId: string;
    projectId: string;
    cwd: string;
    title: string;
    command: string;
    reveal: boolean;
    promptContext?: tauriIpc.TerminalPromptContextInput | null;
  }) => Promise<TerminalTab>;
  syncTerminalDisplayMetadata: (params?: { taskId?: string | null }) => Promise<void>;
  reconnectTab: (tabId: string) => Promise<TerminalTab>;
  executeCommand: (params: {
    tabId: string;
    command: string;
    reveal?: boolean;
  }) => Promise<TerminalTab>;
  writeInput: (tabId: string, input: string) => Promise<void>;
  resizeTab: (tabId: string, cols: number, rows: number) => Promise<void>;
  interruptTab: (tabId: string) => Promise<TerminalTab>;
  clearTab: (tabId: string) => Promise<TerminalTab>;
  closeTab: (tabId: string) => Promise<void>;
}

const delay = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

const clampPanelHeight = (height: number): number =>
  Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, Math.round(height)));

const mapTabDto = (
  dto: tauriIpc.TerminalTabDto,
  existing?: TerminalTab | null
): TerminalTab => {
  const outputSequence = dto.output_sequence ?? 0;
  const existingSequence = existing?.outputSequence ?? 0;
  const keepExistingSnapshot = Boolean(existing) && outputSequence < existingSequence;

  return {
    id: dto.id,
    kind: dto.kind === 'task' ? 'task' : 'manual',
    taskId: dto.task_id ?? null,
    projectId: dto.project_id,
    projectName: dto.project_name,
    mountName: dto.mount_name,
    workspacePath: dto.workspace_path,
    cwd: dto.cwd,
    title: dto.title,
    status: dto.status,
    snapshot: keepExistingSnapshot ? existing!.snapshot : dto.snapshot,
    lastCommand: dto.last_command ?? null,
    lastExitCode: dto.last_exit_code ?? null,
    hasLiveSession: dto.has_live_session,
    isRestored: dto.is_restored,
    outputSequence: Math.max(outputSequence, existingSequence),
    hasUnreadOutput: existing?.hasUnreadOutput ?? false,
    createdAt: dto.created_at,
    updatedAt: keepExistingSnapshot ? existing!.updatedAt : dto.updated_at,
  };
};

const syncTabOrder = (
  currentOrder: string[],
  tabs: Record<string, TerminalTab>,
  appendedTabId?: string
): string[] => {
  const nextOrder = currentOrder.filter((tabId) => Boolean(tabs[tabId]));

  if (appendedTabId && tabs[appendedTabId] && !nextOrder.includes(appendedTabId)) {
    nextOrder.push(appendedTabId);
  }

  Object.keys(tabs).forEach((tabId) => {
    if (!nextOrder.includes(tabId)) {
      nextOrder.push(tabId);
    }
  });

  return nextOrder;
};

const buildInitialTabOrder = (
  tabDtos: tauriIpc.TerminalTabDto[],
  tabs: Record<string, TerminalTab>
): string[] =>
  syncTabOrder(
    tabDtos.map((dto) => dto.id),
    tabs
  );

const persistActiveTabId = (tabId: string | null) => {
  void savePreference(PREF_KEYS.TERMINAL_ACTIVE_TAB_ID, tabId);
};

const persistPanelHeight = (height: number) => {
  void savePreference(PREF_KEYS.TERMINAL_PANEL_HEIGHT, height);
};

const isLiveTaskCommandTabStatus = (status: string): boolean =>
  status === 'running' || status === 'interrupting';

const normalizeLastManualProjectIdByTaskId = (value: unknown): LastManualProjectIdByTaskId => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce<LastManualProjectIdByTaskId>((acc, [taskId, projectId]) => {
    if (typeof taskId !== 'string' || typeof projectId !== 'string') {
      return acc;
    }

    const normalizedTaskId = taskId.trim();
    const normalizedProjectId = projectId.trim();
    if (!normalizedTaskId || !normalizedProjectId) {
      return acc;
    }

    acc[normalizedTaskId] = normalizedProjectId;
    return acc;
  }, {});
};

const getCurrentSelectedTask = (): TaskWithTargets | null => {
  const appState = useAppStore.getState();
  const taskState = useTaskStore.getState();
  return (
    taskState.tasks.find((task) => task.id === appState.selectedTaskId) as TaskWithTargets | undefined
  ) ?? null;
};

const getManualTerminalUnavailableMessage = (): string => {
  const selectedTask = getCurrentSelectedTask();
  if (isManualDraftPendingInitialization(selectedTask)) {
    return 'Send a first message to name this feature and initialize its terminal.';
  }

  return 'Select a task before opening a terminal.';
};

const resolveSupportedTerminalProject = (projectId: string): { projectId: string; project: Project } => {
  const appState = useAppStore.getState();
  const resolvedProject = resolveTerminalProjectForRequestedId({
    requestedProjectId: projectId,
    standaloneProjects: appState.standaloneProjects,
    projectGroups: appState.projectGroups,
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: appState.selectedProjectId,
    selectedTask: getCurrentSelectedTask(),
    lastManualProjectIdByTaskId: null,
  });
  if (!resolvedProject) {
    throw new Error(`Unknown project id: ${projectId}`);
  }
  if (resolvedProject.project.isReadOnly) {
    throw new Error(`Project "${resolvedProject.project.name}" is read-only. Terminal sessions are unavailable.`);
  }
  return resolvedProject;
};

const assertProjectSupportsTerminal = (projectId: string): Project => {
  return resolveSupportedTerminalProject(projectId).project;
};

const resolvePromptTaskLabel = (
  task: TaskWithTargets | null,
  conversations: Array<{ id: string; title: string; task_id?: string | null }>
): string | null => {
  if (!task) {
    return null;
  }

  const normalizedTaskTitle = typeof task.title === 'string' ? task.title.trim() : '';
  if (normalizedTaskTitle) {
    return normalizedTaskTitle;
  }

  const conversationTitle = task.conversation_id
    ? conversations.find((conversation) => conversation.id === task.conversation_id)?.title
    : conversations.find((conversation) => conversation.task_id === task.id)?.title;
  const normalizedConversationTitle = typeof conversationTitle === 'string' ? conversationTitle.trim() : '';
  if (normalizedConversationTitle) {
    return normalizedConversationTitle;
  }

  return task.id;
};

const resolveProjectLabelFromProject = (
  project: Pick<Project, 'mountName' | 'name'> | null | undefined
): string | null => {
  const mountName = typeof project?.mountName === 'string' ? project.mountName.trim() : '';
  if (mountName) {
    return mountName;
  }

  const name = typeof project?.name === 'string' ? project.name.trim() : '';
  return name || null;
};

const resolveProjectLabelFromTab = (
  tab: Pick<TerminalTab, 'mountName' | 'projectName'>
): string | null => {
  const mountName = typeof tab.mountName === 'string' ? tab.mountName.trim() : '';
  if (mountName) {
    return mountName;
  }

  const projectName = typeof tab.projectName === 'string' ? tab.projectName.trim() : '';
  return projectName || null;
};

const normalizeSessionCwd = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isAbsoluteSessionCwd = (value: string): boolean => /^(?:[a-zA-Z]:[\\/]|\/)/.test(value);

const joinSessionCwd = (basePath: string, relativePath: string): string => {
  const normalizedBase = basePath.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');

  if (!normalizedBase) {
    return normalizedRelative;
  }

  if (!normalizedRelative || normalizedRelative === '.') {
    return normalizedBase;
  }

  return `${normalizedBase}/${normalizedRelative}`;
};

const resolveSessionBaseCwd = (projectId: string, fallbackProjectPath: string): string => {
  const appState = useAppStore.getState();
  const taskState = useTaskStore.getState();
  const chatState = useChatStore.getState();
  const executionContext = resolveProjectExecutionContext({
    mode: appState.mode,
    projects: [
      ...(appState.standaloneProjects ?? []),
      ...appState.projectGroups.flatMap((group) => group.projects),
    ],
    projectGroups: appState.projectGroups,
    tasks: taskState.tasks,
    conversations: chatState.conversations,
    conversationId: chatState.selectedConversationId,
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: projectId,
    selectedTaskId: appState.selectedTaskId,
    activeRepositoryPath: taskState.activeRepositoryPath,
    workspacePathOverridesByProjectId: taskState.activeWorkspacePathOverridesByProjectId,
    branchWorktrees: taskState.branchWorktrees,
  });

  if (executionContext.taskId) {
    return (
      executionContext.workspacePathsByProjectId[projectId] ||
      executionContext.workspacePath ||
      fallbackProjectPath
    );
  }

  return fallbackProjectPath;
};

const resolveSessionCreationCwd = (params: {
  projectId: string;
  projectPath: string;
  cwd?: string | null;
}): string => {
  const requestedCwd = normalizeSessionCwd(params.cwd);
  const baseCwd = resolveSessionBaseCwd(params.projectId, params.projectPath);

  if (!requestedCwd) {
    return baseCwd;
  }

  if (isAbsoluteSessionCwd(requestedCwd)) {
    return requestedCwd;
  }

  return joinSessionCwd(baseCwd, requestedCwd);
};

const getManualInstanceIndexForTab = (params: {
  tabs: TerminalTab[];
  targetTabId: string;
}): number | null => {
  const sortedTabs = [...params.tabs].sort((left, right) => {
    const createdDelta = left.createdAt.localeCompare(right.createdAt);
    if (createdDelta !== 0) {
      return createdDelta;
    }

    return left.id.localeCompare(right.id);
  });
  const index = sortedTabs.findIndex((tab) => tab.id === params.targetTabId);
  return index >= 0 ? index + 1 : null;
};

const getNextManualInstanceIndex = (tabs: TerminalTab[]): number =>
  [...tabs]
    .sort((left, right) => {
      const createdDelta = left.createdAt.localeCompare(right.createdAt);
      if (createdDelta !== 0) {
        return createdDelta;
      }

      return left.id.localeCompare(right.id);
    })
    .length + 1;

const resolveCurrentTerminalScope = (
  lastManualProjectIdByTaskId: LastManualProjectIdByTaskId
): TerminalTaskScope | null => {
  const appState = useAppStore.getState();

  return resolveSelectedTaskTerminalScope({
    standaloneProjects: appState.standaloneProjects,
    projectGroups: appState.projectGroups,
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: appState.selectedProjectId,
    selectedTask: getCurrentSelectedTask(),
    lastManualProjectIdByTaskId,
  });
};

const resolveManualTerminalContext = (params?: {
  projectId?: string | null;
  groupId?: string | null;
  lastManualProjectIdByTaskId?: LastManualProjectIdByTaskId | null;
}): ManualTerminalContext | null => {
  const appState = useAppStore.getState();
  const taskState = useTaskStore.getState();
  const chatState = useChatStore.getState();
  const selectedTask = getCurrentSelectedTask();
  const scope = resolveSelectedTaskTerminalScope({
    standaloneProjects: appState.standaloneProjects,
    projectGroups: appState.projectGroups,
    selectedGroupId: params?.groupId?.trim() || appState.selectedGroupId,
    selectedProjectId: params?.projectId?.trim() || appState.selectedProjectId,
    selectedTask,
    lastManualProjectIdByTaskId: params?.lastManualProjectIdByTaskId,
  });

  if (!scope) {
    return null;
  }

  const targetProjectId =
    params?.projectId && scope.scopedProjectIds.includes(params.projectId)
      ? params.projectId
      : scope.preferredProjectId;
  const allProjects = [
    ...(appState.standaloneProjects ?? []),
    ...appState.projectGroups.flatMap((group) => group.projects),
  ];
  const targetProject = allProjects.find((project) => project.id === targetProjectId) ?? null;
  if (!targetProject) {
    return null;
  }

  const resolvedContext = resolveProjectExecutionContext({
    mode: appState.mode,
    projects: allProjects,
    projectGroups: appState.projectGroups,
    tasks: taskState.tasks,
    conversations: chatState.conversations,
    conversationId: chatState.selectedConversationId,
    selectedGroupId: scope.groupId,
    selectedProjectId: targetProjectId,
    selectedTaskId: scope.taskId,
    activeRepositoryPath: taskState.activeRepositoryPath,
    workspacePathOverridesByProjectId: taskState.activeWorkspacePathOverridesByProjectId,
    branchWorktrees: taskState.branchWorktrees,
  });
  const cwd =
    resolvedContext.workspacePathsByProjectId[targetProjectId] ||
    resolvedContext.workspacePath ||
    targetProject.path;

  if (!cwd) {
    return null;
  }

  const projectLabel = resolveProjectLabelFromProject(targetProject);
  const taskLabel = resolvePromptTaskLabel(selectedTask, chatState.conversations);
  const promptContext = buildTerminalDisplayMetadata({
    projectLabel,
    taskLabel,
  }).promptContext;

  return {
    ...scope,
    projectId: targetProjectId,
    preferredProjectId: scope.preferredProjectId,
    cwd,
    projectLabel,
    taskLabel,
    promptContext,
  };
};

const getScopeKeyForTab = (tab: Pick<TerminalTab, 'taskId' | 'projectId'>): string | null =>
  tab.taskId ? getTerminalScopeKey(tab.taskId, tab.projectId) : null;

const getOrderedTabs = (
  tabs: Record<string, TerminalTab>,
  tabOrder: string[]
): TerminalTab[] =>
  tabOrder
    .map((tabId) => tabs[tabId])
    .filter((tab): tab is TerminalTab => Boolean(tab));

const getTabsForTaskFromState = (
  state: Pick<TerminalVisibilityState, 'tabs' | 'tabOrder'>,
  taskId: string | null
): TerminalTab[] =>
  taskId
    ? getOrderedTabs(state.tabs, state.tabOrder).filter((tab) => tab.taskId === taskId)
    : [];

const getVisibleTabsForScopeFromState = (
  state: Pick<TerminalVisibilityState, 'tabs' | 'tabOrder'>,
  scope: TerminalTaskScope | null | undefined
): TerminalTab[] => {
  if (!scope) {
    return [];
  }

  return getTabsForTaskFromState(state, scope.taskId).filter(
    (tab) => tab.projectId === scope.projectId
  );
};

const rebuildActiveTabIdByScope = (params: {
  tabs: Record<string, TerminalTab>;
  tabOrder: string[];
  previous: Record<string, string>;
  preferredTabId?: string | null;
}): Record<string, string> => {
  const next: Record<string, string> = {};

  Object.entries(params.previous).forEach(([scopeKey, tabId]) => {
    const tab = params.tabs[tabId];
    if (!tab) {
      return;
    }

    if (getScopeKeyForTab(tab) === scopeKey) {
      next[scopeKey] = tabId;
    }
  });

  params.tabOrder.forEach((tabId) => {
    const tab = params.tabs[tabId];
    if (!tab) {
      return;
    }

    const scopeKey = getScopeKeyForTab(tab);
    if (scopeKey && !next[scopeKey]) {
      next[scopeKey] = tabId;
    }
  });

  if (params.preferredTabId && params.tabs[params.preferredTabId]) {
    const preferredScopeKey = getScopeKeyForTab(params.tabs[params.preferredTabId]);
    if (preferredScopeKey) {
      next[preferredScopeKey] = params.preferredTabId;
    }
  }

  return next;
};

const getVisibleActiveTabIdFromState = (
  state: Pick<TerminalVisibilityState, 'tabs' | 'tabOrder' | 'activeTabId' | 'activeTabIdByScope'>,
  scope: TerminalTaskScope | null | undefined
): string | null => {
  const visibleTabs = getVisibleTabsForScopeFromState(state, scope);
  if (visibleTabs.length === 0 || !scope) {
    return null;
  }

  const visibleTabIds = new Set(visibleTabs.map((tab) => tab.id));
  const scopedActiveTabId = state.activeTabIdByScope[getTerminalScopeKey(scope.taskId, scope.projectId)];
  if (scopedActiveTabId && visibleTabIds.has(scopedActiveTabId)) {
    return scopedActiveTabId;
  }

  if (state.activeTabId && visibleTabIds.has(state.activeTabId)) {
    return state.activeTabId;
  }

  return visibleTabs[0]?.id ?? null;
};

const computeHiddenCountForScope = (
  state: TerminalVisibilityState,
  scope: TerminalTaskScope | null
): number => {
  const visibleTabs = getVisibleTabsForScopeFromState(state, scope);
  if (visibleTabs.length === 0) {
    return 0;
  }

  const activeTabId = getVisibleActiveTabIdFromState(state, scope);
  return visibleTabs.filter((tab) => {
    if (state.panelOpen) {
      return tab.id !== activeTabId && tab.hasUnreadOutput;
    }
    return tab.hasUnreadOutput || tab.status === 'running';
  }).length;
};

export const useTerminalStore = create<TerminalStore>((set, get) => {
  let initializePromise: Promise<void> | null = null;
  let eventUnlisteners: UnlistenFn[] = [];
  let pendingOutputEvents: Record<string, tauriIpc.TerminalOutputEvent> = {};
  let outputFlushTimer: number | null = null;

  const computeCurrentHiddenCount = (state: TerminalVisibilityState): number =>
    computeHiddenCountForScope(state, resolveCurrentTerminalScope(state.lastManualProjectIdByTaskId));

  const syncTabMetadataLocally = (tab: TerminalTab) => {
    upsertTab(tab, {});
  };

  const upsertTab = (nextTab: TerminalTab, options?: { activate?: boolean; openPanel?: boolean }) => {
    set((state) => {
      const existing = state.tabs[nextTab.id];
      const currentScope = resolveCurrentTerminalScope(state.lastManualProjectIdByTaskId);
      const activeVisibleTabId = getVisibleActiveTabIdFromState(state, currentScope);
      const panelOpen = options?.openPanel ?? state.panelOpen;
      const hasUnreadOutput =
        options?.activate || (panelOpen && activeVisibleTabId === nextTab.id)
          ? false
          : existing?.hasUnreadOutput ?? nextTab.hasUnreadOutput;
      const tabs = {
        ...state.tabs,
        [nextTab.id]: {
          ...nextTab,
          hasUnreadOutput,
        },
      };
      const tabOrder = syncTabOrder(state.tabOrder, tabs, existing ? undefined : nextTab.id);
      const activeTabIdByScope = rebuildActiveTabIdByScope({
        tabs,
        tabOrder,
        previous: state.activeTabIdByScope,
        preferredTabId: options?.activate ? nextTab.id : null,
      });
      const activeTabId =
        options?.activate
          ? nextTab.id
          : state.activeTabId && tabs[state.activeTabId]
            ? state.activeTabId
            : tabOrder[0] ?? null;
      const nextState: TerminalVisibilityState = {
        tabs,
        tabOrder,
        panelOpen,
        activeTabId,
        activeTabIdByScope,
        lastManualProjectIdByTaskId: state.lastManualProjectIdByTaskId,
      };

      return {
        tabs,
        tabOrder,
        panelOpen,
        activeTabId,
        activeTabIdByScope,
        hiddenTerminalTabCount: computeCurrentHiddenCount(nextState),
      };
    });
    if (options?.activate) {
      persistActiveTabId(nextTab.id);
    }
  };

  const removeTabLocally = (tabId: string) => {
    let nextActiveTabId: string | null = null;

    set((state) => {
      if (!state.tabs[tabId]) {
        return state;
      }

      const { [tabId]: _removed, ...tabs } = state.tabs;
      const tabOrder = syncTabOrder(state.tabOrder, tabs);
      const activeTabIdByScope = rebuildActiveTabIdByScope({
        tabs,
        tabOrder,
        previous: state.activeTabIdByScope,
      });
      const provisionalActiveTabId =
        state.activeTabId === tabId ? null : state.activeTabId && tabs[state.activeTabId] ? state.activeTabId : null;
      const nextState: TerminalVisibilityState = {
        tabs,
        tabOrder,
        panelOpen: tabOrder.length > 0 ? state.panelOpen : false,
        activeTabId: provisionalActiveTabId,
        activeTabIdByScope,
        lastManualProjectIdByTaskId: state.lastManualProjectIdByTaskId,
      };
      nextActiveTabId =
        provisionalActiveTabId ||
        getVisibleActiveTabIdFromState(
          nextState,
          resolveCurrentTerminalScope(nextState.lastManualProjectIdByTaskId)
        ) ||
        tabOrder[0] ||
        null;
      const finalState: TerminalVisibilityState = {
        ...nextState,
        activeTabId: nextActiveTabId,
      };

      return {
        tabs,
        tabOrder,
        panelOpen: finalState.panelOpen,
        activeTabId: nextActiveTabId,
        activeTabIdByScope,
        hiddenTerminalTabCount: computeCurrentHiddenCount(finalState),
      };
    });

    persistActiveTabId(nextActiveTabId);
  };

  const loadTabsWithRetry = async (): Promise<tauriIpc.TerminalTabDto[]> => {
    if (!tauriIpc.isTauriAvailable()) {
      return [];
    }

    for (let attempt = 0; attempt < DB_READY_RETRIES; attempt += 1) {
      try {
        return await tauriIpc.terminalListTabs();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Database not initialized') || attempt === DB_READY_RETRIES - 1) {
          throw error;
        }
        await delay(DB_READY_DELAY_MS);
      }
    }

    return [];
  };

  const registerListeners = async () => {
    if (!tauriIpc.isTauriAvailable() || eventUnlisteners.length > 0) {
      return;
    }

    const flushPendingOutputEvents = () => {
      outputFlushTimer = null;
      const queuedEvents = Object.values(pendingOutputEvents);
      pendingOutputEvents = {};

      if (queuedEvents.length === 0) {
        return;
      }

      set((state) => {
        const currentScope = resolveCurrentTerminalScope(state.lastManualProjectIdByTaskId);
        const activeVisibleTabId = getVisibleActiveTabIdFromState(state, currentScope);
        let tabs = state.tabs;
        let changed = false;

        queuedEvents.forEach((payload) => {
          const existing = tabs[payload.tab_id];
          if (!existing) {
            return;
          }
          if ((payload.sequence ?? 0) < existing.outputSequence) {
            return;
          }

          if (!changed) {
            tabs = { ...tabs };
            changed = true;
          }

          tabs[existing.id] = {
            ...existing,
            snapshot: payload.snapshot,
            outputSequence: Math.max(payload.sequence ?? 0, existing.outputSequence),
            updatedAt: payload.updated_at,
            hasUnreadOutput: state.panelOpen && activeVisibleTabId === existing.id ? false : true,
          };
        });

        if (!changed) {
          return state;
        }

        const nextState: TerminalVisibilityState = {
          tabs,
          tabOrder: state.tabOrder,
          panelOpen: state.panelOpen,
          activeTabId: state.activeTabId,
          activeTabIdByScope: state.activeTabIdByScope,
          lastManualProjectIdByTaskId: state.lastManualProjectIdByTaskId,
        };

        return {
          tabs,
          hiddenTerminalTabCount: computeCurrentHiddenCount(nextState),
        };
      });
    };

    const queueOutputEvent = (payload: tauriIpc.TerminalOutputEvent) => {
      const existing = pendingOutputEvents[payload.tab_id];
      if (!existing || (payload.sequence ?? 0) >= (existing.sequence ?? 0)) {
        pendingOutputEvents[payload.tab_id] = payload;
      }

      if (outputFlushTimer !== null) {
        return;
      }

      if (typeof window === 'undefined') {
        flushPendingOutputEvents();
        return;
      }

      outputFlushTimer = window.setTimeout(() => {
        flushPendingOutputEvents();
      }, 16);
    };

    eventUnlisteners = await Promise.all([
      listen<tauriIpc.TerminalOutputEvent>('terminal:output', (event) => {
        queueOutputEvent(event.payload);
      }),
      listen<tauriIpc.TerminalTabDto>('terminal:tab', (event) => {
        const existing = get().tabs[event.payload.id];
        const nextTab = mapTabDto(event.payload, existing);
        upsertTab(nextTab, {});
        if (nextTab.kind === 'task' && !isLiveTaskCommandTabStatus(nextTab.status)) {
          useTaskStore.getState().handleTaskCommandTerminalClosed(nextTab.id);
        }
      }),
      listen<{ tab_id: string }>('terminal:closed', (event) => {
        useTaskStore.getState().handleTaskCommandTerminalClosed(event.payload.tab_id);
        removeTabLocally(event.payload.tab_id);
      }),
    ]);
  };

  const persistLastManualProjectSelection = (taskId: string, projectId: string) => {
    const nextValue = {
      ...get().lastManualProjectIdByTaskId,
      [taskId]: projectId,
    };
    set({
      lastManualProjectIdByTaskId: nextValue,
      hiddenTerminalTabCount: computeCurrentHiddenCount({
        tabs: get().tabs,
        tabOrder: get().tabOrder,
        panelOpen: get().panelOpen,
        activeTabId: get().activeTabId,
        activeTabIdByScope: get().activeTabIdByScope,
        lastManualProjectIdByTaskId: nextValue,
      }),
    });
    void savePreference(PREF_KEYS.TERMINAL_LAST_MANUAL_PROJECT_BY_TASK, nextValue);
  };

  return {
    initialized: false,
    initializing: false,
    sessions: {},
    lastSessionIdByProjectId: {},
    tabs: {},
    tabOrder: [],
    panelOpen: false,
    panelHeight: DEFAULT_PANEL_HEIGHT,
    activeTabId: null,
    activeTabIdByScope: {},
    hiddenTerminalTabCount: 0,
    lastManualContext: null,
    lastManualProjectIdByTaskId: {},

    upsertSession: (session) => {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [session.id]: session,
        },
        lastSessionIdByProjectId: {
          ...state.lastSessionIdByProjectId,
          [session.project_id]: session.id,
        },
      }));
      return session;
    },

    createSession: async ({ projectId, cwd }) => {
      const resolvedProject = resolveSupportedTerminalProject(projectId);
      const session = await tauriIpc.terminalCreateSession({
        projectId: resolvedProject.projectId,
        cwd: resolveSessionCreationCwd({
          projectId: resolvedProject.projectId,
          projectPath: resolvedProject.project.path,
          cwd: cwd ?? null,
        }),
      });
      return get().upsertSession(session);
    },

    runCommand: async ({ sessionId, command, timeoutMs }) => {
      const session = await tauriIpc.terminalRun({
        sessionId,
        command,
        timeoutMs: timeoutMs ?? null,
      });
      return get().upsertSession(session);
    },

    readSession: async (sessionId) => {
      const session = await tauriIpc.terminalRead(sessionId);
      return get().upsertSession(session);
    },

    killSession: async (sessionId) => {
      const session = await tauriIpc.terminalKill(sessionId);
      return get().upsertSession(session);
    },

    initialize: async () => {
      if (get().initialized) {
        return;
      }
      if (initializePromise) {
        return initializePromise;
      }

      initializePromise = (async () => {
        set({ initializing: true });
        try {
          const [savedHeight, savedActiveTabId, savedLastManualProjects] = await Promise.all([
            loadPreference<number>(PREF_KEYS.TERMINAL_PANEL_HEIGHT),
            loadPreference<string | null>(PREF_KEYS.TERMINAL_ACTIVE_TAB_ID),
            loadPreference<LastManualProjectIdByTaskId | null>(
              PREF_KEYS.TERMINAL_LAST_MANUAL_PROJECT_BY_TASK
            ),
          ]);
          const lastManualProjectIdByTaskId = normalizeLastManualProjectIdByTaskId(
            savedLastManualProjects
          );
          const tabDtos = await loadTabsWithRetry();
          const tabs = tabDtos.reduce<Record<string, TerminalTab>>((acc, dto) => {
            const mapped = mapTabDto(dto);
            acc[mapped.id] = mapped;
            return acc;
          }, {});
          const tabOrder = buildInitialTabOrder(tabDtos, tabs);
          const activeTabIdByScope = rebuildActiveTabIdByScope({
            tabs,
            tabOrder,
            previous: {},
            preferredTabId: savedActiveTabId && tabs[savedActiveTabId] ? savedActiveTabId : null,
          });
          const activeTabId =
            (savedActiveTabId && tabs[savedActiveTabId] ? savedActiveTabId : null) ||
            tabOrder[0] ||
            null;
          const nextState: TerminalVisibilityState = {
            tabs,
            tabOrder,
            panelOpen: false,
            activeTabId,
            activeTabIdByScope,
            lastManualProjectIdByTaskId,
          };

          set({
            initialized: true,
            initializing: false,
            tabs,
            tabOrder,
            activeTabId,
            activeTabIdByScope,
            panelHeight: clampPanelHeight(savedHeight ?? DEFAULT_PANEL_HEIGHT),
            lastManualProjectIdByTaskId,
            hiddenTerminalTabCount: computeCurrentHiddenCount(nextState),
          });
          await registerListeners();
          await get().syncTerminalDisplayMetadata();
        } catch (error) {
          set({ initializing: false });
          throw error;
        }
      })().finally(() => {
        initializePromise = null;
      });

      return initializePromise;
    },

    togglePanel: async () => {
      await get().initialize();
      if (get().panelOpen) {
        get().setPanelOpen(false);
        return;
      }

      const scope = get().getSelectedTaskTerminalScope();
      if (!scope) {
        return;
      }

      if (!get().hasAnyTabForTask(scope.taskId)) {
        await get().createManualTab();
        return;
      }

      get().setPanelOpen(true);
    },

    setPanelOpen: (open) => {
      set((state) => {
        const nextState: TerminalVisibilityState = {
          tabs: state.tabs,
          tabOrder: state.tabOrder,
          panelOpen: open,
          activeTabId: state.activeTabId,
          activeTabIdByScope: state.activeTabIdByScope,
          lastManualProjectIdByTaskId: state.lastManualProjectIdByTaskId,
        };

        return {
          panelOpen: open,
          hiddenTerminalTabCount: computeCurrentHiddenCount(nextState),
        };
      });
    },

    setPanelHeight: (height) => {
      const nextHeight = clampPanelHeight(height);
      set({ panelHeight: nextHeight });
      persistPanelHeight(nextHeight);
    },

    activateTab: (tabId) => {
      let persistedTabId: string | null = null;

      set((state) => {
        const existing = state.tabs[tabId];
        if (!existing) {
          return state;
        }

        const tabs = {
          ...state.tabs,
          [tabId]: {
            ...existing,
            hasUnreadOutput: false,
          },
        };
        const activeTabIdByScope = rebuildActiveTabIdByScope({
          tabs,
          tabOrder: state.tabOrder,
          previous: state.activeTabIdByScope,
          preferredTabId: tabId,
        });
        const nextState: TerminalVisibilityState = {
          tabs,
          tabOrder: state.tabOrder,
          panelOpen: state.panelOpen,
          activeTabId: tabId,
          activeTabIdByScope,
          lastManualProjectIdByTaskId: state.lastManualProjectIdByTaskId,
        };
        persistedTabId = tabId;

        return {
          tabs,
          activeTabId: tabId,
          activeTabIdByScope,
          hiddenTerminalTabCount: computeCurrentHiddenCount(nextState),
        };
      });

      persistActiveTabId(persistedTabId);
    },

    getSelectedTaskTerminalScope: () =>
      resolveCurrentTerminalScope(get().lastManualProjectIdByTaskId),

    getVisibleTabsForScope: (scope) =>
      getVisibleTabsForScopeFromState(
        {
          tabs: get().tabs,
          tabOrder: get().tabOrder,
        },
        scope ?? get().getSelectedTaskTerminalScope()
      ),

    getTabsForTask: (taskId) =>
      getTabsForTaskFromState(
        {
          tabs: get().tabs,
          tabOrder: get().tabOrder,
        },
        taskId
      ),

    hasAnyTabForTask: (taskId) => get().getTabsForTask(taskId).length > 0,

    getVisibleActiveTabId: (scope) =>
      getVisibleActiveTabIdFromState(
        {
          tabs: get().tabs,
          tabOrder: get().tabOrder,
          activeTabId: get().activeTabId,
          activeTabIdByScope: get().activeTabIdByScope,
        },
        scope ?? get().getSelectedTaskTerminalScope()
      ),

    getHiddenTerminalTabCount: (scope) =>
      computeHiddenCountForScope(
        {
          tabs: get().tabs,
          tabOrder: get().tabOrder,
          panelOpen: get().panelOpen,
          activeTabId: get().activeTabId,
          activeTabIdByScope: get().activeTabIdByScope,
          lastManualProjectIdByTaskId: get().lastManualProjectIdByTaskId,
        },
        scope ?? get().getSelectedTaskTerminalScope()
      ),

    getPreferredManualProjectId: (params) => {
      const scope = get().getSelectedTaskTerminalScope();
      const taskId = params?.taskId ?? scope?.taskId ?? null;
      const selectedProjectId =
        params?.selectedProjectId ?? useAppStore.getState().selectedProjectId ?? null;
      const projects = params?.projects ?? scope?.projects ?? [];

      return resolvePreferredManualProjectId({
        taskId,
        selectedProjectId,
        projects,
        lastManualProjectIdByTaskId: get().lastManualProjectIdByTaskId,
      });
    },

    rememberManualProjectForTask: (taskId, projectId) => {
      persistLastManualProjectSelection(taskId, projectId);
    },

    openManualTabForProject: async ({ projectId, groupId }) => {
      await get().initialize();
      if (isManualDraftPendingInitialization(getCurrentSelectedTask())) {
        throw new Error(getManualTerminalUnavailableMessage());
      }

      assertProjectSupportsTerminal(projectId);

      const context = resolveManualTerminalContext({
        projectId,
        groupId,
        lastManualProjectIdByTaskId: get().lastManualProjectIdByTaskId,
      });

      if (!context) {
        throw new Error(getManualTerminalUnavailableMessage());
      }

      const siblingTabs = get()
        .getTabsForTask(context.taskId)
        .filter((tab) => tab.kind === 'manual' && tab.projectId === context.projectId);
      const instanceIndex = getNextManualInstanceIndex(siblingTabs);
      const displayMetadata = buildTerminalDisplayMetadata({
        projectLabel: context.projectLabel,
        taskLabel: context.taskLabel,
        instanceIndex,
      });

      const dto = await tauriIpc.terminalCreateTab({
        kind: 'manual',
        projectId: context.projectId,
        cwd: context.cwd,
        title: displayMetadata.title,
        taskId: context.taskId,
        promptContext: displayMetadata.promptContext,
      });
      const tab = mapTabDto(dto);
      upsertTab(tab, { activate: true, openPanel: true });
      persistLastManualProjectSelection(context.taskId, context.projectId);
      set({ lastManualContext: context });
      return tab;
    },

    createManualTab: async (params) => {
      await get().initialize();
      if (isManualDraftPendingInitialization(getCurrentSelectedTask())) {
        throw new Error(getManualTerminalUnavailableMessage());
      }

      const context = resolveManualTerminalContext({
        projectId: params?.projectId ?? null,
        groupId: params?.groupId ?? null,
        lastManualProjectIdByTaskId: get().lastManualProjectIdByTaskId,
      });

      if (!context) {
        throw new Error(getManualTerminalUnavailableMessage());
      }

      return get().openManualTabForProject({
        projectId: context.projectId,
        groupId: context.groupId,
      });
    },

    ensureTaskTab: async ({ taskId, projectId, cwd, title, reveal, promptContext }) => {
      await get().initialize();
      const resolvedProject = resolveSupportedTerminalProject(projectId);
      const resolvedProjectId = resolvedProject.projectId;
      const existing = Object.values(get().tabs).find(
        (tab) => tab.kind === 'task' && tab.taskId === taskId && tab.projectId === resolvedProjectId
      );
      const dto = existing
        ? existing.hasLiveSession
          ? await tauriIpc.terminalReadTab(existing.id)
          : await tauriIpc.terminalReconnectTab(existing.id)
        : await tauriIpc.terminalCreateTab({
            kind: 'task',
            projectId: resolvedProjectId,
            cwd,
            title,
            taskId,
            promptContext: promptContext ?? null,
          });

      const tab = mapTabDto(dto, existing);
      upsertTab(tab, { activate: reveal, openPanel: reveal ? true : undefined });
      return tab;
    },

    startTaskCommandTab: async ({ taskId, projectId, cwd, title, command, reveal, promptContext }) => {
      await get().initialize();
      const resolvedProject = resolveSupportedTerminalProject(projectId);
      const resolvedProjectId = resolvedProject.projectId;
      const dto = await tauriIpc.terminalStartCommandTab({
        kind: 'task',
        projectId: resolvedProjectId,
        cwd,
        title,
        taskId,
        promptContext: promptContext ?? null,
        command,
      });
      const tab = mapTabDto(dto);
      upsertTab(tab, { activate: reveal, openPanel: reveal ? true : undefined });
      return tab;
    },

    syncTerminalDisplayMetadata: async (params) => {
      await get().initialize();

      const appState = useAppStore.getState();
      const taskState = useTaskStore.getState();
      const chatState = useChatStore.getState();
      const allProjects = [
        ...(appState.standaloneProjects ?? []),
        ...appState.projectGroups.flatMap((group) => group.projects),
      ];
      const orderedTabs = getOrderedTabs(get().tabs, get().tabOrder);
      const tabsToSync = orderedTabs.filter((tab) => {
        if (!tab.taskId) {
          return false;
        }

        return !params?.taskId || tab.taskId === params.taskId;
      });

      for (const tab of tabsToSync) {
        const task = taskState.tasks.find((candidate) => candidate.id === tab.taskId) ?? null;
        const project = allProjects.find((candidate) => candidate.id === tab.projectId) ?? null;
        const projectLabel = project
          ? resolveProjectLabelFromProject(project)
          : resolveProjectLabelFromTab(tab);
        const taskLabel = resolvePromptTaskLabel(task, chatState.conversations);
        const relatedTabs = orderedTabs.filter(
          (candidate) =>
            candidate.kind === 'manual' &&
            candidate.taskId === tab.taskId &&
            candidate.projectId === tab.projectId
        );
        const instanceIndex =
          tab.kind === 'manual'
            ? getManualInstanceIndexForTab({
                tabs: relatedTabs,
                targetTabId: tab.id,
              })
            : null;
        const displayMetadata = buildTerminalDisplayMetadata({
          projectLabel,
          taskLabel,
          instanceIndex,
        });

        const nextTitle =
          tab.kind === 'manual'
            ? displayMetadata.title
            : buildTerminalDisplayMetadata({
                projectLabel,
                taskLabel,
              }).title;
        const nextPromptContext = displayMetadata.promptContext;

        const dto = await tauriIpc.terminalUpdateTabMetadata({
          tabId: tab.id,
          title: nextTitle,
          promptContext: nextPromptContext,
        });
        syncTabMetadataLocally(mapTabDto(dto, get().tabs[tab.id]));
      }
    },

    reconnectTab: async (tabId) => {
      const existingTab = get().tabs[tabId];
      if (existingTab?.taskId) {
        await get().syncTerminalDisplayMetadata({ taskId: existingTab.taskId });
      }
      const dto = await tauriIpc.terminalReconnectTab(tabId);
      const tab = mapTabDto(dto, get().tabs[tabId]);
      upsertTab(tab, {});
      return tab;
    },

    executeCommand: async ({ tabId, command, reveal = false }) => {
      const dto = await tauriIpc.terminalExecuteCommand({ tabId, command });
      const tab = mapTabDto(dto, get().tabs[tabId]);
      upsertTab(tab, { activate: reveal, openPanel: reveal ? true : undefined });
      return tab;
    },

    writeInput: async (tabId, input) => {
      await tauriIpc.terminalWriteInput({ tabId, input });
    },

    resizeTab: async (tabId, cols, rows) => {
      await tauriIpc.terminalResize({
        tabId,
        cols,
        rows,
      });
    },

    interruptTab: async (tabId) => {
      const dto = await tauriIpc.terminalInterrupt(tabId);
      const tab = mapTabDto(dto, get().tabs[tabId]);
      upsertTab(tab, {});
      return tab;
    },

    clearTab: async (tabId) => {
      const dto = await tauriIpc.terminalClearTab(tabId);
      const tab = mapTabDto(dto, get().tabs[tabId]);
      upsertTab(
        {
          ...tab,
          hasUnreadOutput: false,
        },
        {}
      );
      return tab;
    },

    closeTab: async (tabId) => {
      const existingTab = get().tabs[tabId] ?? null;
      await tauriIpc.terminalCloseTab(tabId);
      if (existingTab?.kind === 'task') {
        useTaskStore.getState().handleTaskCommandTerminalClosed(tabId);
      }
      removeTabLocally(tabId);
    },
  };
});
