import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Theme } from '../types/theme';
import { syncDynamicAppIcon } from './useDynamicAppIcon';
import type { MacosDynamicAppIconThemeSpec } from './dynamicAppIconRenderer';

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
  const buildMacosAppIconThemeSpec = mock(
    (_theme: Theme): MacosDynamicAppIconThemeSpec => ({
      backgroundColor: '#09090b',
      logoStartColor: '#6366f1',
      logoEndColor: '#4f52c1',
    })
  );
  const setWindowIconFromPng = mock(async (_pngBytes: Uint8Array) => undefined);
  const setMacosAppIconTheme = mock(async (_spec: MacosDynamicAppIconThemeSpec) => undefined);

  beforeEach(() => {
    renderWindowsAppIconPngBytes.mockClear();
    buildMacosAppIconThemeSpec.mockClear();
    setWindowIconFromPng.mockClear();
    setMacosAppIconTheme.mockClear();
  });

  it('skips icon work entirely outside Tauri', async () => {
    await syncDynamicAppIcon(darkTheme, {
      isTauriEnvironment: () => false,
      getPlatform: () => 'macos',
      renderWindowsAppIconPngBytes,
      buildMacosAppIconThemeSpec,
      setWindowIconFromPng,
      setMacosAppIconTheme,
    });

    expect(renderWindowsAppIconPngBytes).not.toHaveBeenCalled();
    expect(buildMacosAppIconThemeSpec).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
    expect(setMacosAppIconTheme).not.toHaveBeenCalled();
  });

  it('routes the icon through the dedicated macOS native bridge on macOS', async () => {
    await syncDynamicAppIcon(darkTheme, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'macos',
      renderWindowsAppIconPngBytes,
      buildMacosAppIconThemeSpec,
      setWindowIconFromPng,
      setMacosAppIconTheme,
    });

    expect(buildMacosAppIconThemeSpec).toHaveBeenCalledTimes(1);
    expect(buildMacosAppIconThemeSpec).toHaveBeenCalledWith(darkTheme);
    expect(renderWindowsAppIconPngBytes).not.toHaveBeenCalled();
    expect(setMacosAppIconTheme).toHaveBeenCalledTimes(1);
    expect(setMacosAppIconTheme).toHaveBeenCalledWith({
      backgroundColor: '#09090b',
      logoStartColor: '#6366f1',
      logoEndColor: '#4f52c1',
    });
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
  });

  it('keeps using the existing window icon path on non-macOS platforms', async () => {
    await syncDynamicAppIcon(darkTheme, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'windows',
      renderWindowsAppIconPngBytes,
      buildMacosAppIconThemeSpec,
      setWindowIconFromPng,
      setMacosAppIconTheme,
    });

    expect(renderWindowsAppIconPngBytes).toHaveBeenCalledTimes(1);
    expect(buildMacosAppIconThemeSpec).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).toHaveBeenCalledTimes(1);
    expect(setWindowIconFromPng).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(setMacosAppIconTheme).not.toHaveBeenCalled();
  });
});
