import type { MacroExtensionManifest, MacroExtensionPermissionGrant } from './extensions';
import {
  cloneExtensionJson,
  readBrowserExtensionPreference,
  saveExtensionPreference,
} from './extensionStorage';
import { PREF_KEYS } from './preferences';

export interface MacroExtensionTrustState {
  grants: Record<string, MacroExtensionPermissionGrant | undefined>;
}

const trustedExtensions = new Map<string, MacroExtensionPermissionGrant>();
let hasLoadedPersistedTrust = false;

const clonePermissions = (permissions: Record<string, string[]> | undefined): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(permissions ?? {}).map(([scope, grants]) => [
      scope,
      [...new Set((Array.isArray(grants) ? grants : []).filter((grant) => typeof grant === 'string'))],
    ]),
  );

export const grantAllRequestedExtensionPermissions = (
  manifest: MacroExtensionManifest,
  source: MacroExtensionPermissionGrant['source'] = 'development',
): MacroExtensionPermissionGrant => {
  ensurePersistedTrustLoaded();
  const grant: MacroExtensionPermissionGrant = {
    extensionId: manifest.id,
    granted: clonePermissions(manifest.permissions),
    trusted: true,
    grantedAt: new Date().toISOString(),
    source,
  };
  trustedExtensions.set(manifest.id, grant);
  persistTrustedExtensions();
  return grant;
};

export const resolveExtensionPermissionGrant = (
  manifest: MacroExtensionManifest,
  trustState?: MacroExtensionTrustState | null,
): MacroExtensionPermissionGrant => {
  ensurePersistedTrustLoaded();
  const stored = trustState?.grants?.[manifest.id] ?? trustedExtensions.get(manifest.id);
  if (stored?.trusted) {
    return {
      ...stored,
      granted: clonePermissions(stored.granted),
    };
  }

  return {
    extensionId: manifest.id,
    granted: {},
    trusted: false,
    grantedAt: '',
  };
};

export const isExtensionTrusted = (extensionId: string): boolean => {
  ensurePersistedTrustLoaded();
  return trustedExtensions.get(extensionId)?.trusted === true;
};

export const revokeExtensionTrustForTest = (extensionId: string): void => {
  ensurePersistedTrustLoaded();
  trustedExtensions.delete(extensionId);
  persistTrustedExtensions();
};

const ensurePersistedTrustLoaded = (): void => {
  if (hasLoadedPersistedTrust) return;
  hasLoadedPersistedTrust = true;

  const parsed = readBrowserExtensionPreference<unknown>(PREF_KEYS.EXTENSION_TRUST_GRANTS);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

  for (const [extensionId, value] of Object.entries(parsed)) {
    if (!isPermissionGrant(value)) continue;
    trustedExtensions.set(extensionId, {
      ...cloneExtensionJson(value),
      granted: clonePermissions(value.granted),
    });
  }
};

const persistTrustedExtensions = (): void => {
  const grants = Object.fromEntries(trustedExtensions.entries());
  saveExtensionPreference(PREF_KEYS.EXTENSION_TRUST_GRANTS, grants);
};

const isPermissionGrant = (value: unknown): value is MacroExtensionPermissionGrant => {
  if (!value || typeof value !== 'object') return false;
  const grant = value as MacroExtensionPermissionGrant;
  return (
    typeof grant.extensionId === 'string' &&
    typeof grant.trusted === 'boolean' &&
    typeof grant.grantedAt === 'string' &&
    Boolean(grant.granted) &&
    typeof grant.granted === 'object'
  );
};
