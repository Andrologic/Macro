import { useTerminalStore, type TerminalTab } from '../stores/useTerminalStore';

interface RunWorktreeSetupCommandParams {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  worktreePath: string;
  command: string;
}

export interface WorktreeSetupCommandResult {
  exitCode: number | null;
  failed: boolean;
  tabId: string;
}

const inFlightSetupCommands = new Map<string, Promise<WorktreeSetupCommandResult>>();

const finalTerminalStatuses = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
  'restored-disconnected',
]);

const setupCommandKey = (params: RunWorktreeSetupCommandParams): string =>
  [
    params.taskId,
    params.projectId,
    params.worktreePath,
    params.command.trim(),
  ].join('::');

const isFinalTerminalTab = (tab: TerminalTab): boolean =>
  finalTerminalStatuses.has(tab.status) || (!tab.hasLiveSession && tab.status !== 'running');

const isFailedTerminalTab = (tab: TerminalTab): boolean =>
  tab.status === 'failed' ||
  tab.status === 'error' ||
  (typeof tab.lastExitCode === 'number' && tab.lastExitCode !== 0);

const waitForSetupTab = (tabId: string): Promise<TerminalTab> =>
  new Promise((resolve) => {
    const readCurrent = () => useTerminalStore.getState().tabs[tabId] ?? null;
    const current = readCurrent();
    if (current && isFinalTerminalTab(current)) {
      resolve(current);
      return;
    }

    const unsubscribe = useTerminalStore.subscribe((state) => {
      const tab = state.tabs[tabId];
      if (!tab || !isFinalTerminalTab(tab)) {
        return;
      }
      unsubscribe();
      resolve(tab);
    });

    const nextCurrent = readCurrent();
    if (nextCurrent && isFinalTerminalTab(nextCurrent)) {
      unsubscribe();
      resolve(nextCurrent);
    }
  });

export const runWorktreeSetupCommand = async (
  params: RunWorktreeSetupCommandParams
): Promise<WorktreeSetupCommandResult> => {
  const trimmedCommand = params.command.trim();
  if (!trimmedCommand) {
    return {
      exitCode: null,
      failed: false,
      tabId: '',
    };
  }

  const key = setupCommandKey({ ...params, command: trimmedCommand });
  const existing = inFlightSetupCommands.get(key);
  if (existing) {
    return existing;
  }

  const runPromise = (async () => {
    const terminalStore = useTerminalStore.getState();
    const tab = await terminalStore.startWorktreeSetupCommandTab({
      taskId: params.taskId,
      projectId: params.projectId,
      cwd: params.worktreePath,
      title: `Setup - ${params.projectName}`,
      command: trimmedCommand,
      promptContext: {
        projectLabel: params.projectName,
        taskLabel: params.taskTitle,
        branchLabel: null,
      },
    });

    const finalTab = await waitForSetupTab(tab.id);
    const failed = isFailedTerminalTab(finalTab);

    if (failed) {
      const latestStore = useTerminalStore.getState();
      latestStore.activateTab(finalTab.id);
      latestStore.setPanelOpen(true);
    } else {
      await useTerminalStore.getState().closeTab(finalTab.id).catch(() => undefined);
    }

    return {
      exitCode: finalTab.lastExitCode,
      failed,
      tabId: finalTab.id,
    };
  })();

  inFlightSetupCommands.set(key, runPromise);
  try {
    return await runPromise;
  } finally {
    inFlightSetupCommands.delete(key);
  }
};
