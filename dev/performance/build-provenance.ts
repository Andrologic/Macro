import { execFileSync } from 'node:child_process';

/** A baseline build needs a wholly clean worktree, including untracked inputs.
 * Environment files are ignored by Git but consumed by Vite: refuse them too.
 * Dependencies remain caller-installed and their provenance is separate. */
export function assertCleanBuildSource(root: string | URL): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=all')) {
    throw new Error('Commit or remove all tracked and untracked changes before measuring bundles');
  }
  const ignoredInputs = git('ls-files', '--others', '--ignored', '--exclude-standard', '--',
    '.env*', 'src', 'public');
  if (ignoredInputs) throw new Error('Ignored environment/source/public inputs prevent source attribution');
  return git('rev-parse', 'HEAD');
}
