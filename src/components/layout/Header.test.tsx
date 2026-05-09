import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getMacosTrafficLightPosition,
  getTitleBarLayout,
} from './titleBarLayout';

const actualTauriWindow = await import('../../services/tauriWindow');
const actualDesktopPlatform = await import('../../utils/desktopPlatform');

type AppMode = 'Chat' | 'Architect' | 'Implement';

type AppStoreState = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  openSettings: () => void;
  openAccount: () => void;
  uiZoomMode: 'auto' | 'override';
  uiZoomLevel: number;
  selectedGroupId: string | null;
  projectGroups: unknown[];
};

type TauriWindowState = {
  isAvailable: boolean;
  toggleMaximize: () => void;
  startDragging: () => void;
};

let appState: AppStoreState;
let tauriWindowState: TauriWindowState;
let windowSetTrafficLightPositionMock: ReturnType<typeof mock>;
let windowResizeListeners: Array<() => void>;
let windowScaleChangedListeners: Array<() => void>;
let windowFocusChangedListeners: Array<(focused: boolean) => void>;
let windowEventUnlistenCount: number;
let windowFullscreenState: boolean;
let chromeState: {
  platform: 'macos' | 'windows' | 'linux' | 'web';
  isTauriWindow: boolean;
  showCustomWindowControls: boolean;
  disableCustomDoubleClickZoom: boolean;
  usesNativeMacosTitlebar: boolean;
};
let importCounter = 0;

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & {
    getState: () => T;
    setState: (patch: Partial<T>) => void;
    subscribe: () => () => void;
  };

  hook.getState = getSnapshot;
  hook.setState = (patch) => Object.assign(getSnapshot() as object, patch);
  hook.subscribe = () => () => undefined;
  return hook;
};

const useAppStore = createStoreHook(() => appState);

const registerHeaderMocks = () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    initReactI18next: {
      type: '3rdParty',
      init: () => undefined,
    },
    useTranslation: () => ({
      t: (key: string, fallback?: string) => fallback ?? key,
      i18n: {
        language: 'en-US',
        changeLanguage: mock(async () => undefined),
      },
    }),
  }));

  mock.module('../../stores/useAppStore', () => ({
    useAppStore,
  }));

  mock.module('../../hooks/useTauriWindow', () => ({
    useTauriWindow: () => tauriWindowState,
  }));

  mock.module('../../services/tauriWindow', () => ({
    ...actualTauriWindow,
    windowIsFullscreen: () => Promise.resolve(windowFullscreenState),
    windowOnFocusChanged: (listener: (focused: boolean) => void) => {
      windowFocusChangedListeners.push(listener);
      let active = true;
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        windowEventUnlistenCount += 1;
        windowFocusChangedListeners = windowFocusChangedListeners.filter(
          (candidate) => candidate !== listener
        );
      });
    },
    windowOnResized: (listener: () => void) => {
      windowResizeListeners.push(listener);
      let active = true;
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        windowEventUnlistenCount += 1;
        windowResizeListeners = windowResizeListeners.filter(
          (candidate) => candidate !== listener
        );
      });
    },
    windowOnScaleChanged: (listener: () => void) => {
      windowScaleChangedListeners.push(listener);
      let active = true;
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        windowEventUnlistenCount += 1;
        windowScaleChangedListeners = windowScaleChangedListeners.filter(
          (candidate) => candidate !== listener
        );
      });
    },
    windowSetTrafficLightPosition: (...args: [number, number]) =>
      windowSetTrafficLightPositionMock(...args),
  }));
  mock.module('../../services/tauriWindow.ts', () => ({
    ...actualTauriWindow,
    windowIsFullscreen: () => Promise.resolve(windowFullscreenState),
    windowOnFocusChanged: (listener: (focused: boolean) => void) => {
      windowFocusChangedListeners.push(listener);
      let active = true;
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        windowEventUnlistenCount += 1;
        windowFocusChangedListeners = windowFocusChangedListeners.filter(
          (candidate) => candidate !== listener
        );
      });
    },
    windowOnResized: (listener: () => void) => {
      windowResizeListeners.push(listener);
      let active = true;
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        windowEventUnlistenCount += 1;
        windowResizeListeners = windowResizeListeners.filter(
          (candidate) => candidate !== listener
        );
      });
    },
    windowOnScaleChanged: (listener: () => void) => {
      windowScaleChangedListeners.push(listener);
      let active = true;
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        windowEventUnlistenCount += 1;
        windowScaleChangedListeners = windowScaleChangedListeners.filter(
          (candidate) => candidate !== listener
        );
      });
    },
    windowSetTrafficLightPosition: (...args: [number, number]) =>
      windowSetTrafficLightPositionMock(...args),
  }));

  mock.module('../../utils/desktopPlatform', () => ({
    ...actualDesktopPlatform,
    getPlatformChromeState: () => chromeState,
  }));

  mock.module('../ui/Logo', () => ({
    Logo: () => <span data-testid="logo" />,
  }));

  mock.module('../modals/ProjectNavigator', () => ({
    ProjectNavigator: () => null,
  }));

  mock.module('../../services/globalProjects', () => ({
    getGlobalProjectById: () => ({ name: 'Macro Repo' }),
  }));
};

