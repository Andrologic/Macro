// Git currently reports sync failures through a generic Git error payload.
// Keep the fallback text classification in one place until IPC has finer codes.
export type GitSyncFailureKind =
  | 'missing_origin' | 'missing_upstream' | 'remote_unavailable'
  | 'auth' | 'network' | 'local_changes' | 'divergence' | 'unknown';

export const classifyGitSyncFailure = (message: string): GitSyncFailureKind => {
  const text = message.toLowerCase();
  if (['no configured push destination', 'remote origin is not configured',
    "'origin' does not appear to be a git repository", 'no such remote'].some(value => text.includes(value))) {
    return 'missing_origin';
  }
  if (['no tracking information', 'no upstream branch'].some(value => text.includes(value))) {
    return 'missing_upstream';
  }
  if (['authentication failed', 'permission denied', 'could not read username',
    'could not read from remote repository', 'authentication required'].some(value => text.includes(value))) {
    return 'auth';
  }
  if (text.includes('repository') && text.includes('not found')) return 'remote_unavailable';
  if (['could not resolve host', 'failed to connect', 'connection refused', 'timed out',
    'unable to access', 'network is unreachable'].some(value => text.includes(value))) return 'network';
  if (['commit or stash', 'commit your changes or stash', 'not clean',
    'would be overwritten by merge', 'would be overwritten by checkout'].some(value => text.includes(value))) {
    return 'local_changes';
  }
  if (['diverged', 'non-fast-forward', 'not possible to fast-forward', 'fetch first'].some(value => text.includes(value))) {
    return 'divergence';
  }
  return 'unknown';
};
