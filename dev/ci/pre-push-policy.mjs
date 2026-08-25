export function targetBaseForBranch(branchName, remoteSha) {
  const hasRemoteCommit = remoteSha && !/^0+$/.test(remoteSha);
  if (branchName === 'develop' || branchName === 'main') {
    return {
      ref: hasRemoteCommit ? remoteSha : `origin/${branchName}`,
      mode: 'direct',
    };
  }
  if (branchName.startsWith('release/') || branchName.startsWith('hotfix/')) {
    return { ref: 'origin/main', mode: 'merge-base' };
  }
  return { ref: 'origin/develop', mode: 'merge-base' };
}

export function strongestProfile(profiles) {
  const weights = { documentation: 1, frontend: 2, full: 3 };
  return profiles.reduce((strongest, candidate) =>
    (weights[candidate] || weights.full) > (weights[strongest] || 0) ? candidate : strongest,
  'documentation');
}

export function parsePrePushInput(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}
