#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UPDATE_CHANNELS } from './channel-manifests.mjs';
import { UPDATER_TARGETS } from './updater-manifest.mjs';

function expectedAssetPrefix(repository, tag) {
  return `/${repository}/releases/download/${encodeURIComponent(tag)}/`;
}

export function validateChannelManifest(manifest, {
  channel,
  target,
  version,
  tag,
  repository = 'Andrologic/Macro',
}) {
  const errors = [];
  const channelTarget = `${channel}-${target}`;
  if (!UPDATE_CHANNELS.includes(channel)) errors.push(`Unsupported update channel: ${channel}.`);
  if (!UPDATER_TARGETS.includes(target)) errors.push(`Unsupported updater target: ${target}.`);
  if (!manifest || typeof manifest !== 'object') return ['Channel manifest must be a JSON object.'];
  if (manifest.version !== version) {
    errors.push(`Channel manifest version must be ${version}; found ${manifest.version}.`);
  }
  if (typeof manifest.notes !== 'string') errors.push('Channel manifest notes must be a string.');
  if (typeof manifest.pub_date !== 'string' || Number.isNaN(Date.parse(manifest.pub_date))) {
    errors.push('Channel manifest pub_date must be a valid date.');
  }

  const platformKeys = manifest.platforms && typeof manifest.platforms === 'object'
    ? Object.keys(manifest.platforms)
    : [];
  if (platformKeys.length !== 1 || platformKeys[0] !== channelTarget) {
    errors.push(`Channel manifest must contain only platform ${channelTarget}.`);
    return errors;
  }

  const platform = manifest.platforms[channelTarget];
  if (typeof platform?.signature !== 'string' || !platform.signature.trim()) {
    errors.push(`Updater signature is missing for ${channelTarget}.`);
  } else if (/^https?:\/\//i.test(platform.signature.trim())) {
    errors.push(`Updater signature for ${channelTarget} must contain signature content, not a URL.`);
  }

  try {
    const url = new URL(platform?.url);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || !url.pathname.startsWith(expectedAssetPrefix(repository, tag))
    ) {
      errors.push(`Updater URL for ${channelTarget} must be pinned to ${repository} tag ${tag}.`);
    }
  } catch {
    errors.push(`Updater URL is invalid for ${channelTarget}.`);
  }
  return errors;
}

export function verifyChannelManifestDirectory({
  directory,
  channel,
  version,
  tag,
  repository = 'Andrologic/Macro',
}) {
  const root = resolve(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [`Channel manifest directory does not exist: ${directory}.`];
  }
  const expectedNames = UPDATER_TARGETS.map((target) => `${channel}-${target}.json`).sort();
  const actualNames = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${channel}-`) && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const errors = [];
  for (const name of expectedNames.filter((value) => !actualNames.includes(value))) {
    errors.push(`Missing channel manifest: ${name}.`);
  }
  for (const name of actualNames.filter((value) => !expectedNames.includes(value))) {
    errors.push(`Unexpected channel manifest: ${name}.`);
  }
  for (const target of UPDATER_TARGETS) {
    const name = `${channel}-${target}.json`;
    if (!actualNames.includes(name)) continue;
    try {
      const manifest = JSON.parse(readFileSync(resolve(root, name), 'utf8'));
      errors.push(...validateChannelManifest(manifest, { channel, target, version, tag, repository })
        .map((error) => `${name}: ${error}`));
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return errors;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {
    directory: argumentValue(args, '--directory'),
    channel: argumentValue(args, '--channel'),
    version: argumentValue(args, '--version'),
    tag: argumentValue(args, '--tag'),
    repository: argumentValue(args, '--repository') || 'Andrologic/Macro',
  };
  if (!options.directory || !options.channel || !options.version || !options.tag) {
    console.error('Usage: verify-channel-manifests.mjs --directory <path> --channel <stable|preview> --version <semver> --tag <tag> [--repository <owner/name>]');
    process.exit(1);
  }
  const errors = verifyChannelManifestDirectory(options);
  if (errors.length > 0) {
    console.error('Updater channel verification failed:');
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(`Updater ${options.channel} channel verification passed for ${options.version}.`);
}
