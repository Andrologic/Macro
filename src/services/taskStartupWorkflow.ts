import type { TaskExecutionTarget, TaskStatus } from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import { isPlanFinalizationTask } from './implementTaskCatalog';
import { resolveTaskReference } from './durableIdentity';
import { toServiceError } from './contracts/errors';

export interface PreparedTaskWorkspace extends TaskExecutionTarget {
  projectName: string;
  repoPath: string;
  worktreePath: string;
}

export interface TaskWorkspacePreparation {
  createdWorktrees: Record<string, string>;
  preparedTargets: PreparedTaskWorkspace[];
}

export type TaskStartupResult =
  | { status: 'started'; taskId: string; presentationCurrent: boolean }
  | { status: 'resumed' | 'review' | 'ignored'; taskId: string }
  | { status: 'rejected' | 'failed'; taskId: string; error: unknown };

export interface TaskStartupSelection {
  projectId: string | null;
  isCurrent(): boolean;
}

export interface TaskStartupOptions {
  onWorkspacesPrepared?: () => void;
  pilotActionToken?: symbol;
  beforeEffect?: () => Promise<void>;
}

export interface TaskStartupPorts {
  executionAvailable(): boolean;
  tasks(): CatalogedImplementTask[];
  taskIdentity(task: CatalogedImplementTask): string;
  executionTargets(task: CatalogedImplementTask): TaskExecutionTarget[];
  isDirectTarget(target: TaskExecutionTarget): boolean;
  resolveRepository(projectId: string, fallback?: string | null): string | null;
  planMutationActive(planId: string): boolean;
  acquireOperation(taskId: string): boolean;
  releaseOperation(taskId: string): void;
  withLifecycleLock<T>(taskId: string, operation: () => Promise<T>, projectPaths: string[]): Promise<T>;
  readDurableTasks(): Promise<CatalogedImplementTask[]>;
  reserveStandaloneStatus(taskId: string, expectedStatus: TaskStatus): Promise<number | null>;
  restoreStandaloneStatus(taskId: string, status: TaskStatus, revision: number): Promise<void>;
  persistArchitectAdmission(task: CatalogedImplementTask, options?: TaskStartupOptions): Promise<void>;
  setStatus(taskId: string, status: TaskStatus, options?: TaskStartupOptions): Promise<void>;
  refreshCatalog(pilot?: boolean): Promise<void>;
  syncStandaloneMetadata(taskId: string, onError: (message: string) => void, options?: TaskStartupOptions): Promise<void>;
  prepare(task: CatalogedImplementTask, options?: TaskStartupOptions): Promise<TaskWorkspacePreparation>;
  hasMergeReview(taskId: string): boolean;
  openMergeReview(task: CatalogedImplementTask, selection: TaskStartupSelection, isCurrent: () => boolean): Promise<void>;
  projection: {
    select(taskId: string): TaskStartupSelection;
    admitted(task: CatalogedImplementTask): void;
    prepared(task: CatalogedImplementTask, preparation: TaskWorkspacePreparation, primaryPath: string | null, current: boolean): void;
    activateWorkspace(path: string | null): Promise<void>;
    failure(error: unknown): void;
    reviewFailure(task: CatalogedImplementTask, error: unknown): void;
  };
  message(key: string, fallback: string, values?: Record<string, unknown>): string;
  operationBlockedMessage(): string;
  finalizationBlockedError(tasks: CatalogedImplementTask[]): unknown;
  unavailableMessage(): string;
}

