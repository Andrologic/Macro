#!/usr/bin/env bun

import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { UPDATE_CHANNELS } from './channel-manifests.mjs';

const UPDATE_BRANCH = 'updates';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const ISOLATED_GIT_ENVIRONMENT = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
);

function runGit(repositoryDirectory, args, { allowExitCodes = [0] } = {}) {
  const result = spawnSync('git', args, {
    cwd: repositoryDirectory,
    env: ISOLATED_GIT_ENVIRONMENT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!allowExitCodes.includes(result.status)) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function requireChannel(channel) {
  if (!UPDATE_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported update channel: ${channel}`);
  }
  return channel;
}

function requireLabel(label) {
  const value = String(label ?? '').trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new Error('Publication label must be a non-empty single line.');
  }
  return value;
}

function channelManifestNames(manifestsDirectory, channel) {
  const prefix = `${channel}-`;
  const names = readdirSync(manifestsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`No ${channel} channel manifests were found in ${manifestsDirectory}.`);
  }
  return names;
}

export function publishChannelBranch({
  repositoryDirectory,
  manifestsDirectory,
  channel,
  label,
}) {
  const repository = resolve(repositoryDirectory);
  const manifests = resolve(manifestsDirectory);
  const normalizedChannel = requireChannel(channel);
  const normalizedLabel = requireLabel(label);
  const names = channelManifestNames(manifests, normalizedChannel);

  const remoteBranch = runGit(repository, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${UPDATE_BRANCH}`,
  ], { allowExitCodes: [0, 1] });

  if (remoteBranch.status === 0) {
    runGit(repository, ['switch', '--track', `origin/${UPDATE_BRANCH}`]);
  } else {
    runGit(repository, ['switch', '--orphan', UPDATE_BRANCH]);
    const trackedFiles = runGit(repository, ['ls-files']).stdout.trim();
    if (trackedFiles) {
      throw new Error(`New orphan branch unexpectedly contains tracked files: ${trackedFiles}`);
    }
  }

  const channelsDirectory = join(repository, 'channels');
  mkdirSync(channelsDirectory, { recursive: true });
  runGit(repository, [
    'rm',
    '--ignore-unmatch',
    '--',
    `:(glob)channels/${normalizedChannel}-*.json`,
  ]);
  const stagedPaths = names.map((name) => {
    cpSync(join(manifests, name), join(channelsDirectory, basename(name)));
    return `channels/${name}`;
  });
  runGit(repository, ['add', '--', ...stagedPaths]);

  const diff = runGit(repository, ['diff', '--cached', '--quiet'], { allowExitCodes: [0, 1] });
  if (diff.status === 0) {
    return { changed: false, branch: UPDATE_BRANCH, manifests: names };
  }

  runGit(repository, ['config', 'user.name', BOT_NAME]);
  runGit(repository, ['config', 'user.email', BOT_EMAIL]);
  runGit(repository, [
    'commit',
    '-m',
    `chore(updates): advance ${normalizedChannel} to ${normalizedLabel}`,
  ]);
  runGit(repository, ['push', 'origin', `HEAD:${UPDATE_BRANCH}`]);
  return { changed: true, branch: UPDATE_BRANCH, manifests: names };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const repositoryDirectory = argumentValue(args, '--repository');
    const manifestsDirectory = argumentValue(args, '--manifests');
    const channel = argumentValue(args, '--channel');
    const label = argumentValue(args, '--label');
    if (!repositoryDirectory || !manifestsDirectory || !channel || !label) {
      throw new Error('Usage: publish-channel-branch.mjs --repository <path> --manifests <path> --channel <stable|preview> --label <version-or-tag>');
    }
    const result = publishChannelBranch({ repositoryDirectory, manifestsDirectory, channel, label });
    console.log(result.changed
      ? `Published ${channel} channel manifests to ${result.branch}.`
      : `${channel} channel manifests already point to ${label}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
