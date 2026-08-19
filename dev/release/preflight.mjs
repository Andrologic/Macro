#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expectedReleaseTag, packageCommandForPlatform } from './preflight-policy.mjs';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitStatus(args) {
  return spawnSync('git', args, { stdio: 'ignore', windowsHide: true }).status;
}

function run(command, args) {
  console.log(`\n==> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function verifyLocalTag(tag, head) {
  const ref = `refs/tags/${tag}`;
  if (gitStatus(['show-ref', '--verify', '--quiet', ref]) !== 0) {
    console.log(`Local tag ${tag} does not exist yet; create it as an annotated tag after this preflight passes.`);
    return;
  }
  if (git(['cat-file', '-t', tag]) !== 'tag') {
    throw new Error(`Local tag ${tag} exists but is not annotated.`);
  }
  if (git(['rev-parse', `${tag}^{commit}`]) !== head) {
    throw new Error(`Local tag ${tag} does not point to HEAD.`);
  }
}

function verifyRemoteTagAbsent(tag) {
  const result = spawnSync('git', [
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    `refs/tags/${tag}`,
  ], { encoding: 'utf8', windowsHide: true });

  if (result.status === 0) {
    throw new Error(`Remote tag ${tag} already exists and must remain immutable.`);
  }
  if (result.status !== 2) {
    throw new Error(`Unable to verify remote tag availability: ${(result.stderr || '').trim() || 'git ls-remote failed'}`);
  }
}

function main() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const expectedTag = expectedReleaseTag(packageJson.version);
  const requestedTag = argumentValue('--tag') || expectedTag;
  if (requestedTag !== expectedTag) {
    throw new Error(`Requested tag ${requestedTag} does not match package version ${packageJson.version}.`);
  }

  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    throw new Error(`Release preflight requires a clean worktree:\n${status}`);
  }

  const head = git(['rev-parse', 'HEAD']);
  let originMain;
  try {
    originMain = git(['rev-parse', '--verify', 'origin/main^{commit}']);
  } catch {
    throw new Error('origin/main is unavailable. Fetch origin/main and tags before preparing a release.');
  }
  if (head !== originMain) {
    throw new Error(`Release HEAD ${head} must exactly match origin/main ${originMain}. Push and validate main before tagging.`);
  }

  verifyLocalTag(requestedTag, head);
  verifyRemoteTagAbsent(requestedTag);
  run(process.execPath, ['dev/ci/run-checks.mjs', '--profile', 'full']);

  const [command, args] = packageCommandForPlatform(process.platform);
  run(command, args);
  console.log(`\nRelease preflight passed for ${requestedTag} on ${process.platform}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
