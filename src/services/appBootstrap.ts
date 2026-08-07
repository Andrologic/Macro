import { preloadModePanels } from '../components/layout/modePanelLoaders';
import type { AppMode } from '../types';
import { isPageShuttingDown } from '../utils/pageLifecycle';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useShortcutsStore } from '../stores/useShortcutsStore';
import { useSkillsStore } from '../stores/useSkillsStore';
import { useTaskStore } from '../stores/useTaskStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useToolsStore } from '../stores/useToolsStore';
import { devLogger } from '../utils/devLogger';

type InitPriority = 'critical' | 'high' | 'normal' | 'low';

export type AppBootstrapPhase = 'idle' | 'critical' | 'resuming' | 'ready' | 'error';

export interface AppBootstrapStartupError {
  message: string;
  failedSteps: string[];
  details?: string;
}

export interface AppBootstrapSnapshot {
  phase: AppBootstrapPhase;
  critical: boolean;
  high: boolean;
  normal: boolean;
  low: boolean;
  ready: boolean;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  startupError: AppBootstrapStartupError | null;
}

interface AppBootstrapDependencies {
  initializeAppCritical: () => Promise<void>;
  resumeAppAfterInitialize: () => Promise<void>;
  initializeChatCritical: () => Promise<void>;
  initializeTasksCritical: () => Promise<void>;
  resumeTasksAfterInitialize: () => Promise<void>;
  initializeTerminal: () => Promise<void>;
  initializeTools: () => Promise<void>;
  initializeSkills: () => Promise<void>;
  initializeProviders: () => Promise<void>;
  restoreChatSelectionAfterProviderInit: () => Promise<void>;
  initializeShortcuts: () => Promise<void>;
  getCurrentMode: () => AppMode;
  preloadModeComponents: (mode: AppMode) => Promise<void>;
  scheduleLowPriority: (run: () => void) => void;
  now: () => number;
  log: (message: string) => void;
  error: (message: string) => void;
  isPageShuttingDown: () => boolean;
}

export interface AppBootstrapController {
  ensureStarted: () => Promise<void>;
  restart: () => Promise<void>;
  getSnapshot: () => AppBootstrapSnapshot;
  subscribe: (listener: () => void) => () => void;
}

const createInitialSnapshot = (): AppBootstrapSnapshot => ({
  phase: 'idle',
  critical: false,
  high: false,
  normal: false,
  low: false,
  ready: false,
  errors: {},
  warnings: {},
  startupError: null,
});

const createWindowLowPriorityScheduler = (): AppBootstrapDependencies['scheduleLowPriority'] => {
  return (run) => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(() => run(), { timeout: 2000 });
      return;
    }

    setTimeout(() => run(), 100);
  };
};

