import { describe, expect, it } from 'bun:test';
import {
  getCreatableStandaloneTaskKinds,
  isStandaloneTaskKindCreatable,
} from './standaloneTaskKinds';

describe('standaloneTaskKinds', () => {
  it('allows Feature, Bugfix, Hotfix, and Direct with a distinct development branch', () => {
    expect(getCreatableStandaloneTaskKinds({
      baseBranch: 'develop',
      mainBranch: 'main',
    })).toEqual(['feature', 'bugfix', 'hotfix', 'direct']);
  });

  it('removes Bugfix when the project uses its production branch as the development target', () => {
    expect(getCreatableStandaloneTaskKinds({
      baseBranch: 'main',
      mainBranch: 'main',
    })).toEqual(['feature', 'hotfix', 'direct']);
    expect(isStandaloneTaskKindCreatable('bugfix', {
      baseBranch: 'MAIN',
      mainBranch: 'main',
    })).toBe(false);
  });

  it('keeps legacy projects permissive when their workflow settings are unavailable', () => {
    expect(getCreatableStandaloneTaskKinds(undefined)).toEqual([
      'feature',
      'bugfix',
      'hotfix',
      'direct',
    ]);
  });
});
