import { describe, expect, it } from 'bun:test';
import type { Project, TaskExecutionTarget } from '../types';
import { resolveProjectExecutionMode } from './projectExecutionMode';

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Project',
  mountName: 'project',
  path: 'C:/work/project',
  created_at: '2026-08-28T00:00:00.000Z',
  status: 'active',
  gitSetupState: 'ready',
  directEdit: false,
  isReadOnly: false,
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
  ...overrides,
});

const target = (
  executionMode?: 'git' | 'direct',
  overrides: Partial<TaskExecutionTarget> = {},
): TaskExecutionTarget => ({
  projectId: 'project-1',
  branchName: 'feature/work',
  worktreeKey: 'project-1::feature/work',
  repoPath: 'C:/work/project',
  ...(executionMode ? { executionMode } : {}),
  ...overrides,
});

describe('resolveProjectExecutionMode', () => {
  it.each([
    ['git', project(), undefined, 'git'],
    ['direct', project({ gitSetupState: 'not_git', directEdit: true }), undefined, 'direct'],
    ['blocked', project({ gitSetupState: 'not_git', directEdit: false, isReadOnly: true }), undefined, 'blocked'],
    ['invalid', project({ gitSetupState: undefined }), undefined, 'invalid'],
  ] as const)('resolves %s projects', (_label, inputProject, inputTarget, expected) => {
    expect(resolveProjectExecutionMode({ project: inputProject, target: inputTarget }).mode).toBe(expected);
  });

  it('blocks a legacy target when the observed project is confirmed not Git', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'not_git', directEdit: false, isReadOnly: true }),
      target: target(),
    })).toMatchObject({ mode: 'blocked', reason: 'git_not_initialized' });
  });

  it('migrates a legacy target to direct only when direct editing is currently enabled', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'not_git', directEdit: true }),
      target: target(),
    })).toMatchObject({ mode: 'direct', reason: 'direct_edit_enabled', source: 'legacy_migration' });
  });

  it('migrates a legacy target to Git only from a confirmed ready project', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'ready' }),
      target: target(),
    })).toMatchObject({ mode: 'git', reason: 'git_ready', source: 'legacy_migration' });
  });

  it('keeps an explicit direct target direct after the project gains Git', () => {
    expect(resolveProjectExecutionMode({ project: project(), target: target('direct') })).toMatchObject({
      mode: 'direct',
      source: 'persisted_target',
    });
  });

  it('keeps a persisted direct target direct after Git is initialized without a commit', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'unborn', directEdit: false }),
      target: target('direct'),
    })).toMatchObject({ mode: 'direct', reason: 'persisted_direct_target' });
  });

  it('rejects an explicit Git target when the project is confirmed not Git', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'not_git', directEdit: true }),
      target: target('git'),
    })).toMatchObject({ mode: 'invalid', reason: 'git_target_without_repository' });
  });

  it('rejects a Git project whose persisted path is empty', () => {
    expect(resolveProjectExecutionMode({
      project: project({ path: '   ', gitSetupState: 'ready' }),
    })).toMatchObject({
      mode: 'invalid',
      reason: 'git_target_without_repository',
    });
  });

  it('blocks a persisted direct target for a user read-only project', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'not_git', directEdit: true, userReadOnly: true }),
      target: target('direct', { checkpointId: 'task-1-0123456789abcdef' }),
    })).toMatchObject({ mode: 'blocked', reason: 'project_read_only' });
  });

  it('fails closed for an unknown persisted mode', () => {
    expect(resolveProjectExecutionMode({
      project: project(),
      target: target('future-mode' as never),
    })).toMatchObject({ mode: 'invalid', reason: 'contradictory_project_metadata' });
  });

  it('keeps a persisted direct target valid after direct editing is disabled for new tasks', () => {
    expect(resolveProjectExecutionMode({
      project: project({ gitSetupState: 'not_git', directEdit: false, isReadOnly: true }),
      target: target('direct'),
    }).mode).toBe('direct');
  });

  it('keeps a legacy checkpoint target direct when its execution mode is missing', () => {
    expect(resolveProjectExecutionMode({
      project: project(),
      target: target(undefined, { checkpointId: 'checkpoint-1' }),
    })).toMatchObject({ mode: 'direct', source: 'persisted_target' });
  });

  it('rejects a checkpoint target that also claims Git execution', () => {
    expect(resolveProjectExecutionMode({
      project: project(),
      target: target('git', { checkpointId: 'checkpoint-1' }),
    })).toMatchObject({ mode: 'invalid', source: 'persisted_target' });
  });
});
