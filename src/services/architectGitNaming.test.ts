import { describe, expect, it } from 'bun:test';
import type { ProjectGitFlowSettings } from '../types';
import {
  validateProjectGitFlowParsing,
  validateProjectGitFlowSettings,
} from './architectGitNaming';

const createSettings = (
  overrides: Partial<ProjectGitFlowSettings> = {},
): ProjectGitFlowSettings => ({
  baseBranch: 'develop',
  mainBranch: 'main',
  planBranchTemplate: 'plan/{planSlug}',
  featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
  standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
  releaseBranchTemplate: 'release/{releaseSlug}',
  hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
  bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
  ...overrides,
});

describe('architectGitNaming', () => {
  it('rejects unknown template placeholders during parse validation', () => {
    const errors = validateProjectGitFlowParsing(
      createSettings({
        featureBranchTemplate:
          'feature/{planSlug}/{featureSlug}/{branchType}',
      }),
    );

    expect(errors).toContain(
      'Feature branch template cannot include unsupported tokens: branchType.',
    );
  });

  it('rejects templates that render invalid Git branch names', () => {
    const errors = validateProjectGitFlowSettings(
      createSettings({
        planBranchTemplate: 'plan/{planSlug}/.draft',
      }),
    );

    expect(errors).toContain(
      'Plan branch template must render a valid Git branch name.',
    );
  });
});
