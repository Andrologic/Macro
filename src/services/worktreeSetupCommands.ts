import { useTerminalStore, type TerminalTab } from '../stores/useTerminalStore';

interface RunWorktreeSetupCommandParams {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  worktreePath: string;
  command: string;
  beforeEffect?: () => Promise<void>;
  signal?: AbortSignal;
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

const waitForSetupTab = (tabId: string, signal?: AbortSignal): Promise<TerminalTab> =>
  new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (tab?: TerminalTab, error?: Error) => {
      if (settled) return;
      settled = true; unsubscribe(); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(tab!);
    };
    const abort = () => finish(undefined, new Error('Setup command wait cancelled.'));
    const inspect = () => {
      const tab = useTerminalStore.getState().tabs[tabId];
      if (signal?.aborted) abort();
      else if (!tab) finish(undefined, new Error('Setup terminal was removed.'));
      else if (isFinalTerminalTab(tab)) finish(tab);
    };
    signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = useTerminalStore.subscribe(inspect);
    inspect();
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
    if (!params.signal) return existing;
    return new Promise<WorktreeSetupCommandResult>((resolve, reject) => {
      const signal = params.signal!;
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Setup command wait cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      existing.then(result => { signal.removeEventListener('abort', abort); resolve(result); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
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
      beforeEffect: params.beforeEffect,
    });

    const finalTab = await waitForSetupTab(tab.id, params.signal);
    const failed = isFailedTerminalTab(finalTab);

    if (failed) {
      const latestStore = useTerminalStore.getState();
      latestStore.activateTab(finalTab.id);
      latestStore.setPanelOpen(true);
    } else {
      await params.beforeEffect?.();
      const close = useTerminalStore.getState().closeTab(finalTab.id);
      if (params.beforeEffect) await close; else await close.catch(() => undefined);
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
