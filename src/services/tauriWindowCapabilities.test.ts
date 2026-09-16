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

  it('leaves macOS traffic-light fullscreen recovery to the native layer', () => {
    const tauriWindowSource = readRepoFile('src', 'services', 'tauriWindow.ts');
    const macosTrafficLightsSource = readRepoFile(
      'src-tauri',
      'src',
      'macos_traffic_lights.rs'
    );

    expect(tauriWindowSource).not.toContain('windowIsFullscreen');
    expect(tauriWindowSource).not.toContain('.isFullscreen()');
    expect(macosTrafficLightsSource).toContain('NSWindowWillExitFullScreenNotification');
    expect(macosTrafficLightsSource).toContain('NSWindowDidExitFullScreenNotification');

    const capability = JSON.parse(
      readRepoFile('src-tauri', 'capabilities', 'default.json')
    ) as CapabilityFile;
    const permissionIds = capability.permissions.map(permissionIdentifier);

    expect(permissionIds).not.toContain('core:window:allow-is-fullscreen');
  });
});


describe('desktop window configuration', () => {
  it('grants precisely the monitor reads and native color operation used by restoration', () => {
    const capability = JSON.parse(readRepoFile('src-tauri', 'capabilities', 'default.json')) as CapabilityFile;
    const permissions = capability.permissions.map(permissionIdentifier);
    for (const operation of ['available-monitors', 'current-monitor', 'primary-monitor', 'set-background-color']) {
      expect(permissions).toContain(`core:window:allow-${operation}`);
    }
    expect(permissions).not.toContain('core:window:default');
  });

  it('delivers native file drops to DOM handlers in every distributed window configuration', () => {
    for (const name of ['tauri.conf.json', 'tauri.macos.conf.json']) {
      const config = JSON.parse(readRepoFile('src-tauri', name));
      for (const window of config.app.windows) expect(window.dragDropEnabled).toBe(false);
    }
  });
});
