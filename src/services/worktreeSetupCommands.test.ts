import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ProjectCommandSession as TerminalTab } from './ProjectCommandRunner';
import { createProjectCommandComposition, type TaskCommandTerminalAdapter } from '../composition/taskCommandComposition';

type TerminalState = TaskCommandTerminalAdapter;
type StartParams = Parameters<TerminalState['startWorktreeSetupCommandTab']>[0];

const startWaiters: Array<() => void> = [];
let nextTabNumber = 1;
let nextTaskNumber = 1;
let activeTaskId = '';

type TestTerminalState = TerminalState & { tabOrder: string[]; activeTabId: string | null; panelOpen: boolean };
const listeners = new Set<() => void>();
let terminalState: TestTerminalState;
const terminalBackend = {
  getState: () => terminalState,
  setState: (update: Partial<TestTerminalState> | ((state: TestTerminalState) => Partial<TestTerminalState>)) => {
    terminalState = { ...terminalState, ...(typeof update === 'function' ? update(terminalState) : update) };
    for (const listener of listeners) listener();
  },
};
const { runner, runWorktreeSetupCommand } = createProjectCommandComposition({
  terminal: terminalBackend.getState,
  subscribeTerminal: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  projectLabel: () => undefined,
});
const startWorktreeSetupCommandTab = mock<
  (_params: StartParams) => Promise<TerminalTab>
>();
const activateTab = mock<(_tabId: string) => void>();
const setPanelOpen = mock<(_open: boolean) => void>();
const closeTab = mock<(_tabId: string) => Promise<void>>();

function buildTab(id: string, patch: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    status: 'running',
    lastExitCode: null,
    hasLiveSession: true,
    ...patch,
  };
}

const commandParams = (command: string) => ({
  taskId: activeTaskId,
  taskTitle: 'Refactor compiler',
  projectId: 'project-1',
  projectName: 'Macro',
  repoPath: 'C:/repos/macro',
  worktreePath: 'C:/repos/macro/.macro/worktrees/task-1',
  command,
});

const waitForNextStart = (): Promise<void> =>
  new Promise((resolve) => {
    startWaiters.push(resolve);
  });

const publishTab = (tabId: string, patch: Partial<TerminalTab>) => {
  terminalBackend.setState((state) => ({
    tabs: {
      ...state.tabs,
      [tabId]: {
        ...state.tabs[tabId],
        ...patch,
      },
    },
  }));
};

