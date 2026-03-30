import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getTitleBarLayout,
} from './titleBarLayout';

type AppMode = 'Chat' | 'Architect' | 'Implement' | 'Debug';

type AppStoreState = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  openSettings: () => void;
  openAccount: () => void;
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
let chromeState: {
  platform: 'macos' | 'windows' | 'linux' | 'web';
  isTauriWindow: boolean;
  showCustomWindowControls: boolean;
  disableCustomDoubleClickZoom: boolean;
  usesNativeMacosTitlebar: boolean;
};

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & { getState: () => T };

  hook.getState = getSnapshot;
  return hook;
};

const useAppStore = createStoreHook(() => appState);

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

mock.module('../../i18n', () => ({
  default: {
    t: (_key: string, fallback: string) => fallback,
  },
}));

mock.module('../../stores/useAppStore', () => ({
  useAppStore,
}));

mock.module('../../hooks/useTauriWindow', () => ({
  useTauriWindow: () => tauriWindowState,
}));

mock.module('../../utils/desktopPlatform', () => ({
  getPlatformChromeState: () => chromeState,
}));

mock.module('../ui/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
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

const {
  Header,
  resolveMacosTitlebarMouseAction,
} = await import('./Header');

describe('Header', () => {
  beforeEach(() => {
    appState = {
      mode: 'Architect',
      setMode: () => undefined,
      openSettings: () => undefined,
      openAccount: () => undefined,
      selectedGroupId: 'group-1',
      projectGroups: [],
    };
    tauriWindowState = {
      isAvailable: true,
      toggleMaximize: () => undefined,
      startDragging: () => undefined,
    };
    chromeState = {
      platform: 'windows',
      isTauriWindow: true,
      showCustomWindowControls: true,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    };
  });

  it('uses the default centered layout on Windows', () => {
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
    expect(html).toContain('macro-topbar-brand-label hidden lg:block');
    expect(html).toContain('data-icon="minus"');
    expect(html).toContain('data-icon="maximize"');
    expect(html).toContain('data-icon="x"');
    expect(html).not.toContain('macro-native-titlebar');
  });

  it('uses a single native macOS top bar without custom window controls', () => {
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
    expect(html).toContain('macro-topbar-brand-label block');
    expect(html).not.toContain('data-icon="minus"');
    expect(html).not.toContain('data-icon="maximize"');
    expect(html).not.toContain('data-icon="x"');
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
  });

  it('starts dragging on macOS title bar mouse down', () => {
    expect(
      resolveMacosTitlebarMouseAction({
        button: 0,
        clickCount: 1,
        isNoDragZone: false,
        isInteractiveElement: false,
      })
    ).toBe('start-dragging');
  });

  it('toggles maximize on macOS title bar double click', () => {
    expect(
      resolveMacosTitlebarMouseAction({
        button: 0,
        clickCount: 2,
        isNoDragZone: false,
        isInteractiveElement: false,
      })
    ).toBe('toggle-maximize');
  });

  it('keeps interactive macOS zones out of drag handling', () => {
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
