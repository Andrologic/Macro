import { describe, expect, test } from 'bun:test';
import { cargoLockPackageVersion, validateUpdaterConfiguration, UPDATER_ENDPOINT } from './updater-preflight.mjs';

function fixture() {
  const publicKey = Buffer.from([
    'untrusted comment: minisign public key: B12797C37337126A',
    'RWRqEjdzw5cnsd7XLldyod5vmYBdEH2BkeTii8zV3vTy24kh6sEhOhbA',
  ].join('\n')).toString('base64');
  return {
    packageJson: {
      scripts: {
        'tauri:build': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json',
        'tauri:build:updater': 'bun dev/tauri-cli.mjs build',
        'tauri:build:nsis': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json --bundles nsis',
        'tauri:build:dmg': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json --bundles dmg',
        'tauri:build:dmg:mac-arm64:test': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json --target aarch64-apple-darwin',
        'tauri:build:dmg:mac-universal:test': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json --target universal-apple-darwin',
        'tauri:build:linux-packages': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json --bundles appimage,deb,rpm',
        'tauri:build:debug': 'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json --debug',
      },
      dependencies: {
        '@tauri-apps/api': '2.12.4',
        '@tauri-apps/plugin-dialog': '2.6.0',
        '@tauri-apps/plugin-http': '2.5.7',
        '@tauri-apps/plugin-notification': '2.3.3',
        '@tauri-apps/plugin-opener': '2.5.3',
        '@tauri-apps/plugin-process': '2.3.1',
        '@tauri-apps/plugin-store': '2.4.2',
      },
      devDependencies: { '@tauri-apps/cli': '2.12.4' },
    },
    cargoToml: [
      'tauri-plugin-dialog = "=2.6.0"',
      'tauri-plugin-http = "2"',
      'tauri-plugin-notification = "2.3.3"',
      'tauri-plugin-opener = "2"',
      'tauri-plugin-updater = "=2.13.3"',
      'tauri-plugin-process = "2.3.1"',
      'tauri-plugin-store = "2"',
    ].join('\n'),
    cargoLock: [
      '[[package]]',
      'name = "tauri-plugin-dialog"',
      'version = "2.6.0"',
      '',
      '[[package]]',
      'name = "tauri-plugin-http"',
      'version = "2.5.9"',
      '',
      '[[package]]',
      'name = "tauri-plugin-notification"',
      'version = "2.3.3"',
      '',
      '[[package]]',
      'name = "tauri-plugin-opener"',
      'version = "2.5.4"',
      '',
      '[[package]]',
      'name = "tauri-plugin-updater"',
      'version = "2.13.3"',
      '',
      '[[package]]',
      'name = "tauri-plugin-process"',
      'version = "2.3.1"',
      '',
      '[[package]]',
      'name = "tauri-plugin-store"',
      'version = "2.4.4"',
    ].join('\n'),
    tauriConfig: {
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          pubkey: publicKey,
          endpoints: [UPDATER_ENDPOINT],
          requireSignedVersion: true,
          allowDowngrades: false,
          windows: { installMode: 'quiet' },
        },
      },
    },
    localTauriConfig: {
      bundle: { createUpdaterArtifacts: false },
    },
    tauriCapabilities: {
      permissions: ['core:app:allow-version', 'core:resources:allow-close'],
    },
  };
}

