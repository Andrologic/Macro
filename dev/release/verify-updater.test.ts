import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATER_TARGETS } from './updater-manifest.mjs';
import { validateUpdaterManifest, verifyLocalUpdaterAssets } from './verify-updater.mjs';

const TEST_PUBLIC_KEY = Buffer.from([
  'untrusted comment: minisign public key: EFCDAB9078563412',
  'RWQSNFZ4kKvN7wOhB7/zzhC+HXDdGOdLwJln5NYwm6UNXx3chmQSVTG4',
].join('\n')).toString('base64');
const FOREIGN_PUBLIC_KEY = Buffer.from([
  'untrusted comment: minisign public key B12797C37337126A',
  'RWRqEjdzw5cnsd7XLldyod5vmYBdEH2BkeTii8zV3vTy24kh6sEhOhbA',
].join('\n')).toString('base64');
const RELEASE_TOOLS_DIRECTORY = import.meta.dir;
const REPOSITORY_ROOT = join(RELEASE_TOOLS_DIRECTORY, '../..');
const MINISIGN_VERIFIER_MANIFEST = join(import.meta.dir, 'minisign-verifier', 'Cargo.toml');
const TEST_SIGNATURES: Record<string, string> = Object.fromEntries(Object.entries({
  '0.2.0': 'Sk5KTYbaWPlb6UrKJBVE1lfN5nyRv2NTBNEV91d2feNfbppEktBjsS34CPnTnW6IS4PFvFJyC9xPbhfT80yIBQ==',
  '0.2.1-nightly.20260916.42': 'WRundy0jt6yPYsQdjYQjCLKAnBzCVWWmn4EGF6mmfvau1/aVw8zfYqJJqIVpMCC/8C+KiJqsZO9QSdymGSbGBw==',
  '0.2.1-rc.1': 'nJ1x7ZXelFVYvODyxihEvzq2DizJecxGpVbiCM55QMnEtRNiONbjfQlemKUBTPTMAB2y9f8zTjWCdJzspI1YCw==',
}).map(([version, globalSignature]) => [version, Buffer.from([
  'untrusted comment: signature from minisign secret key',
  'RWQSNFZ4kKvN76VXp6pguhWceWrRkO1fvuc88dyHDQ5ampsF9laj0O5bSvJ6m1nBrK8ZEpl5M50JqGgPmEJsV9DTs+MuMKH5/gk=',
  `trusted comment: timestamp:1700000000\tfile:test\tversion:${version}`,
  globalSignature,
].join('\n')).toString('base64')]));
const TEST_SIGNATURE = TEST_SIGNATURES['0.2.0'];
const LEGACY_TEST_SIGNATURE = Buffer.from([
  'untrusted comment: signature from minisign secret key',
  'RWQSNFZ4kKvN76VXp6pguhWceWrRkO1fvuc88dyHDQ5ampsF9laj0O5bSvJ6m1nBrK8ZEpl5M50JqGgPmEJsV9DTs+MuMKH5/gk=',
  'trusted comment: timestamp:1700000000\tfile:test',
  '61jxEsENbNOdMHHSWdAqiAdSdQJmWFyNC61/of+nwQyEXjTvX/uce9VU+kIJfe+0BLJi5jL/U+UJ0Q0fO93+AA==',
].join('\n')).toString('base64');

function runBunScript(scriptName: string, args: string[]) {
  return spawnSync(process.execPath, [join(RELEASE_TOOLS_DIRECTORY, scriptName), ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
  });
}

