import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Theme } from '../../types/theme';
import type { ThemeProvider as ThemeProviderComponent } from '../theme/ThemeProvider';
import type { useAppStore as UseAppStoreHook } from '../../stores/useAppStore';
import type CodeMirrorEditorComponent from './CodeMirrorEditor';

const originalFetch = globalThis.fetch;
const originalRequestIdleCallback = window.requestIdleCallback;
const originalCancelIdleCallback = window.cancelIdleCallback;

const macroLightTheme: Theme = {
  name: 'Macro Light',
  type: 'light',
  colors: {
    background: '#ffffff',
    foreground: '#09090b',
    card: '#ffffff',
    cardForeground: '#09090b',
    popover: '#ffffff',
    popoverForeground: '#09090b',
    primary: '#4f46e5',
    primaryForeground: '#fafafa',
    secondary: '#f4f4f5',
    secondaryForeground: '#18181b',
    muted: '#f4f4f5',
    mutedForeground: '#71717a',
    accent: '#f4f4f5',
    accentForeground: '#18181b',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: '#e4e4e7',
    input: '#e4e4e7',
    ring: '#4f46e5',
  },
};

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const installThemeFetchMock = (themes: Record<string, Theme>) => {
  const manifest = {
    themes: Object.entries(themes).map(([id, theme]) => ({
      id,
      name: theme.name,
      path: `/themes/${id}.json`,
      type: theme.type,
    })),
  };

  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const normalizedUrl = String(url);
    if (normalizedUrl.endsWith('/themes/manifest.json')) {
      return jsonResponse(manifest);
    }

    const themeEntry = Object.entries(themes).find(([id]) => normalizedUrl.endsWith(`/themes/${id}.json`));
    if (themeEntry) {
      return jsonResponse(themeEntry[1]);
    }

    throw new Error(`Unexpected fetch URL in test: ${normalizedUrl}`);
  }) as unknown as typeof fetch;
};

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

let importCounter = 0;
let initialAppStoreState: ReturnType<(typeof import('../../stores/useAppStore'))['useAppStore']['getState']> | null = null;
let ThemeProvider!: typeof ThemeProviderComponent;
let defaultTheme!: Theme;
let CodeMirrorEditor!: typeof CodeMirrorEditorComponent;
let useAppStore!: typeof UseAppStoreHook;

const loadCodeMirrorModules = async () => {
  importCounter += 1;
  const appStoreModule = await import(
    `../../stores/useAppStore.ts?code-mirror-editor-store-test=${importCounter}`
  );

  mock.module('../../stores/useAppStore', () => ({
    ...appStoreModule,
  }));

  const themeProviderModule = await import(
    `../theme/ThemeProvider.tsx?code-mirror-editor-theme-test=${importCounter}`
  );

  mock.module('../theme/ThemeProvider', () => ({
    ...themeProviderModule,
  }));

  ({ ThemeProvider, defaultTheme } = themeProviderModule);
  ({ default: CodeMirrorEditor } = await import(
    `./CodeMirrorEditor.tsx?code-mirror-editor-test=${importCounter}`
  ));
  useAppStore = appStoreModule.useAppStore;
  initialAppStoreState = useAppStore.getState();
};

