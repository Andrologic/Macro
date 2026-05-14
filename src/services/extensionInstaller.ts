import {
  createDevelopmentExtension,
  macroContributionRegistry,
  parseMacroExtensionManifest,
  validateMacroExtensionManifest,
  type MacroExtensionManifest,
  type MacroExtensionPermissionGrant,
  type MacroExtensionRecord,
} from './extensions';
import { grantAllRequestedExtensionPermissions } from './extensionTrust';
import {
  cloneExtensionJson,
  loadExtensionPreference,
  readBrowserExtensionPreference,
  saveExtensionPreference,
} from './extensionStorage';
import { PREF_KEYS } from './preferences';
import * as tauriIpc from './tauriIpc';

export type ExtensionInstallKind = 'folder' | 'tgz' | 'development';

export interface InstalledExtensionSummary {
  id: string;
  name: string;
  version: string;
  sourcePath: string;
  kind: ExtensionInstallKind;
  fingerprint: string;
  enabled: boolean;
  installedAt: string;
  manifest: MacroExtensionManifest;
  permissions: MacroExtensionPermissionGrant;
}

export interface ExtensionInstallResult {
  extension: MacroExtensionRecord;
  summary: InstalledExtensionSummary;
}

const installedExtensions = new Map<string, InstalledExtensionSummary>();
let hasLoadedInstalledExtensions = false;

export const listInstalledExtensions = (): InstalledExtensionSummary[] => {
  ensureInstalledExtensionsLoaded();
  return sortedInstalledExtensions().map(cloneInstalledExtensionSummary);
};

export const hydrateInstalledExtensions = async (): Promise<InstalledExtensionSummary[]> => {
  const persisted = await loadExtensionPreference<unknown>(PREF_KEYS.EXTENSION_INSTALLS);
  reconcileInstalledExtensionSummaries(persisted);
  return listInstalledExtensions();
};

export const uninstallExtension = (extensionId: string): void => {
  ensureInstalledExtensionsLoaded();
  installedExtensions.delete(extensionId);
  macroContributionRegistry.unregisterExtension(extensionId);
  persistInstalledExtensions();
};

export const setInstalledExtensionEnabled = (
  extensionId: string,
  enabled: boolean,
): InstalledExtensionSummary | null => {
  ensureInstalledExtensionsLoaded();
  const existing = installedExtensions.get(extensionId);
  if (!existing) return null;

  const next = { ...existing, enabled };
  installedExtensions.set(extensionId, next);
  if (enabled) {
    macroContributionRegistry.registerExtension({
      ...createDevelopmentExtension(next.manifest, next.permissions),
      sourcePath: next.sourcePath,
      installedAt: next.installedAt,
      enabled: true,
    });
  } else {
    macroContributionRegistry.unregisterExtension(extensionId);
  }
  persistInstalledExtensions();
  return cloneInstalledExtensionSummary(next);
};