function createSignedReleaseFixture(
  root: string,
  { version, channel, tag }: { version: string; channel: 'stable' | 'preview'; tag: string },
) {
  const notesPath = join(root, 'release-notes.md');
  const manifestPath = join(root, 'latest.json');
  const configPath = join(root, 'tauri.conf.json');
  writeFileSync(notesPath, `Synthetic ${channel} release ${version}.\n`);
  writeFileSync(configPath, JSON.stringify({ plugins: { updater: { pubkey: TEST_PUBLIC_KEY } } }));

  const manifestArguments = [
    '--version', version,
    '--tag', tag,
    '--channel', channel,
    '--repository', 'Andrologic/Macro',
    '--notes-file', notesPath,
    '--pub-date', '2026-09-16T10:20:30Z',
    '--output', manifestPath,
  ];
  const assetNames: string[] = [];
  for (const target of UPDATER_TARGETS) {
    const assetName = `Macro_${version}_${target}.bundle`;
    const assetPath = join(root, assetName);
    const signaturePath = join(root, `${assetName}.sig`);
    writeFileSync(assetPath, 'test');
    writeFileSync(signaturePath, TEST_SIGNATURES[version]);
    assetNames.push(assetName, `${assetName}.sig`);
    manifestArguments.push('--artifact', target, assetPath, signaturePath, assetName);
  }

  const generated = runBunScript('updater-manifest.mjs', manifestArguments);
  expect(generated.status).toBe(0);

  assetNames.push('latest.json');
  writeFileSync(
    join(root, 'SHA256SUMS.txt'),
    `${assetNames.map((name) => `${createHash('sha256').update(readFileSync(join(root, name))).digest('hex')}  ${name}`).join('\n')}\n`,
  );
  return { manifestPath, configPath, root };
}

function verifySignedReleaseFixture(
  fixture: { manifestPath: string; configPath: string; root: string },
  channel: 'stable' | 'preview',
  configPath = fixture.configPath,
) {
  return runBunScript('verify-updater.mjs', [
    '--manifest', fixture.manifestPath,
    '--channel', channel,
    '--asset-root', fixture.root,
    '--checksums', join(fixture.root, 'SHA256SUMS.txt'),
    '--tauri-config', configPath,
  ]);
}

function manifest() {
  return {
    version: '0.2.0',
    notes: 'Release notes',
    pub_date: '2026-08-19T10:20:30Z',
    platforms: Object.fromEntries(UPDATER_TARGETS.map((target) => [target, {
      signature: TEST_SIGNATURE,
      url: `https://github.com/Andrologic/Macro/releases/download/v0.2.0/Macro_${target}.bundle`,
    }])),
  };
}

