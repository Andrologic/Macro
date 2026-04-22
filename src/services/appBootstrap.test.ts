import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAppBootstrapController } from './appBootstrap';

describe('appBootstrap', () => {
  let callOrder: string[];
  let lowPriorityRuns: Array<() => void>;
  let initializeApp: ReturnType<typeof mock>;
  let initializeTasks: ReturnType<typeof mock>;
  let initializeTerminal: ReturnType<typeof mock>;
  let initializeChat: ReturnType<typeof mock>;
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
    initializeTasks = mock(async () => {
      callOrder.push('tasks');
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
      initializeApp,
      initializeChat,
      initializeTasks,
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
    expect(checkSession.mock.calls.length).toBe(1);
    expect(initializeShortcuts.mock.calls.length).toBe(1);
    expect(initializeTerminal.mock.calls.length).toBe(1);
    expect(preloadModeComponents.mock.calls.length).toBe(1);
    expect(lowPriorityRuns).toHaveLength(1);
    expect(callOrder.slice(0, 7)).toEqual(['app', 'tasks', 'chat', 'auth', 'shortcuts', 'terminal', 'preload']);

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

    expect(initializeTools.mock.calls.length).toBe(1);
    expect(initializeProviders.mock.calls.length).toBe(1);
    expect(restoreChatSelectionAfterProviderInit.mock.calls.length).toBe(1);
    expect(controller.getSnapshot().low).toBe(true);
  });
});
