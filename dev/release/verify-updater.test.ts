import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATER_TARGETS } from './updater-manifest.mjs';
import { validateUpdaterManifest, verifyLocalUpdaterAssets } from './verify-updater.mjs';

function manifest() {
  return {
    version: '0.2.0',
    notes: 'Release notes',
    pub_date: '2026-08-19T10:20:30Z',
    platforms: Object.fromEntries(UPDATER_TARGETS.map((target) => [target, {
      signature: `signature-${target}`,
      url: `https://github.com/Andrologic/Macro/releases/download/v0.2.0/Macro_${target}.bundle`,
    }])),
  };
}

describe('updater release verification', () => {
  test('accepts a complete tag-pinned manifest', () => {
    expect(validateUpdaterManifest(manifest())).toEqual([]);
  });

  test('rejects incomplete or mutable manifest entries', () => {
    const value = manifest();
    delete value.platforms['darwin-aarch64'];
    value.platforms['linux-x86_64'].url = 'https://example.com/latest.AppImage';
    value.platforms['windows-x86_64'].signature = 'https://example.com/signature';
    value.platforms['darwin-x86_64'].url = 'https://github.com/Andrologic/Macro/releases/download/v0.2.0/%2E%2E%2FMacro.app.tar.gz';
    expect(validateUpdaterManifest(value)).toEqual(expect.arrayContaining([
      'Manifest is missing platform targets: darwin-aarch64.',
      'Manifest URL for linux-x86_64 must be an HTTPS URL pinned to the v0.2.0 GitHub tag.',
      'Manifest signature for windows-x86_64 must contain signature content, not a URL.',
      'Manifest URL has no asset name for darwin-x86_64.',
    ]));
  });

  test('verifies downloaded assets and checksums', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-verify-'));
    try {
      const value = manifest();
      const checksums = [];
      for (const target of UPDATER_TARGETS) {
        const assetName = `Macro_${target}.bundle`;
        const content = `bundle-${target}`;
        const assetPath = join(root, assetName);
        const signatureName = `${assetName}.sig`;
        const signatureContent = `signature-${target}`;
        writeFileSync(assetPath, content);
        writeFileSync(join(root, signatureName), signatureContent);
        checksums.push(`${createHash('sha256').update(content).digest('hex')}  ${assetName}`);
        checksums.push(`${createHash('sha256').update(signatureContent).digest('hex')}  ${signatureName}`);
      }
      writeFileSync(join(root, 'latest.json'), JSON.stringify(value));
      checksums.push(`${createHash('sha256').update(readFileSync(join(root, 'latest.json'))).digest('hex')}  latest.json`);
      const checksumsPath = join(root, 'SHA256SUMS.txt');
      writeFileSync(checksumsPath, `${checksums.join('\n')}\n`);

      expect(verifyLocalUpdaterAssets(value, root, checksumsPath)).toEqual([]);
      writeFileSync(join(root, 'Macro_linux-x86_64.bundle'), 'changed');
      expect(verifyLocalUpdaterAssets(value, root, checksumsPath)).toContain('Checksum mismatch for Macro_linux-x86_64.bundle.');

      writeFileSync(join(root, 'Macro_windows-x86_64.bundle.sig'), 'wrong-signature');
      expect(verifyLocalUpdaterAssets(value, root, checksumsPath)).toEqual(expect.arrayContaining([
        'Updater signature content does not match latest.json for windows-x86_64: Macro_windows-x86_64.bundle.sig',
        'Checksum mismatch for Macro_windows-x86_64.bundle.sig.',
      ]));

      rmSync(join(root, 'Macro_windows-x86_64.bundle.sig'));
      expect(verifyLocalUpdaterAssets(value, root)).toContain(
        'Missing downloaded updater signature for windows-x86_64: Macro_windows-x86_64.bundle.sig',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
