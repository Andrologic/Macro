import { ProjectCommandRunner, isFailedProjectCommand } from './ProjectCommandRunner';

export interface RunWorktreeSetupCommandParams {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  worktreePath: string;
  command: string;
  beforeEffect?: () => Promise<void>;
  expectedBranch?: string | null;
  signal?: AbortSignal;
}

export interface WorktreeSetupCommandResult {
  exitCode: number | null;
  failed: boolean;
  tabId: string;
}

const inFlightByRunner = new WeakMap<ProjectCommandRunner, Map<string, Promise<WorktreeSetupCommandResult>>>();

const setupCommandKey = (params: RunWorktreeSetupCommandParams): string =>
  [
    params.taskId,
    params.projectId,
    params.worktreePath,
    params.command.trim(),
  ].join('::');

const awaitAbortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Setup command wait cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
};

export const runWorktreeSetupCommand = async (
  params: RunWorktreeSetupCommandParams,
  runner: ProjectCommandRunner,
): Promise<WorktreeSetupCommandResult> => {
  const trimmedCommand = params.command.trim();
  if (!trimmedCommand) {
    return {
      exitCode: null,
      failed: false,
      tabId: '',
    };
  }

  let inFlightSetupCommands = inFlightByRunner.get(runner);
  if (!inFlightSetupCommands) {
    inFlightSetupCommands = new Map();
    inFlightByRunner.set(runner, inFlightSetupCommands);
  }
  const key = setupCommandKey({ ...params, command: trimmedCommand });
  const existing = inFlightSetupCommands.get(key);
  if (existing) {
    if (!params.signal) return existing;
    return awaitAbortable(existing, params.signal);
  }

  const runPromise = (async () => {
    const tab = await runner.start({
      purpose: 'worktree_setup',
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      projectId: params.projectId,
      projectName: params.projectName,
      cwd: params.worktreePath,
      command: trimmedCommand,
      reveal: false,
      beforeEffect: params.beforeEffect,
      expectedBranch: params.beforeEffect ? params.expectedBranch : undefined,
    });

    const finalTab = await runner.waitForCompletion(tab.id, params.signal);
    if (!finalTab) {
      return {
        exitCode: null,
        failed: true,
        tabId: tab.id,
      };
    }
    const failed = isFailedProjectCommand(finalTab);

    if (failed) {
      runner.reveal(finalTab.id);
    } else {
      await params.beforeEffect?.();
      const closing = runner.close(finalTab.id);
      if (params.beforeEffect) await closing;
      else await closing.catch(() => undefined);
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
