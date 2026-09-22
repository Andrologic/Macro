import { describe, expect, it, mock } from 'bun:test';

const invoke = mock(async (_command: string, _args: unknown) => ({}));
mock.module('../tauriRuntimeBridge', () => ({ invoke }));
const { skillsRunScript } = await import('./skills');

describe('skill execution IPC', () => {
  it('keeps discovery roots separate from the captured execution root', async () => {
    const projectRoots = [{ projectId: 'p1', projectName: 'Project', path: '/repos/project' }];
    const workspaceRoot = { projectId: 'p1', path: '/worktrees/task' };
    await skillsRunScript({
      skillId: 'runner', scriptPath: 'scripts/check.sh', allowWorkspace: true,
      workspacePath: workspaceRoot.path, workspaceRoot, projectRoots,
    });
    expect(invoke).toHaveBeenLastCalledWith('skills_run_script', {
      skillId: 'runner', scriptPath: 'scripts/check.sh', args: [], timeoutMs: null,
      allowWorkspace: true, workspacePath: workspaceRoot.path, workspaceRoot, projectRoots,
    });
  });

  it('defaults to temporary execution without workspace authority', async () => {
    await skillsRunScript({ skillId: 'runner', scriptPath: 'scripts/check.sh' });
    expect(invoke).toHaveBeenLastCalledWith('skills_run_script', {
      skillId: 'runner', scriptPath: 'scripts/check.sh', args: [], timeoutMs: null,
      allowWorkspace: false, workspacePath: null, workspaceRoot: null, projectRoots: [],
    });
  });
});
