import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createAppBootstrapController, waitForDatabaseInitialization, type AppBootstrapDependencies } from './appBootstrap';
import { createLifecycleScope, type LifecycleContext } from './lifecycleScope';
import * as tauriIpc from './tauriIpc';

describe('appBootstrap', () => {
  let callOrder: string[];
  let lowPriorityRuns: Array<() => void>;
  let initializeApp: ReturnType<typeof mock>;
  let resumeApp: ReturnType<typeof mock>;
  let initializeTasks: ReturnType<typeof mock>;
  let resumeTasks: ReturnType<typeof mock>;
  let initializeTerminal: ReturnType<typeof mock>;
  let initializeChat: ReturnType<typeof mock>;
  let initializeTools: ReturnType<typeof mock>;
  let initializeSkills: ReturnType<typeof mock>;
  let initializeProviders: ReturnType<typeof mock>;
  let restoreChatSelectionAfterProviderInit: ReturnType<typeof mock>;
  let initializeShortcuts: ReturnType<typeof mock>;
  let preloadModeComponents: ReturnType<typeof mock>;

  beforeEach(() => {
    callOrder = [];
    lowPriorityRuns = [];
    initializeApp = mock(async () => {
      callOrder.push('app');
    });
    resumeApp = mock(async () => {
      callOrder.push('resume-app');
    });
    initializeTasks = mock(async () => {
      callOrder.push('tasks');
    });
    resumeTasks = mock(async () => {
      callOrder.push('resume-tasks');
    });
    initializeTerminal = mock(async () => {
      callOrder.push('terminal');
    });
    initializeChat = mock(async () => {
      callOrder.push('chat');
    });
    initializeTools = mock(async () => {
      callOrder.push('tools');
    });
    initializeSkills = mock(async () => {
      callOrder.push('skills');
    });
    initializeProviders = mock(async () => {
      callOrder.push('providers');
    });
    restoreChatSelectionAfterProviderInit = mock(async () => {
      callOrder.push('restore-chat-selection');
    });
    initializeShortcuts = mock(async () => {
      callOrder.push('shortcuts');
    });
    preloadModeComponents = mock(async () => {
      callOrder.push('preload');
    });
  });

  it('deduplicates concurrent starts and updates snapshot by phase', async () => {
    const controller = createAppBootstrapController(() => ({
      initializeAppCritical: initializeApp,
      resumeAppAfterInitialize: resumeApp,
      initializeChatCritical: initializeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeSkills,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      getCurrentMode: () => 'Chat',
      preloadModeComponents,
      scheduleLowPriority: (run) => {
        lowPriorityRuns.push(run);
      },
      now: () => 0,
      log: () => undefined,
      error: () => undefined,
      isPageShuttingDown: () => false,
    }));

    const firstStart = controller.ensureStarted();
    const secondStart = controller.ensureStarted();

    expect(firstStart).toBe(secondStart);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lowPriorityRuns).toHaveLength(1);
    lowPriorityRuns[0]();
    await firstStart;

    expect(initializeApp.mock.calls.length).toBe(1);
    expect(initializeTasks.mock.calls.length).toBe(1);
    expect(initializeChat.mock.calls.length).toBe(1);
    expect(resumeApp.mock.calls.length).toBe(1);
    expect(resumeTasks.mock.calls.length).toBe(1);
    expect(initializeShortcuts.mock.calls.length).toBe(1);
    expect(initializeTerminal.mock.calls.length).toBe(1);
    expect(preloadModeComponents.mock.calls.length).toBe(1);
    expect(lowPriorityRuns).toHaveLength(1);
    expect(callOrder[0]).toBe('app');
    expect(callOrder.slice(1, 3).sort()).toEqual(['chat', 'tasks']);
    expect(callOrder.indexOf('preload')).toBeLessThan(callOrder.indexOf('resume-app'));
    expect(callOrder).toContain('resume-app');
    expect(callOrder).toContain('resume-tasks');
    expect(callOrder.indexOf('providers')).toBeLessThan(callOrder.indexOf('restore-chat-selection'));
    expect(callOrder.indexOf('resume-app')).toBeLessThan(callOrder.indexOf('restore-chat-selection'));
    expect(callOrder.indexOf('resume-tasks')).toBeLessThan(callOrder.indexOf('restore-chat-selection'));
    expect(callOrder).toContain('preload');

    expect(controller.getSnapshot()).toEqual({
      phase: 'ready',
      critical: true,
      high: true,
      normal: true,
      low: true,
      ready: true,
      errors: {},
      warnings: {},
      startupError: null,
    });

    expect(initializeTools.mock.calls.length).toBe(1);
    expect(initializeProviders.mock.calls.length).toBe(1);
    expect(restoreChatSelectionAfterProviderInit.mock.calls.length).toBe(1);
    expect(controller.getSnapshot().low).toBe(true);
  });

  it('keeps the shell critical path green when task/chat critical fail', async () => {
    initializeTasks = mock(async () => {
      callOrder.push('tasks');
      throw new Error('task catalog unavailable');
    });
    initializeChat = mock(async () => {
      callOrder.push('chat');
      throw new Error('chat snapshot unavailable');
    });

    const controller = createAppBootstrapController(() => ({
      initializeAppCritical: initializeApp,
      resumeAppAfterInitialize: resumeApp,
      initializeChatCritical: initializeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeSkills,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      getCurrentMode: () => 'Chat',
      preloadModeComponents,
      scheduleLowPriority: (run) => {
        lowPriorityRuns.push(run);
      },
      now: () => 0,
      log: () => undefined,
      error: () => undefined,
      isPageShuttingDown: () => false,
    }));

    const start = controller.ensureStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lowPriorityRuns).toHaveLength(1);
    lowPriorityRuns[0]();
    await start;

    expect(controller.getSnapshot().critical).toBe(true);
    expect(controller.getSnapshot().ready).toBe(true);
    expect(controller.getSnapshot().errors['Task Critical']).toBe('task catalog unavailable');
    expect(controller.getSnapshot().errors['Chat Critical']).toBe('chat snapshot unavailable');
  });

  it('keeps booting when current mode panel preload fails', async () => {
    preloadModeComponents = mock(async () => {
      callOrder.push('preload');
      throw new Error('chunk missing');
    });

    const controller = createAppBootstrapController(() => ({
      initializeAppCritical: initializeApp,
      resumeAppAfterInitialize: resumeApp,
      initializeChatCritical: initializeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeSkills,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      getCurrentMode: () => 'Implement',
      preloadModeComponents,
      scheduleLowPriority: (run) => {
        lowPriorityRuns.push(run);
      },
      now: () => 0,
      log: () => undefined,
      error: () => undefined,
      isPageShuttingDown: () => false,
    }));

    const start = controller.ensureStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    lowPriorityRuns[0]();
    await start;

    expect(controller.getSnapshot().critical).toBe(true);
    expect(controller.getSnapshot().ready).toBe(true);
    expect(controller.getSnapshot().errors['Current Mode UI Preload']).toBe('chunk missing');
    expect(controller.getSnapshot().warnings['Current Mode UI Preload']).toBe('chunk missing');
  });

  it('can restart after a failed run', async () => {
    let shouldFail = true;
    initializeApp = mock(async () => {
      callOrder.push('app');
      if (shouldFail) {
        throw new Error('first boot failed');
      }
    });

    const controller = createAppBootstrapController(() => ({
      initializeAppCritical: initializeApp,
      resumeAppAfterInitialize: resumeApp,
      initializeChatCritical: initializeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeSkills,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      getCurrentMode: () => 'Chat',
      preloadModeComponents,
      scheduleLowPriority: (run) => {
        lowPriorityRuns.push(run);
      },
      now: () => 0,
      log: () => undefined,
      error: () => undefined,
      isPageShuttingDown: () => false,
    }));

    await controller.ensureStarted();
    expect(controller.getSnapshot().startupError?.details).toBe('first boot failed');
    expect(controller.getSnapshot().critical).toBe(false);
    expect(controller.getSnapshot().ready).toBe(false);
    expect(resumeApp.mock.calls.length).toBe(0);

    shouldFail = false;
    const restart = controller.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lowPriorityRuns).toHaveLength(1);
    lowPriorityRuns[0]();
    await restart;

    expect(initializeApp.mock.calls.length).toBe(2);
    expect(controller.getSnapshot().startupError).toBeNull();
    expect(controller.getSnapshot().ready).toBe(true);
  });

  it('drains stale deferred operations before restarting', async () => {
    const resumeResolvers: Array<() => void> = [];
    resumeApp = mock(
      () =>
        new Promise<void>((resolve) => {
          callOrder.push('resume-app');
          resumeResolvers.push(resolve);
        })
    );

    const controller = createAppBootstrapController(() => ({
      initializeAppCritical: initializeApp,
      resumeAppAfterInitialize: resumeApp,
      initializeChatCritical: initializeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeSkills,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      getCurrentMode: () => 'Chat',
      preloadModeComponents,
      scheduleLowPriority: (run) => {
        lowPriorityRuns.push(run);
      },
      now: () => 0,
      log: () => undefined,
      error: () => undefined,
      isPageShuttingDown: () => false,
    }));

    const firstStart = controller.ensureStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().critical).toBe(true);
    expect(controller.getSnapshot().high).toBe(false);
    expect(resumeResolvers).toHaveLength(1);

    const restartPromise = controller.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(resumeResolvers).toHaveLength(1);

    resumeResolvers[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resumeResolvers).toHaveLength(2);
    expect(controller.getSnapshot().high).toBe(false);

    resumeResolvers[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lowPriorityRuns.length).toBeGreaterThanOrEqual(1);
    lowPriorityRuns.splice(0).forEach((run) => run());
    await restartPromise;
    await firstStart;
    expect(controller.getSnapshot().ready).toBe(true);
  });
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const bootstrapDependencies = (overrides: Partial<AppBootstrapDependencies> = {}): AppBootstrapDependencies => ({
  initializeAppCritical: async () => undefined,
  resumeAppAfterInitialize: async () => undefined,
  initializeChatCritical: async () => undefined,
  initializeTasksCritical: async () => undefined,
  resumeTasksAfterInitialize: async () => undefined,
  initializeTerminal: async () => undefined,
  initializeTools: async () => undefined,
  initializeSkills: async () => undefined,
  initializeProviders: async () => undefined,
  restoreChatSelectionAfterProviderInit: async () => undefined,
  initializeShortcuts: async () => undefined,
  getCurrentMode: () => 'Chat',
  preloadModeComponents: async () => undefined,
  scheduleLowPriority: (run) => { queueMicrotask(run); return () => undefined; },
  now: () => 0,
  log: () => undefined,
  error: () => undefined,
  isPageShuttingDown: () => false,
  ...overrides,
});

