import { ProjectCommandRunner, isFailedProjectCommand } from './ProjectCommandRunner';

export interface RunWorktreeSetupCommandParams {
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

const inFlightByRunner = new WeakMap<ProjectCommandRunner, Map<string, Promise<WorktreeSetupCommandResult>>>();

const setupCommandKey = (params: RunWorktreeSetupCommandParams): string =>
  [
    params.taskId,
    params.projectId,
    params.worktreePath,
    params.command.trim(),
  ].join('::');

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
    return existing;
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
    });

    const finalTab = await runner.waitForCompletion(tab.id);
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
      await runner.close(finalTab.id).catch(() => undefined);
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
