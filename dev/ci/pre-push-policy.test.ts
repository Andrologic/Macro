import { describe, expect, test } from 'bun:test';
import { parsePrePushInput, strongestProfile, targetBaseForBranch } from './pre-push-policy.mjs';

describe('pre-push policy', () => {
  test('maps GitFlow branches to their review target', () => {
    expect(targetBaseForBranch('feature/hooks', '')).toEqual({ ref: 'origin/develop', mode: 'merge-base' });
    expect(targetBaseForBranch('release/0.1.0', '')).toEqual({ ref: 'origin/main', mode: 'merge-base' });
    expect(targetBaseForBranch('hotfix/security', '')).toEqual({ ref: 'origin/main', mode: 'merge-base' });
  });

  test('uses the exact remote commit for protected branch pushes', () => {
    expect(targetBaseForBranch('develop', 'abc123')).toEqual({ ref: 'abc123', mode: 'direct' });
    expect(targetBaseForBranch('main', '0'.repeat(40))).toEqual({ ref: 'origin/main', mode: 'direct' });
  });

  test('selects the strongest profile across pushed refs', () => {
    expect(strongestProfile(['documentation', 'frontend'])).toBe('frontend');
    expect(strongestProfile(['frontend', 'full'])).toBe('full');
  });

  test('parses the Git pre-push protocol', () => {
    expect(parsePrePushInput('refs/heads/feature/a abc refs/heads/feature/a 000\n')).toEqual([{
      localRef: 'refs/heads/feature/a',
      localSha: 'abc',
      remoteRef: 'refs/heads/feature/a',
      remoteSha: '000',
    }]);
  });
});
