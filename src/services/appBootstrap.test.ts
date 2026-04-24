import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAppBootstrapController } from './appBootstrap';

describe('appBootstrap', () => {
  let callOrder: string[];
  let lowPriorityRuns: Array<() => void>;
  let initializeApp: ReturnType<typeof mock>;
  let resumeApp: ReturnType<typeof mock>;
  let initializeTasks: ReturnType<typeof mock>;
  let resumeTasks: ReturnType<typeof mock>;
  let initializeTerminal: ReturnType<typeof mock>;
  let initializeChat: ReturnType<typeof mock>;
  let resumeChat: ReturnType<typeof mock>;
  let initializeTools: ReturnType<typeof mock>;
  let initializeProviders: ReturnType<typeof mock>;
  let restoreChatSelectionAfterProviderInit: ReturnType<typeof mock>;
  let initializeShortcuts: ReturnType<typeof mock>;
  let checkSession: ReturnType<typeof mock>;
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
    resumeChat = mock(async () => {
      callOrder.push('resume-chat');
    });
    initializeTools = mock(async () => {
      callOrder.push('tools');
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
    checkSession = mock(async () => {
      callOrder.push('auth');
    });
    preloadModeComponents = mock(() => {
      callOrder.push('preload');
    });
  });

  it('deduplicates concurrent starts and updates snapshot by phase', async () => {
    const controller = createAppBootstrapController(() => ({
      initializeAppCritical: initializeApp,
      resumeAppAfterInitialize: resumeApp,
      initializeChatCritical: initializeChat,
      resumeChatAfterInitialize: resumeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      checkSession,
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
    await firstStart;

    expect(initializeApp.mock.calls.length).toBe(1);
    expect(initializeTasks.mock.calls.length).toBe(1);
    expect(initializeChat.mock.calls.length).toBe(1);
    expect(resumeApp.mock.calls.length).toBe(1);
    expect(resumeTasks.mock.calls.length).toBe(1);
    expect(resumeChat.mock.calls.length).toBe(1);
    expect(checkSession.mock.calls.length).toBe(1);
    expect(initializeShortcuts.mock.calls.length).toBe(1);
    expect(initializeTerminal.mock.calls.length).toBe(1);
    expect(preloadModeComponents.mock.calls.length).toBe(1);
    expect(lowPriorityRuns).toHaveLength(1);
    expect(callOrder[0]).toBe('app');
    expect(callOrder.slice(1, 3).sort()).toEqual(['chat', 'tasks']);
    expect(callOrder).toContain('resume-app');
    expect(callOrder).toContain('resume-tasks');
    expect(callOrder).toContain('resume-chat');
    expect(callOrder).toContain('preload');

    expect(controller.getSnapshot()).toEqual({
      phase: 'ready',
      critical: true,
      high: true,
      normal: true,
      low: false,
      ready: true,
      errors: {},
      warnings: {},
      startupError: null,
    });

    lowPriorityRuns[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

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
      resumeChatAfterInitialize: resumeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      checkSession,
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

    expect(controller.getSnapshot().critical).toBe(true);
    expect(controller.getSnapshot().ready).toBe(true);
    expect(controller.getSnapshot().errors['Task Critical']).toBe('task catalog unavailable');
    expect(controller.getSnapshot().errors['Chat Critical']).toBe('chat snapshot unavailable');
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
      resumeChatAfterInitialize: resumeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      checkSession,
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
    await controller.restart();

    expect(initializeApp.mock.calls.length).toBe(2);
    expect(controller.getSnapshot().startupError).toBeNull();
    expect(controller.getSnapshot().ready).toBe(true);
  });

  it('ignores stale deferred updates after restart', async () => {
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
      resumeChatAfterInitialize: resumeChat,
      initializeTasksCritical: initializeTasks,
      resumeTasksAfterInitialize: resumeTasks,
      initializeTerminal,
      initializeTools,
      initializeProviders,
      restoreChatSelectionAfterProviderInit,
      initializeShortcuts,
      checkSession,
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
    expect(controller.getSnapshot().critical).toBe(true);
    expect(controller.getSnapshot().high).toBe(false);
    expect(resumeResolvers).toHaveLength(2);

    resumeResolvers[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().high).toBe(false);

    resumeResolvers[1]?.();
    await restartPromise;
    await firstStart;
    expect(controller.getSnapshot().ready).toBe(true);
  });
});
