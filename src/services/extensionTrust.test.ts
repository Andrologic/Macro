import { describe, expect, it } from 'bun:test';
import {
  grantAllRequestedExtensionPermissions,
  isExtensionTrusted,
  resolveExtensionPermissionGrant,
  revokeExtensionTrustForTest,
} from './extensionTrust';
import type { MacroExtensionManifest } from './extensions';

const manifest: MacroExtensionManifest = {
  id: 'trust.macro',
  name: 'Trust Macro',
  version: '1.0.0',
  main: './dist/extension.mjs',
  permissions: {
    workspace: ['read'],
    git: ['read'],
  },
};

describe('extensionTrust', () => {
  it('grants requested permissions explicitly', () => {
    revokeExtensionTrustForTest(manifest.id);
    expect(isExtensionTrusted(manifest.id)).toBe(false);

    const grant = grantAllRequestedExtensionPermissions(manifest);

    expect(grant.granted.workspace).toEqual(['read']);
    expect(grant.trusted).toBe(true);
    expect(isExtensionTrusted(manifest.id)).toBe(true);
  });

  it('fails closed when no trusted grant exists', () => {
    revokeExtensionTrustForTest(manifest.id);

    const grant = resolveExtensionPermissionGrant(manifest, null);

    expect(grant.trusted).toBe(false);
    expect(grant.granted).toEqual({});
  });
});
