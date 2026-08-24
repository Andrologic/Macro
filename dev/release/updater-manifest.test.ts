import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UPDATER_TARGETS,
  buildReleaseAssetUrl,
  createUpdaterManifest,
  parseUpdaterArguments,
  writeUpdaterManifest,
} from './updater-manifest.mjs';

function fixtureArtifacts(root: string) {
  return Object.fromEntries(UPDATER_TARGETS.map((target) => {
    const safeTarget = target.replaceAll('-', '_');
    const artifactPath = join(root, `${safeTarget}.bundle`);
    const signaturePath = join(root, `${safeTarget}.bundle.sig`);
    writeFileSync(artifactPath, `bundle for ${target}`);
    writeFileSync(signaturePath, `signature-${target}\n`);
    return [target, {
      path: artifactPath,
      signaturePath,
      assetName: `Macro_0.2.0_${safeTarget}.bundle`,
    }];
  }));
}

describe('updater manifest', () => {
  test('creates a complete deterministic manifest with tag-pinned URLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-manifest-'));
    try {
      const manifest = createUpdaterManifest({
        version: '0.2.0',
        tag: 'v0.2.0',
        repository: 'Andrologic/Macro',
        notes: '## Changes\n\n- A release.',
        pubDate: '2026-08-19T10:20:30Z',
        artifacts: fixtureArtifacts(root),
      });

      expect(Object.keys(manifest.platforms)).toEqual(UPDATER_TARGETS);
      expect(manifest.version).toBe('0.2.0');
      expect(manifest.pub_date).toBe('2026-08-19T10:20:30Z');
      expect(manifest.platforms['windows-x86_64']).toEqual({
        signature: 'signature-windows-x86_64',
        url: 'https://github.com/Andrologic/Macro/releases/download/v0.2.0/Macro_0.2.0_windows_x86_64.bundle',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes stable JSON ordering and a trailing newline', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-manifest-'));
    try {
      const outputPath = join(root, 'latest.json');
      writeUpdaterManifest(outputPath, {
        version: 'v0.2.0',
        tag: 'v0.2.0',
        repository: 'Andrologic/Macro',
        notes: '',
        pubDate: '2026-08-19T10:20:30Z',
        artifacts: fixtureArtifacts(root),
      });

      const output = readFileSync(outputPath, 'utf8');
      expect(output.endsWith('\n')).toBe(true);
      expect(output.indexOf('"version"')).toBeLessThan(output.indexOf('"notes"'));
      expect(output.indexOf('"notes"')).toBeLessThan(output.indexOf('"pub_date"'));
      expect(JSON.parse(output).version).toBe('0.2.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects incomplete, empty, and unsupported artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-manifest-'));
    try {
      const artifacts = fixtureArtifacts(root);
      delete artifacts['darwin-aarch64'];
      expect(() => createUpdaterManifest({
        version: '0.2.0',
        tag: 'v0.2.0',
        repository: 'Andrologic/Macro',
        pubDate: '2026-08-19T10:20:30Z',
        artifacts,
      })).toThrow('darwin-aarch64');

      const complete = fixtureArtifacts(root);
      writeFileSync(complete['linux-x86_64'].signaturePath, '  \n');
      expect(() => createUpdaterManifest({
        version: '0.2.0',
        tag: 'v0.2.0',
        repository: 'Andrologic/Macro',
        pubDate: '2026-08-19T10:20:30Z',
        artifacts: complete,
      })).toThrow('signature for linux-x86_64 is empty');

      const unsupported = fixtureArtifacts(root);
      unsupported['freebsd-x86_64'] = unsupported['linux-x86_64'];
      expect(() => createUpdaterManifest({
        version: '0.2.0',
        tag: 'v0.2.0',
        repository: 'Andrologic/Macro',
        pubDate: '2026-08-19T10:20:30Z',
        artifacts: unsupported,
      })).toThrow('Unsupported updater artifact targets');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid release metadata and asset URL inputs', () => {
    expect(() => buildReleaseAssetUrl({
      repository: 'Andrologic',
      tag: 'v0.2.0',
      assetName: 'Macro.app.tar.gz',
    })).toThrow('owner/name');

    expect(() => buildReleaseAssetUrl({
      repository: 'Andrologic/Macro',
      tag: 'v0.2.0',
      assetName: '../Macro.exe',
    })).toThrow('without path segments');

    expect(() => createUpdaterManifest({
      version: '0.2.0-rc.1',
      tag: 'v0.2.0-rc.1',
      repository: 'Andrologic/Macro',
      pubDate: '2026-08-19T10:20:30Z',
      artifacts: {},
    })).toThrow('stable x.y.z');

    expect(() => createUpdaterManifest({
      version: '0.2.0',
      tag: 'v0.2.1',
      repository: 'Andrologic/Macro',
      pubDate: '2026-08-19T10:20:30Z',
      artifacts: {},
    })).toThrow('exactly match v0.2.0');

    expect(() => createUpdaterManifest({
      version: '0.2.0',
      tag: 'v0.2.0',
      repository: 'Andrologic/Macro',
      pubDate: 'August 19, 2026',
      artifacts: {},
    })).toThrow('RFC 3339');
  });

  test('parses the release workflow command shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-manifest-'));
    try {
      const notesPath = join(root, 'release-notes.md');
      writeFileSync(notesPath, '## Changes\n');
      const options = parseUpdaterArguments([
        '--version', '0.2.0',
        '--tag', 'v0.2.0',
        '--repository', 'Andrologic/Macro',
        '--notes-file', notesPath,
        '--pub-date', '2026-08-19T10:20:30Z',
        '--output', join(root, 'latest.json'),
        '--artifact', 'windows-x86_64', 'bundle.exe', 'bundle.exe.sig', 'Macro.exe',
      ]);
      expect(options.notes).toBe('## Changes\n');
      expect(options.artifacts['windows-x86_64']).toEqual({
        path: 'bundle.exe',
        signaturePath: 'bundle.exe.sig',
        assetName: 'Macro.exe',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
