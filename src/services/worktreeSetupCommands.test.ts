import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { useTerminalStore, type TerminalTab } from '../stores/useTerminalStore';
import { runWorktreeSetupCommand } from './worktreeSetupCommands';

type TerminalState = ReturnType<typeof useTerminalStore.getState>;
type StartParams = Parameters<TerminalState['startWorktreeSetupCommandTab']>[0];

const startWaiters: Array<() => void> = [];
let nextTabNumber = 1;
let nextTaskNumber = 1;
let activeTaskId = '';

const originalTerminalState = useTerminalStore.getState();
const startWorktreeSetupCommandTab = mock<
  (_params: StartParams) => Promise<TerminalTab>
>();
const activateTab = mock<(_tabId: string) => void>();
const setPanelOpen = mock<(_open: boolean) => void>();
const closeTab = mock<(_tabId: string) => Promise<void>>();

function buildTab(id: string, patch: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    kind: 'task',
    purpose: 'worktree_setup',
    taskId: activeTaskId,
    projectId: 'project-1',
    projectName: 'Macro',
    mountName: 'macro',
    workspacePath: 'C:/repos/macro/.macro/worktrees/task-1',
    cwd: 'C:/repos/macro/.macro/worktrees/task-1',
    title: 'Setup - Macro',
    status: 'running',
    snapshot: '',
    lastCommand: 'bun install',
    lastExitCode: null,
    hasLiveSession: true,
    isRestored: false,
    outputSequence: 0,
    generation: 0,
    hasUnreadOutput: false,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
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
  useTerminalStore.setState((state) => ({
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
      useTerminalStore.setState((state) => ({
        tabs: { ...state.tabs, [tab.id]: tab },
      }));
      startWaiters.shift()?.();
      return tab;
    });
    closeTab.mockImplementation(async (tabId: string) => {
      useTerminalStore.setState((state) => {
        const tabs = { ...state.tabs };
        delete tabs[tabId];
        return { tabs };
      });
    });
    useTerminalStore.setState({
      tabs: {},
      tabOrder: [],
      activeTabId: null,
      panelOpen: false,
      startWorktreeSetupCommandTab,
      activateTab,
      setPanelOpen,
      closeTab,
    });
  });

  afterEach(() => {
    useTerminalStore.setState(originalTerminalState, true);
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
      useTerminalStore.setState((state) => ({
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
});