describe('appBootstrap ownership', () => {
  it('cancels idle work, settles start and makes a retained callback inert', async () => {
    const scheduled = deferred<() => void>();
    const cancel = mock(() => undefined);
    const low = mock(async () => undefined);
    const controller = createAppBootstrapController(() => bootstrapDependencies({
      scheduleLowPriority: (run) => { scheduled.resolve(run); return cancel; },
      initializeTools: low,
    }));
    const started = controller.ensureStarted();
    const staleCallback = await scheduled.promise;
    const stopped = controller.stop();
    expect(controller.stop()).toBe(stopped);
    await stopped;
    await started;
    staleCallback();
    await tick();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('revokes a blocked init before cleanup and drains admitted writes before the next read', async () => {
    const admittedWrite = deferred();
    const entered = deferred();
    const operations: string[] = [];
    let first = true;
    let activeContext: LifecycleContext | undefined;
    const controller = createAppBootstrapController(() => bootstrapDependencies({
      initializeAppCritical: async (context) => {
        activeContext = context;
        operations.push('read');
        if (!first) return;
        first = false;
        operations.push('write-admitted');
        entered.resolve();
        await admittedWrite.promise;
        operations.push('write-finished');
        context?.assertActive();
        operations.push('obsolete-next-operation');
      },
    }));
    const started = controller.ensureStarted();
    await entered.promise;
    const restarted = controller.restart();
    expect(activeContext?.signal.aborted).toBe(true);
    await tick();
    expect(operations).toEqual(['read', 'write-admitted']);
    admittedWrite.resolve();
    await Promise.all([started, restarted]);
    expect(operations).toEqual(['read', 'write-admitted', 'write-finished', 'read']);
    await controller.stop();
  });

  it('drains subscription work even if cleanup throws and still allows a new start', async () => {
    const pending = deferred();
    const installed = deferred();
    let context: LifecycleContext | undefined;
    const cleanup = mock(() => {
      expect(context?.isActive()).toBe(false);
      throw new Error('dispose failed');
    });
    const controller = createAppBootstrapController(() => bootstrapDependencies({
      startSubscriptions: (owner) => { context = owner; installed.resolve(); return cleanup; },
      drainSubscriptions: () => pending.promise,
    }));
    const started = controller.ensureStarted();
    await installed.promise;
    let settled = false;
    const stopped = controller.stop().then(() => 'ok', () => { settled = true; return 'failed'; });
    await tick();
    expect(settled).toBe(false);
    pending.resolve();
    expect(await stopped).toBe('failed');
    await started;
    expect(cleanup).toHaveBeenCalledTimes(1);
    await controller.ensureStarted();
    expect(controller.getSnapshot().ready).toBe(true);
    await controller.stop().catch(() => undefined);
  });

  it('revokes queued starts without hydrating their cancelled generation', async () => {
    const pending = deferred();
    const entered = deferred();
    const initialize = mock(async () => { entered.resolve(); await pending.promise; });
    const controller = createAppBootstrapController(() => bootstrapDependencies({ initializeAppCritical: initialize }));
    const first = controller.ensureStarted();
    await entered.promise;
    const second = controller.restart();
    const third = controller.restart();
    pending.resolve();
    await Promise.all([first, second, third]);
    expect(initialize).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it('passes the bootstrap owner to panel preload and stops before resuming', async () => {
    const entered = deferred<LifecycleContext>();
    const resume = mock(async () => undefined);
    let initializationContext: LifecycleContext | undefined;
    const controller = createAppBootstrapController(() => bootstrapDependencies({
      initializeAppCritical: async (context) => { initializationContext = context; },
      preloadModeComponents: async (mode, context) => {
        expect(mode).toBe('Chat');
        if (!context) throw new Error('Missing preload lifetime');
        entered.resolve(context);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        context.assertActive();
      },
      resumeAppAfterInitialize: resume,
    }));
    const starting = controller.ensureStarted();
    const preloadContext = await entered.promise;
    expect(preloadContext).toBe(initializationContext);
    await controller.stop();
    await starting;
    expect(preloadContext.signal.aborted).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('clears the database polling timer immediately on revocation', async () => {
    const scope = createLifecycleScope();
    const available = spyOn(tauriIpc, 'isTauriAvailable').mockReturnValue(true);
    const status = spyOn(tauriIpc, 'getDatabaseInitializationStatus').mockResolvedValue({ status: 'initializing', message: null });
    const scheduled = deferred();
    const originalTimeout = globalThis.setTimeout;
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay?: number) => {
      if (delay === 50) { scheduled.resolve(); return originalTimeout(run, 10_000); }
      return originalTimeout(run, delay);
    }) as typeof setTimeout);
    const cleared = spyOn(globalThis, 'clearTimeout');
    try {
      const waiting = waitForDatabaseInitialization(scope).catch((error) => error);
      await scheduled.promise;
      scope.stop();
      expect(cleared).toHaveBeenCalledTimes(1);
      expect((await waiting).name).toBe('LifecycleStoppedError');
      expect(status).toHaveBeenCalledTimes(1);
    } finally {
      available.mockRestore(); status.mockRestore(); timeout.mockRestore(); cleared.mockRestore();
    }
  });
});
