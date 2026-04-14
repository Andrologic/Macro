import { describe, expect, it } from 'bun:test';
import { toBranchWorktreeKey } from './implementTaskDerivation';
import {
  areAllFileChangesRepositoriesResolved,
  getFileChangesExecutionTargets,
  getFileChangesTaskRepositoryIds,
} from './fileChangesReviewScope';

describe('fileChangesReviewScope', () => {
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
        worktreeKey: toBranchWorktreeKey('project-a', 'feature/example'),
        planBranchName: 'main',
      },
    ]);
  });

  it('prefers explicit execution targets when deriving repository ids', () => {
    const worktreeKeyA = toBranchWorktreeKey('project-a', 'feature/example');
    const worktreeKeyB = toBranchWorktreeKey('project-b', 'feature/example');

    expect(
      getFileChangesTaskRepositoryIds({
        project_id: 'project-a',
        assigned_branch: 'feature/example',
        execution_targets: [
          {
            projectId: 'project-a',
            branchName: 'feature/example',
            worktreeKey: worktreeKeyA,
          },
          {
            projectId: 'project-b',
            branchName: 'feature/example',
            worktreeKey: worktreeKeyB,
          },
        ],
      })
    ).toEqual([
      `project-a::${worktreeKeyA}`,
      `project-b::${worktreeKeyB}`,
    ]);
  });

  it('treats committed repositories and execution records as resolved', () => {
    const worktreeKeyA = toBranchWorktreeKey('project-a', 'feature/example');
    const worktreeKeyB = toBranchWorktreeKey('project-b', 'feature/example');

    expect(
      areAllFileChangesRepositoriesResolved({
        task: {
          project_id: 'project-a',
          assigned_branch: 'feature/example',
          execution_targets: [
            {
              projectId: 'project-a',
              branchName: 'feature/example',
              worktreeKey: worktreeKeyA,
            },
            {
              projectId: 'project-b',
              branchName: 'feature/example',
              worktreeKey: worktreeKeyB,
            },
          ],
        },
        repositories: [
          {
            id: `project-a::${worktreeKeyA}`,
            commitState: 'committed',
          },
          {
            id: `project-b::${worktreeKeyB}`,
            commitState: 'idle',
          },
        ],
        executionRecords: {
          [`project-b::${worktreeKeyB}`]: {
            status: 'committed',
          },
        },
      })
    ).toBe(true);
  });

  it('returns false when at least one repository is still unresolved', () => {
    const worktreeKeyA = toBranchWorktreeKey('project-a', 'feature/example');
    const worktreeKeyB = toBranchWorktreeKey('project-b', 'feature/example');

    expect(
      areAllFileChangesRepositoriesResolved({
        task: {
          project_id: 'project-a',
          assigned_branch: 'feature/example',
          execution_targets: [
            {
              projectId: 'project-a',
              branchName: 'feature/example',
              worktreeKey: worktreeKeyA,
            },
            {
              projectId: 'project-b',
              branchName: 'feature/example',
              worktreeKey: worktreeKeyB,
            },
          ],
        },
        repositories: [
          {
            id: `project-a::${worktreeKeyA}`,
            commitState: 'committed',
          },
          {
            id: `project-b::${worktreeKeyB}`,
            commitState: 'idle',
          },
        ],
        executionRecords: {},
      })
    ).toBe(false);
  });
});
