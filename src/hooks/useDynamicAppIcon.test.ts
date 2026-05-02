import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { syncDynamicAppIcon } from './useDynamicAppIcon';
import type {
  DynamicLogoThemeColors,
  MacosDynamicAppIconThemeSpec,
} from './dynamicAppIconRenderer';

const darkThemeColors: DynamicLogoThemeColors = {
  backgroundColor: '#09090b',
  primaryColor: '#6366f1',
  themeType: 'dark',
};

const lightThemeColors: DynamicLogoThemeColors = {
  backgroundColor: '#ffffff',
  primaryColor: '#f97316',
  themeType: 'light',
};

describe('syncDynamicAppIcon', () => {
  const logoSvgSource =
    '<svg><stop stop-color="#3B82F6" /><stop stop-color="#1E40AF" /><path d="logo" /></svg>';
  const loadLogoSvgSource = mock(async () => logoSvgSource);
  const renderThemedLogoPngBytes = mock(async (_themedLogoSvg: string) => new Uint8Array([1, 2, 3]));
  const buildMacosAppIconThemeSpec = mock(
    (_colors: DynamicLogoThemeColors): MacosDynamicAppIconThemeSpec => ({
      backgroundColor: '#09090b',
      logoStartColor: '#6366f1',
      logoEndColor: '#4f52c1',
    })
  );
  const setFaviconFromSvg = mock((_themedLogoSvg: string) => undefined);
  const setWindowIconFromPng = mock(async (_pngBytes: Uint8Array) => undefined);
  const setMacosAppIconTheme = mock(async (_spec: MacosDynamicAppIconThemeSpec) => undefined);
  const logDynamicLogoWarning = mock((_message: string, _error?: unknown) => undefined);

  beforeEach(() => {
    loadLogoSvgSource.mockClear();
    renderThemedLogoPngBytes.mockClear();
    buildMacosAppIconThemeSpec.mockClear();
    setFaviconFromSvg.mockClear();
    setWindowIconFromPng.mockClear();
    setMacosAppIconTheme.mockClear();
    logDynamicLogoWarning.mockClear();
  });

  it('updates only the favicon outside Tauri', async () => {
    const result = await syncDynamicAppIcon(darkThemeColors, {
      isTauriEnvironment: () => false,
      getPlatform: () => 'macos',
      renderThemedLogoPngBytes,
      loadLogoSvgSource,
      buildMacosAppIconThemeSpec,
      setFaviconFromSvg,
      setWindowIconFromPng,
      setMacosAppIconTheme,
      logDynamicLogoWarning,
    });

    expect(loadLogoSvgSource).toHaveBeenCalledTimes(1);
    expect(setFaviconFromSvg).toHaveBeenCalledTimes(1);
    expect(setFaviconFromSvg.mock.calls[0]?.[0]).toContain('stop-color="#6366f1"');
    expect(renderThemedLogoPngBytes).not.toHaveBeenCalled();
    expect(buildMacosAppIconThemeSpec).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
    expect(setMacosAppIconTheme).not.toHaveBeenCalled();
    expect(result).toEqual({
      favicon: { surface: 'favicon', status: 'updated' },
      nativeIcon: { surface: 'nativeIcon', status: 'skipped', reason: 'not-tauri' },
    });
  });

  it('returns structured failures when the public logo cannot be loaded', async () => {
    const loadLogoFailure = mock(async () => {
      throw new Error('missing logo');
    });

    const result = await syncDynamicAppIcon(darkThemeColors, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'windows',
      renderThemedLogoPngBytes,
      loadLogoSvgSource: loadLogoFailure,
      buildMacosAppIconThemeSpec,
      setFaviconFromSvg,
      setWindowIconFromPng,
      setMacosAppIconTheme,
      logDynamicLogoWarning,
    });

    expect(setFaviconFromSvg).not.toHaveBeenCalled();
    expect(renderThemedLogoPngBytes).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
    expect(result).toEqual({
      favicon: { surface: 'favicon', status: 'failed', reason: 'missing logo' },
      nativeIcon: { surface: 'nativeIcon', status: 'failed', reason: 'missing logo' },
    });
    expect(logDynamicLogoWarning).toHaveBeenCalledWith(
      'Failed to load the public logo SVG.',
      expect.any(Error)
    );
  });

  it('routes the icon through the dedicated macOS native bridge on macOS', async () => {
    const result = await syncDynamicAppIcon(darkThemeColors, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'macos',
      renderThemedLogoPngBytes,
      loadLogoSvgSource,
      buildMacosAppIconThemeSpec,
      setFaviconFromSvg,
      setWindowIconFromPng,
      setMacosAppIconTheme,
      logDynamicLogoWarning,
    });

    expect(setFaviconFromSvg).toHaveBeenCalledTimes(1);
    expect(buildMacosAppIconThemeSpec).toHaveBeenCalledTimes(1);
    expect(buildMacosAppIconThemeSpec).toHaveBeenCalledWith(darkThemeColors);
    expect(renderThemedLogoPngBytes).not.toHaveBeenCalled();
    expect(loadLogoSvgSource).toHaveBeenCalledTimes(1);
    expect(setMacosAppIconTheme).toHaveBeenCalledTimes(1);
    expect(setMacosAppIconTheme).toHaveBeenCalledWith({
      backgroundColor: '#09090b',
      logoStartColor: '#6366f1',
      logoEndColor: '#4f52c1',
    });
    expect(setWindowIconFromPng).not.toHaveBeenCalled();
    expect(result.nativeIcon).toEqual({ surface: 'nativeIcon', status: 'updated' });
  });

  it('keeps using the existing window icon path on non-macOS platforms', async () => {
    const result = await syncDynamicAppIcon(darkThemeColors, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'windows',
      renderThemedLogoPngBytes,
      loadLogoSvgSource,
      buildMacosAppIconThemeSpec,
      setFaviconFromSvg,
      setWindowIconFromPng,
      setMacosAppIconTheme,
      logDynamicLogoWarning,
    });

    expect(loadLogoSvgSource).toHaveBeenCalledTimes(1);
    expect(setFaviconFromSvg).toHaveBeenCalledTimes(1);
    expect(renderThemedLogoPngBytes).toHaveBeenCalledTimes(1);
    expect(renderThemedLogoPngBytes.mock.calls[0]?.[0]).toContain('stop-color="#6366f1"');
    expect(buildMacosAppIconThemeSpec).not.toHaveBeenCalled();
    expect(setWindowIconFromPng).toHaveBeenCalledTimes(1);
    expect(setWindowIconFromPng).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(setMacosAppIconTheme).not.toHaveBeenCalled();
    expect(logDynamicLogoWarning).toHaveBeenCalledWith(
      'Updated the native window icon. Windows 11 may keep showing the pinned taskbar icon from its shell cache.'
    );
    expect(result.nativeIcon).toEqual({
      surface: 'nativeIcon',
      status: 'updated',
      reason: 'windows-taskbar-best-effort',
    });
  });

  it('recalculates the non-macOS window icon for successive theme colors', async () => {
    await syncDynamicAppIcon(darkThemeColors, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'linux',
      renderThemedLogoPngBytes,
      loadLogoSvgSource,
      buildMacosAppIconThemeSpec,
      setFaviconFromSvg,
      setWindowIconFromPng,
      setMacosAppIconTheme,
      logDynamicLogoWarning,
    });
    await syncDynamicAppIcon(lightThemeColors, {
      isTauriEnvironment: () => true,
      getPlatform: () => 'linux',
      renderThemedLogoPngBytes,
      loadLogoSvgSource,
      buildMacosAppIconThemeSpec,
      setFaviconFromSvg,
      setWindowIconFromPng,
      setMacosAppIconTheme,
      logDynamicLogoWarning,
    });

    expect(loadLogoSvgSource).toHaveBeenCalledTimes(2);
    expect(setFaviconFromSvg).toHaveBeenCalledTimes(2);
    expect(renderThemedLogoPngBytes).toHaveBeenCalledTimes(2);
    expect(renderThemedLogoPngBytes.mock.calls[0]?.[0]).toContain('stop-color="#6366f1"');
    expect(renderThemedLogoPngBytes.mock.calls[1]?.[0]).toContain('stop-color="#f97316"');
    expect(setWindowIconFromPng).toHaveBeenCalledTimes(2);
  });
});
