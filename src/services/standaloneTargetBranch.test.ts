import { describe, expect, it } from 'bun:test';
import { resolveTargetBranch } from './architectPlanService';
import { resolveStandaloneTargetBranchName } from './standaloneTargetBranch';

describe('standaloneTargetBranch', () => {
  it('prefers the execution target branch over the legacy base branch', () => {
    expect(
      resolveStandaloneTargetBranchName(
        { task_source: 'standalone', base_branch: 'develop' },
        { targetBranchName: 'release/web' }
      )
    ).toBe(resolveTargetBranch('release/web'));
  });

  it('falls back to the legacy base branch when execution targets are incomplete', () => {
    expect(
      resolveStandaloneTargetBranchName(
        { task_source: 'standalone', base_branch: 'develop' },
        null,
        { fallbackToGlobalBaseBranch: false }
      )
    ).toBe(resolveTargetBranch('develop'));
  });

  it('can disable the global fallback for incomplete draft data', () => {
    expect(
      resolveStandaloneTargetBranchName(
        { task_source: 'standalone', base_branch: null },
        null,
        { fallbackToGlobalBaseBranch: false }
      )
    ).toBeNull();
  });
});
