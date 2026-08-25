import { describe, expect, it } from 'bun:test';
import type { ProjectGitFlowSettings } from '../types';
import {
  getCreatableArchitectPlanKinds,
  getPlanKindBackmergeBranch,
  normalizeArchitectPlanGitFlowMetadata,
} from './architectPlanKinds';

const createSettings = (
  baseBranch: string,
  mainBranch: string,
): ProjectGitFlowSettings => ({
  baseBranch,
  mainBranch,
  planBranchTemplate: 'plan/{planSlug}',
  featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
  standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
  releaseBranchTemplate: 'release/{releaseSlug}',
  hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
  bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
});

describe('architectPlanKinds', () => {
  it('allows creating feature and hotfix plans for mainline projects', () => {
    expect(getCreatableArchitectPlanKinds([createSettings('main', 'main')])).toEqual([
      'feature',
      'hotfix',
    ]);
  });

  it('allows creating feature and hotfix plans when a mixed scope includes a mainline project', () => {
    expect(
      getCreatableArchitectPlanKinds([
        createSettings('main', 'main'),
        createSettings('develop', 'main'),
      ])
    ).toEqual(['feature', 'hotfix']);
  });

  it('keeps typed plan creation available for develop-based projects', () => {
    expect(getCreatableArchitectPlanKinds([createSettings('develop', 'main')])).toEqual([
      'feature',
      'release',
      'hotfix',
      'bugfix',
    ]);
  });

  it('keeps all plan kinds available when no project settings are provided', () => {
    expect(getCreatableArchitectPlanKinds([])).toEqual([
      'feature',
      'release',
      'hotfix',
      'bugfix',
    ]);
  });

  it('omits hotfix backmerge for mainline projects', () => {
    expect(
      getPlanKindBackmergeBranch({
        planKind: 'hotfix',
        baseBranch: 'main',
        mainBranch: 'main',
      })
    ).toBeNull();
  });

  it('keeps hotfix backmerge for develop-based projects', () => {
    expect(
      getPlanKindBackmergeBranch({
        planKind: 'hotfix',
        baseBranch: 'develop',
        mainBranch: 'main',
      })
    ).toBe('develop');
  });

  it('keeps release backmerge for develop-based projects', () => {
    expect(
      getPlanKindBackmergeBranch({
        planKind: 'release',
        baseBranch: 'develop',
        mainBranch: 'main',
      })
    ).toBe('develop');
  });

  it('normalizes mixed-scope hotfix metadata with project-specific backmerge branches', () => {
    const metadata = normalizeArchitectPlanGitFlowMetadata({
      planKind: 'hotfix',
      projectIds: ['mainline-web', 'develop-api'],
      fallbackSlug: 'critical-patch',
      getDefaultBranches: (projectId) =>
        projectId === 'mainline-web'
          ? { baseBranch: 'main', mainBranch: 'main' }
          : { baseBranch: 'develop', mainBranch: 'main' },
    });

    expect(metadata?.projects['mainline-web']).toMatchObject({
      sourceBranch: 'main',
      targetBranch: 'main',
      backmergeBranch: null,
    });
    expect(metadata?.projects['develop-api']).toMatchObject({
      sourceBranch: 'main',
      targetBranch: 'main',
      backmergeBranch: 'develop',
    });
  });
});
