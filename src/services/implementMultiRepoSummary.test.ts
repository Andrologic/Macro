import { describe, expect, it } from 'bun:test';
import {
  buildReviewTaskSummary,
  canRequestTaskChangesFromReview,
  getTaskRepositoryDescriptors,
} from './implementMultiRepoSummary';

describe('buildReviewTaskSummary', () => {
  it('summarizes mixed repository review states and marks the next actionable repository', () => {
    const reviewSummary = buildReviewTaskSummary([
      {
        id: 'repo-a',
        projectId: 'web',
        repoPath: '/repos/web',
        branchName: 'feature/shared-task',
        stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 0 },
        commitState: 'committed',
      },
      {
        id: 'repo-b',
        projectId: 'api',
        repoPath: '/repos/api',
        branchName: 'feature/shared-task',
        stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 2 },
        commitState: 'idle',
      },
      {
        id: 'repo-c',
        projectId: 'worker',
        repoPath: '/repos/worker',
        branchName: 'feature/shared-task',
        stats: { pendingVisibleFileCount: 3, validatedStagedFileCount: 0 },
        commitState: 'idle',
      },
    ]);

    expect(reviewSummary.nextRepositoryId).toBe('repo-b');
    expect(reviewSummary.nextAction).toBe('commit_repository');
    expect(reviewSummary.stateCounts).toEqual({
      pending_validation: 1,
      ready_to_commit: 1,
      committed: 1,
      no_changes: 0,
    });
    expect(reviewSummary.hasCommittedRepositories).toBe(true);
  });

  it('detects no-change reviews as a task-level completion path', () => {
    const reviewSummary = buildReviewTaskSummary([
      {
        id: 'repo-a',
        projectId: 'web',
        repoPath: '/repos/web',
        branchName: 'feature/noop',
        stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 0 },
        commitState: 'no_changes',
      },
      {
        id: 'repo-b',
        projectId: 'api',
        repoPath: '/repos/api',
        branchName: 'feature/noop',
        stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 0 },
        commitState: 'no_changes',
      },
    ]);

    expect(reviewSummary.allRepositoriesResolved).toBe(true);
    expect(reviewSummary.allRepositoriesNoChanges).toBe(true);
    expect(reviewSummary.nextAction).toBe('complete_without_code_changes');
  });

  it('prioritizes validation when the next repository has both staged and unstaged work', () => {
    const reviewSummary = buildReviewTaskSummary([
      {
        id: 'repo-a',
        projectId: 'web',
        repoPath: '/repos/web',
        branchName: 'feature/mixed',
        stats: { pendingVisibleFileCount: 1, validatedStagedFileCount: 1 },
        commitState: 'idle',
      },
      {
        id: 'repo-b',
        projectId: 'api',
        repoPath: '/repos/api',
        branchName: 'feature/mixed',
        stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 2 },
        commitState: 'idle',
      },
    ]);

    expect(reviewSummary.nextRepositoryId).toBe('repo-a');
    expect(reviewSummary.actionCounts).toEqual({
      pending_validation: 1,
      ready_to_commit: 2,
    });
    expect(reviewSummary.nextAction).toBe('validate_repository');
  });
});

describe('canRequestTaskChangesFromReview', () => {
  it('blocks reopening review after a partial repository commit', () => {
    const reviewSummary = buildReviewTaskSummary([
      {
        id: 'repo-a',
        projectId: 'web',
        repoPath: '/repos/web',
        branchName: 'feature/shared-task',
        stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 0 },
        commitState: 'committed',
      },
      {
        id: 'repo-b',
        projectId: 'api',
        repoPath: '/repos/api',
        branchName: 'feature/shared-task',
        stats: { pendingVisibleFileCount: 1, validatedStagedFileCount: 0 },
        commitState: 'idle',
      },
    ]);

    expect(canRequestTaskChangesFromReview(reviewSummary)).toBe(false);
  });
});

describe('getTaskRepositoryDescriptors', () => {
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
