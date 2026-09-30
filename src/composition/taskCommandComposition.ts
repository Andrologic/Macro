import { ProjectCommandRunner, type ProjectCommandSession, type ProjectCommandRequest } from '../services/ProjectCommandRunner';
import { buildTerminalDisplayMetadata, type TerminalDisplayMetadata } from '../services/terminalDisplayMetadata';
import { runWorktreeSetupCommand, type RunWorktreeSetupCommandParams } from '../services/worktreeSetupCommands';
import { createTaskProjectCommands, type TaskProjectCommandPorts } from '../services/taskProjectCommandWorkflow';

type TerminalCommandInput = Pick<ProjectCommandRequest, 'taskId' | 'projectId' | 'cwd' | 'command'>
  & TerminalDisplayMetadata;

export interface TaskCommandTerminalAdapter {
  startTaskCommandTab(input: TerminalCommandInput & { reveal: boolean }): Promise<ProjectCommandSession>;
  startWorktreeSetupCommandTab(input: TerminalCommandInput): Promise<ProjectCommandSession>;
  closeTab(id: string): Promise<void>;
  tabs: Readonly<Record<string, ProjectCommandSession>>;
  activateTab(id: string): void;
  setPanelOpen(open: boolean): void;
}

/** Accessors read the current owners at each call; no store is imported at runtime. */
export function createProjectCommandComposition(dependencies: {
  terminal(): TaskCommandTerminalAdapter;
  subscribeTerminal(changed: () => void): () => void;
  projectLabel(projectId: string): string | null | undefined;
}) {
  const runner = new ProjectCommandRunner({
    start: (request) => {
      const terminal = dependencies.terminal();
      const common = {
        taskId: request.taskId, projectId: request.projectId,
        cwd: request.cwd, command: request.command,
      };
      if (request.purpose === 'worktree_setup') return terminal.startWorktreeSetupCommandTab({
        ...common,
        title: `Setup - ${request.projectName}`,
        promptContext: { projectLabel: request.projectName, taskLabel: request.taskTitle, branchLabel: null },
      });
      return terminal.startTaskCommandTab({
        ...common,
        ...buildTerminalDisplayMetadata({
          projectLabel: dependencies.projectLabel(request.projectId) || request.projectName,
          taskLabel: request.taskTitle,
        }),
        reveal: request.reveal,
      });
    },
    read: (id) => dependencies.terminal().tabs[id] ?? null,
    subscribe: dependencies.subscribeTerminal,
    close: (id) => dependencies.terminal().closeTab(id),
  }, {
    reveal: (id) => {
      dependencies.terminal().activateTab(id);
      dependencies.terminal().setPanelOpen(true);
    },
  });
  return {
    runner,
    runWorktreeSetupCommand: (params: RunWorktreeSetupCommandParams) => runWorktreeSetupCommand(params, runner),
    createTaskCommands: (ports: TaskProjectCommandPorts) => createTaskProjectCommands(runner, ports),
  };
}
