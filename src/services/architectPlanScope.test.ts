import { describe, expect, it } from 'bun:test';

import {
  getArchitectPlanActionableProjectIdsFromScope,
  normalizeArchitectPlanScope,
} from './architectPlanScope';

describe('architectPlanScope', () => {
  it('keeps actionable and context scopes separate and derives expected as their union', () => {
    const scope = normalizeArchitectPlanScope({
      projectId: 'web',
      projectIds: ['web', 'api'],
      contextProjectIds: ['docs', 'web'],
      expectedProjectIds: ['web', 'api', 'docs', 'storybook'],
    });

    expect(scope.actionableProjectIds).toEqual(['web', 'api']);
    expect(scope.contextProjectIds).toEqual(['docs']);
    expect(scope.expectedProjectIds).toEqual(['web', 'api', 'docs']);
  });

  it('only uses expected project ids as an actionable fallback for legacy unscoped plans', () => {
    expect(
      getArchitectPlanActionableProjectIdsFromScope(
        {
          contextProjectIds: ['docs'],
          expectedProjectIds: ['web', 'docs'],
        },
        { useExpectedAsActionableFallback: true }
      )
    ).toEqual(['web']);

    expect(
      getArchitectPlanActionableProjectIdsFromScope({
        contextProjectIds: ['docs'],
        expectedProjectIds: ['web', 'docs'],
      })
    ).toEqual([]);
  });
});
