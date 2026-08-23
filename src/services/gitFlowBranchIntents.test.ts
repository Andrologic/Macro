import { describe, expect, it } from 'bun:test';
import {
  getPlanNodeBranchIntent,
  getPredictedBranchIntentKey,
  inferWorkBranchTypeFromName,
  resolveWorkBranchIntent,
} from './gitFlowBranchIntents';

describe('gitFlowBranchIntents', () => {
  it('normalizes Git references and separators when inferring the work type', () => {
    expect(inferWorkBranchTypeFromName(' refs\\heads\\HOTFIX\\urgent-fix/ ')).toBe('hotfix');
    expect(inferWorkBranchTypeFromName('/release/v2/')).toBe('release');
    expect(inferWorkBranchTypeFromName('topic/no-known-prefix')).toBe('feature');
  });

  it('gives explicit type and slug fields priority over the legacy assigned branch', () => {
    expect(
      resolveWorkBranchIntent({
        branchType: 'bugfix',
        branchSlug: ' Checkout Crash ',
        assignedBranch: 'refs/heads/hotfix/legacy-fix',
      }),
    ).toEqual({
      branchType: 'bugfix',
      branchSlug: 'checkout-crash',
      label: 'bugfix/checkout-crash',
      key: 'bugfix:checkout-crash',
      legacyAssignedBranch: 'hotfix/legacy-fix',
    });
  });

  it('derives a coherent intent from a legacy assigned branch', () => {
    expect(
      resolveWorkBranchIntent({
        assignedBranch: ' refs\\heads\\release\\V2.4.0 ',
      }),
    ).toEqual({
      branchType: 'release',
      branchSlug: 'v2.4.0',
      label: 'release/v2.4.0',
      key: 'release:v2.4.0',
      legacyAssignedBranch: 'release/V2.4.0',
    });
  });

  it('falls back to the plan title and exposes the same normalized key for predictions', () => {
    expect(
      getPlanNodeBranchIntent({
        branchType: 'feature',
        title: 'Add Project Export',
      }),
    ).toMatchObject({
      branchSlug: 'add-project-export',
      key: 'feature:add-project-export',
      legacyAssignedBranch: 'add-project-export',
    });
    expect(
      getPredictedBranchIntentKey({
        name: 'refs/heads/feature/add-project-export',
      }),
    ).toBe('feature:add-project-export');
  });
});
