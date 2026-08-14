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
  uiZoomMode: 'auto' | 'override';
  uiZoomLevel: number;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  projectGroups: unknown[];
  getProjectById: (projectId: string) =>
    | {
        id: string;
        name: string;
        gitSetupState?: 'ready' | 'not_git' | 'unborn';
        readOnlyReason?: 'manual' | 'missing_git' | 'missing_initial_commit' | 'manual_and_missing_git' | null;
      }
    | undefined;
};

type TauriWindowState = {
  isAvailable: boolean;
  toggleMaximize: () => void;
  startDragging: () => void;
};

let appState: AppStoreState;
let tauriWindowState: TauriWindowState;
let windowSetTrafficLightPositionMock: ReturnType<typeof mock>;
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
    windowSetTrafficLightPosition: (...args: [number, number]) =>
      windowSetTrafficLightPositionMock(...args),
  }));
  mock.module('../../services/tauriWindow.ts', () => ({
    ...actualTauriWindow,
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
    getGlobalProjectById: (_groups: unknown[], groupId: string | null | undefined) =>
      groupId ? { name: 'Macro Repo' } : null,
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
      uiZoomMode: 'auto',
      uiZoomLevel: 1,
      selectedGroupId: 'group-1',
      selectedProjectId: null,
      projectGroups: [],
      getProjectById: () => undefined,
    };
    tauriWindowState = {
      isAvailable: true,
      toggleMaximize: () => undefined,
      startDragging: () => undefined,
    };
    windowSetTrafficLightPositionMock = mock(() => Promise.resolve());
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

  it('only exposes the left-panel toggle when the current mode has that slot', async () => {
    const { Header } = await loadHeader();
    const render = () => renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(render()).toContain('data-tour-id="toggle-left-panel"');
    appState.mode = 'Chat';
    expect(render()).toContain('data-tour-id="toggle-left-panel"');
    appState.mode = 'Implement';
    expect(render()).toContain('data-tour-id="toggle-left-panel"');
  });

  it('hides the project picker in Implement mode', async () => {
    const { Header } = await loadHeader();
    const render = () => renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(render()).toContain('data-tour-id="project-picker"');
    appState.mode = 'Implement';
    expect(render()).not.toContain('data-tour-id="project-picker"');
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

  it('leaves fullscreen traffic light recovery to the native macOS layer', async () => {
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

    windowSetTrafficLightPositionMock.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await Promise.resolve();
    });

    expect(windowSetTrafficLightPositionMock).not.toHaveBeenCalled();
  });

  it('shows the selected standalone project name in the project picker', async () => {
    const { Header } = await loadHeader();
    appState = {
      ...appState,
      mode: 'Architect',
      selectedGroupId: null,
      selectedProjectId: 'project-solo',
      getProjectById: (projectId) =>
        projectId === 'project-solo' ? { id: projectId, name: 'Solo Project' } : undefined,
    };

    const html = renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(html).toContain('Solo Project');
    expect(html).not.toContain('header.selectProject');
  });

  it('uses the group icon for a selected group in the project picker', async () => {
    const { Header } = await loadHeader();
    appState.mode = 'Architect';

    const html = renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(html).toContain('Macro Repo');
    expect(html).toContain('lucide-layers');
  });

  it('uses the git folder icon for a selected standalone git project in the project picker', async () => {
    const { Header } = await loadHeader();
    appState = {
      ...appState,
      mode: 'Architect',
      selectedGroupId: null,
      selectedProjectId: 'project-solo',
      getProjectById: (projectId) =>
        projectId === 'project-solo'
          ? {
              id: projectId,
              name: 'Solo Git Project',
              gitSetupState: 'ready',
              readOnlyReason: null,
            }
          : undefined,
    };

    const html = renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(html).toContain('Solo Git Project');
    expect(html).toContain('lucide-folder-git-2');
  });

  it('uses the plain folder icon for a selected standalone non-git project in the project picker', async () => {
    const { Header } = await loadHeader();
    appState = {
      ...appState,
      mode: 'Architect',
      selectedGroupId: null,
      selectedProjectId: 'project-folder',
      getProjectById: (projectId) =>
        projectId === 'project-folder'
          ? {
              id: projectId,
              name: 'Folder Project',
              gitSetupState: 'not_git',
              readOnlyReason: null,
            }
          : undefined,
    };

    const html = renderToStaticMarkup(
      <Header
        isLeftOpen
        isRightOpen
        onToggleLeft={() => undefined}
        onToggleRight={() => undefined}
      />
    );

    expect(html).toContain('Folder Project');
    expect(html).toContain('lucide-folder');
    expect(html).not.toContain('lucide-folder-git-2');
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
