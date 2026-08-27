import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { createChannelManifests } from './channel-manifests.mjs';
import { UPDATER_TARGETS } from './updater-manifest.mjs';
import {
  validateChannelManifest,
  verifyChannelManifestDirectory,
} from './verify-channel-manifests.mjs';

const baseManifest = () => ({
  version: '0.1.1',
  notes: 'First supported release.',
  pub_date: '2026-08-27T10:00:00Z',
  platforms: Object.fromEntries(UPDATER_TARGETS.map((target) => [target, {
    signature: `signature-${target}`,
    url: `https://github.com/Andrologic/Macro/releases/download/v0.1.1/Macro_${target}.bundle`,
  }])),
});

describe('updater channel verification', () => {
  test('accepts complete stable manifests including Windows ARM64', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-channel-verify-'));
    try {
      mkdirSync(root, { recursive: true });
      const manifests = createChannelManifests(baseManifest(), 'stable');
      for (const [target, manifest] of Object.entries(manifests)) {
        writeFileSync(join(root, `${target}.json`), JSON.stringify(manifest));
      }
      expect(verifyChannelManifestDirectory({
        directory: root,
        channel: 'stable',
        version: '0.1.1',
        tag: 'v0.1.1',
      })).toEqual([]);
      expect(manifests['stable-windows-aarch64'].platforms['stable-windows-aarch64']).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a mismatched target, version, signature, and tag URL', () => {
    const manifest = {
      version: '0.1.0',
      notes: '',
      pub_date: 'invalid',
      platforms: {
        'stable-windows-aarch64': {
          signature: 'https://example.com/signature',
          url: 'https://github.com/Andrologic/Macro/releases/download/v0.1.0/Macro.exe',
        },
      },
    };
    const errors = validateChannelManifest(manifest, {
      channel: 'stable',
      target: 'windows-aarch64',
      version: '0.1.1',
      tag: 'v0.1.1',
    });
    expect(errors.some((error) => error.includes('version'))).toBe(true);
    expect(errors.some((error) => error.includes('pub_date'))).toBe(true);
    expect(errors.some((error) => error.includes('signature content'))).toBe(true);
    expect(errors.some((error) => error.includes('tag v0.1.1'))).toBe(true);
  });
});
