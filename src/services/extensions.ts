import {
  validateMacroExtensionManifest,
  type MacroExtensionCommandContribution,
  type MacroExtensionComposerContribution,
  type MacroExtensionManifest,
  type MacroExtensionModeContribution,
  type MacroExtensionToolContribution,
  type MacroExtensionViewContribution,
} from '../../packages/macro-extension-api/src/manifest';

export {
  parseMacroExtensionManifest,
  validateMacroExtensionManifest,
  normalizeMacroExtensionPackagePath,
} from '../../packages/macro-extension-api/src/manifest';
export type {
  MacroExtensionCommandContribution,
  MacroExtensionComposerContribution,
  MacroExtensionComposerMode,
  MacroExtensionManifest,
  MacroExtensionManifestValidation,
  MacroExtensionModeContribution,
  MacroExtensionToolContribution,
  MacroExtensionViewContribution,
  MacroExtensionViewKind,
  MacroExtensionViewLocation,
} from '../../packages/macro-extension-api/src/manifest';

export interface MacroExtensionPermissionGrant {
  extensionId: string;
  granted: Record<string, string[]>;
  trusted: boolean;
  grantedAt: string;
  source?: 'development' | 'installed' | 'test';
}

export interface MacroExtensionRecord {
  id: string;
  manifest: MacroExtensionManifest;
  permissions: MacroExtensionPermissionGrant;
  sourcePath?: string | null;
  installedAt?: string | null;
  enabled: boolean;
}

export interface MacroExtensionContribution<TContribution> {
  extensionId: string;
  manifest: MacroExtensionManifest;
  contribution: TContribution;
}

type RegistryListener = () => void;

const toContributionEntries = <TContribution extends { id: string }>(
  extension: MacroExtensionRecord,
  contributions: TContribution[] | undefined,
): Array<[string, MacroExtensionContribution<TContribution>]> =>
  (contributions ?? []).map((contribution) => [
    contribution.id,
    {
      extensionId: extension.id,
      manifest: extension.manifest,
      contribution,
    },
  ]);

class MacroContributionRegistry {
  private readonly extensions = new Map<string, MacroExtensionRecord>();
  private readonly modes = new Map<string, MacroExtensionContribution<MacroExtensionModeContribution>>();
  private readonly views = new Map<string, MacroExtensionContribution<MacroExtensionViewContribution>>();
  private readonly composers = new Map<string, MacroExtensionContribution<MacroExtensionComposerContribution>>();
  private readonly commands = new Map<string, MacroExtensionContribution<MacroExtensionCommandContribution>>();
  private readonly tools = new Map<string, MacroExtensionContribution<MacroExtensionToolContribution>>();
  private readonly listeners = new Set<RegistryListener>();

  registerExtension(extension: MacroExtensionRecord): void {
    const validation = validateMacroExtensionManifest(extension.manifest);
    if (!validation.valid) {
      throw new Error(`Invalid Macro extension manifest:\n${validation.errors.join('\n')}`);
    }

    this.unregisterExtension(extension.id);
    this.assertNoContributionCollisions(extension);
    this.extensions.set(extension.id, extension);

    for (const [id, entry] of toContributionEntries(extension, extension.manifest.contributes?.modes)) {
      this.modes.set(id, entry);
    }
    for (const [id, entry] of toContributionEntries(extension, extension.manifest.contributes?.views)) {
      this.views.set(id, entry);
    }
    for (const [id, entry] of toContributionEntries(extension, extension.manifest.contributes?.composers)) {
      this.composers.set(id, entry);
    }
    for (const [id, entry] of toContributionEntries(extension, extension.manifest.contributes?.commands)) {
      this.commands.set(id, entry);
    }
    for (const [id, entry] of toContributionEntries(extension, extension.manifest.contributes?.tools)) {
      this.tools.set(id, entry);
    }

    this.emitChange();
  }

