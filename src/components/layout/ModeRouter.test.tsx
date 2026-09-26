import { afterEach, describe, expect, it, mock } from 'bun:test';
import React, { useLayoutEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AsyncPanel } from './ModeRouter';
import {
  createModePanelLoader,
  hasModePanel,
  modePanelLoaders,
  type ModePanelLoader,
} from './modePanelLoaders';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ModeRouter AsyncPanel', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  const renderPanel = (element: React.ReactNode) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  };

  it('shows the fallback while loading and renders the loaded panel', async () => {
    let resolveLoader: ((component: React.ComponentType) => void) | null = null;
    const loader = createModePanelLoader({
      id: 'test:center:slow',
      label: 'Slow panel',
      mode: 'Chat',
      panel: 'center',
      importComponent: () =>
        new Promise((resolve) => {
          resolveLoader = resolve;
        }),
    });

    const target = renderPanel(
      <AsyncPanel loader={loader} fallback={<div>Loading panel</div>} />,
    );

    expect(target.textContent).toContain('Loading panel');

    await act(async () => {
      resolveLoader?.(() => <div>Loaded panel</div>);
      await flushPromises();
    });

    expect(target.textContent).toContain('Loaded panel');
  });

  it('never commits the previous panel when switching loaders before passive effects', async () => {
    const deferred = () => {
      let resolve!: (component: React.ComponentType) => void;
      const promise = new Promise<React.ComponentType>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const makeLoader = (pending: ReturnType<typeof deferred>) => createModePanelLoader({
      // Deliberately equal metadata: the loader object owns the component.
      id: 'test:center:panel', label: 'Panel', mode: 'Chat', panel: 'center',
      importComponent: () => pending.promise,
    });
    const loaderA = makeLoader(a);
    const loaderB = makeLoader(b);
    const loaderC = makeLoader(c);
    const commits: string[] = [];
    const Observe = ({ loader }: { loader: ModePanelLoader }) => {
      useLayoutEffect(() => { commits.push(container?.textContent ?? ''); });
      return <AsyncPanel loader={loader} fallback={<div>Loading panel</div>} />;
    };
    const target = renderPanel(<Observe loader={loaderA} />);
    await act(async () => { a.resolve(() => <div>Panel A</div>); await flushPromises(); });
    expect(target.textContent).toBe('Panel A');

    act(() => { root?.render(<Observe loader={loaderB} />); });
    expect(commits.at(-1)).toBe('Loading panel');
    expect(target.textContent).toBe('Loading panel');
    act(() => { root?.render(<Observe loader={loaderC} />); });
    await act(async () => { c.resolve(() => <div>Panel C</div>); await flushPromises(); });
    expect(target.textContent).toBe('Panel C');
    await act(async () => { b.resolve(() => <div>Panel B</div>); await flushPromises(); });
    expect(target.textContent).toBe('Panel C');

    // The obsolete subscription was cancelled, but its loader still populated its cache.
    act(() => { root?.render(<Observe loader={loaderB} />); });
    expect(commits.at(-1)).not.toBe('Panel C');
    expect(target.textContent).toBe('Panel B');
  });

  it('preserves the mounted panel and deduplicates loading when the loader is shared', async () => {
    let mounts = 0;
    const SharedPanel = () => {
      useLayoutEffect(() => { mounts += 1; }, []);
      return <div>Shared panel</div>;
    };
    const importComponent = mock(async () => SharedPanel);
    const loader = createModePanelLoader({
      id: 'shared', label: 'Shared panel', mode: 'Chat', panel: 'center', importComponent,
    });
    const preload = loader.load();
    expect(loader.load()).toBe(preload);
    const target = renderPanel(<AsyncPanel loader={loader} fallback="Loading" />);
    await act(async () => { await preload; await flushPromises(); });
    act(() => { root?.render(<AsyncPanel loader={loader} fallback="Other fallback" />); });
    expect(target.textContent).toBe('Shared panel');
    expect(mounts).toBe(1);
    expect(importComponent).toHaveBeenCalledTimes(1);
    expect(await loader.load()).toBe(SharedPanel);
    expect(importComponent).toHaveBeenCalledTimes(1);
  });

  it('ignores an obsolete rejection and retries only the current loader', async () => {
    let rejectOld!: (error: Error) => void;
    const oldLoader = createModePanelLoader({
      id: 'old', label: 'Old panel', mode: 'Chat', panel: 'center',
      importComponent: () => new Promise((_, reject) => { rejectOld = reject; }),
    });
    let attempts = 0;
    const currentLoader = createModePanelLoader({
      id: 'current', label: 'Current panel', mode: 'Chat', panel: 'center',
      importComponent: async () => {
        if (++attempts === 1) throw new Error('current failure');
        return () => <div>Recovered current panel</div>;
      },
    });
    const consoleError = console.error;
    const errors = mock(() => undefined);
    console.error = errors;
    try {
      const target = renderPanel(<AsyncPanel loader={oldLoader} fallback="Loading" />);
      await act(async () => {
        root?.render(<AsyncPanel loader={currentLoader} fallback="Loading" />);
        await flushPromises();
      });
      expect(target.textContent).toContain('Current panel could not load.');
      await act(async () => { rejectOld(new Error('obsolete failure')); await flushPromises(); });
      expect(target.textContent).toContain('current failure');
      expect(target.textContent).not.toContain('obsolete failure');
      expect(errors).toHaveBeenCalledTimes(1);
      const retry = Array.from(target.querySelectorAll('button')).find(button => button.textContent?.includes('Retry'));
      expect(retry).toBeDefined();
      await act(async () => { retry?.click(); await flushPromises(); });
      expect(target.textContent).toBe('Recovered current panel');
      expect(attempts).toBe(2);
    } finally {
      console.error = consoleError;
    }
  });

  it('keeps chunk failures local and retries the loader', async () => {
    const consoleError = console.error;
    console.error = mock(() => undefined) as unknown as typeof console.error;
    let attempts = 0;
    const loader = createModePanelLoader({
      id: 'test:center:retry',
      label: 'Retry panel',
      mode: 'Implement',
      panel: 'center',
      importComponent: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('chunk failed');
        }
        return () => <div>Recovered panel</div>;
      },
    });

    try {
      const target = renderPanel(
        <AsyncPanel loader={loader} fallback={<div>Loading panel</div>} />,
      );

      await act(async () => {
        await flushPromises();
      });

      expect(target.textContent).toContain('Retry panel could not load.');
      expect(target.textContent).toContain('chunk failed');

      const retryButton = Array.from(target.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Retry'),
      );
      expect(retryButton).not.toBeNull();

      await act(async () => {
        retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushPromises();
      });

      expect(target.textContent).toContain('Recovered panel');
      expect(attempts).toBe(2);
    } finally {
      console.error = consoleError;
    }
  });
});

describe('mode panel configuration', () => {
  it('shares the same center loader between Architect and Chat', () => {
    expect(modePanelLoaders.Architect.center).toBe(modePanelLoaders.Chat.center);
  });
  it('provides navigation and work surfaces for every Architect slot', () => {
    expect(hasModePanel('Architect', 'left')).toBe(true);
    expect(hasModePanel('Architect', 'center')).toBe(true);
    expect(hasModePanel('Architect', 'right')).toBe(true);
    expect(hasModePanel('Chat', 'left')).toBe(true);
    expect(hasModePanel('Implement', 'left')).toBe(true);
  });
});
