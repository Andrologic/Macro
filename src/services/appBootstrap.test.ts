import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAppBootstrapController } from './appBootstrap';

describe('appBootstrap', () => {
  let callOrder: string[];
  let lowPriorityRuns: Array<() => void>;
  let initializeApp: ReturnType<typeof mock>;
  let initializeTasks: ReturnType<typeof mock>;
  let initializeChat: ReturnType<typeof mock>;
  let initializeAI: ReturnType<typeof mock>;
  let initializeTools: ReturnType<typeof mock>;
  let initializeProviders: ReturnType<typeof mock>;
  let initializeShortcuts: ReturnType<typeof mock>;
  let checkSession: ReturnType<typeof mock>;
  let preloadAllModes: ReturnType<typeof mock>;

  beforeEach(() => {
    callOrder = [];
    lowPriorityRuns = [];
    initializeApp = mock(async () => {
      callOrder.push('app');
    });
    initializeTasks = mock(async () => {
      callOrder.push('tasks');
    });
    initializeChat = mock(async () => {
      callOrder.push('chat');
    });
    initializeAI = mock(async () => {
      callOrder.push('ai');
    });
    initializeTools = mock(async () => {
      callOrder.push('tools');
    });
    initializeProviders = mock(async () => {
      callOrder.push('providers');
    });
    initializeShortcuts = mock(async () => {
      callOrder.push('shortcuts');
    });
    checkSession = mock(async () => {
      callOrder.push('auth');
    });
    preloadAllModes = mock(() => {
      callOrder.push('preload');
    });
  });

  it('deduplicates concurrent starts and updates snapshot by phase', async () => {
    const controller = createAppBootstrapController(() => ({
      initializeApp,
      initializeChat,
      initializeTasks,
      initializeAI,
      initializeTools,
      initializeProviders,
      initializeShortcuts,
      checkSession,
      preloadAllModes,
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
    expect(checkSession.mock.calls.length).toBe(1);
    expect(initializeShortcuts.mock.calls.length).toBe(1);
    expect(preloadAllModes.mock.calls.length).toBe(1);
    expect(lowPriorityRuns).toHaveLength(1);
    expect(callOrder.slice(0, 6)).toEqual(['app', 'tasks', 'chat', 'auth', 'shortcuts', 'preload']);

    expect(controller.getSnapshot()).toEqual({
      critical: true,
      high: true,
      normal: true,
      low: false,
      ready: true,
      errors: {},
    });

    lowPriorityRuns[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(initializeAI.mock.calls.length).toBe(1);
    expect(initializeTools.mock.calls.length).toBe(1);
    expect(initializeProviders.mock.calls.length).toBe(1);
    expect(controller.getSnapshot().low).toBe(true);
  });
});
