import { describe, expect, it } from 'bun:test';
import { classifyGitSyncFailure } from './gitSyncFailure';

describe('classifyGitSyncFailure', () => {
  it.each([
    ['fatal: No configured push destination.', 'missing_origin'],
    ['Remote origin is not configured.', 'missing_origin'],
    ['There is no tracking information for the current branch.', 'missing_upstream'],
    ['fatal: The current branch develop has no upstream branch.', 'missing_upstream'],
    ['fatal: repository https://example.invalid/repo not found', 'remote_unavailable'],
    ['fatal: unable to access remote: Could not resolve host', 'network'],
    ['fatal: Authentication failed', 'auth'],
    ['Permission denied (publickey).', 'auth'],
    ['Your local changes to the following files would be overwritten by merge', 'local_changes'],
    ['The following untracked working tree files would be overwritten by merge', 'local_changes'],
    ['Please commit your changes or stash them before you merge.', 'local_changes'],
    ['fatal: Not possible to fast-forward, aborting.', 'divergence'],
    ['fatal: unknown failure', 'unknown'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyGitSyncFailure(message)).toBe(expected);
  });

  it('does not call every rejected command a divergence', () => {
    expect(classifyGitSyncFailure('rejected: permission denied')).toBe('auth');
    expect(classifyGitSyncFailure('remote rejected by server hook')).toBe('unknown');
  });
});
