import { describe, expect, it } from 'bun:test';
import { toBranchWorktreeKey } from './implementTaskDerivation';
import {
  getFileChangesExecutionTargets,
} from './fileChangesReviewScope';

describe('fileChangesReviewScope', () => {
  it('does not invent a legacy worktree for native Agent Tasks', () => {
    const task = { project_id: 'project', assigned_branch: 'develop', task_source: 'agsdl', execution_targets: [] };
    expect(getFileChangesExecutionTargets(task)).toEqual([]);
  });
  it('builds a fallback execution target for single-project tasks', () => {
    expect(
      getFileChangesExecutionTargets(
        {
          project_id: 'project-a',
          assigned_branch: 'feature/example',
          task_source: 'standalone',
          execution_targets: [],
        },
        () => 'main'
      )
    ).toEqual([
      {
        projectId: 'project-a',
        branchName: 'feature/example',
        executionKind: 'worktree',
        worktreeKey: toBranchWorktreeKey('project-a', 'feature/example'),
        planBranchName: 'main',
      },
    ]);
  });

  it('prefers explicit execution targets over the legacy fallback', () => {
    const worktreeKeyA = toBranchWorktreeKey('project-a', 'feature/example');
    const worktreeKeyB = toBranchWorktreeKey('project-b', 'feature/example');

    const executionTargets = [
      { projectId: 'project-a', branchName: 'feature/example', worktreeKey: worktreeKeyA },
      { projectId: 'project-b', branchName: 'feature/example', worktreeKey: worktreeKeyB },
    ];
    expect(getFileChangesExecutionTargets({
      project_id: 'project-a',
      assigned_branch: 'feature/example',
      execution_targets: executionTargets,
    })).toEqual(executionTargets);
  });
});
