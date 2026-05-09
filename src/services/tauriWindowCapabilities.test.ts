import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type CapabilityPermission = string | { identifier: string };
type CapabilityFile = {
  permissions: CapabilityPermission[];
};

const readRepoFile = (...segments: string[]): string =>
  readFileSync(join(process.cwd(), ...segments), 'utf8');

const permissionIdentifier = (permission: CapabilityPermission): string =>
  typeof permission === 'string' ? permission : permission.identifier;

describe('Tauri window close permissions', () => {
  it('allows destroy when close-requested listeners are registered', () => {
    const tauriWindowSource = readRepoFile('src', 'services', 'tauriWindow.ts');
    const windowRestorationSource = readRepoFile('src', 'hooks', 'useWindowRestoration.ts');
    const registersCloseRequestedListener =
      tauriWindowSource.includes('.onCloseRequested(') &&
      windowRestorationSource.includes('windowOnCloseRequested(');

    expect(registersCloseRequestedListener).toBe(true);

    const capability = JSON.parse(
      readRepoFile('src-tauri', 'capabilities', 'default.json')
    ) as CapabilityFile;
    const permissionIds = capability.permissions.map(permissionIdentifier);

    expect(permissionIds).toContain('core:window:allow-destroy');
  });

  it('allows fullscreen state reads for macOS traffic-light recovery', () => {
    const tauriWindowSource = readRepoFile('src', 'services', 'tauriWindow.ts');

    expect(tauriWindowSource).toContain('windowIsFullscreen');
    expect(tauriWindowSource).toContain('.isFullscreen()');

    const capability = JSON.parse(
      readRepoFile('src-tauri', 'capabilities', 'default.json')
    ) as CapabilityFile;
    const permissionIds = capability.permissions.map(permissionIdentifier);

    expect(permissionIds).toContain('core:window:allow-is-fullscreen');
  });
});
