import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Theme } from '../../types/theme';
import type { TerminalTab } from '../../stores/useTerminalStore';
import type { TerminalViewport as TerminalViewportComponent } from './TerminalViewport';

const macroDarkTheme: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090b',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#09090b',
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

const macroLightTheme: Theme = {
  ...macroDarkTheme,
  name: 'Macro Light',
  type: 'light',
  colors: {
    ...macroDarkTheme.colors,
    background: '#ffffff',
    foreground: '#09090b',
    primary: '#4f46e5',
    ring: '#4f46e5',
  },
};

const buildTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'terminal-tab-1',
  kind: 'manual',
  taskId: 'task-1',
  projectId: 'project-1',
  projectName: 'Web',
  mountName: 'web',
  workspacePath: '/repo/web',
  cwd: '/repo/web',
  title: 'Terminal - Web',
  status: 'idle',
  snapshot: 'npm test\r\n',
  lastCommand: null,
  lastExitCode: null,
  hasLiveSession: true,
  isRestored: false,
  outputSequence: 0,
  hasUnreadOutput: false,
  createdAt: '2026-05-08T10:00:00.000Z',
  updatedAt: '2026-05-08T10:00:00.000Z',
  ...overrides,
});

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
};

let activeTheme: Theme = macroDarkTheme;
let TerminalViewport!: typeof TerminalViewportComponent;
let attachTabMock: ReturnType<typeof mock>;
let syncTabMock: ReturnType<typeof mock>;
let detachTabMock: ReturnType<typeof mock>;
let focusTabMock: ReturnType<typeof mock>;
let resizeTabMock: ReturnType<typeof mock>;
let importCounter = 0;

const loadTerminalViewport = async () => {
  importCounter += 1;
  attachTabMock = mock(() => undefined);
  syncTabMock = mock(() => undefined);
  detachTabMock = mock(() => undefined);
  focusTabMock = mock(() => undefined);
  resizeTabMock = mock(() => undefined);

  mock.module('../../services/terminalRuntime', () => ({
    default: {
      attachTab: attachTabMock,
      syncTab: syncTabMock,
      detachTab: detachTabMock,
      focusTab: focusTabMock,
      resizeTab: resizeTabMock,
    },
  }));
  mock.module('../theme/ThemeProvider', () => ({
    useOptionalTheme: () => ({
      theme: activeTheme,
      isDark: activeTheme.type === 'dark',
      isLoading: false,
    }),
  }));

  ({ TerminalViewport } = await import(
    `./TerminalViewport.tsx?terminal-viewport-test=${importCounter}`
  ));
};

describe('TerminalViewport', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    mock.restore();
    activeTheme = macroDarkTheme;
    await loadTerminalViewport();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    mock.restore();
    root = null;
    container = null;
  });

  it('passes the active theme to terminal runtime on attach and sync', async () => {
    await act(async () => {
      root?.render(
        <TerminalViewport tab={buildTab()} onInput={() => undefined} onResize={() => undefined} />
      );
      await flushRender();
    });

    expect(attachTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'terminal-tab-1',
        theme: macroDarkTheme,
      })
    );
    expect(syncTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'terminal-tab-1',
        theme: macroDarkTheme,
      })
    );
    expect(container?.querySelector('.macro-terminal-shell')).not.toBeNull();
  });

  it('syncs a new theme without detaching the terminal tab', async () => {
    const tab = buildTab();
    await act(async () => {
      root?.render(<TerminalViewport tab={tab} onInput={() => undefined} onResize={() => undefined} />);
      await flushRender();
    });
    syncTabMock.mockClear();
    detachTabMock.mockClear();
    activeTheme = macroLightTheme;

    await act(async () => {
      root?.render(<TerminalViewport tab={tab} onInput={() => undefined} onResize={() => undefined} />);
      await flushRender();
    });

    expect(syncTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'terminal-tab-1',
        theme: macroLightTheme,
      })
    );
    expect(detachTabMock).not.toHaveBeenCalled();
  });
});
