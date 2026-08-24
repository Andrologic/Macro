#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPDATER_TARGETS = Object.freeze([
  'windows-x86_64',
  'linux-x86_64',
  'darwin-x86_64',
  'darwin-aarch64',
]);

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function validateAssetName(value, label = 'assetName') {
  const assetName = requireNonEmpty(value, label);
  if (assetName === '.' || assetName === '..' || assetName.includes('/') || assetName.includes('\\')) {
    throw new Error(`${label} must be a file name without path segments.`);
  }
  return assetName;
}

function validateVersion(version) {
  const normalized = requireNonEmpty(version, 'version').replace(/^v/, '');
  if (!STABLE_VERSION.test(normalized)) {
    throw new Error(`Updater version must be a stable x.y.z version; found "${version}".`);
  }
  return normalized;
}

function validatePubDate(pubDate) {
  const value = requireNonEmpty(pubDate, 'pub_date');
  if (!RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Updater pub_date must be a valid RFC 3339 date; found "${pubDate}".`);
  }
  return value;
}

export function buildReleaseAssetUrl({ repository, tag, assetName }) {
  const normalizedRepository = requireNonEmpty(repository, 'repository');
  if (!REPOSITORY.test(normalizedRepository)) {
    throw new Error(`Repository must use the owner/name form; found "${repository}".`);
  }

  const normalizedTag = requireNonEmpty(tag, 'tag');
  const normalizedAssetName = validateAssetName(assetName);
  return `https://github.com/${normalizedRepository}/releases/download/${encodeURIComponent(normalizedTag)}/${encodeURIComponent(normalizedAssetName)}`;
}

function readArtifactSignature(signaturePath, target) {
  const resolvedPath = resolve(requireNonEmpty(signaturePath, `${target} signature path`));
  if (!existsSync(resolvedPath)) {
    throw new Error(`Missing updater signature for ${target}: ${signaturePath}`);
  }
  const signature = readFileSync(resolvedPath, 'utf8').trim();
  if (!signature) {
    throw new Error(`Updater signature for ${target} is empty.`);
  }
  return signature;
}

function validateArtifact(target, artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error(`Updater artifact configuration for ${target} is missing.`);
  }

  const artifactPath = resolve(requireNonEmpty(artifact.path, `${target} artifact path`));
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error(`Missing updater artifact for ${target}: ${artifact.path}`);
  }

  const signature = readArtifactSignature(artifact.signaturePath, target);
  const assetName = validateAssetName(artifact.assetName, `${target} asset name`);
  return { assetName, signature };
}

export function createUpdaterManifest({
  version,
  tag,
  repository,
  notes = '',
  pubDate,
  artifacts,
}) {
  const normalizedVersion = validateVersion(version);
  const normalizedTag = requireNonEmpty(tag, 'tag');
  if (normalizedTag !== `v${normalizedVersion}`) {
    throw new Error(`Updater tag must exactly match v${normalizedVersion}; found "${tag}".`);
  }
  const normalizedRepository = requireNonEmpty(repository, 'repository');
  const normalizedNotes = typeof notes === 'string' ? notes : String(notes ?? '');
  const normalizedPubDate = validatePubDate(pubDate);

  if (!artifacts || typeof artifacts !== 'object') {
    throw new Error('Updater artifacts are required.');
  }

  const configuredTargets = Object.keys(artifacts);
  const missingTargets = UPDATER_TARGETS.filter((target) => !configuredTargets.includes(target));
  if (missingTargets.length > 0) {
    throw new Error(`Missing updater artifact targets: ${missingTargets.join(', ')}.`);
  }

  const unsupportedTargets = configuredTargets.filter((target) => !UPDATER_TARGETS.includes(target));
  if (unsupportedTargets.length > 0) {
    throw new Error(`Unsupported updater artifact targets: ${unsupportedTargets.join(', ')}.`);
  }

  const platforms = {};
  for (const target of UPDATER_TARGETS) {
    const artifact = validateArtifact(target, artifacts[target]);
    platforms[target] = {
      signature: artifact.signature,
      url: buildReleaseAssetUrl({
        repository: normalizedRepository,
        tag: normalizedTag,
        assetName: artifact.assetName,
      }),
    };
  }

  return {
    version: normalizedVersion,
    notes: normalizedNotes,
    pub_date: normalizedPubDate,
    platforms,
  };
}

export function writeUpdaterManifest(outputPath, options) {
  const manifest = createUpdaterManifest(options);
  const resolvedOutputPath = resolve(outputPath);
  mkdirSync(dirname(resolvedOutputPath), { recursive: true });
  writeFileSync(resolvedOutputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function nextArgument(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Argument ${name} requires a value.`);
  }
  return value;
}

export function parseUpdaterArguments(args) {
  const options = { artifacts: {} };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--version':
        options.version = nextArgument(args, index, argument);
        index += 1;
        break;
      case '--tag':
        options.tag = nextArgument(args, index, argument);
        index += 1;
        break;
      case '--repository':
        options.repository = nextArgument(args, index, argument);
        index += 1;
        break;
      case '--notes-file': {
        const notesPath = nextArgument(args, index, argument);
        options.notes = readFileSync(resolve(notesPath), 'utf8');
        index += 1;
        break;
      }
      case '--pub-date':
        options.pubDate = nextArgument(args, index, argument);
        index += 1;
        break;
      case '--output':
        options.output = nextArgument(args, index, argument);
        index += 1;
        break;
      case '--artifact': {
        const target = nextArgument(args, index, argument);
        const artifactPath = nextArgument(args, index + 1, `${argument} ${target}`);
        const signaturePath = nextArgument(args, index + 2, `${argument} ${target}`);
        const assetName = nextArgument(args, index + 3, `${argument} ${target}`);
        options.artifacts[target] = { path: artifactPath, signaturePath, assetName };
        index += 4;
        break;
      }
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown updater manifest argument: ${argument}`);
    }
  }
  return options;
}

function printUsage() {
  console.log([
    'Usage:',
    '  bun dev/release/updater-manifest.mjs --version <x.y.z> --tag <vX.Y.Z>',
    '    --repository <owner/name> --notes-file <path> --pub-date <RFC3339>',
    '    --output <path> --artifact <target> <path> <signature-path> <asset-name>',
    '',
    'Repeat --artifact once for each updater target.',
  ].join('\n'));
}

function main() {
  const options = parseUpdaterArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.output) {
    throw new Error('Argument --output is required.');
  }
  writeUpdaterManifest(options.output, options);
  console.log(`Wrote updater manifest to ${options.output}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
