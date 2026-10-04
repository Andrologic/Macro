import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'bun:test';
import type { ProjectGitFlowSettings } from '../types';
import {
  isMainlineGitWorkflow,
  isValidGitBranchName,
  renderStandaloneTaskBranchName,
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
  it('detects mainline workflow when the target branch is the main branch', () => {
    expect(isMainlineGitWorkflow(createSettings({ baseBranch: 'main', mainBranch: 'main' }))).toBe(true);
    expect(isMainlineGitWorkflow(createSettings({ baseBranch: 'master', mainBranch: 'master' }))).toBe(true);
    expect(isMainlineGitWorkflow(createSettings({ baseBranch: 'develop', mainBranch: 'main' }))).toBe(false);
  });

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

  it('checks literal branch names against Git without repairing invalid input', () => {
    const names = ['main', 'develop', 'feature/café', 'topic/-part', 'topic/a.b',
      'branch invalid', 'topic..bad', 'topic.lock', 'topic.lock/next', 'topic@{1}',
      '-topic', '/topic', 'topic/', 'topic//part', 'topic\\part', '.topic',
      'topic/.part', 'topic.', 'topic~1', 'topic^', 'topic:part', 'topic?',
      'topic*', 'topic[1]', 'topic\tpart', 'topic\x7f', ' main', 'main ', ''];
    for (const name of names) {
      const accepted = spawnSync('git', ['check-ref-format', '--branch', name]).status === 0;
      expect(isValidGitBranchName(name)).toBe(accepted);
      for (const field of ['baseBranch', 'mainBranch'] as const) {
        const errors = validateProjectGitFlowSettings(createSettings({ [field]: name }));
        expect(errors.length === 0).toBe(accepted);
      }
    }
  });

  it('renders standalone branches from the task kind selected by the agent', () => {
    const settings = createSettings();

    expect(renderStandaloneTaskBranchName({ taskKind: 'feature', taskSlug: 'quick-export', settings }))
      .toBe('feature/quick-export');
    expect(renderStandaloneTaskBranchName({ taskKind: 'bugfix', taskSlug: 'quick-export', settings }))
      .toBe('bugfix/quick-export');
    expect(renderStandaloneTaskBranchName({ taskKind: 'hotfix', taskSlug: 'quick-export', settings }))
      .toBe('hotfix/quick-export');
  });
});
