import { describe, expect, it, mock } from 'bun:test';
import { createTaskStartupWorkflow, type TaskStartupPorts } from './taskStartupWorkflow';
import type { CatalogedImplementTask } from './implementTaskCatalog';

const task = (id = 'task-a'): CatalogedImplementTask => ({
  id, node_id: id, plan_id: 'plan', project_id: 'project', project_ids: ['project'],
  title: id, description: '', status: 'Pending', dependencies: [], estimated_changes: [],
  assigned_branch: 'feature/work', branch_name: 'feature/work', branch_id: null,
  branch_task_index: 0, blocked_by_task_ids: [], blocked_by: [], is_blocked: false,
  is_ready: true, sequence_index: 0, needs_revalidation: false,
  execution_targets: [{ projectId: 'project', branchName: '', worktreeKey: id,
    executionMode: 'direct', executionKind: 'repository_root', repoPath: '/repo' }],
  task_source: 'standalone', plan_title: '', plan_status: 'validated', plan_target_branch: 'develop',
  draft: false, standalone_kind: 'manual_feature', base_branch: null, feature_slug: null,
  conversation_id: null, archived_at: null, archive_reason: null, merged_at: null,
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  const tasks = [task()];
  let current = true;
  const ports: TaskStartupPorts = {
    executionAvailable: () => true, tasks: () => tasks, taskIdentity: (task) => task.id,
    executionTargets: (task) => task.execution_targets, isDirectTarget: () => true,
    resolveRepository: () => '/repo', planMutationActive: () => false,
    acquireOperation: mock(() => true), releaseOperation: mock(() => undefined),
    withLifecycleLock: async (_id, operation) => operation(),
    readDurableTasks: mock(async () => tasks),
    reserveStandaloneStatus: mock(async () => 42), restoreStandaloneStatus: mock(async () => undefined),
    persistArchitectAdmission: mock(async () => undefined), setStatus: mock(async () => undefined),
    refreshCatalog: mock(async () => undefined), syncStandaloneMetadata: mock(async () => undefined),
    prepare: mock(async () => ({ createdWorktrees: { 'task-a': '/repo' }, preparedTargets: [] })),
    hasMergeReview: () => false, openMergeReview: mock(async () => undefined),
    projection: {
      select: () => ({ projectId: 'project', isCurrent: () => current }),
      admitted: mock(() => undefined), prepared: mock(() => undefined),
      activateWorkspace: mock(async () => undefined), failure: mock(() => undefined), reviewFailure: mock(() => undefined),
    },
    message: (_key, fallback) => fallback, operationBlockedMessage: () => 'Operation blocked',
    finalizationBlockedError: () => new Error('Unfinished tasks'), unavailableMessage: () => 'Unavailable',
  };
  return { tasks, ports, workflow: createTaskStartupWorkflow(ports), changeSelection: () => { current = false; } };
};

describe('task startup without a UI store', () => {
  it('rechecks durable admission after obtaining the native project lease', async () => {
    const f = fixture();
    const lock = deferred();
    f.ports.withLifecycleLock = async (_id, operation) => { await lock.promise; return operation(); };
    const start = f.workflow.start('task-a');
    expect(f.ports.readDurableTasks).not.toHaveBeenCalled();
    f.ports.readDurableTasks = mock(async () => [f.tasks[0], { ...task('task-b'), status: 'InProgress' as const }]);
    lock.resolve();
    expect((await start).status).toBe('failed');
    expect(f.ports.prepare).not.toHaveBeenCalled();
    expect(f.ports.reserveStandaloneStatus).not.toHaveBeenCalled();
    expect(f.ports.releaseOperation).toHaveBeenCalledWith('task-a');
  });

  it('preserves admitted work while suppressing an obsolete selection projection', async () => {
    const f = fixture();
    const preparing = deferred();
    f.ports.prepare = mock(async () => { await preparing.promise; return { createdWorktrees: { a: '/prepared' }, preparedTargets: [] }; });
    const start = f.workflow.start('task-a');
    await Promise.resolve();
    await Promise.resolve();
    f.changeSelection();
    preparing.resolve();
    expect(await start).toEqual({ status: 'started', taskId: 'task-a', presentationCurrent: false });
    expect(f.ports.restoreStandaloneStatus).not.toHaveBeenCalled();
    expect(f.ports.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(f.ports.projection.activateWorkspace).not.toHaveBeenCalled();
    expect(f.ports.projection.prepared).toHaveBeenCalledWith(f.tasks[0], { createdWorktrees: { a: '/prepared' }, preparedTargets: [] }, null, false);
  });

  it('restores only the native revision reserved by a failed attempt and releases the guard', async () => {
    const f = fixture();
    f.ports.prepare = mock(async () => { throw new Error('Preparation failed'); });
    const result = await f.workflow.start('task-a');
    expect(result.status).toBe('failed');
    expect(f.ports.restoreStandaloneStatus).toHaveBeenCalledWith('task-a', 'Pending', 42);
    expect(f.ports.releaseOperation).toHaveBeenCalledWith('task-a');
    expect(f.ports.projection.failure).toHaveBeenCalledTimes(1);
  });

  it('reserves the direct project before awaiting admission', async () => {
    const f = fixture();
    f.tasks.push(task('task-b'));
    const lock = deferred();
    f.ports.withLifecycleLock = async (_id, operation) => { await lock.promise; return operation(); };
    const first = f.workflow.start('task-a');
    expect((await f.workflow.start('task-b')).status).toBe('rejected');
    expect(f.ports.acquireOperation).toHaveBeenCalledTimes(1);
    lock.resolve();
    await first;
  });

  it('rejects dependency-blocked work before acquiring a lease or creating workspaces', async () => {
    const f = fixture();
    f.tasks[0].is_blocked = true;
    f.tasks[0].blocked_by = ['Task B'];
    expect((await f.workflow.start('task-a')).status).toBe('rejected');
    expect(f.ports.acquireOperation).not.toHaveBeenCalled();
    expect(f.ports.prepare).not.toHaveBeenCalled();
  });
});
