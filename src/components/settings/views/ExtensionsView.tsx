import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  installExtensionFromFolder,
  installExtensionFromTgz,
  hydrateInstalledExtensions,
  listInstalledExtensions,
  setInstalledExtensionEnabled,
  uninstallExtension,
} from '../../../services/extensionInstaller';
import { macroContributionRegistry } from '../../../services/extensions';
import { Icon } from '../../ui/Icon';
import { Button } from '../../ui/Button';

export const ExtensionsView = () => {
  const [, setRevision] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const installed = listInstalledExtensions();
  const registered = macroContributionRegistry.listExtensions();

  const refresh = () => setRevision((current) => current + 1);

  useEffect(() => {
    void hydrateInstalledExtensions().then(() => setRevision((current) => current + 1));
  }, []);

  const installFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string') return;
    try {
      const result = await installExtensionFromFolder(selected);
      setMessage(`Installed ${result.summary.name} ${result.summary.version}.`);
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const installArchive = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: 'Macro extension archive', extensions: ['tgz'] }],
    });
    if (typeof selected !== 'string') return;
    try {
      const result = await installExtensionFromTgz(selected);
      setMessage(`Installed ${result.summary.name} ${result.summary.version}.`);
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleExtension = (extensionId: string, enabled: boolean) => {
    setInstalledExtensionEnabled(extensionId, enabled);
    refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Extensions</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Install local Macro extensions, review their trust state and inspect contributed modes.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" leftIcon={<Icon name="folder-open" size={14} />} onClick={installFolder}>
            Install folder
          </Button>
          <Button variant="secondary" size="sm" leftIcon={<Icon name="archive" size={14} />} onClick={installArchive}>
            Install .tgz
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
          {message}
        </div>
      )}

      <div className="space-y-3">
        {[...installed, ...registered
          .filter((extension) => !installed.some((item) => item.id === extension.id))
          .map((extension) => ({
            id: extension.id,
            name: extension.manifest.name,
            version: extension.manifest.version,
            sourcePath: extension.sourcePath ?? 'development runtime',
            kind: 'development' as const,
            fingerprint: 'registered',
            enabled: extension.enabled,
            installedAt: extension.installedAt ?? '',
            manifest: extension.manifest,
            permissions: extension.permissions,
          }))].map((extension) => {
          const permissionEntries = Object.entries(extension.permissions.granted ?? {});
          const permissionLabel = permissionEntries.length === 0
            ? 'No permissions granted'
            : permissionEntries
                .map(([scope, grants]) => `${scope}: ${grants.join(', ') || 'none'}`)
                .join(' | ');

          return (
          <div key={extension.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Icon name="layout-grid" size={15} className="text-primary" />
                  <h4 className="truncate text-sm font-semibold text-foreground">{extension.name}</h4>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {extension.version}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {extension.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {extension.permissions.trusted ? 'Trusted' : 'Untrusted'}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{extension.id}</p>
                <p className="mt-2 truncate text-xs text-muted-foreground">{extension.sourcePath}</p>
                <p className="mt-2 truncate text-xs text-muted-foreground">{permissionLabel}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {extension.kind} | {extension.fingerprint} | installed {extension.installedAt || 'runtime'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {installed.some((item) => item.id === extension.id) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Icon name={extension.enabled ? 'pause' : 'play'} size={14} />}
                    onClick={() => toggleExtension(extension.id, !extension.enabled)}
                  >
                    {extension.enabled ? 'Disable' : 'Enable'}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="trash" size={14} />}
                  onClick={() => {
                    uninstallExtension(extension.id);
                    refresh();
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
          );
        })}

        {installed.length === 0 && registered.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No extensions installed.
          </div>
        )}
      </div>
    </div>
  );
};
