#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UPDATER_TARGETS } from './updater-manifest.mjs';

export const UPDATE_CHANNELS = Object.freeze(['stable', 'preview']);

export function createChannelManifests(manifest, channel) {
  if (!UPDATE_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported update channel: ${channel}`);
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.platforms) {
    throw new Error('A complete Tauri updater manifest is required.');
  }

  return Object.fromEntries(UPDATER_TARGETS.map((target) => {
    const platform = manifest.platforms[target];
    if (!platform?.url || !platform?.signature) {
      throw new Error(`Missing updater platform: ${target}`);
    }
    const channelTarget = `${channel}-${target}`;
    return [channelTarget, {
      ...manifest,
      platforms: { [channelTarget]: platform },
    }];
  }));
}

export function writeChannelManifests({ manifestPath, channel, outputDirectory }) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  const manifests = createChannelManifests(manifest, channel);
  const destination = resolve(outputDirectory);
  mkdirSync(destination, { recursive: true });
  for (const [target, value] of Object.entries(manifests)) {
    writeFileSync(resolve(destination, `${target}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  return manifests;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = Object.fromEntries(process.argv.slice(2).reduce((entries, value, index, args) => {
    if (!value.startsWith('--')) return entries;
    entries.push([value.slice(2), args[index + 1]]);
    return entries;
  }, []));
  if (!options.manifest || !options.channel || !options.output) {
    throw new Error('Usage: channel-manifests.mjs --manifest <latest.json> --channel <stable|preview> --output <directory>');
  }
  writeChannelManifests({
    manifestPath: options.manifest,
    channel: options.channel,
    outputDirectory: options.output,
  });
}
