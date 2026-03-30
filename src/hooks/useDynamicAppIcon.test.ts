import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Theme } from '../types/theme';
import { syncDynamicAppIcon } from './useDynamicAppIcon';

const darkTheme: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090b',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#111117',
    popoverForeground: '#fafafa',
    primary: '#6366f1',
    primaryForeground: '#fafafa',
    secondary: '#27272a',
    secondaryForeground: '#fafafa',
    muted: '#27272a',
    mutedForeground: '#a1a1aa',
    accent: '#27272a',
    accentForeground: '#fafafa',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: '#27272a',
    input: '#27272a',
    ring: '#6366f1',
  },
};

describe('syncDynamicAppIcon', () => {
  const renderWindowsAppIconPngBytes = mock(async (_theme: Theme) => new Uint8Array([1, 2, 3]));
  const renderMacosAppIconPngBytes = mock(async (_theme: Theme) => new Uint8Array([4, 5, 6]));
  const setWindowIconFromPng = mock(async (_pngBytes: Uint8Array) => undefined);
  const setMacosAppIcon = mock(async (_pngBytes: Uint8Array) => undefined);

  beforeEach(() => {
    renderWindowsAppIconPngBytes.mockClear();
    renderMacosAppIconPngBytes.mockClear();
    setWindowIconFromPng.mockClear();
    setMacosAppIcon.mockClear();
  });

  it('skips icon work entirely outside Tauri', async () => {
    await syncDynamicAppIcon(darkTheme, {
      isTauriEnvironment: () => false,
      getPlatform: () => 'macos',
      renderWindowsAppIconPngBytes,
      renderMacosAppIconPngBytes,
      setWindowIconFromPng,
      setMacosAppIcon,
    });

    expect(renderWindowsAppIconPngBytes).not.toHaveBeenCalled();
    expect(renderMacosAppIconPngBytes).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
    expect(setMacosAppIcon).not.toHaveBeenCalled();
  });

  it('routes the icon through the dedicated macOS renderer and native bridge on macOS', async () => {
    await syncDynamicAppIcon(darkTheme, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'macos',
      renderWindowsAppIconPngBytes,
      renderMacosAppIconPngBytes,
      setWindowIconFromPng,
      setMacosAppIcon,
    });

    expect(renderMacosAppIconPngBytes).toHaveBeenCalledTimes(1);
    expect(renderWindowsAppIconPngBytes).not.toHaveBeenCalled();
    expect(setMacosAppIcon).toHaveBeenCalledTimes(1);
    expect(setMacosAppIcon).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
  });

  it('keeps using the existing window icon path on non-macOS platforms', async () => {
    await syncDynamicAppIcon(darkTheme, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'windows',
      renderWindowsAppIconPngBytes,
      renderMacosAppIconPngBytes,
      setWindowIconFromPng,
      setMacosAppIcon,
    });

    expect(renderWindowsAppIconPngBytes).toHaveBeenCalledTimes(1);
    expect(renderMacosAppIconPngBytes).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).toHaveBeenCalledTimes(1);
    expect(setWindowIconFromPng).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(setMacosAppIcon).not.toHaveBeenCalled();
  });
});
