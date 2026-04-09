import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../../i18n';
import { loadTranslation } from '../../i18n/resources';
import { ThemeProvider, defaultTheme } from '../theme/ThemeProvider';
import { useAppStore } from '../../stores/useAppStore';
import type { Theme } from '../../types/theme';
import { DiffMergeView, type MergeViewEditorHandle } from './DiffMergeView';

const initialAppStoreState = useAppStore.getState();
const initialLanguage = i18n.resolvedLanguage || i18n.language || 'en';
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

const renderWithTheme = (node: ReactNode) => (
  <ThemeProvider>{node}</ThemeProvider>
);

const ensureLanguage = async (language: 'en' | 'fr') => {
  if (!i18n.hasResourceBundle(language, 'translation')) {
    i18n.addResourceBundle(language, 'translation', await loadTranslation(language), true, true);
  }

  await i18n.changeLanguage(language);
};

describe('DiffMergeView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const flushRender = async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    await Promise.resolve();
  };

  beforeEach(async () => {
    await ensureLanguage('en');
    localStorage.clear();
    useAppStore.setState({ activeThemeId: 'macro-dark' });
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
    await ensureLanguage(initialLanguage === 'fr' ? 'fr' : 'en');
    container?.remove();
    localStorage.clear();
    useAppStore.setState(initialAppStoreState, true);
    globalThis.fetch = originalFetch;
    window.requestIdleCallback = originalRequestIdleCallback;
    window.cancelIdleCallback = originalCancelIdleCallback;
    root = null;
    container = null;
  });

  const requireHandle = (handle: MergeViewEditorHandle | null): MergeViewEditorHandle => {
    expect(handle).not.toBeNull();
    return handle as MergeViewEditorHandle;
  };

  it('renders merge view with two editors', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2\nline 3'}
            modified={'line 1\nmodified line 2\nline 3'}
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
    expect(container?.querySelectorAll('.cm-editor').length).toBeGreaterThanOrEqual(2);
  });

  it('renders diff highlights for changed lines and text', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2\nline 3'}
            modified={'line 1\nline 20\nline 3'}
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(2);
    expect(container?.querySelectorAll('.cm-changedText').length).toBeGreaterThan(0);
  });

  it('does not emit onChange during mount or external prop synchronization', async () => {
    let onChangeCalls = 0;
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'before();'}
            modified={'after();'}
            onChange={() => {
              onChangeCalls += 1;
            }}
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    expect(onChangeCalls).toBe(0);
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('after();');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'before();'}
            modified={'after();\nconsole.log("synced");'}
            onChange={() => {
              onChangeCalls += 1;
            }}
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    expect(onChangeCalls).toBe(0);
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('after();\nconsole.log("synced");');
  });

  it('recalculates diff chunks when props change after mount', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2'}
            modified={'line 1\nline 20'}
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(2);
    expect(container?.querySelectorAll('.cm-changedText').length).toBeGreaterThan(0);

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2'}
            modified={'line 1\nline 2'}
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(0);
    expect(container?.querySelectorAll('.cm-changedText').length).toBe(0);
    expect(requireHandle(latestHandle).a.state.doc.toString()).toBe('line 1\nline 2');
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('line 1\nline 2');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'alpha();'}
            modified={'beta();'}
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelectorAll('.cm-changedLine').length).toBe(2);
    expect(requireHandle(latestHandle).a.state.doc.toString()).toBe('alpha();');
    expect(requireHandle(latestHandle).b.state.doc.toString()).toBe('beta();');
  });

  it('handles empty content without errors', async () => {
    await act(async () => {
      root?.render(renderWithTheme(<DiffMergeView original="" modified="" />));
      await flushRender();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });

  it('renders revert controls when specified', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2'}
            modified={'line 1\nmodified line 2'}
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-merge-revert button')).not.toBeNull();
    expect(container?.querySelector('.cm-merge-revert .macro-diff-revert-icon')).not.toBeNull();
  });

  it('collapses unchanged sections in focused mode while keeping the central revert rail', async () => {
    const original = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 1;' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 2;' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-collapsedLines')).not.toBeNull();
    expect(container?.querySelector('.cm-merge-revert button')).not.toBeNull();
  });

  it('reconfigures the existing merge view when switching between focused and full presentation', async () => {
    const original = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 1;' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 2;' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const mergeRoot = container?.querySelector('.macro-diff-merge-root');
    expect(container?.querySelector('.cm-collapsedLines')).not.toBeNull();

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="full"
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('.macro-diff-merge-root')).toBe(mergeRoot);
    expect(container?.querySelector('.cm-collapsedLines')).toBeNull();
    expect(container?.querySelector('.cm-merge-revert button')).not.toBeNull();
  });

  it('uncollapses a focused hidden section when the native collapsed widget is clicked', async () => {
    const original = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 1;' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 2;' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const initialCollapsedCount = container?.querySelectorAll('.cm-collapsedLines').length ?? 0;
    const collapsed = container?.querySelector('.cm-collapsedLines') as HTMLElement | null;
    expect(collapsed).not.toBeNull();
    expect(initialCollapsedCount).toBeGreaterThan(0);

    await act(async () => {
      collapsed?.click();
      await flushRender();
    });

    const nextCollapsedCount = container?.querySelectorAll('.cm-collapsedLines').length ?? 0;
    expect(nextCollapsedCount).toBeLessThan(initialCollapsedCount);
  });

  it('rerenders the collapsed unchanged-lines label when the app language changes', async () => {
    const original = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 1;' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 2;' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const getCollapsedTexts = () =>
      Array.from(container?.querySelectorAll('.cm-collapsedLines') ?? []).map((element) =>
        element.textContent?.trim() ?? ''
      );

    expect(getCollapsedTexts().some((text) => text.includes('unchanged lines'))).toBe(true);

    await act(async () => {
      await ensureLanguage('fr');
      await flushRender();
    });

    expect(getCollapsedTexts().some((text) => text.includes('lignes inchangées'))).toBe(true);
    expect(getCollapsedTexts().some((text) => text.includes('unchanged lines'))).toBe(false);
  });

  it('adapts merge surfaces to the active light theme', async () => {
    useAppStore.setState({ activeThemeId: 'macro-light' });

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2'}
            modified={'line 1\nchanged line 2'}
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    const mergeRoot = container?.querySelector('.macro-diff-merge-root') as HTMLElement | null;
    const wrapper = container?.querySelector('[data-language]') as HTMLElement | null;

    expect(wrapper).not.toBeNull();
    expect(revertButton).not.toBeNull();
    expect(mergeRoot).not.toBeNull();
    expect(wrapper?.style.getPropertyValue('--macro-cm-editor-background')).toBe('#ffffff');
    expect(wrapper?.style.getPropertyValue('--macro-cm-gutter-background')).toBe('#f4f4f5');
    expect(wrapper?.style.getPropertyValue('--macro-cm-revert-button-background')).toBe('rgba(255, 255, 255, 0.980)');
    expect(document.head.textContent).toContain('.cm-gutters {min-height: 100%; padding-top: 0px; padding-bottom: 12px; background-color: #f4f4f5; color: #71717a;');
    expect(document.head.textContent).not.toContain('.cm-editor .cm-gutters');
  });

  it('keeps revert controls in the merge flow without manual scroll compensation', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2\nline 3'}
            modified={'line 1\nchanged line 2\nline 3'}
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const mergeRoot = container?.querySelector('.macro-diff-merge-root') as HTMLElement | null;
    expect(mergeRoot).not.toBeNull();
    const revertRail = container?.querySelector('.cm-merge-revert') as HTMLElement | null;
    expect(revertRail).not.toBeNull();
    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    expect(revertButton).not.toBeNull();
    expect(revertButton?.style.transform).toBe('');
    expect(parseFloat(getComputedStyle(revertRail as HTMLElement).width)).toBeGreaterThan(15);
    expect(parseFloat(getComputedStyle(revertRail as HTMLElement).width)).toBe(
      parseFloat(getComputedStyle(revertButton as HTMLButtonElement).width)
    );
    expect(getComputedStyle(revertButton as HTMLButtonElement).left).toBe('0px');
    expect(getComputedStyle(revertButton as HTMLButtonElement).borderRadius).toBe('6px');

    await act(async () => {
      if (mergeRoot) {
        mergeRoot.scrollTop = 96;
        mergeRoot.dispatchEvent(new Event('scroll'));
      }
      await flushRender();
    });

    expect(container?.querySelector('.cm-merge-revert button')).toBe(revertButton);
    expect(mergeRoot?.style.getPropertyValue('--macro-diff-revert-scroll-y')).toBe('');
  });

  it('repositions revert controls to the first wrapped visual line of the changed block', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'const value = "this is a very long string that stays the same until the wrapped changed token";'}
            modified={'const value = "this is a very long string that stays the same until the wrapped changed result";'}
            revertControls="a-to-b"
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    const handle = requireHandle(latestHandle);
    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    expect(revertButton).not.toBeNull();

    const originalLineBlockAt = handle.b.lineBlockAt.bind(handle.b);
    const originalCoordsAtPos = handle.b.coordsAtPos.bind(handle.b);
    const originalDocumentTop = Object.getOwnPropertyDescriptor(handle.b, 'documentTop');
    const changedText = Array.from(container?.querySelectorAll('.cm-changedText') ?? []).find((element) =>
      element.textContent?.includes('result')
    ) as HTMLElement | undefined;

    expect(changedText).not.toBeUndefined();
    const changedStartPos = handle.b.posAtDOM(changedText!.firstChild ?? changedText!, 0);

    handle.b.lineBlockAt = ((...args: Parameters<typeof handle.b.lineBlockAt>) => {
      const block = originalLineBlockAt(...args);
      return {
        ...block,
        top: 100,
      };
    }) as typeof handle.b.lineBlockAt;

    handle.b.coordsAtPos = ((pos: number, side?: -1 | 1) => {
      if (pos === changedStartPos) {
        return { top: 148, bottom: 172, left: 0, right: 0 } as ReturnType<typeof handle.b.coordsAtPos>;
      }

      return originalCoordsAtPos(pos, side);
    }) as typeof handle.b.coordsAtPos;

    Object.defineProperty(handle.b, 'documentTop', {
      configurable: true,
      get: () => 0,
    });

    await act(async () => {
      container!.style.width = '540px';
      window.dispatchEvent(new Event('resize'));
      await flushRender();
    });

    expect(revertButton?.style.top).toBe('148px');

    handle.b.lineBlockAt = originalLineBlockAt;
    handle.b.coordsAtPos = originalCoordsAtPos;
    if (originalDocumentTop) {
      Object.defineProperty(handle.b, 'documentTop', originalDocumentTop);
    }
  });

  it('recomputes revert control tops when width changes alter layout', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'before change'}
            modified={'after change'}
            revertControls="a-to-b"
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    const handle = requireHandle(latestHandle);
    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    expect(revertButton).not.toBeNull();

    let measuredTop = 132;

    handle.b.coordsAtPos = (() => {
      return { top: measuredTop, bottom: measuredTop + 24, left: 0, right: 0 } as ReturnType<typeof handle.b.coordsAtPos>;
    }) as typeof handle.b.coordsAtPos;

    await act(async () => {
      container!.style.width = '620px';
      window.dispatchEvent(new Event('resize'));
      await flushRender();
    });

    expect(revertButton?.style.top).toBe('132px');
  });

  it('keeps the revert control aligned when a collapsed block sits above the changed chunk', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;
    const original = Array.from({ length: 28 }, (_, index) =>
      index === 13 ? 'const value = "this chunk stays long until before the wrapped token";' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 28 }, (_, index) =>
      index === 13 ? 'const value = "this chunk stays long until before the wrapped result";' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    const handle = requireHandle(latestHandle);
    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    expect(revertButton).not.toBeNull();
    expect(container?.querySelector('.cm-collapsedLines')).not.toBeNull();

    const originalLineBlockAt = handle.b.lineBlockAt.bind(handle.b);
    const originalCoordsAtPos = handle.b.coordsAtPos.bind(handle.b);
    const changedText = Array.from(container?.querySelectorAll('.cm-changedText') ?? []).find((element) =>
      element.textContent?.includes('result')
    ) as HTMLElement | undefined;

    expect(changedText).not.toBeUndefined();
    const changedStartPos = handle.b.posAtDOM(changedText!.firstChild ?? changedText!, 0);

    handle.b.lineBlockAt = ((...args: Parameters<typeof handle.b.lineBlockAt>) => {
      const block = originalLineBlockAt(...args);
      return {
        ...block,
        top: 148,
      };
    }) as typeof handle.b.lineBlockAt;

    handle.b.coordsAtPos = ((pos: number, side?: -1 | 1) => {
      if (pos === changedStartPos) {
        return { top: 196, bottom: 220, left: 0, right: 0 } as ReturnType<typeof handle.b.coordsAtPos>;
      }

      return originalCoordsAtPos(pos, side);
    }) as typeof handle.b.coordsAtPos;

    await act(async () => {
      container!.style.width = '540px';
      window.dispatchEvent(new Event('resize'));
      await flushRender();
    });

    expect(revertButton?.style.top).toBe('196px');
  });

  it('keeps the revert control aligned when a collapsed block sits below the changed chunk', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;
    const original = Array.from({ length: 24 }, (_, index) =>
      index === 3 ? 'const message = "this line keeps going until before the wrapped token";' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 24 }, (_, index) =>
      index === 3 ? 'const message = "this line keeps going until before the wrapped result";' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    const handle = requireHandle(latestHandle);
    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    expect(revertButton).not.toBeNull();
    expect(container?.querySelector('.cm-collapsedLines')).not.toBeNull();

    const originalLineBlockAt = handle.b.lineBlockAt.bind(handle.b);
    const originalCoordsAtPos = handle.b.coordsAtPos.bind(handle.b);
    const changedText = Array.from(container?.querySelectorAll('.cm-changedText') ?? []).find((element) =>
      element.textContent?.includes('result')
    ) as HTMLElement | undefined;

    expect(changedText).not.toBeUndefined();
    const changedStartPos = handle.b.posAtDOM(changedText!.firstChild ?? changedText!, 0);

    handle.b.lineBlockAt = ((...args: Parameters<typeof handle.b.lineBlockAt>) => {
      const block = originalLineBlockAt(...args);
      return {
        ...block,
        top: 100,
      };
    }) as typeof handle.b.lineBlockAt;

    handle.b.coordsAtPos = ((pos: number, side?: -1 | 1) => {
      if (pos === changedStartPos) {
        return { top: 132, bottom: 156, left: 0, right: 0 } as ReturnType<typeof handle.b.coordsAtPos>;
      }

      return originalCoordsAtPos(pos, side);
    }) as typeof handle.b.coordsAtPos;

    await act(async () => {
      container!.style.width = '620px';
      window.dispatchEvent(new Event('resize'));
      await flushRender();
    });

    expect(revertButton?.style.top).toBe('132px');
  });

  it('recomputes revert control tops after expanding a collapsed widget', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;
    const original = Array.from({ length: 28 }, (_, index) =>
      index === 13 ? 'const value = "this chunk stays long until before the wrapped token";' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 28 }, (_, index) =>
      index === 13 ? 'const value = "this chunk stays long until before the wrapped result";' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    const handle = requireHandle(latestHandle);
    const revertButton = container?.querySelector('.cm-merge-revert button') as HTMLButtonElement | null;
    const collapsed = container?.querySelector('.cm-collapsedLines') as HTMLElement | null;
    expect(revertButton).not.toBeNull();
    expect(collapsed).not.toBeNull();

    const originalCoordsAtPos = handle.b.coordsAtPos.bind(handle.b);
    const changedText = Array.from(container?.querySelectorAll('.cm-changedText') ?? []).find((element) =>
      element.textContent?.includes('result')
    ) as HTMLElement | undefined;

    expect(changedText).not.toBeUndefined();
    const changedStartPos = handle.b.posAtDOM(changedText!.firstChild ?? changedText!, 0);
    let measuredTop = 132;

    handle.b.coordsAtPos = ((pos: number, side?: -1 | 1) => {
      if (pos === changedStartPos) {
        return { top: measuredTop, bottom: measuredTop + 24, left: 0, right: 0 } as ReturnType<typeof handle.b.coordsAtPos>;
      }

      return originalCoordsAtPos(pos, side);
    }) as typeof handle.b.coordsAtPos;

    await act(async () => {
      container!.style.width = '560px';
      window.dispatchEvent(new Event('resize'));
      await flushRender();
    });

    expect(revertButton?.style.top).toBe('132px');

    measuredTop = 184;

    await act(async () => {
      collapsed?.click();
      await flushRender();
    });

    expect(revertButton?.style.top).toBe('184px');
  });

  it('styles collapsed widgets without vertical margins so their measured height stays stable', async () => {
    const original = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 1;' : `line ${index + 1};`
    ).join('\n');
    const modified = Array.from({ length: 20 }, (_, index) =>
      index === 9 ? 'const value = 2;' : `line ${index + 1};`
    ).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={original}
            modified={modified}
            presentationMode="focused"
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const collapsed = container?.querySelector('.cm-collapsedLines') as HTMLElement | null;
    expect(collapsed).not.toBeNull();

    const collapsedStyles = getComputedStyle(collapsed as HTMLElement);
    expect(collapsedStyles.marginTop).toBe('0px');
    expect(collapsedStyles.marginBottom).toBe('0px');
    expect(collapsedStyles.minHeight).toBe('27px');
  });

  it('updates merge surfaces when the app theme changes', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'line 1\nline 2'}
            modified={'line 1\nchanged line 2'}
            revertControls="a-to-b"
          />
        )
      );
      await flushRender();
    });

    const getWrapper = () => container?.querySelector('[data-language]') as HTMLElement | null;

    expect(getWrapper()?.style.getPropertyValue('--macro-cm-editor-background')).toBe('#09090b');
    expect(getWrapper()?.style.getPropertyValue('--macro-cm-revert-button-background')).toBe('rgba(9, 9, 11, 0.960)');

    await act(async () => {
      useAppStore.getState().setTheme('macro-light');
      await flushRender();
    });

    expect(getWrapper()?.style.getPropertyValue('--macro-cm-editor-background')).toBe('#ffffff');
    expect(getWrapper()?.style.getPropertyValue('--macro-cm-revert-button-background')).toBe('rgba(255, 255, 255, 0.980)');
  });

  it('applies language extension for typescript', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'const x: number = 1;'}
            modified={'const x: number = 2;'}
            language="typescript"
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('[data-language="typescript"]')).not.toBeNull();
  });

  it('falls back to text for unsupported languages', async () => {
    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'hello'}
            modified={'hello world'}
            language="python"
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('[data-language="text"]')).not.toBeNull();
  });

  it('renders the right editor as truly read-only when editable is false', async () => {
    let latestHandle: MergeViewEditorHandle | null = null;

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={'legacy();'}
            modified={'legacy();'}
            editable={false}
            onEditorReady={(handle) => {
              latestHandle = handle;
            }}
          />
        )
      );
      await flushRender();
    });

    expect(requireHandle(latestHandle).b.contentDOM.getAttribute('contenteditable')).toBe('false');
  });

  it('handles large content without crashing', async () => {
    const largeOriginal = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
    const largeModified = Array.from({ length: 100 }, (_, index) => `modified line ${index + 1}`).join('\n');

    await act(async () => {
      root?.render(
        renderWithTheme(
          <DiffMergeView
            original={largeOriginal}
            modified={largeModified}
          />
        )
      );
      await flushRender();
    });

    expect(container?.querySelector('.cm-mergeView')).not.toBeNull();
  });
});
