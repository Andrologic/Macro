#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { changedPaths, classifyPaths } from './classify-changes.mjs';
import { profileForClassification } from './check-profiles.mjs';
import { planFastLocalChecks } from './fast-local-checks.mjs';
import { parsePrePushInput, strongestProfile, targetBaseForBranch } from './pre-push-policy.mjs';
import { withoutGitRepositoryEnvironment } from '../git-environment.mjs';

const ZERO_SHA = /^0+$/;
const REPOSITORY_ENVIRONMENT = withoutGitRepositoryEnvironment(process.env);

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd || process.cwd(),
    env: REPOSITORY_ENVIRONMENT,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function cleanWorktreeRequired() {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    throw new Error(`Fast local checks require a clean worktree before push:\n${status}`);
  }
}

function trackedTestFiles() {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter((path) => /\.test\.(?:ts|tsx)$/.test(path));
}

function currentPushEntry() {
  const branch = git(['branch', '--show-current']);
  if (!branch) {
    throw new Error('Cannot infer a push target from a detached HEAD.');
  }
  return {
    localRef: `refs/heads/${branch}`,
    localSha: git(['rev-parse', 'HEAD']),
    remoteRef: `refs/heads/${branch}`,
    remoteSha: '',
  };
}

function resolveCommit(ref) {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(`Required comparison ref "${ref}" is unavailable. Fetch the target branch before pushing.`);
  }
}

function validationCacheDirectory() {
  if (process.env.MACRO_VALIDATION_CACHE_DIR) {
    return resolve(process.env.MACRO_VALIDATION_CACHE_DIR);
  }
  const commonDirectory = git(['rev-parse', '--git-common-dir']);
  const absoluteCommonDirectory = isAbsolute(commonDirectory)
    ? commonDirectory
    : resolve(process.cwd(), commonDirectory);
  return resolve(absoluteCommonDirectory, 'macro-validation');
}

function validationMarker(key) {
  const digest = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  return resolve(validationCacheDirectory(), `${digest}.json`);
}

function markerIsValid(path, key) {
  if (!existsSync(path)) {
    return false;
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value.key && JSON.stringify(value.key) === JSON.stringify(key) && value.passed === true;
  } catch {
    return false;
  }
}

function writeMarker(path, key) {
  mkdirSync(validationCacheDirectory(), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ passed: true, validated_at: new Date().toISOString(), key }, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env: REPOSITORY_ENVIRONMENT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: options.quiet ? 'utf8' : undefined,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.quiet) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function main() {
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const input = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  const entries = parsePrePushInput(input);
  const pushes = (entries.length > 0 ? entries : [currentPushEntry()])
    .filter((entry) => entry.localSha && !ZERO_SHA.test(entry.localSha));

  if (pushes.length === 0) {
    console.log('Only ref deletions detected; local CI is not required.');
    return;
  }

  cleanWorktreeRequired();

  const releaseTags = pushes
    .filter((entry) => entry.localRef?.startsWith('refs/tags/v'))
    .map((entry) => entry.localRef.slice('refs/tags/'.length));
  if (releaseTags.length > 0) {
    for (const tag of releaseTags) {
      run(process.execPath, ['dev/release/preflight.mjs', '--tag', tag]);
    }
  }

  const branchPushes = pushes.filter((entry) => entry.localRef?.startsWith('refs/heads/'));
  if (branchPushes.length === 0) {
    return;
  }

  const profiles = [];
  const comparisons = [];
  const allChangedPaths = new Set();
  for (const entry of branchPushes) {
    const branch = entry.localRef.slice('refs/heads/'.length);
    const target = targetBaseForBranch(branch, entry.remoteSha);
    const baseSha = resolveCommit(target.ref);
    const headSha = resolveCommit(entry.localSha);
    const paths = changedPaths(baseSha, headSha, target.mode, { env: REPOSITORY_ENVIRONMENT });
    const classification = classifyPaths(paths);
    const profile = profileForClassification(classification);
    profiles.push(profile);
    paths.forEach((path) => allChangedPaths.add(path));
    comparisons.push({ branch, base_sha: baseSha, head_sha: headSha, mode: target.mode, remote_profile: profile });

    const diffRange = target.mode === 'merge-base' ? `${baseSha}...${headSha}` : `${baseSha}..${headSha}`;
    run('git', ['diff', '--check', diffRange]);
  }

  const remoteProfile = strongestProfile(profiles);
  const plan = planFastLocalChecks([...allChangedPaths], {
    exists: (path) => existsSync(resolve(path)),
    readFile: (path) => readFileSync(resolve(path), 'utf8'),
    testFiles: trackedTestFiles(),
  });
  const key = {
    schema: 2,
    platform: process.platform,
    bun: process.versions.bun,
    comparisons: comparisons.sort((left, right) => left.branch.localeCompare(right.branch)),
    steps: plan.steps.map(({ name, command, args }) => ({ name, command, args })),
  };
  const marker = validationMarker(key);

  console.log(`Fast pre-push checks (${plan.steps.length}):`);
  plan.steps.forEach((step) => console.log(`- ${step.name}`));
  console.log(`Remote CI profile after push: ${remoteProfile}`);
  comparisons.forEach((comparison) => {
    console.log(`- ${comparison.branch}: ${comparison.base_sha.slice(0, 12)}..${comparison.head_sha.slice(0, 12)} (${comparison.mode})`);
  });
  console.log('GitHub CI remains the merge authority.');

  if (!force && markerIsValid(marker, key)) {
    console.log('This exact commit range already passed the fast local checks on this platform.');
    return;
  }
  if (dryRun) {
    console.log('Dry run requested; checks were not executed.');
    return;
  }

  if (plan.steps.some((step) => step.needsDependencies)
    && !existsSync(resolve('node_modules/eslint/bin/eslint.js'))) {
    throw new Error('Fast local checks need installed dependencies. Run "bun install" once, then push again.');
  }

  for (const step of plan.steps) {
    console.log(`\n==> ${step.name}`);
    run(step.command, step.args, { quiet: step.quiet });
  }
  try {
    writeMarker(marker, key);
  } catch (error) {
    console.warn(`Fast local checks passed, but their cache marker could not be written: ${error instanceof Error ? error.message : error}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
