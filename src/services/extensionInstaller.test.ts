import { describe, expect, it } from 'bun:test';
import {
  installExtensionFromManifestSource,
  listInstalledExtensions,
  uninstallExtension,
} from './extensionInstaller';
import { macroContributionRegistry } from './extensions';

const manifestText = JSON.stringify({
  id: 'install.macro',
  name: 'Install Macro',
  version: '1.0.0',
  main: './dist/extension.mjs',
  contributes: {
    modes: [{ id: 'install.macro.mode', label: 'Install', layout: { center: 'install.macro.graph' } }],
    views: [{ id: 'install.macro.graph', title: 'Graph', kind: 'graph', location: 'centerPanel' }],
  },
  permissions: { workspace: ['read'] },
});

describe('extensionInstaller', () => {
  it('installs a manifest source into the contribution registry', () => {
    const result = installExtensionFromManifestSource({
      manifestText,
      sourcePath: '/tmp/install-macro',
      kind: 'development',
    });

    expect(result.summary.fingerprint.startsWith('fnv1a-')).toBe(true);
    expect(listInstalledExtensions().some((extension) => extension.id === 'install.macro')).toBe(true);
    expect(macroContributionRegistry.getMode('install.macro.mode')?.extensionId).toBe('install.macro');

    uninstallExtension('install.macro');
  });
});
