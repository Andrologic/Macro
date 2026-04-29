import { describe, expect, it } from 'bun:test';
import {
  collectMergeWorkflowDirtyFiles,
  isMergeWorkflowFileConflictRepository,
  resolveMergeWorkflowStrategy,
} from './mergeWorkflow';

describe('mergeWorkflow strategy resolution', () => {
  it('classifies dirty repositories before mergeability checks', () => {
    const strategy = resolveMergeWorkflowStrategy({
      status: {
        is_clean: false,
        staged_files: [{ path: 'src/staged.ts', status: 'modified' }],
        unstaged_files: [{ path: 'src/unstaged.ts', status: 'modified' }],
        untracked_files: [{ path: 'src/new.ts', status: 'untracked' }],
      },
      mergeCheck: {
        mergeable: false,
        conflictFiles: [],
        hasChanges: true,
      },
    });

    expect(strategy.mergeStrategy).toBe('dirty');
    expect(strategy.recommendedAction).toBe('stash_dirty');
    expect(strategy.dirtyFiles.map((file) => `${file.area}:${file.path}`)).toEqual([
      'staged:src/staged.ts',
      'unstaged:src/unstaged.ts',
      'untracked:src/new.ts',
    ]);
  });

  it('classifies fast-forwardable branches', () => {
    const strategy = resolveMergeWorkflowStrategy({
      status: { is_clean: true },
      mergeCheck: {
        mergeable: true,
        conflictFiles: [],
        hasChanges: true,
        ahead: 2,
        behind: 0,
      },
    });

    expect(strategy.mergeStrategy).toBe('fast_forward_available');
    expect(strategy.recommendedAction).toBe('fast_forward');
    expect(strategy.availableActions).toContain('merge_commit');
  });

  it('classifies clean local divergent branches as rebaseable when the check passes', () => {
    const strategy = resolveMergeWorkflowStrategy({
      status: { is_clean: true },
      mergeCheck: {
        mergeable: true,
        conflictFiles: [],
        hasChanges: true,
        ahead: 1,
        behind: 1,
      },
      isSourcePublished: false,
      rebaseCheck: {
        rebaseable: true,
        conflictFiles: [],
      },
    });

    expect(strategy.mergeStrategy).toBe('rebase_available');
    expect(strategy.recommendedAction).toBe('rebase_then_continue');
  });

  it('does not offer rebase for published divergent branches', () => {
    const strategy = resolveMergeWorkflowStrategy({
      status: { is_clean: true },
      mergeCheck: {
        mergeable: true,
        conflictFiles: [],
        hasChanges: true,
        ahead: 1,
        behind: 1,
      },
      isSourcePublished: true,
      rebaseCheck: {
        rebaseable: true,
        conflictFiles: [],
      },
    });

    expect(strategy.mergeStrategy).toBe('merge_commit_available');
    expect(strategy.recommendedAction).toBe('merge_commit');
  });

  it('collects dirty files from all git status areas', () => {
    expect(
      collectMergeWorkflowDirtyFiles({
        is_clean: false,
        staged_files: [{ path: 'a.ts', status: 'added' }],
        unstaged_files: [{ path: 'b.ts', status: 'modified' }],
        untracked_files: [{ path: 'c.ts' }],
      })
    ).toEqual([
      { path: 'a.ts', status: 'added', area: 'staged' },
      { path: 'b.ts', status: 'modified', area: 'unstaged' },
      { path: 'c.ts', status: 'untracked', area: 'untracked' },
    ]);
  });

  it('does not treat dirty repositories as file-conflict repositories', () => {
    expect(
      isMergeWorkflowFileConflictRepository({
        mergeStrategy: 'dirty',
        blockingKind: 'repository_dirty',
        conflictFiles: ['src/conflict.ts'],
      })
    ).toBe(false);

    expect(
      isMergeWorkflowFileConflictRepository({
        mergeStrategy: 'file_conflict',
        blockingKind: 'merge_conflict',
        conflictFiles: ['src/conflict.ts'],
      })
    ).toBe(true);
  });
});