export const installExtensionFromManifestSource = (params: {
  manifestText: string;
  sourcePath: string;
  kind: ExtensionInstallKind;
}): ExtensionInstallResult => {
  ensureInstalledExtensionsLoaded();
  const manifest = parseMacroExtensionManifest(params.manifestText);
  const validation = validateMacroExtensionManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid Macro extension manifest:\n${validation.errors.join('\n')}`);
  }

  const permissions = grantAllRequestedExtensionPermissions(
    manifest,
    params.kind === 'development' ? 'development' : 'installed',
  );
  const extension = {
    ...createDevelopmentExtension(manifest, permissions),
    sourcePath: params.sourcePath,
    installedAt: new Date().toISOString(),
  };
  macroContributionRegistry.registerExtension(extension);

  const summary: InstalledExtensionSummary = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    sourcePath: params.sourcePath,
    kind: params.kind,
    fingerprint: fingerprintManifest(params.manifestText),
    enabled: true,
    installedAt: extension.installedAt,
    manifest,
    permissions,
  };
  installedExtensions.set(manifest.id, summary);
  persistInstalledExtensions();
  return { extension, summary: cloneInstalledExtensionSummary(summary) };
};

export const installExtensionFromFolder = async (
  folderPath: string,
): Promise<ExtensionInstallResult> => {
  const manifestPath = `${folderPath.replace(/\/+$/, '')}/macro.extension.json`;
  const manifestFile = await tauriIpc.fsReadFileWithOptions({
    path: manifestPath,
    allowOutsideWorkspace: true,
  });
  return installExtensionFromManifestSource({
    manifestText: manifestFile.content,
    sourcePath: folderPath,
    kind: 'folder',
  });
};

export const installExtensionFromTgz = async (
  archivePath: string,
): Promise<ExtensionInstallResult> => {
  if (!archivePath.toLowerCase().endsWith('.tgz')) {
    throw new Error('Macro extension archives must use the .tgz extension.');
  }

  const extracted = await tauriIpc.extensionExtractTgz(archivePath);
  return installExtensionFromManifestSource({
    manifestText: extracted.manifestText,
    sourcePath: extracted.extensionRootPath,
    kind: 'tgz',
  });
};

const sortedInstalledExtensions = (): InstalledExtensionSummary[] =>
  [...installedExtensions.values()].sort((left, right) => left.id.localeCompare(right.id));

const persistInstalledExtensions = (): void => {
  const snapshot = sortedInstalledExtensions();
  saveExtensionPreference(PREF_KEYS.EXTENSION_INSTALLS, snapshot);
};

const ensureInstalledExtensionsLoaded = (): void => {
  if (hasLoadedInstalledExtensions) return;
  hasLoadedInstalledExtensions = true;

  reconcileInstalledExtensionSummaries(
    readBrowserExtensionPreference<unknown>(PREF_KEYS.EXTENSION_INSTALLS),
  );
};

const reconcileInstalledExtensionSummaries = (value: unknown): void => {
  const summaries = Array.isArray(value)
    ? value.filter(isInstalledExtensionSummary).map(cloneInstalledExtensionSummary)
    : [];
  installedExtensions.clear();

  for (const summary of summaries) {
    installedExtensions.set(summary.id, summary);
    if (!summary.enabled) {
      macroContributionRegistry.unregisterExtension(summary.id);
      continue;
    }

    try {
      const validation = validateMacroExtensionManifest(summary.manifest);
      if (!validation.valid) continue;
      macroContributionRegistry.registerExtension({
        ...createDevelopmentExtension(summary.manifest, summary.permissions),
        sourcePath: summary.sourcePath,
        installedAt: summary.installedAt,
        enabled: summary.enabled,
      });
    } catch {
      macroContributionRegistry.unregisterExtension(summary.id);
    }
  }
};

const isInstalledExtensionSummary = (value: unknown): value is InstalledExtensionSummary => {
  if (!value || typeof value !== 'object') return false;
  const summary = value as InstalledExtensionSummary;
  return (
    typeof summary.id === 'string' &&
    typeof summary.name === 'string' &&
    typeof summary.version === 'string' &&
    typeof summary.sourcePath === 'string' &&
    (summary.kind === 'folder' || summary.kind === 'tgz' || summary.kind === 'development') &&
    typeof summary.fingerprint === 'string' &&
    typeof summary.enabled === 'boolean' &&
    typeof summary.installedAt === 'string' &&
    Boolean(summary.manifest) &&
    typeof summary.manifest === 'object' &&
    Boolean(summary.permissions) &&
    typeof summary.permissions === 'object'
  );
};

const cloneInstalledExtensionSummary = (
  summary: InstalledExtensionSummary,
): InstalledExtensionSummary => cloneExtensionJson(summary);

const fingerprintManifest = (manifestText: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < manifestText.length; index += 1) {
    hash ^= manifestText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};