describe('updater preflight', () => {
  test('accepts a complete updater configuration', () => {
    expect(validateUpdaterConfiguration(fixture())).toEqual([]);
  });

  test('reads exact Cargo.lock package versions', () => {
    expect(cargoLockPackageVersion(fixture().cargoLock, 'tauri-plugin-updater')).toBe('2.13.3');
    expect(cargoLockPackageVersion(fixture().cargoLock, 'tauri-plugin-process')).toBe('2.3.1');
    expect(cargoLockPackageVersion(fixture().cargoLock, 'tauri-plugin-dialog')).toBe('2.6.0');
  });

  test('detects version drift for every paired Tauri plugin', () => {
    const config = fixture();
    config.cargoLock = config.cargoLock.replace(
      'name = "tauri-plugin-dialog"\nversion = "2.6.0"',
      'name = "tauri-plugin-dialog"\nversion = "2.7.2"',
    );
    expect(validateUpdaterConfiguration(config)).toContain(
      '@tauri-apps/plugin-dialog and the resolved tauri-plugin-dialog crate must use the same major/minor version (npm 2.6.0, lock 2.7.2).',
    );
  });

  test('reports missing endpoint, placeholder key, and version drift', () => {
    const config = fixture();
    config.tauriConfig.plugins.updater.pubkey = 'REPLACE_WITH_PUBLIC_KEY';
    config.tauriConfig.plugins.updater.endpoints = [];
    config.tauriConfig.plugins.updater.windows.installMode = 'basicUi';
    config.tauriConfig.plugins.updater.requireSignedVersion = false;
    config.tauriConfig.plugins.updater.allowDowngrades = true;
    config.cargoLock = config.cargoLock.replace('name = "tauri-plugin-updater"\nversion = "2.13.3"', 'name = "tauri-plugin-updater"\nversion = "2.12.0"');
    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      'plugins.updater.pubkey still contains a placeholder.',
      `plugins.updater.endpoints must include ${UPDATER_ENDPOINT}.`,
      'plugins.updater.windows.installMode must be "quiet".',
      'plugins.updater.requireSignedVersion must be true.',
      'plugins.updater.allowDowngrades must not be enabled.',
      'tauri-plugin-updater must resolve to at least 2.13.3.',
    ]));
  });

  test('requires the CLI and API versions that support signed versions', () => {
    const config = fixture();
    config.packageJson.devDependencies['@tauri-apps/cli'] = '2.11.5';
    config.packageJson.dependencies['@tauri-apps/api'] = '2.11.5';
    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      '@tauri-apps/cli must be at least 2.12.0 to sign the updater version.',
      '@tauri-apps/api must be at least 2.12.0.',
    ]));
  });

  test('reports missing build artifacts and dependencies', () => {
    const config = fixture();
    config.tauriConfig.bundle.createUpdaterArtifacts = false;
    delete config.packageJson.dependencies['@tauri-apps/plugin-process'];
    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      'tauri.conf.json must set bundle.createUpdaterArtifacts to true.',
      'Missing Tauri plugin dependency metadata for @tauri-apps/plugin-process / tauri-plugin-process.',
    ]));
  });

  test('rejects WebView updater commands and the unused JavaScript plugin', () => {
    const config = fixture();
    config.tauriCapabilities.permissions = ['updater:allow-check', 'process:allow-restart'];
    Object.assign(config.packageJson.dependencies, { '@tauri-apps/plugin-updater': '2.13.3' });

    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      'src-tauri/capabilities/default.json must not grant updater plugin commands to the WebView.',
      'src-tauri/capabilities/default.json must not grant process:allow-restart.',
      'package.json must not include the unused JavaScript updater plugin.',
    ]));
  });

  test('keeps ordinary local builds independent from the updater signing key', () => {
    const config = fixture();
    config.localTauriConfig.bundle.createUpdaterArtifacts = true;
    config.packageJson.scripts['tauri:build:nsis'] = 'bun dev/tauri-cli.mjs build --bundles nsis';
    config.packageJson.scripts['tauri:build:linux-packages'] =
      'bun dev/tauri-cli.mjs build --bundles appimage,deb,rpm';
    config.packageJson.scripts['tauri:build:updater'] =
      'bun dev/tauri-cli.mjs build --config src-tauri/tauri.local.conf.json';

    expect(validateUpdaterConfiguration(config)).toEqual(expect.arrayContaining([
      'src-tauri/tauri.local.conf.json must disable updater artifacts for ordinary local builds.',
      'package.json script tauri:build:nsis must use src-tauri/tauri.local.conf.json.',
      'package.json script tauri:build:linux-packages must use src-tauri/tauri.local.conf.json.',
      'package.json script tauri:build:updater must keep updater artifacts enabled.',
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
