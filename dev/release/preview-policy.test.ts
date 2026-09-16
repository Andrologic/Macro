import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  comparePreviewVersions,
  decidePreviewPublication,
  expectedPreviewAssetNames,
  assertCandidateAssetsUnused,
  readPublishedPreviewState,
  sourceShaFromReleaseBody,
} from './preview-policy.mjs';
import { isMissingPreviewReleaseError, readPreviewState } from './read-preview-state.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function validManifest(version: string) {
  const assets = new Map([
    ['windows-x86_64', `Macro_${version}_Windows_x64_setup.exe`],
    ['windows-aarch64', `Macro_${version}_Windows_ARM64_setup.exe`],
    ['linux-x86_64', `Macro_${version}_Linux_x64.AppImage`],
    ['darwin-x86_64', `Macro_${version}_macOS_universal.app.tar.gz`],
    ['darwin-aarch64', `Macro_${version}_macOS_universal.app.tar.gz`],
  ]);
  return {
    version,
    notes: 'Preview',
    pub_date: '2026-09-16T10:20:30Z',
    platforms: Object.fromEntries([...assets].map(([target, name]) => [target, {
      signature: 'signature',
      url: `https://github.com/Andrologic/Macro/releases/download/preview/${name}`,
    }])),
  };
}

describe('preview publication policy', () => {
  test('orders nightly builds before RCs and compares their sequence numbers', () => {
    expect(comparePreviewVersions('0.2.0-nightly.20260916.42', '0.2.0-nightly.20260916.43')).toBe(-1);
    expect(comparePreviewVersions('0.2.0-nightly.20260917.1', '0.2.0-rc.1')).toBe(-1);
    expect(comparePreviewVersions('0.2.0-rc.2', '0.2.0-rc.1')).toBe(1);
    expect(comparePreviewVersions('0.2.0-rc.999999999999999999999999', '0.2.0-rc.2')).toBe(1);
  });

  test('allows the first preview and requires later candidates to increase', () => {
    expect(decidePreviewPublication({
      candidateVersion: '0.2.0-rc.1',
      sourceSha: SHA_A,
      published: null,
    }).publish).toBe(true);
    expect(() => decidePreviewPublication({
      candidateVersion: '0.2.0-nightly.20260917.1',
      sourceSha: SHA_A,
      published: { version: '0.2.0-rc.1', sourceSha: SHA_A },
    })).toThrow('must be greater');
  });

  test('skips an exact retry but rejects reuse from another SHA', () => {
    const published = { version: '0.2.0-rc.1', sourceSha: SHA_A };
    expect(decidePreviewPublication({
      candidateVersion: published.version,
      sourceSha: SHA_A,
      published,
    }).publish).toBe(false);
    expect(() => decidePreviewPublication({
      candidateVersion: published.version,
      sourceSha: SHA_B,
      published,
    })).toThrow('another commit');
  });

  test('requires a complete remote state when a Preview release exists', () => {
    const assets = expectedPreviewAssetNames('0.2.0-rc.1').map((name) => ({ name }));
    expect(readPublishedPreviewState({
      release: { body: `Macro 0.2.0-rc.1 is a validated rc build from develop.\n<!-- source-sha:${SHA_A} -->`, assets },
      manifest: validManifest('0.2.0-rc.1'),
    })).toEqual({ version: '0.2.0-rc.1', sourceSha: SHA_A, assetNames: assets.map(({ name }) => name) });
    expect(() => readPublishedPreviewState({
      release: { body: `Macro 0.2.0-rc.1 is a validated rc build from develop.\n<!-- source-sha missing -->`, assets },
      manifest: validManifest('0.2.0-rc.1'),
    })).toThrow('source SHA');
    expect(() => readPublishedPreviewState({
      release: { body: `<!-- source-sha:${SHA_A} -->`, assets },
      manifest: null,
    })).toThrow('latest.json');
    expect(() => readPublishedPreviewState({
      release: { body: `Macro 0.2.0-rc.1 is a validated rc build from develop.\n<!-- source-sha:${SHA_A} -->`, assets },
      manifest: validManifest('0.2.0-rc.2'),
    })).toThrow('does not match');
    expect(sourceShaFromReleaseBody(`<!-- source-sha:${SHA_A} -->`)).toBe(SHA_A);
  });

  test('protects versioned assets left by a partial newer publication', () => {
    expect(() => assertCandidateAssetsUnused('0.2.0-rc.2', [
      'Macro_0.2.0-rc.2_Linux_x64.deb',
    ])).toThrow('already exist and are protected');
  });

  test('keeps Preview state reads shared and protects versioned uploads in the workflow', () => {
    const workflow = readFileSync(join(import.meta.dir, '../../.github/workflows/preview.yml'), 'utf8');
    expect(workflow.match(/read-preview-state\.mjs/g)).toHaveLength(2);
    expect(workflow).toContain('mapfile -t VERSIONED_ASSETS');
    expect(workflow).toContain('gh release upload preview "${VERSIONED_ASSETS[@]}"');
    expect(workflow).toContain('gh release upload preview release-assets/latest.json release-assets/SHA256SUMS.txt --clobber');
    expect(workflow).not.toContain('gh release upload preview release-assets/* --clobber');
  });

  test('only treats an explicit remote 404 as an absent first release', () => {
    expect(isMissingPreviewReleaseError('gh: Not Found (HTTP 404)')).toBe(true);
    expect(isMissingPreviewReleaseError('gh: API request failed: HTTP 500')).toBe(false);
    expect(isMissingPreviewReleaseError('dial tcp: network is unreachable')).toBe(false);
  });

  test('allows a missing first Preview release but refuses remote API failures', () => {
    const missing = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: 'HTTP 404: Not Found' });
    expect(readPreviewState({
      repository: 'Andrologic/Macro',
      allowMissing: true,
      executeGh: missing,
    })).toBeNull();

    for (const stderr of ['HTTP 500: Internal Server Error', 'HTTP 401: Bad credentials']) {
      expect(() => readPreviewState({
        repository: 'Andrologic/Macro',
        allowMissing: true,
        executeGh: () => ({ status: 1, stdout: Buffer.alloc(0), stderr }),
      })).toThrow('Unable to read the remote Preview release state');
    }
  });

  test('refuses an existing release without a readable latest.json', () => {
    const release = {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ assets: [] })),
      stderr: '',
    };
    expect(() => readPreviewState({
      repository: 'Andrologic/Macro',
      executeGh: () => release,
    })).toThrow('latest.json is missing');

    let call = 0;
    expect(() => readPreviewState({
      repository: 'Andrologic/Macro',
      executeGh: () => {
        call += 1;
        return call === 1
          ? {
            status: 0,
            stdout: Buffer.from(JSON.stringify({ assets: [{ name: 'latest.json', id: 42 }] })),
            stderr: '',
          }
          : { status: 0, stdout: Buffer.from('{ malformed'), stderr: '' };
      },
    })).toThrow('latest.json is invalid');
  });
});
