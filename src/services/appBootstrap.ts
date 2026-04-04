import { preloadModeComponents } from '../components/layout/ModeRouter';
import type { AppMode } from '../types';
import { isPageShuttingDown } from '../utils/pageLifecycle';
import { useAppStore } from '../stores/useAppStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatStore } from '../stores/useChatStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useShortcutsStore } from '../stores/useShortcutsStore';
import { useTaskStore } from '../stores/useTaskStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useToolsStore } from '../stores/useToolsStore';
import { devLogger } from '../utils/devLogger';

type InitPriority = 'critical' | 'high' | 'normal' | 'low';

export interface AppBootstrapSnapshot {
  critical: boolean;
  high: boolean;
  normal: boolean;
  low: boolean;
  ready: boolean;
  errors: Record<string, string>;
}

interface AppBootstrapDependencies {
  initializeApp: () => Promise<void>;
  initializeChat: () => Promise<void>;
  initializeTasks: () => Promise<void>;
  initializeTerminal: () => Promise<void>;
  initializeTools: () => Promise<void>;
  initializeProviders: () => Promise<void>;
  initializeShortcuts: () => Promise<void>;
  checkSession: () => Promise<void>;
  getCurrentMode: () => AppMode;
  preloadModeComponents: (mode: AppMode) => void;
  scheduleLowPriority: (run: () => void) => void;
  now: () => number;
  log: (message: string) => void;
  error: (message: string) => void;
  isPageShuttingDown: () => boolean;
}

export interface AppBootstrapController {
  ensureStarted: () => Promise<void>;
  getSnapshot: () => AppBootstrapSnapshot;
  subscribe: (listener: () => void) => () => void;
}

const createInitialSnapshot = (): AppBootstrapSnapshot => ({
  critical: false,
  high: false,
  normal: false,
  low: false,
  ready: false,
  errors: {},
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
  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  const updateSnapshot = (updater: (current: AppBootstrapSnapshot) => AppBootstrapSnapshot) => {
    snapshot = updater(snapshot);
    notify();
  };

  const ensureStarted = () => {
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      const dependencies = getDependencies();

      const initWithTracking = async (
        name: string,
        initFn: () => Promise<void>,
        priority: InitPriority
      ): Promise<void> => {
        const startTime = dependencies.now();

        try {
          await initFn();
          if (dependencies.isPageShuttingDown()) {
            return;
          }
          const duration = dependencies.now() - startTime;
          dependencies.log(`[Init] ${name} (${priority}) completed in ${duration.toFixed(2)}ms`);
        } catch (error) {
          if (dependencies.isPageShuttingDown()) {
            return;
          }

          const duration = dependencies.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          dependencies.error(
            `[Init] ${name} (${priority}) failed after ${duration.toFixed(2)}ms: ${errorMessage}`
          );
          updateSnapshot((current) => ({
            ...current,
            errors: {
              ...current.errors,
              [name]: errorMessage,
            },
          }));
        }
      };

      const startTime = dependencies.now();
      dependencies.log('[Init] Starting prioritized initialization...');

      await initWithTracking('App Bootstrap', dependencies.initializeApp, 'critical');
      await initWithTracking('Task Store', dependencies.initializeTasks, 'critical');
      await initWithTracking('Chat Store', dependencies.initializeChat, 'critical');

      if (!dependencies.isPageShuttingDown()) {
        updateSnapshot((current) => ({ ...current, critical: true }));
      }

      const highPriorityInit = Promise.all([
        initWithTracking('Auth Session', dependencies.checkSession, 'high'),
      ]).then(() => {
        if (!dependencies.isPageShuttingDown()) {
          updateSnapshot((current) => ({ ...current, high: true }));
        }
      });

      const normalPriorityInit = Promise.all([
        initWithTracking('Shortcuts', dependencies.initializeShortcuts, 'normal'),
        initWithTracking('Terminal Store', dependencies.initializeTerminal, 'normal'),
      ]).then(() => {
        if (!dependencies.isPageShuttingDown()) {
          updateSnapshot((current) => ({ ...current, normal: true }));
        }
      });

      const lowPriorityInit = new Promise<void>((resolve) => {
        dependencies.scheduleLowPriority(() => {
          void (async () => {
            await Promise.all([
              initWithTracking('Tools Store', dependencies.initializeTools, 'low'),
              initWithTracking('Provider Store', dependencies.initializeProviders, 'low'),
            ]);

            if (!dependencies.isPageShuttingDown()) {
              updateSnapshot((current) => ({ ...current, low: true }));
            }
            resolve();
          })();
        });
      });

      await Promise.all([highPriorityInit, normalPriorityInit]);

      if (!dependencies.isPageShuttingDown()) {
        const totalDuration = dependencies.now() - startTime;
        dependencies.log(`[Init] App ready in ${totalDuration.toFixed(2)}ms`);
        updateSnapshot((current) => ({ ...current, ready: true }));

        if (!preloadTriggered) {
          preloadTriggered = true;
          dependencies.preloadModeComponents(dependencies.getCurrentMode());
        }
      }

      void lowPriorityInit;
    })();

    return startPromise;
  };

  return {
    ensureStarted,
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
  initializeApp: useAppStore.getState().initialize,
  initializeChat: useChatStore.getState().initialize,
  initializeTasks: useTaskStore.getState().initialize,
  initializeTerminal: useTerminalStore.getState().initialize,
  initializeTools: useToolsStore.getState().loadSettings,
  initializeProviders: useProviderStore.getState().initialize,
  initializeShortcuts: useShortcutsStore.getState().initialize,
  checkSession: useAuthStore.getState().checkSession,
  getCurrentMode: () => useAppStore.getState().mode,
  preloadModeComponents,
  scheduleLowPriority: createWindowLowPriorityScheduler(),
  now: () => performance.now(),
  log: (message) => devLogger.log(message),
  error: (message) => console.error(message),
  isPageShuttingDown,
});

export const appBootstrap = createAppBootstrapController(getAppBootstrapDependencies);
