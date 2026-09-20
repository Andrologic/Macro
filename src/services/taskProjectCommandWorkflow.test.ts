import { describe, expect, it, mock } from 'bun:test';
import { ProjectCommandRunner, type ProjectCommandSession } from './ProjectCommandRunner';
import { createTaskProjectCommands, type TaskCommandRunState, type TaskProjectCommand } from './taskProjectCommandWorkflow';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = (id: string, status = 'running'): ProjectCommandSession => ({
  id, status, hasLiveSession: status === 'running', lastExitCode: null,
});
const target = (projectId: string): TaskProjectCommand => ({
  projectId, projectName: projectId, worktreePath: `/worktrees/${projectId}`,
  command: 'bun dev', openTerminalOnRun: true,
});
function fixture() {
  const runs: Record<string, TaskCommandRunState> = {};
  const errors: unknown[] = [];
  const start = mock(async () => session('tab-1'));
  const close = mock(async (_id: string) => {});
  const acquire = mock(() => true);
  const release = mock(() => {});
  const service = createTaskProjectCommands(new ProjectCommandRunner({
    start, close, read: () => null, subscribe: () => () => {},
  }, { reveal: () => {} }), {
    readRuns: () => runs,
    writeRun: (id, value) => { if (value) runs[id] = value; else delete runs[id]; },
    acquireOperation: acquire, releaseOperation: release, reportError: (error) => { errors.push(error); },
  });
  const run = (prepare = async () => [target('web')]) => service.run({ taskId: 'task', taskTitle: 'Task', prepare });
  return { service, run, runs, errors, start, close, acquire, release };
}

describe('task project commands without stores', () => {
  it('awaits preparation, guards concurrent launches, and retains the live PTY until closed', async () => {
    const f = fixture();
    const setup = deferred<TaskProjectCommand[]>();
    const running = f.run(() => setup.promise);
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.run()).toBeNull();
    setup.resolve([target('web')]);
    expect(await running).toEqual({ status: 'completed', completedCount: 1, totalCount: 1, currentProjectName: null });
    expect(f.runs.task.activeTabIds).toEqual(['tab-1']);
    expect(f.release).toHaveBeenCalledTimes(1);
    f.service.handleTerminalClosed('tab-1');
    expect(f.runs.task).toBeUndefined();
  });

  it.each(['completed', 'failed', 'error'])('does not retain an immediately final %s PTY', async (status) => {
    const f = fixture();
    f.start.mockResolvedValue(session('tab-1', status));
    expect((await f.run())?.status).toBe('completed');
    expect(f.runs.task).toBeUndefined();
  });

  it('does not launch when another task operation owns the guard', async () => {
    const f = fixture();
    f.acquire.mockReturnValue(false);
    expect(await f.run()).toBeNull();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it('cancels during setup and waits for preparation to settle', async () => {
    const f = fixture();
    const setup = deferred<TaskProjectCommand[]>();
    const running = f.run(() => setup.promise);
    const cancellation = f.service.cancel('task');
    expect(f.service.cancel('task')).toBe(cancellation);
    setup.resolve([target('web')]);
    expect((await running)?.status).toBe('cancelled');
    await cancellation;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.runs.task).toBeUndefined();
  });

  it('closes a PTY returned after cancellation and does not launch the next project', async () => {
    const f = fixture();
    const opening = deferred<ProjectCommandSession>();
    const started = deferred<void>();
    f.start.mockImplementation(() => { started.resolve(); return opening.promise; });
    const running = f.run(async () => [target('web'), target('api')]);
    await started.promise;
    const cancellation = f.service.cancel('task');
    opening.resolve(session('late'));
    expect((await running)?.status).toBe('cancelled');
    await cancellation;
    expect(f.close).toHaveBeenCalledWith('late');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.runs.task).toBeUndefined();
  });

  it('keeps a failed cancellation visible and permits retry', async () => {
    const f = fixture();
    await f.run();
    f.close.mockRejectedValueOnce(new Error('close failed'));
    await f.service.cancel('task');
    expect(f.runs.task).toMatchObject({ status: 'running', cancelFailed: true, activeTabIds: ['tab-1'] });
    expect(await f.run()).toBeNull();
    await f.service.cancel('task');
    expect(f.runs.task).toBeUndefined();
    expect(f.errors).toHaveLength(1);
  });

  it('retains a late PTY whose close fails during cancellation', async () => {
    const f = fixture();
    const opening = deferred<ProjectCommandSession>();
    const started = deferred<void>();
    f.start.mockImplementation(() => { started.resolve(); return opening.promise; });
    const running = f.run();
    await started.promise;
    f.close.mockRejectedValueOnce(new Error('cannot close late PTY'));
    const cancellation = f.service.cancel('task');
    opening.resolve(session('late'));
    await running;
    await cancellation;
    expect(f.runs.task).toMatchObject({ cancelFailed: true, activeTabIds: ['late'] });
  });

  it('handles closure before the launch promise returns without resurrecting the tab', async () => {
    const f = fixture();
    f.start.mockImplementation(async () => {
      f.service.handleTerminalClosed('tab-1');
      return session('tab-1');
    });
    await f.run();
    expect(f.runs.task).toBeUndefined();
  });

  it('preserves the launching operation when an earlier tab closes', async () => {
    const f = fixture();
    f.start.mockResolvedValueOnce(session('first')).mockImplementationOnce(async () => {
      f.service.handleTerminalClosed('first');
      return session('second');
    });
    await f.run(async () => [target('web'), target('api')]);
    expect(f.runs.task.activeTabIds).toEqual(['second']);
  });

  it('keeps earlier live PTYs cancellable if a later launch fails', async () => {
    const f = fixture();
    f.start.mockResolvedValueOnce(session('first')).mockRejectedValueOnce(new Error('launch failed'));
    expect(await f.run(async () => [target('web'), target('api')])).toBeNull();
    expect(f.runs.task.activeTabIds).toEqual(['first']);
    expect(f.errors).toHaveLength(1);
    await f.service.cancel('task');
    expect(f.close).toHaveBeenCalledWith('first');
  });

  it('validates every command before launching and releases the guard on preparation failure', async () => {
    const f = fixture();
    expect(await f.run(async () => [target('web'), { ...target('api'), command: '' }])).toBeNull();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.errors[0]).toMatchObject({ projectName: 'api' });
    expect(await f.run(async () => { throw new Error('setup failed'); })).toBeNull();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.runs.task).toBeUndefined();
  });
});

it('keeps cancellation latched after an earlier close fails while the next PTY is starting', async () => {
  const f = fixture();
  const opening = deferred<ProjectCommandSession>();
  const started = deferred<void>();
  f.start.mockResolvedValueOnce(session('first')).mockImplementationOnce(() => {
    started.resolve();
    return opening.promise;
  });
  const running = f.run(async () => [target('web'), target('api'), target('worker')]);
  await started.promise;
  f.close.mockRejectedValueOnce(new Error('first is still alive'));
  const cancellation = f.service.cancel('task');
  await Promise.resolve();
  await Promise.resolve();
  opening.resolve(session('second'));
  expect((await running)?.status).toBe('cancelled');
  await cancellation;
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledWith('second');
  expect(f.runs.task.activeTabIds).toEqual(['first']);
  expect(f.runs.task.cancelFailed).toBe(true);
});
