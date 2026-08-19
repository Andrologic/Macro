import { describe, expect, test } from 'bun:test';
import { cargoLockPackageVersion, validateUpdaterConfiguration, UPDATER_ENDPOINT } from './updater-preflight.mjs';

function fixture() {
  const publicKey = Buffer.from([
    'untrusted comment: minisign public key: B12797C37337126A',
    'RWRqEjdzw5cnsd7XLldyod5vmYBdEH2BkeTii8zV3vTy24kh6sEhOhbA',
  ].join('\n')).toString('base64');
  return {
    packageJson: {
      dependencies: {
        '@tauri-apps/plugin-updater': '2.10.1',
        '@tauri-apps/plugin-process': '2.3.1',
      },
    },
    cargoToml: [
      'tauri-plugin-updater = "2.10.1"',
      'tauri-plugin-process = "2.3.1"',
    ].join('\n'),
    cargoLock: [
      '[[package]]',
      'name = "tauri-plugin-updater"',
      'version = "2.10.1"',
      '',
      '[[package]]',
      'name = "tauri-plugin-process"',
      'version = "2.3.1"',
    ].join('\n'),
    tauriConfig: {
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          pubkey: publicKey,
          endpoints: [UPDATER_ENDPOINT],
          windows: { installMode: 'passive' },
        },
      },
    },
  };
}

describe('updater preflight', () => {
  test('accepts a complete updater configuration', () => {
    expect(validateUpdaterConfiguration(fixture())).toEqual([]);
  });

  test('reads exact Cargo.lock package versions', () => {
    expect(cargoLockPackageVersion(fixture().cargoLock, 'tauri-plugin-updater')).toBe('2.10.1');
    expect(cargoLockPackageVersion(fixture().cargoLock, 'tauri-plugin-process')).toBe('2.3.1');
    expect(cargoLockPackageVersion(fixture().cargoLock, 'tauri-plugin-dialog')).toBeNull();
  });

  test('reports missing endpoint, placeholder key, and version drift', () => {
    const config = fixture();
    config.tauriConfig.plugins.updater.pubkey = 'REPLACE_WITH_PUBLIC_KEY';
    config.tauriConfig.plugins.updater.endpoints = [];
    config.tauriConfig.plugins.updater.windows.installMode = 'basicUi';
    config.packageJson.dependencies['@tauri-apps/plugin-updater'] = '2.11.0';
    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      'plugins.updater.pubkey still contains a placeholder.',
      `plugins.updater.endpoints must include ${UPDATER_ENDPOINT}.`,
      'plugins.updater.windows.installMode must be "passive".',
      expect.stringContaining('same major/minor version'),
    ]));
  });

  test('reports missing build artifacts and dependencies', () => {
    const config = fixture();
    config.tauriConfig.bundle.createUpdaterArtifacts = false;
    delete config.packageJson.dependencies['@tauri-apps/plugin-process'];
    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      'tauri.conf.json must set bundle.createUpdaterArtifacts to true.',
      'Missing updater dependency metadata for @tauri-apps/plugin-process / tauri-plugin-process.',
    ]));
  });

  test('rejects a value that is base64 but not a minisign public key', () => {
    const config = fixture();
    config.tauriConfig.plugins.updater.pubkey = 'dGVzdC1wdWJsaWMta2V5';
    expect(validateUpdaterConfiguration(config)).toContain(
      'plugins.updater.pubkey must be a base64-encoded minisign public key.',
    );
  });
});
