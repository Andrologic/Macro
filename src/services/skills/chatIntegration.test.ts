import { describe, expect, it, mock } from 'bun:test';
import type { SkillPermissionSnapshot, SkillScriptRunRequest } from '../../types';
import { handleSkillToolCall } from './chatIntegration';
import { useSkillsStore } from '../../stores/useSkillsStore';
import { resolveProjectExecutionContext } from '../projectExecutionContext';
import type { Project } from '../../types';

const deniedSnapshot: SkillPermissionSnapshot = {
  conversationId: 'conversation',
  turnId: 'turn',
  capturedAt: '2026-08-26T00:00:00Z',
  skills: {
    sample: {
      skillId: 'sample',
      enabled: false,
      scriptsEnabled: false,
      hasScripts: true,
    },
  },
};

describe('skill chat integration', () => {
  it('passes the captured workspace and project identity, ignoring model-supplied workspace arguments', async () => {
    const project: Project = {
      id: 'project', name: 'Project', mountName: 'project', path: '/repos/project',
      created_at: '2026-03-05T00:00:00Z', status: 'active', gitSetupState: 'ready',
      userReadOnly: false, isReadOnly: false, readOnlyReason: null,
      metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
    };
    const context = resolveProjectExecutionContext({
      mode: 'Implement', projects: [project], selectedTaskId: 'task',
      tasks: [{
        id: 'task', project_id: project.id,
        execution_targets: [{
          projectId: project.id, executionMode: 'git', branchName: 'feature/task', worktreeKey: 'task-worktree',
        }],
      }],
      branchWorktrees: { 'task-worktree': '/worktrees/task' },
    });
    const original = useSkillsStore.getState().runSkillScriptResult;
    const run = mock(async (_request: SkillScriptRunRequest) => ({
      skillId: 'sample', scriptPath: 'scripts/run.sh', stdout: 'ok', stderr: '',
      exitCode: 0, timedOut: false, truncated: false,
    }));
    useSkillsStore.setState({ runSkillScriptResult: run });
    try {
      await handleSkillToolCall('skill_run_script', {
        skill_id: 'sample', script_path: 'scripts/run.sh', allow_workspace: true,
        workspace_path: '/other', project_id: 'other',
        executionContext: { projectId: 'other', workspacePath: '/other' },
      }, 'conversation', null, context);
      expect(run.mock.calls[0]?.[0].executionContext).toEqual({
        projectId: 'project', workspacePath: '/worktrees/task',
      });
      await handleSkillToolCall('skill_run_script', {
        skill_id: 'sample', script_path: 'scripts/run.sh', allow_workspace: true,
      }, 'conversation', null, { ...context, actionableProjectIds: [] });
      expect(run.mock.calls[1]?.[0].executionContext?.workspacePath).toBeNull();
    } finally {
      useSkillsStore.setState({ runSkillScriptResult: original });
    }
  });

  it('returns structured failures for frozen permission denials', async () => {
    const activation = await handleSkillToolCall(
      'skill_activate',
      { skill_id: 'sample' },
      'conversation',
      deniedSnapshot,
    );
    const script = await handleSkillToolCall(
      'skill_run_script',
      { skill_id: 'sample', script_path: 'run.ts' },
      'conversation',
      deniedSnapshot,
    );

    expect(activation).toMatchObject({ isError: true, errorKind: 'permission' });
    expect(script).toMatchObject({ isError: true, errorKind: 'permission' });
  });

  it('returns a structured execution failure when a skill script times out', async () => {
    const original = useSkillsStore.getState().runSkillScriptResult;
    useSkillsStore.setState({
      runSkillScriptResult: async () => ({
        skillId: 'sample',
        scriptPath: 'run.ts',
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: true,
        truncated: false,
      }),
    });

    try {
      const result = await handleSkillToolCall(
        'skill_run_script',
        { skill_id: 'sample', script_path: 'run.ts' },
        'conversation',
        null,
      );
      expect(result).toMatchObject({ isError: true, errorKind: 'execution' });
    } finally {
      useSkillsStore.setState({ runSkillScriptResult: original });
    }
  });
});
