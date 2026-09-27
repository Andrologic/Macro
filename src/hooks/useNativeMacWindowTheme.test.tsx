import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Theme } from '../types/theme';

const savePreferenceMock = mock(async (_key: string, _value: string) => undefined);
const windowSetBackgroundColorMock = mock(async (_color: string) => undefined);
const windowSetThemeMock = mock(async (_theme: 'light' | 'dark') => undefined);

mock.module('../services/preferences', () => ({
  PREF_KEYS: {
    NATIVE_MACOS_TITLEBAR_BG: 'nativeMacosTitlebarBg',
    NATIVE_MACOS_TITLEBAR_THEME: 'nativeMacosTitlebarTheme',
  },
  savePreference: savePreferenceMock,
}));

mock.module('../services/tauriWindow', () => ({
  isTauriEnvironment: () => true,
  windowSetBackgroundColor: windowSetBackgroundColorMock,
  windowSetTheme: windowSetThemeMock,
}));

mock.module('../utils/desktopPlatform', () => ({
  getPlatformChromeState: () => ({ usesNativeMacosTitlebar: true }),
}));

const colors = {
  background: '#111111',
  foreground: '#ffffff',
  card: '#111111',
  cardForeground: '#ffffff',
  popover: '#111111',
  popoverForeground: '#ffffff',
  primary: '#555555',
  primaryForeground: '#ffffff',
  secondary: '#222222',
  secondaryForeground: '#ffffff',
  muted: '#222222',
  mutedForeground: '#aaaaaa',
  accent: '#333333',
  accentForeground: '#ffffff',
  destructive: '#ff0000',
  destructiveForeground: '#ffffff',
  border: '#444444',
  input: '#444444',
  ring: '#555555',
};

const darkTheme: Theme = { name: 'Dark', type: 'dark', colors };
const lightTheme: Theme = {
  name: 'Light',
  type: 'light',
  colors: { ...colors, background: '#ffffff', foreground: '#111111' },
};

let importCounter = 0;

describe('useNativeMacWindowTheme', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    mock.restore();
  });

  it('applies macOS native theme writes in selection order', async () => {
    let releaseDarkWrite: (() => void) | undefined;
    const darkWrite = new Promise<void>((resolve) => {
      releaseDarkWrite = resolve;
    });
    const appliedThemes: Array<'light' | 'dark'> = [];
    let preferenceWrite = 0;
    savePreferenceMock.mockClear();
    savePreferenceMock.mockImplementation(async () => {
      preferenceWrite += 1;
      if (preferenceWrite === 1) throw new Error('preference unavailable');
    });
    windowSetThemeMock.mockClear();
    windowSetThemeMock.mockImplementation(async (theme) => {
      if (theme === 'dark') await darkWrite;
      appliedThemes.push(theme);
    });
    importCounter += 1;
    const { useNativeMacWindowTheme } = await import(
      `./useNativeMacWindowTheme.ts?native-theme-order=${importCounter}`
    );
    const Harness = ({ theme }: { theme: Theme }) => {
      useNativeMacWindowTheme(theme);
      return null;
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness theme={darkTheme} />);
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(<Harness theme={lightTheme} />);
      await Promise.resolve();
    });

    expect(windowSetThemeMock.mock.calls.map((call) => call[0])).toEqual(['dark']);
    releaseDarkWrite?.();
    await act(async () => {
      await darkWrite;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(windowSetThemeMock.mock.calls.map((call) => call[0])).toEqual(['dark', 'light']);
    expect(appliedThemes).toEqual(['dark', 'light']);
  });
});