const loadHeader = async () => {
  registerHeaderMocks();
  importCounter += 1;
  return import(`./Header.tsx?test=${importCounter}`);
};

describe('Header', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    appState = {
      mode: 'Architect',
      setMode: () => undefined,
      openSettings: () => undefined,
      openAccount: () => undefined,
      uiZoomMode: 'auto',
      uiZoomLevel: 1,
      selectedGroupId: 'group-1',
      projectGroups: [],
    };
    tauriWindowState = {
      isAvailable: true,
      toggleMaximize: () => undefined,
      startDragging: () => undefined,
    };
    windowSetTrafficLightPositionMock = mock(() => Promise.resolve());
    windowResizeListeners = [];
    windowScaleChangedListeners = [];
    windowFocusChangedListeners = [];
    windowEventUnlistenCount = 0;
    windowFullscreenState = false;
    chromeState = {
      platform: 'windows',
      isTauriWindow: true,
      showCustomWindowControls: true,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    };
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it('uses the default centered layout on Windows', async () => {
    const { Header } = await loadHeader();
    const html = renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(html).toContain('--macro-titlebar-height:48px');
    expect(html).toContain('macro-topbar-inner');
    expect(html).toContain('macro-topbar-center');
    expect(html).toContain('macro-topbar-brand-label hidden lg:inline-flex');
    expect(html).toContain('title="Minimize"');
    expect(html).toContain('title="Maximize"');
    expect(html).toContain('title="Close"');
    expect(html).not.toContain('macro-native-titlebar');
  });

  it('uses a single native macOS top bar without custom window controls', async () => {
    const { Header } = await loadHeader();
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    const html = renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(html).toContain('--macro-titlebar-height:56px');
    expect(html).toContain('macro-topbar--native-macos');
    expect(html).toContain('macro-topbar-brand-label inline-flex');
    expect(html).not.toContain('title="Minimize"');
    expect(html).not.toContain('title="Maximize"');
    expect(html).not.toContain('title="Close"');
    expect(html).not.toContain('macro-native-titlebar');
  });

  it('keeps a single top bar contract across platforms', () => {
    expect(
      getTitleBarLayout({ platform: 'macos', usesNativeMacosTitlebar: true })
    ).toEqual({
      titleBarHeightPx: 56,
    });
    expect(
      getTitleBarLayout({ platform: 'windows', usesNativeMacosTitlebar: false })
    ).toEqual({
      titleBarHeightPx: 48,
    });
    expect(getMacosTrafficLightPosition(1)).toEqual({
      x: 15,
      y: 30,
    });
    expect(getMacosTrafficLightPosition(1.5)).toEqual({
      x: 23,
      y: 45,
    });
    expect(getMacosTrafficLightPosition(2)).toEqual({
      x: 30,
      y: 60,
    });
  });

  it('repositions native macOS traffic lights when ui zoom changes', async () => {
    const { Header } = await loadHeader();
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Header
          isLeftOpen
          isRightOpen
          onToggleLeft={() => undefined}
          onToggleRight={() => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).toHaveBeenCalledWith(15, 30);

    windowSetTrafficLightPositionMock.mockClear();
    appState = {
      ...appState,
      uiZoomMode: 'override',
      uiZoomLevel: 1.5,
    };

    await act(async () => {
      root?.render(
        <Header
          isLeftOpen
          isRightOpen
          onToggleLeft={() => undefined}
          onToggleRight={() => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).toHaveBeenCalledWith(23, 45);

    windowSetTrafficLightPositionMock.mockClear();
    appState = {
      ...appState,
      uiZoomMode: 'auto',
      uiZoomLevel: 1.5,
    };

    await act(async () => {
      root?.render(
        <Header
          isLeftOpen
          isRightOpen
          onToggleLeft={() => undefined}
          onToggleRight={() => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).toHaveBeenCalledWith(15, 30);
  });

  it('does not force native macOS traffic light reapply for ordinary unchanged window events', async () => {
    const { Header } = await loadHeader();
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Header
          isLeftOpen
          isRightOpen
          onToggleLeft={() => undefined}
          onToggleRight={() => undefined}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).toHaveBeenCalledWith(15, 30);
    expect(windowResizeListeners).toHaveLength(1);
    expect(windowScaleChangedListeners).toHaveLength(1);
    expect(windowFocusChangedListeners).toHaveLength(1);

    windowSetTrafficLightPositionMock.mockClear();

    await act(async () => {
      windowResizeListeners[0]?.();
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).not.toHaveBeenCalled();

    windowSetTrafficLightPositionMock.mockClear();

    await act(async () => {
      windowScaleChangedListeners[0]?.();
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).not.toHaveBeenCalled();

    windowSetTrafficLightPositionMock.mockClear();

    await act(async () => {
      windowFocusChangedListeners[0]?.(false);
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).not.toHaveBeenCalled();

    await act(async () => {
      windowFocusChangedListeners[0]?.(true);
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).not.toHaveBeenCalled();
  });

  it('skips traffic light reapply while fullscreen and reapplies once after leaving fullscreen', async () => {
    const { Header } = await loadHeader();
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Header
          isLeftOpen
          isRightOpen
          onToggleLeft={() => undefined}
          onToggleRight={() => undefined}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    windowSetTrafficLightPositionMock.mockClear();
    windowFullscreenState = true;

    await act(async () => {
      windowResizeListeners[0]?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).not.toHaveBeenCalled();

    windowFullscreenState = false;

    await act(async () => {
      windowResizeListeners[0]?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).toHaveBeenCalledWith(15, 30);
  });

  it('cleans up native macOS traffic light event listeners on unmount', async () => {
    const { Header } = await loadHeader();
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Header
          isLeftOpen
          isRightOpen
          onToggleLeft={() => undefined}
          onToggleRight={() => undefined}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(windowResizeListeners).toHaveLength(1);
    expect(windowScaleChangedListeners).toHaveLength(1);
    expect(windowFocusChangedListeners).toHaveLength(1);

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });

    root = null;
    expect(windowEventUnlistenCount).toBe(3);
    expect(windowResizeListeners).toHaveLength(0);
    expect(windowScaleChangedListeners).toHaveLength(0);
    expect(windowFocusChangedListeners).toHaveLength(0);
  });

  it('starts dragging on macOS title bar mouse down', async () => {
    const { resolveMacosTitlebarMouseAction } = await loadHeader();
    expect(
      resolveMacosTitlebarMouseAction({
        button: 0,
        clickCount: 1,
        isNoDragZone: false,
        isInteractiveElement: false,
      })
    ).toBe('start-dragging');
  });

  it('toggles maximize on macOS title bar double click', async () => {
    const { resolveMacosTitlebarMouseAction } = await loadHeader();
    expect(
      resolveMacosTitlebarMouseAction({
        button: 0,
        clickCount: 2,
        isNoDragZone: false,
        isInteractiveElement: false,
      })
    ).toBe('toggle-maximize');
  });

  it('keeps interactive macOS zones out of drag handling', async () => {
    const { resolveMacosTitlebarMouseAction } = await loadHeader();
    expect(
      resolveMacosTitlebarMouseAction({
        button: 0,
        clickCount: 1,
        isNoDragZone: true,
        isInteractiveElement: false,
      })
    ).toBe('none');
    expect(
      resolveMacosTitlebarMouseAction({
        button: 0,
        clickCount: 2,
        isNoDragZone: false,
        isInteractiveElement: true,
      })
    ).toBe('none');
  });
});