describe('CodeMirrorEditor diff highlights', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    await loadCodeMirrorModules();
    localStorage.clear();
    if (initialAppStoreState) {
      useAppStore.setState(initialAppStoreState, true);
    }
    useAppStore.setState({
      ...useAppStore.getState(),
      activeThemeId: 'macro-dark',
      codeOverflowMode: 'wrap',
    });
    installThemeFetchMock({
      'macro-dark': defaultTheme,
      'macro-light': macroLightTheme,
    });

    window.requestIdleCallback = ((callback: IdleRequestCallback) =>
      window.setTimeout(() => callback({
        didTimeout: false,
        timeRemaining: () => 1,
      } as IdleDeadline), 0)) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = ((id: number) => window.clearTimeout(id)) as typeof window.cancelIdleCallback;

    container = document.createElement('div');
    container.style.height = '320px';
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    localStorage.clear();
    if (initialAppStoreState) {
      useAppStore.setState(initialAppStoreState, true);
    }
    globalThis.fetch = originalFetch;
    window.requestIdleCallback = originalRequestIdleCallback;
    window.cancelIdleCallback = originalCancelIdleCallback;
    mock.restore();
    root = null;
    container = null;
  });

  it('renders line and gutter classes for provided highlights', async () => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor
            code={'line 1\nline 2\nline 3'}
            lineHighlights={[
              {
                lineNumber: 2,
                className: 'cm-diff-added',
              },
            ]}
          />
        </ThemeProvider>
      );
      await flushRender();
    });

    const lineEl = container?.querySelector('.cm-line.cm-diff-added');
    expect(lineEl).not.toBeNull();
  });

  it('renders multiple different highlight types correctly', async () => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor
            code={'line 1\nline 2\nline 3\nline 4\nline 5'}
            lineHighlights={[
              { lineNumber: 1, className: 'cm-diff-removed' },
              { lineNumber: 3, className: 'cm-diff-added' },
              { lineNumber: 5, className: 'cm-diff-modified-right' },
            ]}
          />
        </ThemeProvider>
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-line.cm-diff-removed')).not.toBeNull();
    expect(container?.querySelector('.cm-line.cm-diff-added')).not.toBeNull();
    expect(container?.querySelector('.cm-line.cm-diff-modified-right')).not.toBeNull();
  });

  it('line highlights are preserved after code content update', async () => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor
            code={'line 1\nline 2\nline 3'}
            lineHighlights={[
              { lineNumber: 2, className: 'cm-diff-added' },
            ]}
            onChange={() => {}}
          />
        </ThemeProvider>
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-line.cm-diff-added')).not.toBeNull();
  });

  it('handles empty highlights array without errors', async () => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor
            code={'line 1\nline 2\nline 3'}
            lineHighlights={[]}
          />
        </ThemeProvider>
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-editor')).not.toBeNull();
    expect(container?.querySelectorAll('.cm-diff-added').length).toBe(0);
  });

  it('adapts editor surfaces to the active light theme', async () => {
    useAppStore.setState({ activeThemeId: 'macro-light' });

    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor code={'const value = 1;'} />
        </ThemeProvider>
      );
      await flushRender();
    });

    const wrapper = container?.firstElementChild as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.getPropertyValue('--macro-cm-editor-background')).toBe('#ffffff');
    expect(wrapper?.style.getPropertyValue('--macro-cm-editor-foreground')).toBe('#09090b');
    expect(wrapper?.style.getPropertyValue('--macro-cm-gutter-background')).toBe('#f4f4f5');
    expect(document.head.textContent).toContain('padding: 8px 0px 12px 0;');
    expect(document.head.textContent).toContain('.cm-gutters {min-height: 100%; padding-top: 0px; padding-bottom: 12px; background-color: #f4f4f5; color: #71717a;');
    expect(document.head.textContent).not.toContain('.cm-editor .cm-gutters');
  });

  it('updates editor surfaces when the app theme changes', async () => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor code={'const value = 1;'} />
        </ThemeProvider>
      );
      await flushRender();
    });

    const getWrapper = () => container?.firstElementChild as HTMLElement | null;

    expect(getWrapper()?.style.getPropertyValue('--macro-cm-editor-background')).toBe('#09090b');

    await act(async () => {
      useAppStore.getState().setTheme('macro-light');
      await flushRender();
    });

    expect(getWrapper()?.style.getPropertyValue('--macro-cm-editor-background')).toBe('#ffffff');
    expect(getWrapper()?.style.getPropertyValue('--macro-cm-editor-foreground')).toBe('#09090b');
  });

  it('uses the global overflow mode when no prop override is provided', async () => {
    useAppStore.setState({ codeOverflowMode: 'horizontal_scroll' });

    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor code={'const value = "a very long line that should keep scrolling horizontally";'} />
        </ThemeProvider>
      );
      await flushRender();
    });

    const wrapper = container?.querySelector('[data-overflow-mode]') as HTMLElement | null;
    expect(wrapper?.dataset.overflowMode).toBe('horizontal_scroll');
    expect(container?.querySelector('.cm-lineWrapping')).toBeNull();
  });

  it('allows an explicit overflow mode prop to override the global preference', async () => {
    useAppStore.setState({ codeOverflowMode: 'horizontal_scroll' });

    await act(async () => {
      root?.render(
        <ThemeProvider>
          <CodeMirrorEditor
            code={'const value = "a very long line that should wrap when the prop says so";'}
            overflowMode="wrap"
          />
        </ThemeProvider>
      );
      await flushRender();
    });

    const wrapper = container?.querySelector('[data-overflow-mode]') as HTMLElement | null;
    expect(wrapper?.dataset.overflowMode).toBe('wrap');
    expect(container?.querySelector('.cm-lineWrapping')).not.toBeNull();
  });
});
