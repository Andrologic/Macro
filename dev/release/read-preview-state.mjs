#!/usr/bin/env bun

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: null });
  return {
    status: result.status,
    stdout: result.stdout ? Buffer.from(result.stdout) : Buffer.alloc(0),
    stderr: result.stderr ? Buffer.from(result.stderr).toString('utf8') : '',
  };
}

export function isMissingPreviewReleaseError(stderr) {
  return /HTTP 404\b/i.test(String(stderr ?? ''));
}

export function readPreviewState({ repository, allowMissing = false, executeGh = runGh }) {
  const endpoint = `repos/${repository}/releases/tags/preview`;
  const releaseResult = executeGh(['api', endpoint]);
  if (releaseResult.status !== 0) {
    if (allowMissing && isMissingPreviewReleaseError(releaseResult.stderr)) return null;
    throw new Error(`Unable to read the remote Preview release state: ${releaseResult.stderr.trim()}`);
  }

  let release;
  try {
    release = JSON.parse(releaseResult.stdout.toString('utf8'));
  } catch (error) {
    throw new Error(`Remote Preview release metadata is invalid: ${error instanceof Error ? error.message : error}`);
  }
  const latestAsset = release.assets?.find((asset) => asset?.name === 'latest.json');
  if (!latestAsset?.id) {
    throw new Error('Remote Preview release exists but latest.json is missing.');
  }
  const manifestResult = executeGh([
    'api',
    `repos/${repository}/releases/assets/${latestAsset.id}`,
    '--header',
    'Accept: application/octet-stream',
  ]);
  if (manifestResult.status !== 0) {
    throw new Error(`Unable to read the remote Preview latest.json: ${manifestResult.stderr.trim()}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestResult.stdout.toString('utf8'));
  } catch (error) {
    throw new Error(`Remote Preview latest.json is invalid: ${error instanceof Error ? error.message : error}`);
  }
  return { release, manifest };
}

function main() {
  const args = process.argv.slice(2);
  const repository = argumentValue(args, '--repository');
  const output = argumentValue(args, '--output');
  if (!repository || !output) {
    throw new Error('Usage: read-preview-state.mjs --repository <owner/name> --output <path> [--allow-missing]');
  }
  const state = readPreviewState({ repository, allowMissing: args.includes('--allow-missing') });
  writeFileSync(output, `${JSON.stringify(state)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
