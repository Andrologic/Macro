import { describe, expect, it } from 'bun:test';
import {
  getTaskRepositoryDescriptors,
} from './implementMultiRepoSummary';

describe('buildReviewTaskSummary', () => {
  it('derives repository descriptors for multi-project tasks', () => {
    const repositories = getTaskRepositoryDescriptors(
      {
        assigned_branch: 'feature/shared-task',
        status: 'InReview',
        execution_targets: [
          {
            projectId: 'web',
            branchName: 'feature/web-task',
            worktreeKey: 'branch-web',
          },
          {
            projectId: 'api',
            branchName: 'feature/api-task',
            worktreeKey: 'branch-api',
            repoPath: '/repos/api',
          },
        ],
      },
      (projectId) => {
        if (projectId === 'web') {
          return { name: 'Web App', path: '/repos/web' };
        }
        if (projectId === 'api') {
          return { name: 'API', path: '/repos/api' };
        }
        return null;
      }
    );

    expect(repositories).toEqual([
      {
        id: 'web:feature/web-task',
        projectId: 'web',
        branchName: 'feature/web-task',
        repoPath: '/repos/web',
        projectName: 'Web App',
        label: 'Web App',
      },
      {
        id: 'api:feature/api-task',
        projectId: 'api',
        branchName: 'feature/api-task',
        repoPath: '/repos/api',
        projectName: 'API',
        label: 'API',
      },
    ]);
  });
});
