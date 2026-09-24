import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Project, SkillManifest } from '../../types';
import { chatSendFixture } from '../../test-utils/chatSendFixture';
import { createDeferred } from '../../test-utils/deferred';
import { services } from '../index';
import { useAppStore } from '../../stores/useAppStore';
import { useSkillsStore } from '../../stores/useSkillsStore';
import { handleSkillToolCall } from '../skills/chatIntegration';
import { completePreparedTaskExecutionContext, resolveProjectExecutionContext } from '../projectExecutionContext';
import type { PrepareAssistantStreamParams } from '../chatStreamContracts';

const project: Project = {
  id: 'project-1', name: 'Project', mountName: 'project', path: '/repos/project',
  gitSetupState: 'ready', userReadOnly: false, isReadOnly: false, readOnlyReason: null,
  created_at: '2026-09-22T00:00:00Z', status: 'active',
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
};
const skill: SkillManifest = {
  id: 'runner', name: 'runner', description: 'Run a check', source: { kind: 'global', namespace: 'agents', rootPath: '/skills' },
  resources: [], scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 10 }],
  contentHash: 'hash', isValid: true, validationErrors: [],
};
const appBefore = useAppStore.getState();
const skillsBefore = useSkillsStore.getState();
beforeEach(() => {
  useAppStore.setState({ standaloneProjects: [project], projectGroups: [], selectedProjectId: project.id });
  useSkillsStore.setState({ skills: [skill], settingsBySkillId: {
    [skill.id]: { enabled: true, scriptsEnabled: true, trust: {
      contentHash: 'hash', grantedBy: 'user', grantedAt: '2026-09-22T00:00:00Z',
    } },
  } });
});
afterEach(() => {
  mock.restore();
  useAppStore.setState(appBefore, true);
  useSkillsStore.setState(skillsBefore, true);
});

function startup(draft = false, direct = false) {
  const f = chatSendFixture('Implement');
  const target = {
    projectId: project.id, executionMode: direct ? 'direct' as const : 'git' as const,
    executionKind: direct ? 'repository_root' as const : 'worktree' as const,
    branchName: direct ? '' : 'feature/first', worktreeKey: 'first-worktree',
  };
  const task = { ...f.task, id: 'task-1', project_id: project.id, draft, execution_targets: draft ? [] : [target] };
  const state = {
    projects: [{ ...project, ...(direct ? { gitSetupState: 'not_git' as const, directEdit: true } : {}) }],
    tasks: [task], branchWorktrees: {} as Record<string, string>, taskId: task.id,
  };
  f.snapshot.executionContext = resolveProjectExecutionContext({
    ...state, mode: 'Implement', selectedTaskId: task.id, selectedProjectId: project.id,
  });
  f.ports.tasks.read = () => state.tasks[0];
  f.ports.tasks.finalizeDraft = async () => {
    task.draft = false;
    task.execution_targets = [target];
    return { taskId: task.id };
  };
  f.ports.tasks.assertReady = async () => {
    state.branchWorktrees[target.worktreeKey] = '/worktrees/first';
    return state.tasks[0];
  };
  f.ports.tasks.completeExecutionContext = (taskId, captured) =>
    completePreparedTaskExecutionContext(captured, { ...state, taskId });
  const script = spyOn(services, 'runSkillScript').mockImplementation(async request => ({
    skillId: skill.id, scriptPath: request.scriptPath, stdout: request.workspacePath ?? 'temporary',
    stderr: '', exitCode: 0, timedOut: false, truncated: false,
  }));
  const prepare = mock(async (_request: PrepareAssistantStreamParams) => ({ prepared: true as const }));
  f.ports.stream.prepare = prepare;
  let scriptResult: Promise<unknown> | undefined;
  f.ports.stream.start = request => {
    scriptResult = handleSkillToolCall('skill_run_script', {
      skill_id: skill.id, script_path: 'scripts/check.sh', allow_workspace: true,
    }, request.conversationId, null, request.executionContext);
  };
  return { ...f, state, task, target, script, prepare, scriptResult: () => scriptResult };
}

describe('first send script workspace', () => {
  for (const draft of [false, true]) test(`completes the first workspace through send and the real script store, draft=${draft}`, async () => {
    const f = startup(draft);
    expect(f.snapshot.executionContext.workspacePath).toBeNull();
    const ready = createDeferred<void>();
    const started = createDeferred<void>();
    const assertReady = f.ports.tasks.assertReady;
    f.ports.tasks.assertReady = async id => { started.resolve(); await ready.promise; return assertReady(id); };
    const pending = f.run();
    await started.promise;
    useAppStore.setState({ selectedProjectId: 'other', selectedTaskId: 'other-task' });
    ready.resolve();
    expect((await pending).status).toBe('sent');
    expect(f.prepare.mock.calls[0][0].executionContext?.workspacePath).toBe('/worktrees/first');
    expect(await f.scriptResult()).toContain('/worktrees/first');
    expect(f.script.mock.calls[0][0]).toMatchObject({ workspacePath: '/worktrees/first' });
    expect(f.snapshot.executionContext.workspacePath).toBeNull();
  });

  test('preserves an already prepared workspace', async () => {
    const f = startup();
    f.state.branchWorktrees[f.target.worktreeKey] = '/worktrees/first';
    f.snapshot.executionContext = completePreparedTaskExecutionContext(f.snapshot.executionContext, f.state);
    await f.run();
    expect(await f.scriptResult()).toContain('/worktrees/first');
  });

  test('preserves a non-Git task on its direct root', async () => {
    const f = startup(false, true);
    await f.run();
    expect(await f.scriptResult()).toContain('/repos/project');
  });

  for (const failure of ['prepare', 'task', 'project', 'workspace', 'retarget'] as const) {
    test(`does not start a stream after ${failure} failure`, async () => {
      const f = startup();
      f.ports.tasks.assertReady = async () => {
        if (failure === 'prepare') throw new Error('Worktree preparation failed');
        if (failure === 'task') f.state.tasks = [];
        if (failure === 'project') f.state.projects = [];
        if (failure === 'retarget') {
          f.state.branchWorktrees[f.target.worktreeKey] = '/worktrees/first';
          f.state.projects.push({ ...project, id: 'other', path: '/repos/other' });
          f.task.project_id = 'other';
          f.task.execution_targets = [{ ...f.target, projectId: 'other' }];
        }
        return f.task;
      };
      await expect(f.run()).rejects.toMatchObject({ message: expect.stringMatching(/preparation|task|project|workspace/i) });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.script).not.toHaveBeenCalled();
    });
  }

  test('propagates deletion after preparation from the backend without fallback', async () => {
    const f = startup();
    f.script.mockRejectedValueOnce(new Error('Failed to resolve workspace path: missing'));
    // Attach the rejection assertion before the asynchronous script can reject.
    let observed: Promise<unknown> | undefined;
    const start = f.ports.stream.start;
    f.ports.stream.start = (request, launch) => {
      start(request, launch);
      observed = (async () => {
        await expect(f.scriptResult()).rejects.toThrow('Failed to resolve workspace path: missing');
      })();
    };
    await f.run();
    await observed;
    expect(f.script).toHaveBeenCalledTimes(1);
    expect(f.script.mock.calls[0][0].workspacePath).toBe('/worktrees/first');
  });
});