  unregisterExtension(extensionId: string): void {
    const existing = this.extensions.get(extensionId);
    if (!existing) return;

    this.extensions.delete(extensionId);
    this.deleteOwnedContributions(this.modes, extensionId);
    this.deleteOwnedContributions(this.views, extensionId);
    this.deleteOwnedContributions(this.composers, extensionId);
    this.deleteOwnedContributions(this.commands, extensionId);
    this.deleteOwnedContributions(this.tools, extensionId);
    this.emitChange();
  }

  getExtension(extensionId: string): MacroExtensionRecord | null {
    return this.extensions.get(extensionId) ?? null;
  }

  listExtensions(): MacroExtensionRecord[] {
    return [...this.extensions.values()];
  }

  getMode(id: string): MacroExtensionContribution<MacroExtensionModeContribution> | null {
    return this.modes.get(id) ?? null;
  }

  listModes(): Array<MacroExtensionContribution<MacroExtensionModeContribution>> {
    return [...this.modes.values()];
  }

  getView(id: string): MacroExtensionContribution<MacroExtensionViewContribution> | null {
    return this.views.get(id) ?? null;
  }

  listViews(): Array<MacroExtensionContribution<MacroExtensionViewContribution>> {
    return [...this.views.values()];
  }

  getComposer(id: string): MacroExtensionContribution<MacroExtensionComposerContribution> | null {
    return this.composers.get(id) ?? null;
  }

  getCommand(id: string): MacroExtensionContribution<MacroExtensionCommandContribution> | null {
    return this.commands.get(id) ?? null;
  }

  getTool(id: string): MacroExtensionContribution<MacroExtensionToolContribution> | null {
    return this.tools.get(id) ?? null;
  }

  listTools(): Array<MacroExtensionContribution<MacroExtensionToolContribution>> {
    return [...this.tools.values()];
  }

  subscribe(listener: RegistryListener): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private assertNoContributionCollisions(extension: MacroExtensionRecord): void {
    const assertFree = <TContribution extends { id: string }>(
      map: Map<string, MacroExtensionContribution<TContribution>>,
      contributions: TContribution[] | undefined,
      label: string,
    ) => {
      for (const contribution of contributions ?? []) {
        const existing = map.get(contribution.id);
        if (existing && existing.extensionId !== extension.id) {
          throw new Error(
            `Extension contribution collision for ${label} "${contribution.id}" between "${existing.extensionId}" and "${extension.id}".`,
          );
        }
      }
    };

    assertFree(this.modes, extension.manifest.contributes?.modes, 'mode');
    assertFree(this.views, extension.manifest.contributes?.views, 'view');
    assertFree(this.composers, extension.manifest.contributes?.composers, 'composer');
    assertFree(this.commands, extension.manifest.contributes?.commands, 'command');
    assertFree(this.tools, extension.manifest.contributes?.tools, 'tool');
  }

  private deleteOwnedContributions<TContribution>(
    map: Map<string, MacroExtensionContribution<TContribution>>,
    extensionId: string,
  ): void {
    for (const [id, entry] of map) {
      if (entry.extensionId === extensionId) {
        map.delete(id);
      }
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const macroContributionRegistry = new MacroContributionRegistry();

export const createDevelopmentExtension = (
  manifest: MacroExtensionManifest,
  permissions: MacroExtensionPermissionGrant | Record<string, string[]>,
): MacroExtensionRecord => {
  const grant: MacroExtensionPermissionGrant =
    isMacroExtensionPermissionGrant(permissions)
      ? permissions
      : {
          extensionId: manifest.id,
          granted: permissions,
          trusted: true,
          grantedAt: new Date().toISOString(),
          source: 'development',
        };

  return {
    id: manifest.id,
    manifest,
    permissions: grant,
    sourcePath: null,
    installedAt: null,
    enabled: true,
  };
};

const isMacroExtensionPermissionGrant = (
  value: MacroExtensionPermissionGrant | Record<string, string[]>,
): value is MacroExtensionPermissionGrant =>
  typeof (value as MacroExtensionPermissionGrant).extensionId === 'string' &&
  typeof (value as MacroExtensionPermissionGrant).trusted === 'boolean' &&
  typeof (value as MacroExtensionPermissionGrant).grantedAt === 'string' &&
  Boolean((value as MacroExtensionPermissionGrant).granted);
