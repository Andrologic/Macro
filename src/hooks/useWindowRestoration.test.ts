import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let loadPreferencesMock: ReturnType<typeof mock>;
let showMainWindowMock: ReturnType<typeof mock>;
let windowMaximizeMock: ReturnType<typeof mock>;
let windowIsMaximizedMock: ReturnType<typeof mock>;
let windowOuterPositionMock: ReturnType<typeof mock>;
let windowOuterSizeMock: ReturnType<typeof mock>;
let windowScaleFactorMock: ReturnType<typeof mock>;
let windowSetBackgroundColorMock: ReturnType<typeof mock>;
let windowSetMacosAppIconThemeMock: ReturnType<typeof mock>;
let windowSetPositionMock: ReturnType<typeof mock>;
let windowSetSizeMock: ReturnType<typeof mock>;
let windowSetThemeMock: ReturnType<typeof mock>;
let chromeState: {
  platform: 'macos' | 'windows' | 'linux' | 'web';
  isTauriWindow: boolean;
  showCustomWindowControls: boolean;
  disableCustomDoubleClickZoom: boolean;
  usesNativeMacosTitlebar: boolean;
};
let invocationOrder: string[];
let importCounter = 0;

const registerWindowRestorationMocks = () => {
  mock.restore();

  mock.module('../services/preferences', () => ({
    PREF_KEYS: {
      WINDOW_WIDTH: 'windowWidth',
      WINDOW_HEIGHT: 'windowHeight',
      WINDOW_X: 'windowX',
      WINDOW_Y: 'windowY',
      IS_MAXIMIZED: 'isMaximized',
      NATIVE_MACOS_TITLEBAR_BG: 'nativeMacosTitlebarBg',
      NATIVE_MACOS_TITLEBAR_THEME: 'nativeMacosTitlebarTheme',
    },
    loadPreferences: (...args: unknown[]) => loadPreferencesMock(...args),
    savePreference: () => Promise.resolve(),
  }));

  mock.module('../services/tauriWindow', () => ({
    isTauriEnvironment: () => true,
    showMainWindow: (...args: unknown[]) => showMainWindowMock(...args),
    windowIsMaximized: (...args: unknown[]) => windowIsMaximizedMock(...args),
    windowMaximize: (...args: unknown[]) => windowMaximizeMock(...args),
    windowOuterPosition: (...args: unknown[]) => windowOuterPositionMock(...args),
    windowOuterSize: (...args: unknown[]) => windowOuterSizeMock(...args),
    windowScaleFactor: (...args: unknown[]) => windowScaleFactorMock(...args),
    windowSetBackgroundColor: (...args: unknown[]) => windowSetBackgroundColorMock(...args),
    windowSetMacosAppIconTheme: (...args: unknown[]) => windowSetMacosAppIconThemeMock(...args),
    windowSetPosition: (...args: unknown[]) => windowSetPositionMock(...args),
    windowSetSize: (...args: unknown[]) => windowSetSizeMock(...args),
    windowSetTheme: (...args: unknown[]) => windowSetThemeMock(...args),
  }));

  mock.module('../utils/desktopPlatform', () => ({
    getPlatformChromeState: () => chromeState,
  }));

  mock.module('../utils/pageLifecycle', () => ({
    isPageShuttingDown: () => false,
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
  registerWindowRestorationMocks();
  importCounter += 1;
  return import(`./useWindowRestoration.ts?test=${importCounter}`);
};

describe('ensureWindowRestoredOnce', () => {
  beforeEach(() => {
    invocationOrder = [];
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    loadPreferencesMock = mock(async (keys: string[]) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          {
            windowWidth: 1440,
            windowHeight: 900,
            windowX: 32,
            windowY: 48,
            isMaximized: false,
            nativeMacosTitlebarBg: '#223344',
            nativeMacosTitlebarTheme: 'dark',
          }[key],
        ])
      )
    );

    showMainWindowMock = mock(async () => {
      invocationOrder.push('show');
    });
    windowMaximizeMock = mock(async () => {
      invocationOrder.push('maximize');
    });
    windowIsMaximizedMock = mock(async () => false);
    windowOuterPositionMock = mock(async () => ({ x: 0, y: 0 }));
    windowOuterSizeMock = mock(async () => ({ width: 0, height: 0 }));
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
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.restore();
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
    expect(showMainWindowMock.mock.calls).toHaveLength(1);
  });
});
