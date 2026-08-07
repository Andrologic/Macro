import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type AppStoreState = {
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  leftPanelWidth: number;
  rightPanelWidth: number;
  setLeftPanelWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  metadataRecoveryReport: null;
};

type AppBootstrapSnapshot = {
  phase: 'idle' | 'critical' | 'resuming' | 'ready' | 'error';
  critical: boolean;
  high: boolean;
  normal: boolean;
  low: boolean;
  ready: boolean;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  startupError: {
    message: string;
    failedSteps: string[];
    details?: string;
  } | null;
};

let appState: AppStoreState;
let appBootstrapSnapshot: AppBootstrapSnapshot;
let importCounter = 0;
const actualDesktopPlatform = await import('./utils/desktopPlatform');
const actualAppBootstrap = await import('./services/appBootstrap');

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

const registerAppMocks = () => {
  mock.restore();

  mock.module('./hooks/useWindowRestoration', () => ({
    useWindowRestoration: () => undefined,
  }));

  mock.module('./hooks/useUiZoom', () => ({
    useUiZoom: () => undefined,
  }));

  mock.module('./hooks/useGlobalShortcuts', () => ({
    useGlobalShortcuts: () => undefined,
  }));

  mock.module('./stores/useAppStore', () => ({
    useAppStore,
  }));

  mock.module('./components/layout/Header', () => ({
    Header: () => <header data-testid="mock-header" />,
  }));

  mock.module('./components/ui/Toaster', () => ({
    Toaster: () => <div data-testid="mock-toaster" />,
  }));

  mock.module('./components/layout/PanelResizer', () => ({
    PanelResizer: () => <div data-testid="mock-resizer" />,
  }));

  mock.module('./components/layout/ModeRouter', () => ({
    ModeRouter: ({ panel }: { panel: 'left' | 'center' | 'right' }) => (
      <section data-testid={`panel-${panel}`} />
    ),
  }));

  mock.module('./components/shared/Skeleton', () => ({
    Skeleton: ({ className }: { className?: string }) => (
      <div className={className} data-testid="mock-skeleton" />
    ),
  }));

  mock.module('./utils/desktopPlatform', () => ({
    ...actualDesktopPlatform,
    getPlatformChromeState: () => ({
      platform: 'windows',
      isTauriWindow: false,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    }),
  }));

  mock.module('./services/appBootstrap', () => ({
    ...actualAppBootstrap,
    appBootstrap: {
      getSnapshot: () => appBootstrapSnapshot,
      subscribe: () => () => undefined,
      ensureStarted: () => Promise.resolve(),
      restart: () => Promise.resolve(),
    },
  }));

  mock.module('./components/modals/DiffModal', () => ({
    default: () => null,
  }));

  mock.module('./components/settings/SettingsModal', () => ({
    default: () => null,
  }));

  mock.module('./components/modals/AccountModal', () => ({
    default: () => null,
  }));

  mock.module('./components/modals/ProjectModal', () => ({
    default: () => null,
  }));

  mock.module('./components/modals/ProjectGitFlowModal', () => ({
    default: () => null,
  }));

  mock.module('./components/modals/CodeFileViewerModal', () => ({
    default: () => null,
  }));

  mock.module('./components/layout/Footer', () => ({
    Footer: () => <footer data-testid="mock-footer" />,
  }));
};

const loadApp = async () => {
  registerAppMocks();
  importCounter += 1;
  return import(`./App.tsx?test=${importCounter}`);
};

describe('App layout containment', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    appState = {
      isLeftPanelOpen: true,
      isRightPanelOpen: true,
      setLeftPanelOpen: () => undefined,
      setRightPanelOpen: () => undefined,
      leftPanelWidth: 320,
      rightPanelWidth: 360,
      setLeftPanelWidth: () => undefined,
      setRightPanelWidth: () => undefined,
      metadataRecoveryReport: null,
    };

    appBootstrapSnapshot = {
      phase: 'ready',
      critical: true,
      high: true,
      normal: true,
      low: true,
      ready: true,
      errors: {},
      warnings: {},
      startupError: null,
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
    mock.restore();
  });

  it('renders the app shell and primary wrappers with overflow confinement classes', async () => {
    const { default: App } = await loadApp();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const shell = container.querySelector('.macro-app-shell') as HTMLDivElement | null;
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain('h-full');
    expect(shell?.className).toContain('w-full');
    expect(shell?.className).toContain('min-h-0');
    expect(shell?.className).toContain('min-w-0');
    expect(shell?.className).toContain('overflow-hidden');
    expect(shell?.className).not.toContain('h-screen');
    expect(shell?.className).not.toContain('w-screen');

    const mainContentWrapper = shell?.children.item(1) as HTMLDivElement | null;
    expect(mainContentWrapper).not.toBeNull();
    expect(mainContentWrapper?.className).toContain('h-full');
    expect(mainContentWrapper?.className).toContain('min-h-0');
    expect(mainContentWrapper?.className).toContain('min-w-0');
    expect(mainContentWrapper?.className).toContain('overflow-hidden');

    const leftPanelWrapper = container.querySelector('[data-testid="panel-left"]')?.parentElement;
    const centerPanelWrapper = container.querySelector('[data-testid="panel-center"]')?.parentElement;
    const rightPanelWrapper = container.querySelector('[data-testid="panel-right"]')?.parentElement;

    expect(leftPanelWrapper?.className).toContain('min-h-0');
    expect(leftPanelWrapper?.className).toContain('overflow-hidden');
    expect(centerPanelWrapper?.className).toContain('min-h-0');
    expect(centerPanelWrapper?.className).toContain('overflow-hidden');
    expect(rightPanelWrapper?.className).toContain('min-h-0');
    expect(rightPanelWrapper?.className).toContain('overflow-hidden');
  });

  it('renders startup chrome while critical boot is pending', async () => {
    appBootstrapSnapshot = {
      ...appBootstrapSnapshot,
      phase: 'critical',
      critical: false,
      ready: false,
    };
    const { default: App } = await loadApp();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.macro-app-shell')).toBeNull();
    expect(container.querySelectorAll('[data-testid="mock-skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders a startup error instead of an infinite loader', async () => {
    appBootstrapSnapshot = {
      ...appBootstrapSnapshot,
      phase: 'error',
      critical: false,
      ready: false,
      startupError: {
        message: 'Critical bootstrap failed.',
        failedSteps: ['App Critical'],
        details: 'boom',
      },
    };
    const { default: App } = await loadApp();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Macro could not finish booting.');
    expect(container.textContent).toContain(
      'Macro could not initialize its local data. You can retry safely.'
    );
    expect(container.textContent).not.toContain('Critical bootstrap failed.');
    expect(container.textContent).not.toContain('App Critical');
  });
});
