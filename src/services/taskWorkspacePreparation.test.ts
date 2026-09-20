import { describe, expect, it, mock } from 'bun:test';
import { prepareTaskWorkspaces, type TaskWorkspacePreparationPorts } from './taskWorkspacePreparation';
import type { TaskExecutionTarget } from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';

const target = (id: string): TaskExecutionTarget => ({ projectId: id, branchName: 'feature/work', worktreeKey: id, repoPath: `/repos/${id}`, executionMode: 'git' });
const task = { id: 'task', title: 'Task' } as CatalogedImplementTask;
const fixture = () => {
  const targets = [target('a'), target('b'), target('c')];
  const ports: TaskWorkspacePreparationPorts<Record<string, string>> = {
    targets: () => targets, assertRunnable: () => undefined,
    loadCommands: async () => ({}), setupCommand: (commands, path) => commands[path] || '',
    isDirect: () => false, isGit: () => true, project: (id) => ({ name: id, path: `/repos/${id}` }),
    ensureWorkspace: async (_task, target, _cache, created) => { created(target.projectId !== 'a'); return `/worktrees/${target.projectId}`; },
    removeWorkspace: mock(async () => undefined), runSetup: mock(async () => ({ failed: false })),
    setupFailed: mock(() => undefined), rollbackFailed: mock(() => undefined),
    unresolvedProject: () => new Error('Missing project'),
  };
  return { targets, ports };
};

describe('task workspace preparation without UI', () => {
  it('validates all targets before creating any worktree', async () => {
    const { ports } = fixture();
    ports.assertRunnable = (target) => { if (target.projectId === 'b') throw new Error('Blocked'); };
    ports.ensureWorkspace = mock(ports.ensureWorkspace);
    await expect(prepareTaskWorkspaces({ task, branchWorktrees: {} }, ports)).rejects.toThrow('Blocked');
    expect(ports.ensureWorkspace).not.toHaveBeenCalled();
  });
  it('rolls back only newly created worktrees when a later preparation fails', async () => {
    const { ports } = fixture();
    const ensure = ports.ensureWorkspace;
    ports.ensureWorkspace = async (...args) => {
      if (args[1].projectId === 'c') throw new Error('Create failed');
      return ensure(...args);
    };
    await expect(prepareTaskWorkspaces({ task, branchWorktrees: {} }, ports)).rejects.toThrow('Create failed');
    expect(ports.removeWorkspace).toHaveBeenCalledTimes(1);
    expect(ports.removeWorkspace).toHaveBeenCalledWith({ ...target('b'), repoPath: '/repos/b' });
  });
  it('reports setup failure but keeps prepared work and runs later setup commands', async () => {
    const { ports } = fixture();
    ports.runSetup = mock(async (_task, target) => ({ failed: target.projectId === 'a' }));
    const prepared = mock(() => undefined);
    const result = await prepareTaskWorkspaces({ task, branchWorktrees: {}, commands: { '/repos/a': 'setup-a', '/repos/b': 'setup-b' }, onWorkspacesPrepared: prepared }, ports);
    expect(result.preparedTargets).toHaveLength(3);
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(ports.runSetup).toHaveBeenCalledTimes(2);
    expect(ports.setupFailed).toHaveBeenCalledTimes(1);
    expect(ports.removeWorkspace).not.toHaveBeenCalled();
  });
});
