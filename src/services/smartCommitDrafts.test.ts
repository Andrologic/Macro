import { describe, expect, it } from 'bun:test';
import type { ReviewRepositoryState } from '../stores/useFileChangesStore';
import {
  buildDefaultCommitMessage,
  buildEditableCommitMessages,
  buildManualCommitMessageDrafts,
  getReadyCommitRepositories,
  isRepositoryReadyToCommit,
} from './smartCommitDrafts';

const repository = (
  id: string,
  overrides: Partial<ReviewRepositoryState> = {}
): ReviewRepositoryState => ({
  id,
  projectId: id,
  repoPath: `/repo/${id}`,
  worktreePath: `/repo/${id}`,
  branchName: 'feature/work',
  planBranchName: null,
  changes: [],
  stagedPaths: ['src/file.ts'],
  selectedChangeId: null,
  stats: {
    pendingVisibleFileCount: 0,
    validatedStagedFileCount: 1,
    additions: 1,
    deletions: 0,
  },
  commitMessageDraft: 'fix: keep saved draft',
  commitState: 'idle',
  loadingChangeId: null,
  savingChangeId: null,
  lastError: null,
  lastCommitHash: null,
  ...overrides,
});

describe('smartCommitDrafts', () => {
  it('uses the same ready-to-commit predicate for filtering', () => {
    const ready = repository('ready');
    const committed = repository('committed', { commitState: 'committed' });
    const unstaged = repository('unstaged', {
      stagedPaths: [],
      stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 1, additions: 1, deletions: 0 },
    });
    const unvalidated = repository('unvalidated', {
      stats: { pendingVisibleFileCount: 0, validatedStagedFileCount: 0, additions: 1, deletions: 0 },
    });

    expect(isRepositoryReadyToCommit(ready)).toBe(true);
    expect(getReadyCommitRepositories([ready, committed, unstaged, unvalidated])).toEqual([ready]);
  });

  it('builds manual drafts from existing valid repository drafts first', () => {
    expect(buildManualCommitMessageDrafts([repository('repo-a')])).toEqual({
      'repo-a': {
        type: 'fix',
        scope: null,
        breaking: false,
        subject: 'keep saved draft',
        body: null,
      },
    });
  });

  it('falls back to the task title when the repository draft is invalid', () => {
    expect(buildDefaultCommitMessage('Update task changes')).toBe('chore: update task changes');
    expect(buildManualCommitMessageDrafts([
      repository('repo-a', { commitMessageDraft: 'not conventional' }),
    ], { taskTitle: 'Ship smarter commits' })).toEqual({
      'repo-a': {
        type: 'chore',
        scope: null,
        breaking: false,
        subject: 'ship smarter commits',
        body: null,
      },
    });
  });

  it('builds editable fields from generated messages only for ready repositories', () => {
    expect(buildEditableCommitMessages({
      repositories: [
        {
          repositoryId: 'repo-a',
          type: 'feat',
          breaking: true,
          subject: 'add manual fallback',
          body: 'Keeps commits unblocked.',
        },
        {
          repositoryId: 'repo-b',
          type: 'fix',
          breaking: false,
          subject: 'ignored committed repo',
          body: null,
        },
      ],
    }, [
      repository('repo-a'),
      repository('repo-b', { commitState: 'committed' }),
    ])).toEqual({
      'repo-a': {
        type: 'feat',
        scope: null,
        breaking: true,
        subject: 'add manual fallback',
        body: 'Keeps commits unblocked.',
      },
    });
  });
});