export const createAppBootstrapController = (
  getDependencies: () => AppBootstrapDependencies
): AppBootstrapController => {
  let snapshot = createInitialSnapshot();
  let startPromise: Promise<void> | null = null;
  let preloadTriggered = false;
  let runId = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  const updateSnapshot = (updater: (current: AppBootstrapSnapshot) => AppBootstrapSnapshot) => {
    snapshot = updater(snapshot);
    notify();
  };

  const updateSnapshotForRun = (
    activeRunId: number,
    updater: (current: AppBootstrapSnapshot) => AppBootstrapSnapshot
  ) => {
    if (activeRunId !== runId) {
      return;
    }
    updateSnapshot(updater);
  };

  const ensureStarted = () => {
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      const activeRunId = ++runId;
      const dependencies = getDependencies();

      const initWithTracking = async (
        name: string,
        initFn: () => Promise<void>,
        priority: InitPriority,
        options?: { fatal?: boolean; warningOnly?: boolean }
      ): Promise<boolean> => {
        const startTime = dependencies.now();

        try {
          await initFn();
          if (dependencies.isPageShuttingDown()) {
            return true;
          }
          const duration = dependencies.now() - startTime;
          dependencies.log(`[Init] ${name} (${priority}) completed in ${duration.toFixed(2)}ms`);
          return true;
        } catch (error) {
          if (dependencies.isPageShuttingDown()) {
            return false;
          }

          const duration = dependencies.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          dependencies.error(
            `[Init] ${name} (${priority}) failed after ${duration.toFixed(2)}ms: ${errorMessage}`
          );
          updateSnapshotForRun(activeRunId, (current) => ({
            ...current,
            errors: {
              ...current.errors,
              [name]: errorMessage,
            },
            warnings: options?.warningOnly
              ? {
                  ...current.warnings,
                  [name]: errorMessage,
                }
              : current.warnings,
            startupError: options?.fatal
              ? {
                  message: 'Macro could not load the critical shell state.',
                  failedSteps: [name],
                  details: errorMessage,
                }
              : current.startupError,
          }));
          return false;
        }
      };

      const startTime = dependencies.now();
      dependencies.log('[Init] Starting prioritized initialization...');
      updateSnapshotForRun(activeRunId, (current) => ({
        ...current,
        phase: 'critical',
        startupError: null,
      }));

      const appCriticalOk = await initWithTracking(
        'App Critical',
        dependencies.initializeAppCritical,
        'critical',
        { fatal: true }
      );

      if (!appCriticalOk) {
        updateSnapshotForRun(activeRunId, (current) => ({
          ...current,
          phase: 'error',
          critical: false,
          ready: false,
        }));
        return;
      }

      await Promise.all([
        initWithTracking('Task Critical', dependencies.initializeTasksCritical, 'critical'),
        initWithTracking('Chat Critical', dependencies.initializeChatCritical, 'critical'),
      ]);

      if (!preloadTriggered) {
        preloadTriggered = true;
        await initWithTracking(
          'Current Mode UI Preload',
          () => dependencies.preloadModeComponents(dependencies.getCurrentMode()),
          'critical',
          { warningOnly: true }
        );
      }

      if (!dependencies.isPageShuttingDown()) {
        updateSnapshotForRun(activeRunId, (current) => ({
          ...current,
          critical: true,
          phase: 'resuming',
        }));
      }

      const highPriorityInit = Promise.all([
        initWithTracking('App Resume', dependencies.resumeAppAfterInitialize, 'high', {
          warningOnly: true,
        }),
        initWithTracking('Task Resume', dependencies.resumeTasksAfterInitialize, 'high', {
          warningOnly: true,
        }),
      ]).then(() => {
        if (!dependencies.isPageShuttingDown()) {
          updateSnapshotForRun(activeRunId, (current) => ({ ...current, high: true }));
        }
      });

      const normalPriorityInit = Promise.all([
        initWithTracking('Shortcuts', dependencies.initializeShortcuts, 'normal'),
        initWithTracking('Terminal Store', dependencies.initializeTerminal, 'normal'),
      ]).then(() => {
        if (!dependencies.isPageShuttingDown()) {
          updateSnapshotForRun(activeRunId, (current) => ({ ...current, normal: true }));
        }
      });

      const lowPriorityInit = new Promise<void>((resolve) => {
        dependencies.scheduleLowPriority(() => {
          void (async () => {
            await Promise.all([
              initWithTracking('Tools Store', dependencies.initializeTools, 'low'),
              initWithTracking('Skills Store', dependencies.initializeSkills, 'low'),
              initWithTracking('Provider Store', dependencies.initializeProviders, 'low'),
            ]);
            await highPriorityInit;
            await initWithTracking(
              'Chat Context Restore',
              dependencies.restoreChatSelectionAfterProviderInit,
              'low',
              { warningOnly: true }
            );

            if (!dependencies.isPageShuttingDown()) {
              updateSnapshotForRun(activeRunId, (current) => ({ ...current, low: true }));
            }
            resolve();
          })();
        });
      });

      await Promise.all([highPriorityInit, normalPriorityInit, lowPriorityInit]);

      if (!dependencies.isPageShuttingDown()) {
        const totalDuration = dependencies.now() - startTime;
        dependencies.log(`[Init] App ready in ${totalDuration.toFixed(2)}ms`);
        updateSnapshotForRun(activeRunId, (current) => ({
          ...current,
          phase: current.startupError ? 'error' : 'ready',
          ready: true,
        }));
      }
    })();

    return startPromise;
  };

  const restart = () => {
    runId += 1;
    startPromise = null;
    preloadTriggered = false;
    snapshot = createInitialSnapshot();
    notify();
    return ensureStarted();
  };

  return {
    ensureStarted,
    restart,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const getAppBootstrapDependencies = (): AppBootstrapDependencies => ({
  initializeAppCritical: useAppStore.getState().initializeCritical,
  resumeAppAfterInitialize: useAppStore.getState().resumeAfterInitialize,
  initializeChatCritical: useChatStore.getState().initializeCritical,
  initializeTasksCritical: useTaskStore.getState().initializeCritical,
  resumeTasksAfterInitialize: useTaskStore.getState().resumeAfterInitialize,
  initializeTerminal: useTerminalStore.getState().initialize,
  initializeTools: useToolsStore.getState().loadSettings,
  initializeSkills: useSkillsStore.getState().loadSettings,
  initializeProviders: useProviderStore.getState().initialize,
  restoreChatSelectionAfterProviderInit:
    useChatStore.getState().reapplySelectionForCurrentContext,
  initializeShortcuts: useShortcutsStore.getState().initialize,
  getCurrentMode: () => useAppStore.getState().mode,
  preloadModeComponents: async (mode) => {
    const state = useAppStore.getState();
    const result = await preloadModePanels(mode, {
      includeLeft: state.isLeftPanelOpen,
      includeRight: state.isRightPanelOpen,
      timeoutMs: 450,
    });

    if (result.failed.length > 0) {
      throw new Error(
        result.failed
          .map(({ id, error }) => {
            const message = error instanceof Error ? error.message : String(error);
            return `${id}: ${message}`;
          })
          .join('; ')
      );
    }
  },
  scheduleLowPriority: createWindowLowPriorityScheduler(),
  now: () => performance.now(),
  log: (message) => devLogger.log(message),
  error: (message) => console.error(message),
  isPageShuttingDown,
});

export const appBootstrap = createAppBootstrapController(getAppBootstrapDependencies);
