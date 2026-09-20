import type { TaskExecutionTarget } from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import type { TaskWorkspacePreparation, PreparedTaskWorkspace } from './taskStartupWorkflow';

export interface TaskWorkspacePreparationPorts<TCommands> {
  targets(task: CatalogedImplementTask): TaskExecutionTarget[];
  assertRunnable(target: TaskExecutionTarget): void;
  loadCommands(projectIds: string[]): Promise<TCommands>;
  setupCommand(commands: TCommands, repoPath: string): string;
  isDirect(target: TaskExecutionTarget): boolean;
  isGit(target: TaskExecutionTarget): boolean;
  project(projectId: string): { name: string; path: string } | null;
  ensureWorkspace(task: CatalogedImplementTask, target: TaskExecutionTarget, cache: Record<string, string>, onCreated: (created: boolean) => void): Promise<string>;
  removeWorkspace(target: TaskExecutionTarget & { repoPath: string }): Promise<void>;
  runSetup(task: CatalogedImplementTask, target: PreparedTaskWorkspace, command: string): Promise<{ failed: boolean }>;
  setupFailed(target: PreparedTaskWorkspace, error?: unknown): void;
  rollbackFailed(task: CatalogedImplementTask, target: TaskExecutionTarget, error: unknown): void;
  unresolvedProject(task: CatalogedImplementTask): unknown;
}

/** Preparation rolls back only worktrees created by this attempt, never pre-existing work. */
export const prepareTaskWorkspaces = async <TCommands>(
  input: {
    task: CatalogedImplementTask;
    branchWorktrees: Record<string, string>;
    commands?: TCommands;
    onWorkspacesPrepared?: () => void;
    skipIntegratedTargets?: Set<string>;
  },
  ports: TaskWorkspacePreparationPorts<TCommands>,
): Promise<TaskWorkspacePreparation> => {
  const { task } = input;
  const targets = ports.targets(task);
  if (!targets.length) throw ports.unresolvedProject(task);
  // Validate every target before preparing the first repository.
  targets.forEach(ports.assertRunnable);
  const commands = input.commands ?? await ports.loadCommands(targets.map((target) => target.projectId));
  const createdWorktrees: Record<string, string> = {};
  const preparedTargets: PreparedTaskWorkspace[] = [];
  const rollback: Array<TaskExecutionTarget & { repoPath: string }> = [];
  try {
    for (const target of targets) {
      if (input.skipIntegratedTargets?.has(target.worktreeKey)) continue;
      let created = false;
      const worktreePath = await ports.ensureWorkspace(task, target, input.branchWorktrees, (value) => { created = value; });
      createdWorktrees[target.worktreeKey] = worktreePath;
      const project = ports.project(target.projectId);
      const repoPath = project?.path ?? target.repoPath ?? null;
      if (!repoPath) throw ports.unresolvedProject(task);
      if (ports.isGit(target) && created) rollback.push({ ...target, repoPath });
      preparedTargets.push({ ...target, projectName: project?.name ?? target.projectId, repoPath, worktreePath });
    }
    input.onWorkspacesPrepared?.();
    for (const target of preparedTargets) {
      const command = ports.isDirect(target) ? '' : ports.setupCommand(commands, target.repoPath).trim();
      if (!command) continue;
      try {
        if ((await ports.runSetup(task, target, command)).failed) ports.setupFailed(target);
      } catch (error) {
        ports.setupFailed(target, error);
      }
    }
  } catch (error) {
    for (const target of rollback.reverse()) {
      try { await ports.removeWorkspace(target); }
      catch (rollbackError) { ports.rollbackFailed(task, target, rollbackError); }
    }
    throw error;
  }
  return { createdWorktrees, preparedTargets };
};
