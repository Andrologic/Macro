import { afterEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { inspectWorktree, repairWorktree } from './worktreeDiagnostics';

const entry = { project: { path: '/repo', name: 'Repo' }, target: { projectId: 'p', branchName: 'feature/task', worktreeKey: 'p-task' } };
const absent = { taskId: 'p-task', worktreePath: '/repo/.macro/worktrees/taskp-task', branchName: null, status: 'absent', isDirty: null };
afterEach(removeTauriRuntimeMock);

describe('worktree diagnostic transport', () => {
  it('inspects without repairing and rechecks before a protected repair', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    let created = false;
    installTauriRuntimeMock(mock(async (command, args) => {
      calls.push({ command, args });
      if (command === 'git_worktree_create') { created = true; return {}; }
      return created ? { ...absent, status: 'ready', branchName: 'feature/task', isDirty: false } : absent;
    }));
    await inspectWorktree(entry);
    expect(calls).toEqual([{ command: 'git_worktree_inspect', args: { repoPath: '/repo', taskId: 'p-task', branchName: 'feature/task', readOnly: true } }]);
    calls.length = 0;
    expect((await repairWorktree(entry)).status).toBe('ready');
    expect(calls.map((call) => call.command)).toEqual(['git_worktree_inspect', 'git_worktree_create', 'git_worktree_inspect']);
  });
  it('propagates refusal without deleting files or registrations', async () => {
    const calls: string[] = [];
    installTauriRuntimeMock(mock(async (command) => {
      calls.push(command);
      if (command === 'git_worktree_create') throw new Error('Worktree repair refused to preserve data');
      return { ...absent, status: 'orphan_path' };
    }));
    await expect(repairWorktree(entry)).rejects.toThrow('preserve data');
    expect(calls).toEqual(['git_worktree_inspect', 'git_worktree_create']);
  });
  it('rejects WSL before issuing IPC and refuses a mismatched ready branch', async () => {
    const invoke = mock(async () => ({ ...absent, status: 'ready', branchName: 'other' }));
    installTauriRuntimeMock(invoke);
    await expect(repairWorktree({ ...entry, project: { name: 'WSL', path: '//wsl$/Ubuntu/repo' } })).rejects.toThrow('WSL');
    expect(invoke).not.toHaveBeenCalled();
    await expect(repairWorktree(entry)).rejects.toThrow('another branch');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
