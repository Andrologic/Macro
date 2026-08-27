import { describe, expect, test } from 'bun:test';
import { withoutGitRepositoryEnvironment } from './git-environment.mjs';

describe('Git subprocess environment isolation', () => {
  test('removes repository-local variables without dropping transport or identity settings', () => {
    const environment = withoutGitRepositoryEnvironment({
      GIT_DIR: '/unexpected/repository',
      git_index_file: '/unexpected/index',
      GIT_WORK_TREE: '/unexpected/worktree',
      GIT_SSH_COMMAND: 'ssh -i release-key',
      GIT_AUTHOR_NAME: 'Macro Release',
      PATH: '/usr/bin',
    });

    expect(environment).toEqual({
      GIT_SSH_COMMAND: 'ssh -i release-key',
      GIT_AUTHOR_NAME: 'Macro Release',
      PATH: '/usr/bin',
    });
  });

});
