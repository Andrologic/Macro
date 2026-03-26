import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as tauriIpc from '../services/tauriIpc';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';
import { resolveProjectExecutionContext } from '../services/projectExecutionContext';
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
  hasUnreadOutput: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ManualTerminalContext {
  projectId: string;
  cwd: string;
  title: string;
}

interface TerminalStore {
  initialized: boolean;
  initializing: boolean;
  sessions: Record<string, tauriIpc.TerminalSessionDto>;
  lastSessionIdByProjectId: Record<string, string>;
  tabs: Record<string, TerminalTab>;
  tabOrder: string[];
  panelOpen: boolean;
  panelHeight: number;
  activeTabId: string | null;
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
  createManualTab: () => Promise<TerminalTab>;
  ensureTaskTab: (params: {
    taskId: string;
    projectId: string;
    cwd: string;
    title: string;
    reveal: boolean;
  }) => Promise<TerminalTab>;
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
): TerminalTab => ({
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
  snapshot: dto.snapshot,
  lastCommand: dto.last_command ?? null,
  lastExitCode: dto.last_exit_code ?? null,
  hasLiveSession: dto.has_live_session,
  isRestored: dto.is_restored,
  hasUnreadOutput: existing?.hasUnreadOutput ?? false,
  createdAt: dto.created_at,
  updatedAt: dto.updated_at,
});

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

const computeHiddenCount = (state: Pick<TerminalStore, 'panelOpen' | 'activeTabId' | 'tabs'>): number =>
  Object.values(state.tabs).filter((tab) => {
    if (state.panelOpen) {
      return tab.id !== state.activeTabId && tab.hasUnreadOutput;
    }
    return tab.hasUnreadOutput || tab.status === 'running';
  }).length;

const persistActiveTabId = (tabId: string | null) => {
  void savePreference(PREF_KEYS.TERMINAL_ACTIVE_TAB_ID, tabId);
};

const persistPanelHeight = (height: number) => {
  void savePreference(PREF_KEYS.TERMINAL_PANEL_HEIGHT, height);
};

const resolveManualTerminalContext = (): ManualTerminalContext | null => {
  const appState = useAppStore.getState();
  const taskState = useTaskStore.getState();
  const chatState = useChatStore.getState();
  const context = resolveProjectExecutionContext({
    mode: appState.mode,
    projects: appState.projectGroups.flatMap((group) => group.projects),
    projectGroups: appState.projectGroups,
    tasks: taskState.tasks,
    conversations: chatState.conversations,
    conversationId: chatState.selectedConversationId,
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: appState.selectedProjectId,
    selectedTaskId: appState.selectedTaskId,
    activeRepositoryPath: taskState.activeRepositoryPath,
    branchWorktrees: taskState.branchWorktrees,
  });

  if (!context.projectId || !context.workspacePath) {
    return null;
  }

  return {
    projectId: context.projectId,
    cwd: context.workspacePath,
    title: context.projectName ? `Terminal · ${context.projectName}` : 'Terminal',
  };
};

