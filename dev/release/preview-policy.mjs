#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateUpdaterManifest } from './verify-updater.mjs';

const SHA = /^[0-9a-f]{40}$/i;
export const PREVIEW_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-(?:nightly\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)|rc\.(0|[1-9][0-9]*))$/;

function requireVersion(value, label = 'Preview version') {
  const version = String(value ?? '').trim().replace(/^v/, '');
  if (!PREVIEW_VERSION.test(version)) {
    throw new Error(`${label} must be a nightly or rc semantic version; found "${value}".`);
  }
  return version;
}

function parseVersion(value, label) {
  const version = requireVersion(value, label);
  const match = version.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)-(nightly|rc)\.(?:([0-9]+)\.([0-9]+)|([0-9]+))$/);
  if (!match) throw new Error(`${label} could not be parsed: ${value}`);
  return {
    version,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    kind: match[4],
    first: BigInt(match[5] ?? match[7]),
    second: BigInt(match[6] ?? 0),
  };
}

export function comparePreviewVersions(left, right) {
  const a = parseVersion(left, 'Left preview version');
  const b = parseVersion(right, 'Right preview version');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.kind !== b.kind) return a.kind === 'rc' ? 1 : -1;
  if (a.first !== b.first) return a.first > b.first ? 1 : -1;
  if (a.second !== b.second) return a.second > b.second ? 1 : -1;
  return 0;
}

function requireSha(value, label) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA.test(sha)) throw new Error(`${label} must be a 40-character commit SHA.`);
  return sha;
}

export function expectedPreviewAssetNames(version) {
  const normalized = requireVersion(version);
  return [
    `Macro_${normalized}_macOS_universal.dmg`,
    `Macro_${normalized}_macOS_universal.app.tar.gz`,
    `Macro_${normalized}_macOS_universal.app.tar.gz.sig`,
    `Macro_${normalized}_Windows_x64_setup.exe`,
    `Macro_${normalized}_Windows_x64_setup.exe.sig`,
    `Macro_${normalized}_Windows_ARM64_setup.exe`,
    `Macro_${normalized}_Windows_ARM64_setup.exe.sig`,
    `Macro_${normalized}_Linux_x64.AppImage`,
    `Macro_${normalized}_Linux_x64.AppImage.sig`,
    `Macro_${normalized}_Linux_x64.deb`,
    `Macro_${normalized}_Linux_x64.rpm`,
    'latest.json',
    'SHA256SUMS.txt',
  ];
}

export function sourceShaFromReleaseBody(body) {
  const match = String(body ?? '').match(/source-sha:([0-9a-f]{40})/i);
  if (!match) throw new Error('Preview release notes do not contain a valid source SHA.');
  return requireSha(match[1], 'Published source SHA');
}

export function previewVersionFromReleaseBody(body) {
  const match = String(body ?? '').match(/(?:^|\n)Macro ([^\s]+) is a validated (?:nightly|rc) build from develop\./);
  if (!match) throw new Error('Preview release notes do not contain a valid preview version.');
  return requireVersion(match[1], 'Published Preview notes version');
}

export function readPublishedPreviewState({ release, manifest }) {
  if (release === null) return null;
  if (!release || typeof release !== 'object') {
    throw new Error('Published Preview release state is not an object.');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Published Preview latest.json is missing or invalid.');
  }
  const manifestVersion = requireVersion(manifest.version, 'Published Preview version');
  const notesVersion = previewVersionFromReleaseBody(release.body);
  if (notesVersion !== manifestVersion) {
    throw new Error(`Published Preview notes version ${notesVersion} does not match latest.json ${manifestVersion}.`);
  }
  const manifestErrors = validateUpdaterManifest(manifest, { channel: 'preview' });
  if (manifestErrors.length > 0) {
    throw new Error(`Published Preview latest.json is incomplete: ${manifestErrors.join(' ')}`);
  }
  const assetNames = new Set((release.assets ?? []).map((asset) => asset?.name));
  const missingAssets = expectedPreviewAssetNames(manifestVersion).filter((name) => !assetNames.has(name));
  if (missingAssets.length > 0) {
    throw new Error(`Published Preview release is incomplete; missing assets: ${missingAssets.join(', ')}.`);
  }
  return {
    version: manifestVersion,
    sourceSha: sourceShaFromReleaseBody(release.body),
    assetNames: [...assetNames],
  };
}

export function decidePreviewPublication({ candidateVersion, sourceSha, published }) {
  const candidate = requireVersion(candidateVersion, 'Candidate Preview version');
  const candidateSha = requireSha(sourceSha, 'Candidate source SHA');
  if (published === null) return { publish: true, candidate, sourceSha: candidateSha };

  const publishedVersion = requireVersion(published?.version, 'Published Preview version');
  const publishedSha = requireSha(published?.sourceSha, 'Published source SHA');
  const comparison = comparePreviewVersions(candidate, publishedVersion);
  if (comparison === 0) {
    if (candidateSha === publishedSha) {
      return {
        publish: false,
        candidate,
        sourceSha: candidateSha,
        reason: `Preview ${candidate} is already published from ${candidateSha}.`,
      };
    }
    throw new Error(`Preview ${candidate} is already published from another commit (${publishedSha}).`);
  }
  if (comparison < 0) {
    throw new Error(`Preview ${candidate} must be greater than the published ${publishedVersion}.`);
  }
  return { publish: true, candidate, sourceSha: candidateSha };
}

export function assertCandidateAssetsUnused(candidateVersion, existingAssetNames = []) {
  const existing = new Set(existingAssetNames);
  const conflicts = expectedPreviewAssetNames(candidateVersion)
    .filter((name) => name !== 'latest.json' && name !== 'SHA256SUMS.txt' && existing.has(name));
  if (conflicts.length > 0) {
    throw new Error(`Preview assets for ${candidateVersion} already exist and are protected: ${conflicts.join(', ')}.`);
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const statePath = argumentValue(args, '--state-file');
  const githubOutput = argumentValue(args, '--github-output');
  if (!statePath || !githubOutput) {
    throw new Error('Usage: preview-policy.mjs --candidate-version <version> --source-sha <sha> --state-file <path> --github-output <path>');
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const published = state === null ? null : readPublishedPreviewState({
    release: state.release,
    manifest: state.manifest,
  });
  const result = decidePreviewPublication({
    candidateVersion: argumentValue(args, '--candidate-version'),
    sourceSha: argumentValue(args, '--source-sha'),
    published,
  });
  if (result.publish && published) {
    assertCandidateAssetsUnused(result.candidate, published.assetNames);
  }
  const lines = [`publish=${result.publish}`];
  if (result.reason) lines.push(`reason=${result.reason}`);
  if (result.publish) {
    lines.push(`version=${result.candidate}`);
    lines.push(`source_sha=${result.sourceSha}`);
  }
  lines.push('');
  Bun.write(githubOutput, `${lines.join('\n')}`);
  if (result.reason) console.log(result.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
