import { describe, expect, it } from 'bun:test';
import {
  resolvePlatformChromeState,
} from './desktopPlatform';

describe('resolvePlatformChromeState', () => {
  it('uses native macOS titlebar rules on macOS tauri windows', () => {
    expect(
      resolvePlatformChromeState({
        platform: 'macos',
        tauriWindow: true,
      })
    ).toEqual({
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    });
  });

  it('keeps custom controls on Windows tauri windows', () => {
    expect(
      resolvePlatformChromeState({
        platform: 'windows',
        tauriWindow: true,
      })
    ).toEqual({
      platform: 'windows',
      isTauriWindow: true,
      showCustomWindowControls: true,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    });
  });

  it('disables desktop chrome behaviors in the web environment', () => {
    expect(
      resolvePlatformChromeState({
        platform: 'web',
        tauriWindow: false,
      })
    ).toEqual({
      platform: 'web',
      isTauriWindow: false,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    });
  });
});
