#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UPDATER_TARGETS } from './updater-manifest.mjs';

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function normalizedVersion(version) {
  const value = String(version ?? '').replace(/^v/, '');
  return STABLE_VERSION.test(value) ? value : null;
}

function assetNameFromUrl(value) {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split('/').at(-1) || '');
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || basename(name) !== name) {
      return null;
    }
    return name;
  } catch {
    return null;
  }
}

export function validateUpdaterManifest(manifest, { repository = 'Andrologic/Macro' } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return ['Manifest must be a JSON object.'];
  }

  const version = normalizedVersion(manifest.version);
  if (!version) {
    errors.push(`Manifest version must be a stable x.y.z version; found "${manifest.version}".`);
  }
  if (typeof manifest.notes !== 'string') {
    errors.push('Manifest notes must be a string.');
  }
  if (typeof manifest.pub_date !== 'string' || Number.isNaN(Date.parse(manifest.pub_date))) {
    errors.push('Manifest pub_date must be a valid date.');
  }

  if (!manifest.platforms || typeof manifest.platforms !== 'object') {
    errors.push('Manifest platforms must be an object.');
    return errors;
  }

  const targets = Object.keys(manifest.platforms);
  const missingTargets = UPDATER_TARGETS.filter((target) => !targets.includes(target));
  if (missingTargets.length > 0) {
    errors.push(`Manifest is missing platform targets: ${missingTargets.join(', ')}.`);
  }
  const extraTargets = targets.filter((target) => !UPDATER_TARGETS.includes(target));
  if (extraTargets.length > 0) {
    errors.push(`Manifest contains unsupported platform targets: ${extraTargets.join(', ')}.`);
  }

  for (const target of UPDATER_TARGETS) {
    const platform = manifest.platforms[target];
    if (!platform || typeof platform !== 'object') {
      continue;
    }
    if (typeof platform.signature !== 'string' || platform.signature.trim() === '') {
      errors.push(`Manifest signature is missing for ${target}.`);
    } else if (/^https?:\/\//i.test(platform.signature.trim())) {
      errors.push(`Manifest signature for ${target} must contain signature content, not a URL.`);
    }

    let url;
    try {
      url = new URL(platform.url);
    } catch {
      errors.push(`Manifest URL is invalid for ${target}.`);
      continue;
    }
    const expectedPath = version
      ? `/${repository}/releases/download/v${version}/`
      : `/${repository}/releases/download/`;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedPath)) {
      errors.push(`Manifest URL for ${target} must be an HTTPS URL pinned to the v${version || 'x.y.z'} GitHub tag.`);
    }
    if (!assetNameFromUrl(platform.url)) {
      errors.push(`Manifest URL has no asset name for ${target}.`);
    }
  }
  return errors;
}

function checksumEntries(checksumText) {
  const entries = new Map();
  for (const line of checksumText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifyLocalUpdaterAssets(manifest, assetRoot, checksumsPath) {
  const errors = [];
  const root = resolve(assetRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [`Asset root does not exist or is not a directory: ${assetRoot}`];
  }

  const assets = new Map();
  for (const target of UPDATER_TARGETS) {
    const platform = manifest.platforms?.[target];
    const assetName = platform ? assetNameFromUrl(platform.url) : null;
    if (!assetName) continue;
    const expectedSignature = typeof platform.signature === 'string'
      ? platform.signature.trim()
      : null;
    assets.set(assetName, target);
    assets.set(`${assetName}.sig`, `${target} signature`);
    const artifactPath = resolve(root, assetName);
    const signaturePath = resolve(root, `${assetName}.sig`);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      errors.push(`Missing downloaded updater asset for ${target}: ${assetName}`);
    }
    if (!existsSync(signaturePath) || !statSync(signaturePath).isFile()) {
      errors.push(`Missing downloaded updater signature for ${target}: ${assetName}.sig`);
    } else if (expectedSignature && readFileSync(signaturePath, 'utf8').trim() !== expectedSignature) {
      errors.push(`Updater signature content does not match latest.json for ${target}: ${assetName}.sig`);
    }
  }

  if (checksumsPath) {
    const entries = checksumEntries(readFileSync(resolve(checksumsPath), 'utf8'));
    for (const assetName of assets.keys()) {
      const path = resolve(root, assetName);
      const expected = entries.get(assetName);
      if (!expected) {
        errors.push(`Checksum file does not contain ${assetName}.`);
      } else if (existsSync(path) && statSync(path).isFile() && sha256(path) !== expected) {
        errors.push(`Checksum mismatch for ${assetName}.`);
      }
    }
    const manifestName = basename(new URL('https://github.com/Andrologic/Macro/releases/latest/download/latest.json').pathname);
    const manifestPath = resolve(root, manifestName);
    const expectedManifestHash = entries.get(manifestName);
    if (!expectedManifestHash) {
      errors.push(`Checksum file does not contain ${manifestName}.`);
    } else if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
      errors.push(`Asset root does not contain ${manifestName}.`);
    } else if (sha256(manifestPath) !== expectedManifestHash) {
      errors.push(`Checksum mismatch for ${manifestName}.`);
    }
  }
  return errors;
}

async function readManifest(source) {
  if (/^https?:\/\//i.test(source)) {
    if (!/^https:\/\//i.test(source)) {
      throw new Error('Remote updater manifests must use HTTPS.');
    }
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Unable to download updater manifest: HTTP ${response.status}.`);
    }
    return response.json();
  }
  return JSON.parse(readFileSync(resolve(source), 'utf8'));
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function printUsage() {
  console.log('Usage: bun dev/release/verify-updater.mjs --manifest <path-or-https-url> [--asset-root <path>] [--checksums <path>]');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    return;
  }
  const source = argumentValue(args, '--manifest');
  if (!source) throw new Error('Argument --manifest is required.');
  const manifest = await readManifest(source);
  const errors = validateUpdaterManifest(manifest);
  const assetRoot = argumentValue(args, '--asset-root');
  if (assetRoot) {
    errors.push(...verifyLocalUpdaterAssets(manifest, assetRoot, argumentValue(args, '--checksums')));
  }
  if (errors.length > 0) {
    console.error('Updater release verification failed:');
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(`Updater release verification passed for v${normalizedVersion(manifest.version)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
