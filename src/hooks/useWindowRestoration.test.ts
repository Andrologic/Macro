import { beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let loadPreferencesMock: ReturnType<typeof mock>;
let loadPersistedPreferenceMock: ReturnType<typeof mock>;
let savePreferenceMock: ReturnType<typeof mock>;
let showMainWindowMock: ReturnType<typeof mock>;
let windowCurrentMonitorWorkAreaMock: ReturnType<typeof mock>;
let windowMaximizeMock: ReturnType<typeof mock>;
let windowIsMaximizedMock: ReturnType<typeof mock>;
let windowOuterPositionMock: ReturnType<typeof mock>;
let windowOuterSizeMock: ReturnType<typeof mock>;
let windowPrimaryMonitorWorkAreaMock: ReturnType<typeof mock>;
let windowScaleFactorMock: ReturnType<typeof mock>;
let windowSetBackgroundColorMock: ReturnType<typeof mock>;
let windowSetMacosAppIconThemeMock: ReturnType<typeof mock>;
let windowSetPositionMock: ReturnType<typeof mock>;
let windowSetSizeMock: ReturnType<typeof mock>;
let windowSetThemeMock: ReturnType<typeof mock>;
let windowOnCloseRequestedMock: ReturnType<typeof mock>;
let chromeState: {
  platform: 'macos' | 'windows' | 'linux' | 'web';
  isTauriWindow: boolean;
  showCustomWindowControls: boolean;
  disableCustomDoubleClickZoom: boolean;
  usesNativeMacosTitlebar: boolean;
};
let invocationOrder: string[];
let persistedPreferenceValues: Record<string, unknown>;
let preferenceValues: Record<string, unknown>;
let importCounter = 0;
let pageShuttingDown = false;
let closeRequestedListener: (() => void | Promise<void>) | null = null;
let movedListener: (() => void) | null = null;
let resizedListener: (() => void) | null = null;

const registerWindowRestorationMocks = async () => {
  const actualPreferences = await import(
    `../services/preferences.ts?window-restoration-preferences-test=${importCounter + 1}`
  );

  mock.module('../services/preferences', () => ({
    ...actualPreferences,
    loadPreferences: (...args: unknown[]) => loadPreferencesMock(...args),
    loadPersistedPreference: (...args: unknown[]) => loadPersistedPreferenceMock(...args),
    savePreference: (...args: unknown[]) => savePreferenceMock(...args),
  }));

  mock.module('../services/tauriWindow', () => ({
    isTauriEnvironment: () => true,
    showMainWindow: (...args: unknown[]) => showMainWindowMock(...args),
    windowCurrentMonitorWorkArea: (...args: unknown[]) => windowCurrentMonitorWorkAreaMock(...args),
    windowIsMaximized: (...args: unknown[]) => windowIsMaximizedMock(...args),
    windowMaximize: (...args: unknown[]) => windowMaximizeMock(...args),
    windowOuterPosition: (...args: unknown[]) => windowOuterPositionMock(...args),
    windowOuterSize: (...args: unknown[]) => windowOuterSizeMock(...args),
    windowPrimaryMonitorWorkArea: (...args: unknown[]) => windowPrimaryMonitorWorkAreaMock(...args),
    windowScaleFactor: (...args: unknown[]) => windowScaleFactorMock(...args),
    windowSetBackgroundColor: (...args: unknown[]) => windowSetBackgroundColorMock(...args),
    windowSetMacosAppIconTheme: (...args: unknown[]) => windowSetMacosAppIconThemeMock(...args),
    windowSetPosition: (...args: unknown[]) => windowSetPositionMock(...args),
    windowSetSize: (...args: unknown[]) => windowSetSizeMock(...args),
    windowSetTheme: (...args: unknown[]) => windowSetThemeMock(...args),
    windowSetTrafficLightPosition: async () => undefined,
    windowOnCloseRequested: (...args: unknown[]) => windowOnCloseRequestedMock(...args),
    windowOnMoved: async (listener: () => void) => {
      movedListener = listener;
      return () => {
        if (movedListener === listener) {
          movedListener = null;
        }
      };
    },
    windowOnResized: async (listener: () => void) => {
      resizedListener = listener;
      return () => {
        if (resizedListener === listener) {
          resizedListener = null;
        }
      };
    },
  }));

  mock.module('../utils/desktopPlatform', () => ({
    getPlatformChromeState: () => chromeState,
  }));

  mock.module('../utils/pageLifecycle', () => ({
    isPageShuttingDown: () => pageShuttingDown,
    markPageShuttingDown: (reason?: unknown) => {
      pageShuttingDown = true;
      return reason;
    },
  }));

  mock.module('../utils/devLogger', () => ({
    devLogger: {
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  }));
};

const loadWindowRestoration = async () => {
  await registerWindowRestorationMocks();
  importCounter += 1;
  return import(`./useWindowRestoration.ts?test=${importCounter}`);
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const renderWindowRestorationHook = async (
  useWindowRestoration: () => void
): Promise<{ root: Root; container: HTMLDivElement }> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const TestComponent = () => {
    useWindowRestoration();
    return null;
  };

  await act(async () => {
    root.render(React.createElement(TestComponent));
  });

  return { root, container };
};

describe('ensureWindowRestoredOnce', () => {
  beforeEach(() => {
    invocationOrder = [];
    pageShuttingDown = false;
    closeRequestedListener = null;
    movedListener = null;
    resizedListener = null;
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };
    preferenceValues = {
      windowWidth: 1440,
      windowHeight: 900,
      windowX: 32,
      windowY: 48,
      isMaximized: false,
      nativeMacosTitlebarBg: '#223344',
      nativeMacosTitlebarTheme: 'dark',
    };
    persistedPreferenceValues = {
      windowWidth: 1440,
      windowHeight: 900,
      windowX: 32,
      windowY: 48,
      isMaximized: false,
      windowBootstrapVersion: 2,
    };

    loadPreferencesMock = mock(async (keys: string[]) =>
      Object.fromEntries(
        keys.map((key) => [key, preferenceValues[key]])
      )
    );
    loadPersistedPreferenceMock = mock(async (key: string) => persistedPreferenceValues[key]);
    savePreferenceMock = mock(async () => undefined);

    showMainWindowMock = mock(async () => {
      invocationOrder.push('show');
    });
    windowCurrentMonitorWorkAreaMock = mock(async () => ({
      x: 0,
      y: 40,
      width: 1728,
      height: 1077,
    }));
    windowMaximizeMock = mock(async () => {
      invocationOrder.push('maximize');
    });
    windowIsMaximizedMock = mock(async () => false);
    windowOuterPositionMock = mock(async () => ({ x: 0, y: 0 }));
    windowOuterSizeMock = mock(async () => ({ width: 0, height: 0 }));
    windowPrimaryMonitorWorkAreaMock = mock(async () => ({
      x: 0,
      y: 24,
      width: 1512,
      height: 958,
    }));
    windowScaleFactorMock = mock(async () => 1);
    windowSetBackgroundColorMock = mock(async () => {
      invocationOrder.push('background');
    });
    windowSetMacosAppIconThemeMock = mock(async () => undefined);
    windowSetPositionMock = mock(async () => {
      invocationOrder.push('position');
    });
    windowSetSizeMock = mock(async () => {
      invocationOrder.push('size');
    });
    windowSetThemeMock = mock(async () => {
      invocationOrder.push('theme');
    });
    windowOnCloseRequestedMock = mock(async (listener: () => void | Promise<void>) => {
      closeRequestedListener = listener;
      return () => {
        if (closeRequestedListener === listener) {
          closeRequestedListener = null;
        }
      };
    });
  });

  it('applies the native macOS theme snapshot before showing the window', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowSetBackgroundColorMock.mock.calls).toHaveLength(1);
    expect(windowSetThemeMock.mock.calls).toHaveLength(1);
    expect(showMainWindowMock.mock.calls).toHaveLength(1);
    expect(invocationOrder.indexOf('background')).toBeLessThan(invocationOrder.indexOf('show'));
    expect(invocationOrder.indexOf('theme')).toBeLessThan(invocationOrder.indexOf('show'));
  });

  it('skips native macOS snapshot syncing on non-mac platforms', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    chromeState = {
      platform: 'windows',
      isTauriWindow: true,
      showCustomWindowControls: true,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    };

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowSetBackgroundColorMock.mock.calls).toHaveLength(0);
    expect(windowSetThemeMock.mock.calls).toHaveLength(0);
    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowPrimaryMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(showMainWindowMock.mock.calls).toHaveLength(1);
  });

  it('bootstraps the first macOS launch maximized before showing the window', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    preferenceValues = {
      windowWidth: 1200,
      windowHeight: 800,
      windowX: null,
      windowY: null,
      isMaximized: false,
      nativeMacosTitlebarBg: '#223344',
      nativeMacosTitlebarTheme: 'dark',
    };
    persistedPreferenceValues = {};

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowPrimaryMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowSetSizeMock.mock.calls).toHaveLength(0);
    expect(windowSetPositionMock.mock.calls).toHaveLength(0);
    expect(windowMaximizeMock.mock.calls).toHaveLength(1);
    expect(savePreferenceMock.mock.calls).toEqual([
      ['isMaximized', true],
      ['windowBootstrapVersion', 2],
    ]);
    expect(invocationOrder.indexOf('maximize')).toBeLessThan(invocationOrder.indexOf('show'));
  });

  it('migrates the legacy macOS 1200x800 bootstrap once to a maximized launch', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    preferenceValues = {
      windowWidth: 1200,
      windowHeight: 800,
      windowX: 32,
      windowY: 48,
      isMaximized: false,
      nativeMacosTitlebarBg: '#223344',
      nativeMacosTitlebarTheme: 'dark',
    };
    persistedPreferenceValues = {
      windowWidth: 1200,
      windowHeight: 800,
      windowX: 32,
      windowY: 48,
      isMaximized: false,
    };

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowSetSizeMock.mock.calls).toHaveLength(0);
    expect(windowSetPositionMock.mock.calls).toHaveLength(0);
    expect(windowMaximizeMock.mock.calls).toHaveLength(1);
    expect(savePreferenceMock.mock.calls).toEqual([
      ['isMaximized', true],
      ['windowBootstrapVersion', 2],
    ]);
  });

  it('preserves a custom persisted macOS window size when the bootstrap version is already current', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowPrimaryMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowSetSizeMock.mock.calls).toEqual([[1440, 900]]);
    expect(windowSetPositionMock.mock.calls).toEqual([[32, 48]]);
    expect(savePreferenceMock.mock.calls).toHaveLength(0);
  });

  it('does not migrate an already customized macOS window state from an older bootstrap version', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    persistedPreferenceValues = {
      windowWidth: 1380,
      windowHeight: 860,
      windowX: 20,
      windowY: 30,
      isMaximized: false,
    };
    preferenceValues = {
      windowWidth: 1380,
      windowHeight: 860,
      windowX: 20,
      windowY: 30,
      isMaximized: false,
      nativeMacosTitlebarBg: '#223344',
      nativeMacosTitlebarTheme: 'dark',
    };

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowSetSizeMock.mock.calls).toEqual([[1380, 860]]);
    expect(windowSetPositionMock.mock.calls).toEqual([[20, 30]]);
    expect(savePreferenceMock.mock.calls).toEqual([['windowBootstrapVersion', 2]]);
  });

  it('keeps maximized macOS windows maximized and records the new bootstrap version', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    persistedPreferenceValues = {
      windowWidth: 1200,
      windowHeight: 800,
      isMaximized: true,
    };
    preferenceValues = {
      windowWidth: 1200,
      windowHeight: 800,
      windowX: 32,
      windowY: 48,
      isMaximized: true,
      nativeMacosTitlebarBg: '#223344',
      nativeMacosTitlebarTheme: 'dark',
    };

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(0);
    expect(windowSetSizeMock.mock.calls).toHaveLength(0);
    expect(windowSetPositionMock.mock.calls).toHaveLength(0);
    expect(windowMaximizeMock.mock.calls).toHaveLength(1);
    expect(savePreferenceMock.mock.calls).toEqual([
      ['isMaximized', true],
      ['windowBootstrapVersion', 2],
    ]);
  });

  it('falls back to the primary monitor work area when default maximize fails', async () => {
    const { __resetWindowRestorationForTests, ensureWindowRestoredOnce } = await loadWindowRestoration();
    preferenceValues = {
      windowWidth: 1200,
      windowHeight: 800,
      windowX: null,
      windowY: null,
      isMaximized: false,
      nativeMacosTitlebarBg: '#223344',
      nativeMacosTitlebarTheme: 'dark',
    };
    persistedPreferenceValues = {};
    windowMaximizeMock = mock(async () => {
      invocationOrder.push('maximize');
      throw new Error('maximize not available');
    });
    windowCurrentMonitorWorkAreaMock = mock(async () => null);

    __resetWindowRestorationForTests();
    await ensureWindowRestoredOnce();

    expect(windowMaximizeMock.mock.calls).toHaveLength(1);
    expect(windowCurrentMonitorWorkAreaMock.mock.calls).toHaveLength(1);
    expect(windowPrimaryMonitorWorkAreaMock.mock.calls).toHaveLength(1);
    expect(windowSetSizeMock.mock.calls).toEqual([[1512, 958]]);
    expect(windowSetPositionMock.mock.calls).toEqual([[0, 24]]);
    expect(savePreferenceMock.mock.calls).toEqual([
      ['windowWidth', 1512],
      ['windowHeight', 958],
      ['windowX', 0],
      ['windowY', 24],
      ['isMaximized', false],
      ['windowBootstrapVersion', 2],
    ]);
  });

  it('skips showing the window when close is requested before restore completes', async () => {
    const { __resetWindowRestorationForTests, useWindowRestoration } = await loadWindowRestoration();
    let releasePreferences: () => void = () => undefined;
    const preferenceGate = new Promise<void>((resolve) => {
      releasePreferences = resolve;
    });
    loadPreferencesMock = mock(
      async () => {
        await preferenceGate;
        return Object.fromEntries(Object.entries(preferenceValues));
      }
    );

    __resetWindowRestorationForTests();
    const { root, container } = await renderWindowRestorationHook(useWindowRestoration);

    expect(typeof closeRequestedListener).toBe('function');

    await act(async () => {
      await closeRequestedListener?.();
    });

    releasePreferences();

    await act(async () => {
      await Promise.resolve();
    });

    expect(showMainWindowMock.mock.calls).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('skips showing the window when close is requested during the bootstrap delay', async () => {
    const { __resetWindowRestorationForTests, useWindowRestoration } = await loadWindowRestoration();

    __resetWindowRestorationForTests();
    const { root, container } = await renderWindowRestorationHook(useWindowRestoration);

    expect(typeof closeRequestedListener).toBe('function');

    await delay(10);
    await act(async () => {
      await closeRequestedListener?.();
    });
    await delay(70);

    expect(showMainWindowMock.mock.calls).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('cancels the pending window save debounce when close is requested', async () => {
    const { __resetWindowRestorationForTests, useWindowRestoration } = await loadWindowRestoration();

    __resetWindowRestorationForTests();
    const { root, container } = await renderWindowRestorationHook(useWindowRestoration);

    await delay(80);
    savePreferenceMock.mockClear();

    expect(typeof movedListener).toBe('function');
    expect(typeof closeRequestedListener).toBe('function');

    movedListener?.();
    await act(async () => {
      await closeRequestedListener?.();
    });
    await delay(650);

    expect(savePreferenceMock.mock.calls).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
