import type { CatalogedImplementTask } from './implementTaskCatalog';
import { isManualDraftPendingInitialization } from './manualDraftInitialization';
import { ProjectCommandRunner } from './ProjectCommandRunner';

export interface TaskCommandRunState {
  taskId: string;
  status: 'running' | 'cancelling';
  currentProjectId: string | null;
  currentProjectName: string | null;
  activeTabIds: string[];
  cancelFailed?: boolean;
  startedAt: string;
}

export interface TaskCommandRunResult {
  /** Completed means all PTY launches returned, not that their processes exited. */
  status: 'completed' | 'cancelled';
  completedCount: number;
  totalCount: number;
  currentProjectName: string | null;
}

export interface TaskProjectCommand {
  projectId: string;
  projectName: string;
  worktreePath: string;
  command: string;
  openTerminalOnRun: boolean;
}

export class MissingProjectCommandError extends Error {
  constructor(readonly projectName: string) {
    super(`Missing run command for ${projectName}.`);
    this.name = 'MissingProjectCommandError';
  }
}

export type TaskCommandAdmissionFailure = 'closing' | 'unavailable' | 'unknown_task' | 'uninitialized' | 'draft' | 'archived' | 'plan_mutation';

export const validateTaskCommandAdmission = (input: {
  task: CatalogedImplementTask | undefined;
  closing: boolean;
  available: boolean;
  planMutationActive: boolean;
}): TaskCommandAdmissionFailure | null => {
  if (input.closing) return 'closing';
  if (!input.available) return 'unavailable';
  if (!input.task) return 'unknown_task';
  if (isManualDraftPendingInitialization(input.task)) return 'uninitialized';
  if (input.task.draft) return 'draft';
  if (input.task.archived_at) return 'archived';
  if (input.planMutationActive) return 'plan_mutation';
  return null;
};

export interface TaskProjectCommandPorts {
  readRuns(): Readonly<Record<string, TaskCommandRunState>>;
  writeRun(taskId: string, state: TaskCommandRunState | null): void;
  acquireOperation(taskId: string): boolean;
  releaseOperation(taskId: string): void;
  reportError(error: unknown): void;
}

export interface RunTaskProjectCommands {
  taskId: string;
  taskTitle: string;
  /** Resolve current project paths and await worktree setup before returning. */
  prepare(): Promise<readonly TaskProjectCommand[]>;
}

interface LaunchOperation {
  cancelled: boolean;
  completion: Promise<void>;
  finish(): void;
  closedDuringLaunch: Set<string>;
}

/** Owns launch/cancellation coordination. Durable task state stays behind the port. */
export function createTaskProjectCommands(runner: ProjectCommandRunner, ports: TaskProjectCommandPorts) {
  const launches = new Map<string, LaunchOperation>();
  const cancellations = new Map<string, Promise<void>>();
  const read = (id: string) => ports.readRuns()[id];

  const handleTerminalClosed = (tabId: string): void => {
    // A close event can arrive before start() returns its session id.
    for (const launch of launches.values()) launch.closedDuringLaunch.add(tabId);
    for (const state of Object.values(ports.readRuns())) {
      if (!state.activeTabIds.includes(tabId)) continue;
      const activeTabIds = state.activeTabIds.filter((id) => id !== tabId);
      ports.writeRun(state.taskId, activeTabIds.length || launches.has(state.taskId)
        ? { ...state, activeTabIds }
        : null);
    }
  };

  const close = async (taskId: string, tabId: string): Promise<boolean> => {
    try {
      await runner.close(tabId);
      handleTerminalClosed(tabId);
      return true;
    } catch (error) {
      const state = read(taskId);
      if (state) ports.writeRun(taskId, {
        ...state,
        status: 'running',
        cancelFailed: true,
        activeTabIds: [...new Set([...state.activeTabIds, tabId])],
      });
      ports.reportError(error);
      return false;
    }
  };

  const run = async (input: RunTaskProjectCommands): Promise<TaskCommandRunResult | null> => {
    const { taskId } = input;
    if (read(taskId) || launches.has(taskId) || cancellations.has(taskId)
      || !ports.acquireOperation(taskId)) return null;
    let finish!: () => void;
    const operation: LaunchOperation = {
      cancelled: false,
      completion: new Promise<void>((resolve) => { finish = resolve; }),
      finish: () => finish(),
      closedDuringLaunch: new Set(),
    };
    launches.set(taskId, operation);
    let completedCount = 0;
    let totalCount = 0;
    let currentProjectName: string | null = null;
    const cancelled = () => operation.cancelled || !read(taskId) || read(taskId)?.status === 'cancelling';
    const result = (status: TaskCommandRunResult['status']): TaskCommandRunResult => ({
      status, completedCount, totalCount,
      currentProjectName: status === 'completed' ? null : currentProjectName,
    });
    try {
      ports.writeRun(taskId, {
        taskId, status: 'running', currentProjectId: null, currentProjectName: null,
        activeTabIds: [], startedAt: new Date().toISOString(),
      });
      const targets = await input.prepare();
      totalCount = targets.length;
      if (cancelled()) return result('cancelled');
      const missing = targets.find((target) => !target.command);
      if (missing) throw new MissingProjectCommandError(missing.projectName);
      for (const target of targets) {
        currentProjectName = target.projectName;
        if (cancelled()) return result('cancelled');
        const session = await runner.start({
          purpose: 'task', taskId, taskTitle: input.taskTitle,
          projectId: target.projectId, projectName: target.projectName,
          cwd: target.worktreePath, command: target.command, reveal: target.openTerminalOnRun,
        });
        if (cancelled()) {
          await close(taskId, session.id);
          return result('cancelled');
        }
        const state = read(taskId)!;
        ports.writeRun(taskId, {
          ...state, currentProjectId: target.projectId, currentProjectName: target.projectName,
          activeTabIds: [...new Set([
            ...state.activeTabIds,
            ...(session.status === 'running' && !operation.closedDuringLaunch.has(session.id) ? [session.id] : []),
          ])],
        });
        completedCount += 1;
        if (cancelled()) {
          await close(taskId, session.id);
          return result('cancelled');
        }
      }
      return result('completed');
    } catch (error) {
      if (cancelled()) return result('cancelled');
      ports.reportError(error);
      return null;
    } finally {
      // Preserve earlier live PTYs even if a later project fails to launch.
      const state = read(taskId);
      if (state && !state.activeTabIds.length && !state.cancelFailed) ports.writeRun(taskId, null);
      launches.delete(taskId);
      ports.releaseOperation(taskId);
      operation.finish();
    }
  };

  const cancel = (taskId: string): Promise<void> => {
    const existing = cancellations.get(taskId);
    if (existing) return existing;
    const operation = launches.get(taskId);
    const state = read(taskId);
    if (!state && !operation) return Promise.resolve();
    if (operation) operation.cancelled = true;
    // Publish the cancellation promise before callbacks can re-enter cancel().
    const promise = Promise.resolve().then(async () => {
      const current = read(taskId);
      if (current) ports.writeRun(taskId, { ...current, status: 'cancelling', cancelFailed: false });
      const ids = [...new Set(read(taskId)?.activeTabIds ?? [])];
      for (const id of ids) await close(taskId, id);
      await operation?.completion;
      const latest = read(taskId);
      if (latest && !latest.activeTabIds.length) ports.writeRun(taskId, null);
    }).finally(() => {
      if (cancellations.get(taskId) === promise) cancellations.delete(taskId);
    });
    cancellations.set(taskId, promise);
    return promise;
  };

  return { run, cancel, handleTerminalClosed };
}
