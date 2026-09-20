import { createLifecycleScope, type LifecycleContext, type LifecycleScope } from './lifecycleScope';
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
import {
  getDatabaseInitializationStatus,
  isTauriAvailable,
} from './tauriIpc';

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

export type AppBootstrapInit = (context?: LifecycleContext) => Promise<void>;

export interface AppBootstrapDependencies {
  initializeDatabaseCritical?: AppBootstrapInit;
  initializeAppCritical: AppBootstrapInit;
  resumeAppAfterInitialize: AppBootstrapInit;
  initializeChatCritical: AppBootstrapInit;
  initializeTasksCritical: AppBootstrapInit;
  resumeTasksAfterInitialize: AppBootstrapInit;
  initializeTerminal: AppBootstrapInit;
  initializeTools: AppBootstrapInit;
  initializeSkills: AppBootstrapInit;
  initializeProviders: AppBootstrapInit;
  restoreChatSelectionAfterProviderInit: AppBootstrapInit;
  initializeShortcuts: AppBootstrapInit;
  getCurrentMode: () => AppMode;
  preloadModeComponents: (mode: AppMode, context?: LifecycleContext) => Promise<void>;
  scheduleLowPriority: (run: () => void) => (() => void) | void;
  startSubscriptions?: (context: LifecycleContext) => () => void;
  drainSubscriptions?: () => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  error: (message: string) => void;
  isPageShuttingDown: () => boolean;
}

export interface AppBootstrapController {
  ensureStarted: () => Promise<void>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  drain: () => Promise<void>;
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
      const handle = window.requestIdleCallback(() => run(), { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }

    const handle = setTimeout(() => run(), 100);
    return () => clearTimeout(handle);
  };
};