/** Owns admission and durable effects; the projection port owns selection and rendering. */
export const createTaskStartupWorkflow = (ports: TaskStartupPorts) => {
  const startingDirectProjects = new Set<string>();
  const fail = (taskId: string, error: unknown, status: 'rejected' | 'failed' = 'rejected'): TaskStartupResult => {
    ports.projection.failure(error);
    return { status, taskId, error };
  };
  const conflictFor = (task: CatalogedImplementTask, tasks: CatalogedImplementTask[], projectIds: Set<string>, paths: string[] = []) =>
    tasks.find((candidate) => candidate.id !== task.id && !candidate.archived_at &&
      ['InProgress', 'AwaitingResponse', 'InReview'].includes(candidate.status) &&
      ports.executionTargets(candidate).some((target) => ports.isDirectTarget(target) &&
        (projectIds.has(target.projectId) || paths.includes(ports.resolveRepository(target.projectId, target.repoPath) ?? ''))));
  const conflictError = (task: CatalogedImplementTask) => new Error(ports.message(
    'implement.errors.directProjectTaskAlreadyActive',
    'Another direct-edit task is already active for this project: {{task}}', { task: task.title },
  ));

  return {
    async start(taskId: string, options?: TaskStartupOptions): Promise<TaskStartupResult> {
      if (!ports.executionAvailable()) return fail(taskId, new Error(ports.unavailableMessage()));
      const task = resolveTaskReference(ports.tasks(), taskId);
      if (!task) return fail(taskId, new Error(ports.message('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId })));
      if (task.archived_at || task.draft) return { status: 'ignored', taskId };
      if (task.status === 'Completed') return fail(taskId, new Error(ports.message('implement.errors.taskAlreadyCompleted', 'Task is already completed.')));
      if (task.plan_id && ports.planMutationActive(task.plan_id)) {
        const error = new Error(ports.operationBlockedMessage());
        fail(taskId, error);
        throw error;
      }
      if (task.status === 'AwaitingResponse') {
        await options?.beforeEffect?.();
        await ports.setStatus(task.id, 'InProgress', options);
        return { status: 'resumed', taskId: task.id };
      }
      const blockers = isPlanFinalizationTask(task) ? ports.tasks().filter((candidate) =>
        candidate.plan_id === task.plan_id && candidate.task_source === 'architect' && !candidate.archived_at && candidate.status !== 'Completed') : [];
      if (blockers.length) return fail(task.id, ports.finalizationBlockedError(blockers));
      if (task.is_blocked) return fail(task.id, new Error(ports.message(
        'implement.errors.taskBlockedByDependencies', 'Task is blocked by unresolved dependencies: {{reason}}',
        { reason: task.blocked_by.length ? task.blocked_by.join(', ') : 'dependency chain' },
      )));
      const directTargets = ports.executionTargets(task).filter(ports.isDirectTarget);
      const projectIds = new Set(directTargets.map((target) => target.projectId));
      const conflict = conflictFor(task, ports.tasks(), projectIds);
      if (conflict) return fail(task.id, conflictError(conflict));
      if ([...projectIds].some((id) => startingDirectProjects.has(id)) || !ports.acquireOperation(task.id)) {
        return fail(task.id, new Error(ports.operationBlockedMessage()));
      }
      projectIds.forEach((id) => startingDirectProjects.add(id));
      try {
        await options?.beforeEffect?.();
        const paths = [...new Set(directTargets.map((target) => ports.resolveRepository(target.projectId, target.repoPath))
          .filter((path): path is string => Boolean(path)))];
        return await ports.withLifecycleLock(task.id, async (): Promise<TaskStartupResult> => {
          // The native lease protects this re-read against other clients' admissions.
          if (projectIds.size) {
            const durableTasks = await ports.readDurableTasks();
            const durableConflict = conflictFor(task, durableTasks, projectIds, paths);
            if (durableConflict) throw conflictError(durableConflict);
            if (task.task_source === 'architect') {
              const persisted = durableTasks.find((candidate) => candidate.id === task.id);
              if (!persisted || persisted.archived_at || persisted.draft || persisted.status !== task.status) {
                throw new Error('Task changed before startup admission.');
              }
            }
          }
          const selection = options?.pilotActionToken
            ? { projectId: task.project_id ?? null, isCurrent: () => false }
            : ports.projection.select(task.id);
          const exists = () => {
            const current = resolveTaskReference(ports.tasks(), task.id);
            return Boolean(current && !current.archived_at && !current.draft && ports.taskIdentity(current) === ports.taskIdentity(task));
          };
          const current = () => exists() && selection.isCurrent();
          if (isPlanFinalizationTask(task) || ports.hasMergeReview(task.id)) {
            try {
              await ports.openMergeReview(task, selection, current);
              return { status: 'review', taskId: task.id };
            } catch (error) {
              if (current()) ports.projection.reviewFailure(task, error);
              return { status: 'failed', taskId: task.id, error };
            }
          }
          let revision: number | null = null;
          try {
            if (task.task_source === 'standalone' && task.standalone_kind === 'manual_feature') {
              await options?.beforeEffect?.();
              revision = await ports.reserveStandaloneStatus(task.id, task.status);
              if (revision === null) throw new Error('Task changed before startup admission.');
            }
            const preparation = await ports.prepare(task, options);
            if (!exists()) return { status: 'ignored', taskId: task.id };
            const architectAdmission = projectIds.size > 0 && task.task_source === 'architect';
            if (architectAdmission) {
              await options?.beforeEffect?.();
              await ports.persistArchitectAdmission(task, options);
              ports.projection.admitted(task);
            }
            const primary = preparation.preparedTargets.find((target) => target.projectId === selection.projectId) || preparation.preparedTargets[0];
            const primaryPath = primary?.worktreePath || null;
            // A selection change only suppresses presentation. Prepared work and admission remain durable.
            ports.projection.prepared(task, preparation, primaryPath, current());
            if (current()) await ports.projection.activateWorkspace(primaryPath);
            if (revision !== null) {
              if (options?.pilotActionToken) ports.projection.admitted(task);
              else await ports.refreshCatalog();
              await options?.beforeEffect?.();
              await ports.syncStandaloneMetadata(task.id, (message) => { if (current()) ports.projection.failure(new Error(message)); }, options);
            } else if (!architectAdmission) {
              await options?.beforeEffect?.();
              await ports.setStatus(task.id, 'InProgress', options);
            }
            return { status: 'started', taskId: task.id, presentationCurrent: current() };
          } catch (error) {
            let failure = error;
            if (revision !== null && exists()) {
              try {
                await options?.beforeEffect?.();
                await ports.restoreStandaloneStatus(task.id, task.status, revision);
                await ports.refreshCatalog(Boolean(options?.pilotActionToken));
              } catch (rollbackError) {
                failure = new Error(`${toServiceError(error).message}\n${toServiceError(rollbackError).message}`);
              }
            }
            if (current()) ports.projection.failure(failure);
            return { status: 'failed', taskId: task.id, error: failure };
          }
        }, paths);
      } catch (error) {
        return fail(task.id, error, 'failed');
      } finally {
        projectIds.forEach((id) => startingDirectProjects.delete(id));
        ports.releaseOperation(task.id);
      }
    },
  };
};