describe('updater release verification', () => {
  beforeAll(() => {
    const build = spawnSync('cargo', [
      'build', '--locked', '--quiet', '--manifest-path', MINISIGN_VERIFIER_MANIFEST,
    ], { encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(build.stderr || build.error?.message || 'Unable to build the signature verifier.');
    }
  }, 120_000);

  test('accepts a complete tag-pinned manifest', () => {
    expect(validateUpdaterManifest(manifest())).toEqual([]);
  });

  test('accepts a prerelease manifest pinned to the preview tag', () => {
    const value = manifest();
    value.version = '0.2.1-nightly.20260830.42';
    for (const platform of Object.values(value.platforms)) {
      platform.url = platform.url.replace(
        '/releases/download/v0.2.0/',
        '/releases/download/preview/',
      );
    }

    expect(validateUpdaterManifest(value, { channel: 'preview' })).toEqual([]);
    expect(validateUpdaterManifest(value)).toContain(
      'Manifest version must be a stable x.y.z version; found "0.2.1-nightly.20260830.42".',
    );

    value.version = '0.2.1-rc.1';
    expect(validateUpdaterManifest(value, { channel: 'preview' })).toEqual([]);
    expect(validateUpdaterManifest(value)).toContain(
      'Manifest version must be a stable x.y.z version; found "0.2.1-rc.1".',
    );

    value.version = '0.2.1-beta.1';
    expect(validateUpdaterManifest(value, { channel: 'preview' })).toContain(
      'Manifest version must be a nightly or rc semantic version; found "0.2.1-beta.1".',
    );
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
        const content = 'test';
        const assetPath = join(root, assetName);
        const signatureName = `${assetName}.sig`;
        const signatureContent = TEST_SIGNATURE;
        writeFileSync(assetPath, content);
        writeFileSync(join(root, signatureName), signatureContent);
        checksums.push(`${createHash('sha256').update(content).digest('hex')}  ${assetName}`);
        checksums.push(`${createHash('sha256').update(signatureContent).digest('hex')}  ${signatureName}`);
      }
      writeFileSync(join(root, 'latest.json'), JSON.stringify(value));
      checksums.push(`${createHash('sha256').update(readFileSync(join(root, 'latest.json'))).digest('hex')}  latest.json`);
      const checksumsPath = join(root, 'SHA256SUMS.txt');
      writeFileSync(checksumsPath, `${checksums.join('\n')}\n`);

      expect(verifyLocalUpdaterAssets(value, root, checksumsPath, { publicKey: TEST_PUBLIC_KEY })).toEqual([]);
      writeFileSync(join(root, 'Macro_linux-x86_64.bundle'), 'changed');
      expect(verifyLocalUpdaterAssets(value, root, checksumsPath, { publicKey: TEST_PUBLIC_KEY })).toEqual(expect.arrayContaining([
        'Checksum mismatch for Macro_linux-x86_64.bundle.',
        expect.stringContaining('Updater signature verification failed for'),
      ]));

      writeFileSync(join(root, 'Macro_windows-x86_64.bundle.sig'), 'wrong-signature');
      expect(verifyLocalUpdaterAssets(value, root, checksumsPath, { publicKey: TEST_PUBLIC_KEY })).toEqual(expect.arrayContaining([
        'Updater signature content does not match latest.json for windows-x86_64: Macro_windows-x86_64.bundle.sig',
        'Checksum mismatch for Macro_windows-x86_64.bundle.sig.',
      ]));

      rmSync(join(root, 'Macro_windows-x86_64.bundle.sig'));
      expect(verifyLocalUpdaterAssets(value, root, undefined, { publicKey: TEST_PUBLIC_KEY })).toContain(
        'Missing downloaded updater signature for windows-x86_64: Macro_windows-x86_64.bundle.sig',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('rejects signatures that only match the manifest text', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-crypto-'));
    try {
      const value = manifest();
      for (const target of UPDATER_TARGETS) {
        const assetName = `Macro_${target}.bundle`;
        const signature = `synthetic-signature-${target}`;
        value.platforms[target].signature = signature;
        writeFileSync(join(root, assetName), 'test');
        writeFileSync(join(root, `${assetName}.sig`), signature);
      }

      expect(verifyLocalUpdaterAssets(value, root, undefined, { publicKey: TEST_PUBLIC_KEY })).toEqual([
        expect.stringContaining('Updater signature'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('verifies all five assets through the standalone CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-minisign-cli-'));
    try {
      const assetArguments: string[] = [];
      for (const target of UPDATER_TARGETS) {
        const assetPath = join(root, `Macro_${target}.bundle`);
        const signaturePath = join(root, `Macro_${target}.bundle.sig`);
        writeFileSync(assetPath, 'test');
        writeFileSync(signaturePath, TEST_SIGNATURE);
        assetArguments.push('--asset', assetPath, '--signature', signaturePath);
      }

      const cliArguments = [
        'run',
        '--offline',
        '--locked',
        '--quiet',
        '--manifest-path',
        MINISIGN_VERIFIER_MANIFEST,
        '--',
        '--public-key-b64',
        TEST_PUBLIC_KEY,
        '--version',
        '0.2.0',
        ...assetArguments,
      ];
      const verified = spawnSync('cargo', cliArguments, {
        encoding: 'utf8',
        env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
      });
      expect(verified.status).toBe(0);
      expect(verified.stdout).toContain('Verified 5 minisign updater signature(s).');

      const firstAssetPath = join(root, 'Macro_windows-x86_64.bundle');
      const firstSignaturePath = join(root, 'Macro_windows-x86_64.bundle.sig');
      const malformedArguments = spawnSync('cargo', [
        ...cliArguments.slice(0, -assetArguments.length),
        '--asset',
        firstAssetPath,
        firstSignaturePath,
        '--signature',
        firstSignaturePath,
      ], {
        encoding: 'utf8',
        env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
      });
      expect(malformedArguments.status).not.toBe(0);
      expect(malformedArguments.stderr).toContain('Each --asset must be followed by --signature.');

      writeFileSync(join(root, 'Macro_linux-x86_64.bundle'), 'tampered');
      const rejected = spawnSync('cargo', [
        ...cliArguments.slice(0, -assetArguments.length),
        '--asset',
        join(root, 'Macro_linux-x86_64.bundle'),
        '--signature',
        join(root, 'Macro_linux-x86_64.bundle.sig'),
      ], {
        encoding: 'utf8',
        env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('Updater signature verification failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('rejects a missing or mismatched signed version after signature verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-minisign-version-'));
    try {
      const assetPath = join(root, 'Macro.bundle');
      const signaturePath = join(root, 'Macro.bundle.sig');
      writeFileSync(assetPath, 'test');
      const args = [
        'run', '--offline', '--locked', '--quiet', '--manifest-path', MINISIGN_VERIFIER_MANIFEST,
        '--', '--public-key-b64', TEST_PUBLIC_KEY, '--version', '0.2.0',
        '--asset', assetPath, '--signature', signaturePath,
      ];
      for (const [signature, expectedError] of [
        [LEGACY_TEST_SIGNATURE, 'signed version is missing'],
        [TEST_SIGNATURES['0.2.1-rc.1'], 'differs from manifest version'],
      ]) {
        writeFileSync(signaturePath, signature);
        const result = spawnSync('cargo', args, {
          encoding: 'utf8',
          env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expectedError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('rejects a release whose valid signatures belong to another version', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-updater-wrong-version-'));
    try {
      const fixture = createSignedReleaseFixture(root, {
        version: '0.2.0', channel: 'stable', tag: 'v0.2.0',
      });
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
      for (const target of UPDATER_TARGETS) {
        const signature = TEST_SIGNATURES['0.2.1-rc.1'];
        manifest.platforms[target].signature = signature;
        writeFileSync(join(root, `Macro_0.2.0_${target}.bundle.sig`), signature);
      }
      expect(verifyLocalUpdaterAssets(manifest, root, undefined, { publicKey: TEST_PUBLIC_KEY }))
        .toEqual([expect.stringContaining('differs from manifest version')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('composes and verifies stable, nightly, and rc releases through both CLIs', () => {
    const cases = [
      { version: '0.2.0', channel: 'stable' as const, tag: 'v0.2.0' },
      { version: '0.2.1-nightly.20260916.42', channel: 'preview' as const, tag: 'preview' },
      { version: '0.2.1-rc.1', channel: 'preview' as const, tag: 'preview' },
    ];

    for (const release of cases) {
      const root = mkdtempSync(join(tmpdir(), 'macro-updater-composition-'));
      try {
        const fixture = createSignedReleaseFixture(root, release);
        const verified = verifySignedReleaseFixture(fixture, release.channel);
        expect(verified.status).toBe(0);
        expect(verified.stdout).toContain(
          `Updater release verification passed for ${release.channel} ${release.version}.`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test('rejects a foreign key, malformed signature, and altered asset through the real CLI', () => {
    const foreignKeyRoot = mkdtempSync(join(tmpdir(), 'macro-updater-foreign-key-'));
    try {
      const fixture = createSignedReleaseFixture(foreignKeyRoot, {
        version: '0.2.0',
        channel: 'stable',
        tag: 'v0.2.0',
      });
      const foreignConfigPath = join(foreignKeyRoot, 'foreign-tauri.conf.json');
      writeFileSync(foreignConfigPath, JSON.stringify({ plugins: { updater: { pubkey: FOREIGN_PUBLIC_KEY } } }));
      const rejected = verifySignedReleaseFixture(fixture, 'stable', foreignConfigPath);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('Updater signature verification failed');
    } finally {
      rmSync(foreignKeyRoot, { recursive: true, force: true });
    }

    const malformedSignatureRoot = mkdtempSync(join(tmpdir(), 'macro-updater-malformed-signature-'));
    try {
      const fixture = createSignedReleaseFixture(malformedSignatureRoot, {
        version: '0.2.0',
        channel: 'stable',
        tag: 'v0.2.0',
      });
      writeFileSync(join(malformedSignatureRoot, 'Macro_0.2.0_windows-x86_64.bundle.sig'), 'malformed-signature');
      const rejected = verifySignedReleaseFixture(fixture, 'stable');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('not valid base64');
    } finally {
      rmSync(malformedSignatureRoot, { recursive: true, force: true });
    }

    const alteredAssetRoot = mkdtempSync(join(tmpdir(), 'macro-updater-altered-asset-'));
    try {
      const fixture = createSignedReleaseFixture(alteredAssetRoot, {
        version: '0.2.0',
        channel: 'stable',
        tag: 'v0.2.0',
      });
      writeFileSync(join(alteredAssetRoot, 'Macro_0.2.0_linux-x86_64.bundle'), 'tampered');
      const rejected = verifySignedReleaseFixture(fixture, 'stable');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('Checksum mismatch for Macro_0.2.0_linux-x86_64.bundle.');
      expect(rejected.stderr).toContain('Updater signature verification failed');
    } finally {
      rmSync(alteredAssetRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