export const createAppBootstrapController = (
  getDependencies: () => AppBootstrapDependencies
): AppBootstrapController => {
  let snapshot = createInitialSnapshot();
  let startPromise: Promise<void> | null = null;
  let preloadTriggered = false;
  let owner: LifecycleScope | null = null;
  let retirement: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> = retirement;
  let drainOwnedSubscriptions: (() => Promise<void>) | undefined;
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

    const scope = createLifecycleScope();
    owner = scope;
    const activeRunId = ++runId;
    const previousRetirement = retirement;
    startPromise = scope.track((async () => {
      await previousRetirement;
      if (!scope.isActive()) return;
      const dependencies = getDependencies();
      const isActive = () => scope.isActive() && !dependencies.isPageShuttingDown();
      if (!isActive()) return;
      drainOwnedSubscriptions = dependencies.drainSubscriptions;

      const initWithTracking = async (
        name: string,
        initFn: AppBootstrapInit,
        priority: InitPriority,
        options?: { fatal?: boolean; warningOnly?: boolean }
      ): Promise<boolean> => {
        if (!isActive()) return false;
        const startTime = dependencies.now();

        try {
          await scope.track(initFn(scope));
          if (!isActive()) {
            return false;
          }
          const duration = dependencies.now() - startTime;
          dependencies.log(`[Init] ${name} (${priority}) completed in ${duration.toFixed(2)}ms`);
          return true;
        } catch (error) {
          if (!isActive()) {
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

      if (dependencies.initializeDatabaseCritical) {
        const databaseOk = await initWithTracking(
          'Database Critical',
          dependencies.initializeDatabaseCritical,
          'critical',
          { fatal: true }
        );
        if (!isActive()) return;
        if (!databaseOk) {
          updateSnapshotForRun(activeRunId, (current) => ({
            ...current,
            phase: 'error',
            critical: false,
            ready: false,
          }));
          return;
        }
      }

      const appCriticalOk = await initWithTracking(
        'App Critical',
        dependencies.initializeAppCritical,
        'critical',
        { fatal: true }
      );

      if (!isActive()) return;
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

      if (!isActive()) return;
      if (dependencies.startSubscriptions) scope.own(dependencies.startSubscriptions(scope));
      if (!isActive()) return;
      if (!preloadTriggered) {
        preloadTriggered = true;
        await initWithTracking(
          'Current Mode UI Preload',
          (context) => dependencies.preloadModeComponents(dependencies.getCurrentMode(), context),
          'critical',
          { warningOnly: true }
        );
      }

      if (isActive()) {
        updateSnapshotForRun(activeRunId, (current) => ({
          ...current,
          critical: true,
          phase: 'resuming',
        }));
      }

      if (!isActive()) return;
      const highPriorityInit = Promise.all([
        initWithTracking('App Resume', dependencies.resumeAppAfterInitialize, 'high', {
          warningOnly: true,
        }),
        initWithTracking('Task Resume', dependencies.resumeTasksAfterInitialize, 'high', {
          warningOnly: true,
        }),
      ]).then(() => {
        if (isActive()) {
          updateSnapshotForRun(activeRunId, (current) => ({ ...current, high: true }));
        }
      });

      const normalPriorityInit = Promise.all([
        initWithTracking('Shortcuts', dependencies.initializeShortcuts, 'normal'),
        initWithTracking('Terminal Store', dependencies.initializeTerminal, 'normal'),
      ]).then(() => {
        if (isActive()) {
          updateSnapshotForRun(activeRunId, (current) => ({ ...current, normal: true }));
        }
      });

      const lowPriorityInit = new Promise<void>((resolve) => {
        let cancel: (() => void) | void;
        const release = scope.own(() => {
          try { cancel?.(); } finally { resolve(); }
        });
        cancel = dependencies.scheduleLowPriority(() => {
          if (!isActive()) { release(); return; }
          void scope.track((async () => {
            try {
              await Promise.all([
                initWithTracking('Tools Store', dependencies.initializeTools, 'low'),
                initWithTracking('Skills Store', dependencies.initializeSkills, 'low'),
                initWithTracking('Provider Store', dependencies.initializeProviders, 'low'),
              ]);
              if (!isActive()) return;
              await highPriorityInit;
              if (!isActive()) return;
              await initWithTracking(
                'Chat Context Restore',
                dependencies.restoreChatSelectionAfterProviderInit,
                'low',
                { warningOnly: true }
              );
              if (isActive()) {
                updateSnapshotForRun(activeRunId, (current) => ({ ...current, low: true }));
              }
            } finally { release(); }
          })());
        });
        // A scheduler may synchronously invoke the callback or stop its owner.
        if (!scope.isActive()) cancel?.();
      });

      await Promise.all([highPriorityInit, normalPriorityInit, lowPriorityInit]);

      if (isActive()) {
        const totalDuration = dependencies.now() - startTime;
        dependencies.log(`[Init] App ready in ${totalDuration.toFixed(2)}ms`);
        updateSnapshotForRun(activeRunId, (current) => ({
          ...current,
          phase: current.startupError ? 'error' : 'ready',
          ready: true,
        }));
      }
    })());

    return startPromise;
  };

  const stop = (): Promise<void> => {
    const retired = owner;
    if (!retired) return stopPromise;
    owner = null;
    runId += 1;
    startPromise = null;
    preloadTriggered = false;
    const failures: unknown[] = [];
    // Revoke before releasing resources; cleanup failure must not skip draining.
    try { retired.stop(); } catch (error) { failures.push(error); }
    const drainSubscriptions = drainOwnedSubscriptions;
    drainOwnedSubscriptions = undefined;
    retirement = Promise.allSettled([
      retirement,
      retired.drain(),
      Promise.resolve().then(() => drainSubscriptions?.()),
    ]).then((results) => {
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    });
    stopPromise = retirement.then(() => {
      if (failures.length) throw new AggregateError(failures, 'Failed to stop app bootstrap.');
    });
    snapshot = createInitialSnapshot();
    notify();
    return stopPromise;
  };

  const restart = () => {
    const stopping = stop();
    const starting = ensureStarted();
    return Promise.all([stopping, starting]).then(() => undefined);
  };

  return {
    ensureStarted,
    restart,
    stop,
    drain: () => Promise.all([retirement, owner?.drain()]).then(() => undefined),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const waitForDatabaseInitialization: AppBootstrapInit = async (context) => {
  context?.assertActive();
  if (!isTauriAvailable()) {
    return;
  }

  const deadline = Date.now() + 15_000;
  while (true) {
    context?.assertActive();
    const status = await getDatabaseInitializationStatus();
    context?.assertActive();
    if (status.status === 'ready') {
      return;
    }
    if (status.status === 'failed') {
      throw new Error(status.message || 'Database initialization failed.');
    }
    if (Date.now() >= deadline) {
      throw new Error('Database is still initializing after 15 seconds.');
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(handle);
        context?.signal.removeEventListener('abort', finish);
        resolve();
      };
      const handle = setTimeout(finish, 50);
      context?.signal.addEventListener('abort', finish, { once: true });
      if (context?.signal.aborted) finish();
    });
  }
};

const getAppBootstrapDependencies = (): AppBootstrapDependencies => ({
  startSubscriptions: (context) => {
    const scope = createLifecycleScope();
    try {
      scope.own(useTaskStore.getState().startAppSync(context));
      scope.own(useChatStore.getState().startSubscriptions(context));
      return () => scope.stop();
    } catch (error) {
      try { scope.stop(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to start bootstrap subscriptions.');
      }
      throw error;
    }
  },
  drainSubscriptions: async () => {
    await Promise.all([
      useTaskStore.getState().drainAppSync(),
      useChatStore.getState().drainSubscriptions(),
    ]);
  },
  initializeDatabaseCritical: waitForDatabaseInitialization,
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
  preloadModeComponents: async (mode, context) => {
    context?.assertActive();
    const state = useAppStore.getState();
    const result = await preloadModePanels(mode, {
      includeLeft: state.isLeftPanelOpen,
      includeRight: state.isRightPanelOpen,
      timeoutMs: 450,
      lifecycle: context,
    });
    context?.assertActive();

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