describe('runWorktreeSetupCommand', () => {
  beforeEach(() => {
    startWaiters.length = 0;
    nextTabNumber = 1;
    activeTaskId = `worktree-setup-test-${nextTaskNumber++}`;

    startWorktreeSetupCommandTab.mockReset();
    activateTab.mockReset();
    setPanelOpen.mockReset();
    closeTab.mockReset();

    startWorktreeSetupCommandTab.mockImplementation(async () => {
      const tab = buildTab(`setup-tab-${nextTabNumber++}`);
      terminalBackend.setState((state) => ({
        tabs: { ...state.tabs, [tab.id]: tab },
      }));
      startWaiters.shift()?.();
      return tab;
    });
    closeTab.mockImplementation(async (tabId: string) => {
      terminalBackend.setState((state) => {
        const tabs = { ...state.tabs };
        delete tabs[tabId];
        return { tabs };
      });
    });
    terminalBackend.setState({
      tabs: {},
      tabOrder: [],
      activeTabId: null,
      panelOpen: false,
      startTaskCommandTab: mock(async () => buildTab('task-tab')),
      startWorktreeSetupCommandTab,
      activateTab,
      setPanelOpen,
      closeTab,
    });
  });

  afterEach(() => {
    expect(listeners.size).toBe(0);
    listeners.clear();
  });

  it('adapts a task PTY command with its display metadata and reveal preference', async () => {
    await runner.start({
      purpose: 'task', taskId: activeTaskId, taskTitle: 'Refactor compiler',
      projectId: 'project-1', projectName: 'Macro', cwd: '/worktrees/task',
      command: 'bun dev', reveal: false,
    });
    expect(terminalState.startTaskCommandTab).toHaveBeenCalledWith({
      taskId: activeTaskId, projectId: 'project-1', cwd: '/worktrees/task',
      command: 'bun dev', reveal: false, title: 'Macro - Refactor compiler',
      promptContext: { projectLabel: 'Macro', taskLabel: 'Refactor compiler', branchLabel: null },
    });
    expect(startWorktreeSetupCommandTab).not.toHaveBeenCalled();
  });

  it('ignores an empty setup command', async () => {
    await expect(runWorktreeSetupCommand(commandParams('   '))).resolves.toEqual({
      exitCode: null,
      failed: false,
      tabId: '',
    });
    expect(startWorktreeSetupCommandTab).not.toHaveBeenCalled();
  });

  it('waits for completion, passes trimmed metadata, and closes a successful tab', async () => {
    closeTab.mockRejectedValueOnce(new Error('terminal already closed'));
    const started = waitForNextStart();
    const resultPromise = runWorktreeSetupCommand(commandParams('  bun install  '));
    await started;

    expect(startWorktreeSetupCommandTab).toHaveBeenCalledWith({
      taskId: activeTaskId,
      projectId: 'project-1',
      cwd: 'C:/repos/macro/.macro/worktrees/task-1',
      title: 'Setup - Macro',
      command: 'bun install',
      promptContext: {
        projectLabel: 'Macro',
        taskLabel: 'Refactor compiler',
        branchLabel: null,
      },
    });

    publishTab('setup-tab-1', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 0,
    });

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      failed: false,
      tabId: 'setup-tab-1',
    });
    expect(closeTab).toHaveBeenCalledWith('setup-tab-1');
    expect(activateTab).not.toHaveBeenCalled();
    expect(setPanelOpen).not.toHaveBeenCalled();
  });

  it('accepts a disconnected non-running tab as an immediate successful result', async () => {
    startWorktreeSetupCommandTab.mockImplementationOnce(async () => {
      const tab = buildTab('setup-tab-1', {
        status: 'idle',
        hasLiveSession: false,
      });
      terminalBackend.setState((state) => ({
        tabs: { ...state.tabs, [tab.id]: tab },
      }));
      return tab;
    });

    await expect(runWorktreeSetupCommand(commandParams('bun install'))).resolves.toEqual({
      exitCode: null,
      failed: false,
      tabId: 'setup-tab-1',
    });
    expect(closeTab).toHaveBeenCalledWith('setup-tab-1');
  });

  it('reveals a tab whose terminal status reports failure', async () => {
    const started = waitForNextStart();
    const resultPromise = runWorktreeSetupCommand(commandParams('bun install'));
    await started;

    publishTab('setup-tab-1', {
      status: 'error',
      hasLiveSession: false,
      lastExitCode: null,
    });

    await expect(resultPromise).resolves.toEqual({
      exitCode: null,
      failed: true,
      tabId: 'setup-tab-1',
    });
    expect(activateTab).toHaveBeenCalledWith('setup-tab-1');
    expect(setPanelOpen).toHaveBeenCalledWith(true);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('treats a non-zero exit code as failure even after a completed status', async () => {
    const started = waitForNextStart();
    const resultPromise = runWorktreeSetupCommand(commandParams('bun install'));
    await started;

    publishTab('setup-tab-1', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 7,
    });

    await expect(resultPromise).resolves.toEqual({
      exitCode: 7,
      failed: true,
      tabId: 'setup-tab-1',
    });
    expect(activateTab).toHaveBeenCalledWith('setup-tab-1');
    expect(setPanelOpen).toHaveBeenCalledWith(true);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('settles as failed when the user closes the setup tab', async () => {
    const started = waitForNextStart();
    const resultPromise = runWorktreeSetupCommand(commandParams('bun install'));
    await started;

    terminalBackend.setState((state) => {
      const tabs = { ...state.tabs };
      delete tabs['setup-tab-1'];
      return { tabs };
    });

    await expect(resultPromise).resolves.toEqual({
      exitCode: null,
      failed: true,
      tabId: 'setup-tab-1',
    });
    expect(activateTab).not.toHaveBeenCalled();
    expect(setPanelOpen).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('deduplicates an in-flight command and permits a new run after it settles', async () => {
    const firstStarted = waitForNextStart();
    const firstResult = runWorktreeSetupCommand(commandParams(' bun install '));
    const duplicateResult = runWorktreeSetupCommand(commandParams('bun install'));
    await firstStarted;

    expect(startWorktreeSetupCommandTab).toHaveBeenCalledTimes(1);
    publishTab('setup-tab-1', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 0,
    });
    await expect(Promise.all([firstResult, duplicateResult])).resolves.toEqual([
      { exitCode: 0, failed: false, tabId: 'setup-tab-1' },
      { exitCode: 0, failed: false, tabId: 'setup-tab-1' },
    ]);

    const secondStarted = waitForNextStart();
    const secondResult = runWorktreeSetupCommand(commandParams('bun install'));
    await secondStarted;
    expect(startWorktreeSetupCommandTab).toHaveBeenCalledTimes(2);

    publishTab('setup-tab-2', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 0,
    });
    await expect(secondResult).resolves.toEqual({
      exitCode: 0,
      failed: false,
      tabId: 'setup-tab-2',
    });
  });

  it('does not deduplicate distinct commands', async () => {
    const firstStarted = waitForNextStart();
    const secondStarted = waitForNextStart();
    const installResult = runWorktreeSetupCommand(commandParams('bun install'));
    const generateResult = runWorktreeSetupCommand(commandParams('bun run generate'));
    await Promise.all([firstStarted, secondStarted]);

    expect(startWorktreeSetupCommandTab).toHaveBeenCalledTimes(2);
    publishTab('setup-tab-1', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 0,
    });
    publishTab('setup-tab-2', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 0,
    });

    await expect(Promise.all([installResult, generateResult])).resolves.toEqual([
      { exitCode: 0, failed: false, tabId: 'setup-tab-1' },
      { exitCode: 0, failed: false, tabId: 'setup-tab-2' },
    ]);
  });

  it('clears the in-flight key when terminal startup rejects', async () => {
    startWorktreeSetupCommandTab.mockRejectedValueOnce(new Error('terminal unavailable'));
    await expect(runWorktreeSetupCommand(commandParams('bun install'))).rejects.toThrow(
      'terminal unavailable'
    );

    const retryStarted = waitForNextStart();
    const retryResult = runWorktreeSetupCommand(commandParams('bun install'));
    await retryStarted;
    expect(startWorktreeSetupCommandTab).toHaveBeenCalledTimes(2);

    publishTab('setup-tab-1', {
      status: 'completed',
      hasLiveSession: false,
      lastExitCode: 0,
    });
    await expect(retryResult).resolves.toEqual({
      exitCode: 0,
      failed: false,
      tabId: 'setup-tab-1',
    });
  });
  it('settles a pending setup wait when the Pilot lifecycle is cancelled', async () => {
    const controller = new AbortController();
    const started = waitForNextStart();
    const pending = runWorktreeSetupCommand({ ...commandParams('sleep forever'), signal: controller.signal });
    const settled = pending.catch(error => error);
    await started; controller.abort();
    expect((await settled).message).toContain('cancelled');
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('returns a failed setup result when the terminal disappears', async () => {
    const started = waitForNextStart();
    const pending = runWorktreeSetupCommand(commandParams('sleep forever'));
    await started;
    terminalBackend.setState({ tabs: {} });
    await expect(pending).resolves.toMatchObject({ failed: true });
  });

  it('cancels a Pilot subscriber without cancelling the shared local setup', async () => {
    const started = waitForNextStart();
    const params = commandParams('shared setup');
    const local = runWorktreeSetupCommand(params);
    await started;
    const controller = new AbortController();
    const joined = runWorktreeSetupCommand({ ...params, signal: controller.signal }).catch(error => error);
    controller.abort();
    expect((await joined).message).toContain('cancelled');
    expect(startWorktreeSetupCommandTab).toHaveBeenCalledTimes(1);
    publishTab('setup-tab-1', { status: 'completed', hasLiveSession: false, lastExitCode: 0 });
    await expect(local).resolves.toMatchObject({ failed: false });
  });

  it('does not close a completed setup terminal after authorization is revoked', async () => {
    startWorktreeSetupCommandTab.mockImplementationOnce(async () => {
      const tab = buildTab('setup-revoked', { status: 'completed', hasLiveSession: false, lastExitCode: 0 });
      terminalBackend.setState({ tabs: { [tab.id]: tab } });
      return tab;
    });
    await expect(runWorktreeSetupCommand({ ...commandParams('echo fixture'),
      beforeEffect: async () => { throw new Error('authorization revoked'); },
    })).rejects.toThrow('authorization revoked');
    expect(closeTab).not.toHaveBeenCalled();
  });

});