export const useTerminalStore = create<TerminalStore>((set, get) => {
  let initializePromise: Promise<void> | null = null;
  let eventUnlisteners: UnlistenFn[] = [];

  const upsertTab = (nextTab: TerminalTab, options?: { activate?: boolean; openPanel?: boolean }) => {
    set((state) => {
      const existing = state.tabs[nextTab.id];
      const activeTabId = options?.activate
        ? nextTab.id
        : state.activeTabId && state.tabs[state.activeTabId]
          ? state.activeTabId
          : nextTab.id;
      const hasUnreadOutput =
        state.panelOpen && activeTabId === nextTab.id
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
      const panelOpen = options?.openPanel ?? state.panelOpen;
      const nextState = {
        tabs,
        tabOrder,
        panelOpen,
        activeTabId,
        hiddenTerminalTabCount: computeHiddenCount({
          panelOpen,
          activeTabId,
          tabs,
        }),
      };
      return nextState;
    });
    if (options?.activate) {
      persistActiveTabId(nextTab.id);
    }
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

    eventUnlisteners = await Promise.all([
      listen<tauriIpc.TerminalOutputEvent>('terminal:output', (event) => {
        set((state) => {
          const existing = state.tabs[event.payload.tab_id];
          if (!existing) {
            return state;
          }

          const activeVisible = state.panelOpen && state.activeTabId === existing.id;
          const nextTab: TerminalTab = {
            ...existing,
            snapshot: event.payload.snapshot,
            updatedAt: event.payload.updated_at,
            hasUnreadOutput: activeVisible ? false : true,
          };
          const tabs = { ...state.tabs, [existing.id]: nextTab };
          return {
            tabs,
            tabOrder: state.tabOrder,
            hiddenTerminalTabCount: computeHiddenCount({
              panelOpen: state.panelOpen,
              activeTabId: state.activeTabId,
              tabs,
            }),
          };
        });
      }),
      listen<tauriIpc.TerminalTabDto>('terminal:tab', (event) => {
        const existing = get().tabs[event.payload.id];
        const nextTab = mapTabDto(event.payload, existing);
        const activeVisible = get().panelOpen && get().activeTabId === nextTab.id;
        upsertTab(
          {
            ...nextTab,
            hasUnreadOutput: activeVisible ? false : existing?.hasUnreadOutput ?? false,
          },
          {}
        );
      }),
      listen<{ tab_id: string }>('terminal:closed', (event) => {
        const closedTabId = event.payload.tab_id;
        set((state) => {
          const { [closedTabId]: _removed, ...tabs } = state.tabs;
          const tabOrder = syncTabOrder(state.tabOrder, tabs);
          const activeTabId =
            state.activeTabId === closedTabId ? tabOrder[0] ?? null : state.activeTabId;
          const panelOpen = tabOrder.length > 0 ? state.panelOpen : false;
          return {
            tabs,
            tabOrder,
            activeTabId,
            panelOpen,
            hiddenTerminalTabCount: computeHiddenCount({
              panelOpen,
              activeTabId,
              tabs,
            }),
          };
        });
      }),
    ]);
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
    hiddenTerminalTabCount: 0,
    lastManualContext: null,

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
      const session = await tauriIpc.terminalCreateSession({ projectId, cwd: cwd ?? null });
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
          const [savedHeight, savedActiveTabId] = await Promise.all([
            loadPreference<number>(PREF_KEYS.TERMINAL_PANEL_HEIGHT),
            loadPreference<string | null>(PREF_KEYS.TERMINAL_ACTIVE_TAB_ID),
          ]);
          const tabDtos = await loadTabsWithRetry();
          const tabs = tabDtos.reduce<Record<string, TerminalTab>>((acc, dto) => {
            const mapped = mapTabDto(dto);
            acc[mapped.id] = mapped;
            return acc;
          }, {});
          const tabOrder = buildInitialTabOrder(tabDtos, tabs);
          const activeTabId =
            (savedActiveTabId && tabs[savedActiveTabId] ? savedActiveTabId : null) ||
            tabOrder[0] ||
            null;

          set({
            initialized: true,
            initializing: false,
            tabs,
            tabOrder,
            activeTabId,
            panelHeight: clampPanelHeight(savedHeight ?? DEFAULT_PANEL_HEIGHT),
            hiddenTerminalTabCount: computeHiddenCount({
              panelOpen: false,
              activeTabId,
              tabs,
            }),
          });
          await registerListeners();
        } catch (error) {
          set({ initializing: false });
          throw error;
        }
      })()
        .finally(() => {
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

      if (get().tabOrder.length === 0) {
        await get().createManualTab();
        return;
      }

      set((state) => ({
        panelOpen: true,
        hiddenTerminalTabCount: computeHiddenCount({
          panelOpen: true,
          activeTabId: state.activeTabId,
          tabs: state.tabs,
        }),
      }));
    },

    setPanelOpen: (open) => {
      set((state) => ({
        panelOpen: open,
        hiddenTerminalTabCount: computeHiddenCount({
          panelOpen: open,
          activeTabId: state.activeTabId,
          tabs: state.tabs,
        }),
      }));
    },

    setPanelHeight: (height) => {
      const nextHeight = clampPanelHeight(height);
      set({ panelHeight: nextHeight });
      persistPanelHeight(nextHeight);
    },

    activateTab: (tabId) => {
      set((state) => {
        if (!state.tabs[tabId]) {
          return state;
        }
        const tabs = {
          ...state.tabs,
          [tabId]: {
            ...state.tabs[tabId],
            hasUnreadOutput: false,
          },
        };
        return {
          activeTabId: tabId,
          tabs,
          hiddenTerminalTabCount: computeHiddenCount({
            panelOpen: state.panelOpen,
            activeTabId: tabId,
            tabs,
          }),
        };
      });
      persistActiveTabId(tabId);
    },

    createManualTab: async () => {
      await get().initialize();
      const context = resolveManualTerminalContext();
      if (!context) {
        throw new Error('No repository is available for a manual terminal.');
      }

      const dto = await tauriIpc.terminalCreateTab({
        kind: 'manual',
        projectId: context.projectId,
        cwd: context.cwd,
        title: context.title,
      });
      const tab = mapTabDto(dto);
      upsertTab(tab, { activate: true, openPanel: true });
      set({ lastManualContext: context });
      return tab;
    },

    ensureTaskTab: async ({ taskId, projectId, cwd, title, reveal }) => {
      await get().initialize();
      const existing = Object.values(get().tabs).find(
        (tab) => tab.kind === 'task' && tab.taskId === taskId && tab.projectId === projectId
      );
      const dto = existing
        ? existing.hasLiveSession
          ? await tauriIpc.terminalReadTab(existing.id)
          : await tauriIpc.terminalReconnectTab(existing.id)
        : await tauriIpc.terminalCreateTab({
          kind: 'task',
          projectId,
          cwd,
          title,
          taskId,
        });

      const tab = mapTabDto(dto, existing);
      upsertTab(tab, { activate: reveal, openPanel: reveal ? true : undefined });
      return tab;
    },

    reconnectTab: async (tabId) => {
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
      await tauriIpc.terminalCloseTab(tabId);
      set((state) => {
        const { [tabId]: _removed, ...tabs } = state.tabs;
        const tabOrder = syncTabOrder(state.tabOrder, tabs);
        const activeTabId =
          state.activeTabId === tabId ? tabOrder[0] ?? null : state.activeTabId;
        const panelOpen = tabOrder.length > 0 ? state.panelOpen : false;
        return {
          tabs,
          tabOrder,
          activeTabId,
          panelOpen,
          hiddenTerminalTabCount: computeHiddenCount({
            panelOpen,
            activeTabId,
            tabs,
          }),
        };
      });
    },
  };
});
